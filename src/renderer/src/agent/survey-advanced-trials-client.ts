import { z } from 'zod'
import {
  SURVEY_ADVANCED_TRIAL_LIMITS as LIMITS, SurveyAdvancedTrialCreateV1, SurveyAdvancedTrialSummaryV1,
  SurveyAdvancedTrialRecordV1, SurveyAdvancedTrialListV1, SurveyAdvancedTrialVerificationV1,
  SurveyGeneralizedWRequestV1, SurveyVceTrialInputV1, SurveyHuberTrialInputV1, SurveyStatisticalFamilyInputV1, SurveyReferenceDatumInputV1, SurveyStaticIncrementalInputV1, runtimeSurveyAdvancedTrialsPath, parseAdvancedTrialJson
} from '@shared/survey-advanced-trials'
import { rendererRuntimeClient } from './runtime-client'

export type AdvancedTrialBinding = { projectId: string; projectRevision: number; workspaceRoot: string }
export type AdvancedTrialRecord = z.infer<typeof SurveyAdvancedTrialRecordV1>
export type AdvancedTrialSummary = z.infer<typeof SurveyAdvancedTrialSummaryV1>
export type AdvancedTrialKind = AdvancedTrialRecord['kind']
export type AdvancedTrialInput = Pick<z.infer<typeof SurveyAdvancedTrialCreateV1>, 'kind' | 'declarationJson' | 'modelBasisStatement'>
export type AdvancedTrialHistory = z.infer<typeof SurveyAdvancedTrialListV1> & { offset: number }
export type AdvancedTrialFailure = 'not_found' | 'stale' | 'integrity' | 'conflict' | 'limit' | 'rate_limit' | 'replay-environment' | 'invalid-response' | 'invalid-input' | 'unavailable' | 'request-failed'
export class AdvancedTrialRequestError extends Error {
  constructor(readonly reason: AdvancedTrialFailure) { super(reason) }
}
const invalid = (): never => { throw new AdvancedTrialRequestError('invalid-response') }
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
async function hash(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  return result.success ? result.data : invalid()
}
function parseDeclaration(kind: AdvancedTrialKind, raw: string): unknown {
  const parsed: unknown = parseAdvancedTrialJson(raw)
  return ({ 'generalized-w': SurveyGeneralizedWRequestV1, vce: SurveyVceTrialInputV1, huber: SurveyHuberTrialInputV1, 'statistical-family': SurveyStatisticalFamilyInputV1, 'reference-datum': SurveyReferenceDatumInputV1, 'static-incremental': SurveyStaticIncrementalInputV1 })[kind].parse(parsed)
}
export function validateAdvancedTrialInput(binding: AdvancedTrialBinding, input: AdvancedTrialInput): boolean {
  try {
    const body = SurveyAdvancedTrialCreateV1.parse({ ...input, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey: 'validation-only' })
    if (bytes(JSON.stringify(body)) > LIMITS.requestBytes) return false
    parseDeclaration(input.kind, input.declarationJson)
    return true
  } catch { return false }
}
async function request(path: string, method = 'GET', body?: string): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body) }
  catch { throw new AdvancedTrialRequestError('request-failed') }
  if (!response.ok) {
    if (response.body.length < 16_384) {
      try {
        const { code } = JSON.parse(response.body) as { code?: unknown }
        if (code === 'advanced_trials_validation') throw new AdvancedTrialRequestError('invalid-input')
        const reason = (['not_found', 'stale', 'integrity', 'conflict', 'limit', 'rate_limit', 'replay-environment'] as const).find(value => code === `advanced_trials_${value.replaceAll('-', '_')}`)
        if (reason) throw new AdvancedTrialRequestError(reason)
      } catch (cause) { if (cause instanceof AdvancedTrialRequestError) throw cause }
    }
    throw new AdvancedTrialRequestError([404, 503].includes(response.status) ? 'unavailable' : 'request-failed')
  }
  try {
    if (response.body.length > LIMITS.recordBytes || bytes(response.body) > LIMITS.recordBytes) return invalid()
    return parseAdvancedTrialJson(response.body)
  } catch { return invalid() }
}
async function checkSummary(raw: unknown, binding: AdvancedTrialBinding): Promise<AdvancedTrialSummary> {
  const summary = decode(SurveyAdvancedTrialSummaryV1, raw)
  if (summary.projectId !== binding.projectId || summary.projectRevision !== binding.projectRevision
    || summary.projectBindingHash !== await hash(canonical({ id: binding.projectId, revision: binding.projectRevision, workspace: binding.workspaceRoot }))) invalid()
  return summary
}
export function advancedTrialSummary(record: AdvancedTrialRecord): AdvancedTrialSummary {
  const { declarationJson: _declarationJson, declaration: _declaration, result: _result, requestJson: _requestJson,
    modelBasisStatement: _modelBasis, projectSnapshot: _snapshot, replayEnvironment: _environment, ...summary } = record
  return SurveyAdvancedTrialSummaryV1.parse(summary)
}
// The frozen statistical-family-1 kernel sorts only the supplied statistic subset.
// Preserve original declaration order/bytes and its model hash separately.
function statisticalResultRequest(declaration: z.infer<typeof SurveyStatisticalFamilyInputV1>) {
  return { ...declaration, statistics: [...declaration.statistics].sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0) }
}
function checkResultBinding(record: AdvancedTrialRecord): void {
  if (record.kind === 'generalized-w' || record.kind === 'huber') {
    if (!equal(record.result.request, record.declaration)) invalid()
    return
  }
  if (record.kind === 'reference-datum' || record.kind === 'static-incremental') {
    if (record.result.outcome === 'invalid-input' || !equal(record.result.request, record.declaration)) invalid()
    return
  }
  if (record.kind === 'statistical-family') {
    if (record.result.outcome !== 'evaluated' || !equal(record.result.request, statisticalResultRequest(record.declaration))) invalid()
    return
  }
  const { declaration, result } = record
  const groupIds = declaration.groups.map(group => group.id), observationIds = declaration.observations.map(row => row.id)
  const n = observationIds.length, p = declaration.parameterIds.length, k = groupIds.length
  if (!equal(result.parameterIds, declaration.parameterIds) || !equal(result.groupIds, groupIds) || !equal(result.observationIds, observationIds)
    || !equal(result.convergencePolicy, { maxIterations: declaration.maxIterations, relativeTolerance: declaration.relativeTolerance })
    || result.unit !== declaration.unit || result.squaredUnit !== `${declaration.unit}2` || result.degreesOfFreedom !== n - p
    || result.iterations.length > declaration.maxIterations) invalid()
  const fitValid = (fit: NonNullable<typeof result.finalFit>): boolean => fit.parameters.length === p && fit.residuals.length === n && fit.functionalNormalConditionInfinity <= 1e8
  for (const [index, iteration] of result.iterations.entries()) {
    if (iteration.iteration !== index + 1 || iteration.currentVariances.length !== k || iteration.candidateVariances.length !== k
      || iteration.normal.length !== k || iteration.normal.some(row => row.length !== k) || iteration.rightHandSide.length !== k
      || !fitValid(iteration.fit) || iteration.stochasticNormalConditionInfinity > 1e8
      || !equal(iteration.currentVariances, index ? result.iterations[index - 1]!.candidateVariances : declaration.groups.map(group => group.initialVariance))) invalid()
    const change = Math.max(...iteration.candidateVariances.map((value, i) => Math.abs(value - iteration.currentVariances[i]!) / Math.max(Math.abs(value), Math.abs(iteration.currentVariances[i]!))))
    if (Math.abs(change - iteration.relativeChange) > 1e-12 * Math.max(1, change)) invalid()
  }
  const last = result.iterations.at(-1)
  if (result.outcome === 'converged') {
    if (!last || last.relativeChange > declaration.relativeTolerance || !result.finalFit || !fitValid(result.finalFit)
      || !equal(result.convergedVariances, last.candidateVariances) || last.candidateVariances.some(value => value < 1e-18 || value > 1e18)) invalid()
  } else if (result.convergedVariances !== null || result.finalFit !== null) invalid()
  if (result.outcome === 'nonpositive-component' && (!last || !last.candidateVariances.some(value => value <= 0))) invalid()
  if (result.outcome === 'iteration-limit' && result.iterations.length !== declaration.maxIterations) invalid()
}
async function checkRecord(raw: unknown, binding: AdvancedTrialBinding, expected: AdvancedTrialSummary): Promise<AdvancedTrialRecord> {
  const record = decode(SurveyAdvancedTrialRecordV1, raw)
  const summary = await checkSummary(advancedTrialSummary(record), binding)
  if (!equal(summary, expected) || record.projectSnapshot.workspace !== binding.workspaceRoot) invalid()
  let body: z.infer<typeof SurveyAdvancedTrialCreateV1>, declaration: unknown
  try { body = SurveyAdvancedTrialCreateV1.parse(parseAdvancedTrialJson(record.requestJson)); declaration = parseDeclaration(record.kind, record.declarationJson) }
  catch { return invalid() }
  if (body.kind !== record.kind || body.expectedProjectRevision !== record.projectRevision || body.idempotencyKey !== record.idempotencyKey
    || body.declarationJson !== record.declarationJson || body.modelBasisStatement !== record.modelBasisStatement || !equal(declaration, record.declaration)) invalid()
  const { recordHash: _recordHash, ...unsigned } = record
  const expectedHashes = await Promise.all([
    hash(record.requestJson), hash(record.declarationJson), hash(record.modelBasisStatement), hash(canonical(record.declaration)),
    hash(canonical(record.result)), hash(canonical(record.replayEnvironment)), hash(canonical(unsigned))
  ])
  const recordedHashes = [record.requestSha256, record.declarationSha256, record.modelBasisSha256, record.modelHash, record.resultHash, record.replayEnvironmentHash, record.recordHash]
  if (!equal(recordedHashes, expectedHashes)) invalid()
  if ((record.kind === 'generalized-w' || record.kind === 'huber') && record.result.requestHash !== await hash(JSON.stringify(record.declaration))) invalid()
  if (record.kind === 'statistical-family' && (record.result.outcome !== 'evaluated' || record.result.requestSha256 !== await hash(JSON.stringify(statisticalResultRequest(record.declaration))))) invalid()
  if ((record.kind === 'reference-datum' || record.kind === 'static-incremental') && (record.result.outcome === 'invalid-input' || record.result.requestSha256 !== await hash(JSON.stringify(record.declaration)))) invalid()
  if (record.kind === 'static-incremental' && record.result.outcome !== 'invalid-input') {
    if (record.result.computedBaseFingerprint !== await hash(JSON.stringify(record.declaration.base))) invalid()
    if (record.result.outcome === 'calculated') {
      const finalBase = { ...record.declaration.base, revision: record.declaration.append.nextRevision, observations: [...record.declaration.base.observations, ...record.declaration.append.observations] }
      if (record.result.finalFingerprint !== await hash(JSON.stringify(finalBase))) invalid()
      for (const state of [record.result.baseQrState, record.result.updatedQrState]) {
        const { stateSha256, ...unsignedState } = state
        if (stateSha256 !== await hash(JSON.stringify(unsignedState))) invalid()
      }
    }
  }
  checkResultBinding(record)
  return record
}
export async function listAdvancedTrials(binding: AdvancedTrialBinding, offset = 0): Promise<AdvancedTrialHistory> {
  if (!Number.isInteger(offset) || offset < 0 || offset > LIMITS.trialsPerProject) throw new AdvancedTrialRequestError('invalid-input')
  const page = decode(SurveyAdvancedTrialListV1, await request(`${runtimeSurveyAdvancedTrialsPath(binding.projectId)}?limit=${LIMITS.pageSize}&offset=${offset}`))
  const count = page.trials.length + page.unavailable.length
  if (count > LIMITS.trialsPerProject - offset || page.nextOffset !== null && (page.nextOffset !== offset + LIMITS.pageSize || count !== LIMITS.pageSize)) invalid()
  await Promise.all(page.trials.map(summary => checkSummary(summary, binding)))
  return { ...page, offset }
}
export async function readAdvancedTrial(binding: AdvancedTrialBinding, expected: AdvancedTrialSummary): Promise<AdvancedTrialRecord> {
  return checkRecord(await request(runtimeSurveyAdvancedTrialsPath(binding.projectId, expected.id)), binding, expected)
}
export async function exportAdvancedTrial(binding: AdvancedTrialBinding, expected: AdvancedTrialSummary): Promise<AdvancedTrialRecord> {
  // The export endpoint performs fresh server replay; never export a cached view.
  return checkRecord(await request(runtimeSurveyAdvancedTrialsPath(binding.projectId, expected.id, 'export')), binding, expected)
}
export async function createAdvancedTrial(binding: AdvancedTrialBinding, input: AdvancedTrialInput, idempotencyKey: string, stillCurrent: () => boolean = () => true): Promise<AdvancedTrialRecord> {
  if (!validateAdvancedTrialInput(binding, input)) throw new AdvancedTrialRequestError('invalid-input')
  const body = SurveyAdvancedTrialCreateV1.parse({ ...input, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey })
  const raw = JSON.stringify(body)
  if (bytes(raw) > LIMITS.requestBytes) throw new AdvancedTrialRequestError('invalid-input')
  const summary = await checkSummary(await request(runtimeSurveyAdvancedTrialsPath(binding.projectId), 'POST', raw), binding)
  const [requestHash, declarationHash, modelHash, basisHash] = await Promise.all([hash(raw), hash(input.declarationJson), hash(canonical(parseDeclaration(input.kind, input.declarationJson))), hash(input.modelBasisStatement)])
  if (summary.kind !== input.kind || summary.idempotencyKey !== idempotencyKey || summary.requestSha256 !== requestHash
    || summary.declarationSha256 !== declarationHash || summary.modelHash !== modelHash || summary.modelBasisSha256 !== basisHash
    || summary.requestSizeBytes !== bytes(raw) || summary.declarationSizeBytes !== bytes(input.declarationJson) || summary.modelBasisSizeBytes !== bytes(input.modelBasisStatement)) invalid()
  if (!stillCurrent()) throw new AdvancedTrialRequestError('stale')
  return readAdvancedTrial(binding, summary)
}
export async function reverifyAdvancedTrial(binding: AdvancedTrialBinding, expected: AdvancedTrialSummary, stillCurrent: () => boolean = () => true): Promise<AdvancedTrialRecord> {
  const verification = decode(SurveyAdvancedTrialVerificationV1, await request(runtimeSurveyAdvancedTrialsPath(binding.projectId, expected.id, 'reverify'), 'POST', '{}'))
  if (verification.projectId !== binding.projectId || verification.trialId !== expected.id || verification.kind !== expected.kind
    || verification.recordHash !== expected.recordHash || verification.modelHash !== expected.modelHash || verification.resultHash !== expected.resultHash
    || verification.requestSha256 !== expected.requestSha256 || verification.declarationSha256 !== expected.declarationSha256) invalid()
  if (!stillCurrent()) throw new AdvancedTrialRequestError('stale')
  return readAdvancedTrial(binding, expected)
}
