import { z } from 'zod'
import {
  SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS as LIMITS, SurveyQualityScoringCreateV1, SurveyQualityScoringSummaryV1,
  SurveyQualityScoringRecordV1, SurveyQualityScoringListV1, SurveyQualityScoringVerificationV1,
  SurveyQualityScoringInputV1, runtimeSurveyQualityScoringPath, parseQualityScoringJson
} from '@shared/survey-quality-scoring'
import { rendererRuntimeClient } from './runtime-client'

export type QualityScoringBinding = { projectId: string; projectRevision: number; workspaceRoot: string }
export type QualityScoringRecord = z.infer<typeof SurveyQualityScoringRecordV1>
export type QualityScoringSummary = z.infer<typeof SurveyQualityScoringSummaryV1>
export type QualityScoringKind = QualityScoringRecord['kind']
export type QualityScoringInput = Pick<z.infer<typeof SurveyQualityScoringCreateV1>, 'kind' | 'declarationJson' | 'modelBasisStatement'>
export type QualityScoringHistory = z.infer<typeof SurveyQualityScoringListV1> & { offset: number }
export type QualityScoringFailure = 'not_found' | 'stale' | 'integrity' | 'conflict' | 'limit' | 'rate_limit' | 'replay-environment' | 'invalid-response' | 'invalid-input' | 'unavailable' | 'request-failed'
export class QualityScoringRequestError extends Error {
  constructor(readonly reason: QualityScoringFailure) { super(reason) }
}
const invalid = (): never => { throw new QualityScoringRequestError('invalid-response') }
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
function parseDeclaration(kind: QualityScoringKind, raw: string): unknown {
  const parsed: unknown = parseQualityScoringJson(raw)
  const declaration = SurveyQualityScoringInputV1.parse(parsed)
  if (declaration.operation !== kind) throw new Error('operation mismatch')
  return declaration
}
export function validateQualityScoringInput(binding: QualityScoringBinding, input: QualityScoringInput): boolean {
  try {
    const body = SurveyQualityScoringCreateV1.parse({ ...input, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey: 'validation-only' })
    if (bytes(JSON.stringify(body)) > LIMITS.requestBytes) return false
    parseDeclaration(input.kind, input.declarationJson)
    return true
  } catch { return false }
}
async function request(path: string, method = 'GET', body?: string): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body) }
  catch { throw new QualityScoringRequestError('request-failed') }
  if (!response.ok) {
    if (response.body.length < 16_384) {
      try {
        const { code } = JSON.parse(response.body) as { code?: unknown }
        if (code === 'quality_scoring_validation') throw new QualityScoringRequestError('invalid-input')
        const reason = (['not_found', 'stale', 'integrity', 'conflict', 'limit', 'rate_limit', 'replay-environment'] as const).find(value => code === `quality_scoring_${value.replaceAll('-', '_')}`)
        if (reason) throw new QualityScoringRequestError(reason)
      } catch (cause) { if (cause instanceof QualityScoringRequestError) throw cause }
    }
    throw new QualityScoringRequestError([404, 503].includes(response.status) ? 'unavailable' : 'request-failed')
  }
  try {
    if (response.body.length > LIMITS.recordBytes || bytes(response.body) > LIMITS.recordBytes) return invalid()
    return parseQualityScoringJson(response.body)
  } catch { return invalid() }
}
async function checkSummary(raw: unknown, binding: QualityScoringBinding): Promise<QualityScoringSummary> {
  const summary = decode(SurveyQualityScoringSummaryV1, raw)
  if (summary.projectId !== binding.projectId || summary.projectRevision !== binding.projectRevision
    || summary.projectBindingHash !== await hash(canonical({ id: binding.projectId, revision: binding.projectRevision, workspace: binding.workspaceRoot }))) invalid()
  return summary
}
export function qualityScoringSummary(record: QualityScoringRecord): QualityScoringSummary {
  const { declarationJson: _declarationJson, declaration: _declaration, result: _result, requestJson: _requestJson,
    modelBasisStatement: _modelBasis, projectSnapshot: _snapshot, replayEnvironment: _environment, ...summary } = record
  return SurveyQualityScoringSummaryV1.parse(summary)
}
function checkResultBinding(record: QualityScoringRecord): void {
  if (!equal(record.result.request, record.declaration)) invalid()
}
async function checkRecord(raw: unknown, binding: QualityScoringBinding, expected: QualityScoringSummary): Promise<QualityScoringRecord> {
  const record = decode(SurveyQualityScoringRecordV1, raw)
  const summary = await checkSummary(qualityScoringSummary(record), binding)
  if (!equal(summary, expected) || record.projectSnapshot.workspace !== binding.workspaceRoot) invalid()
  let body: z.infer<typeof SurveyQualityScoringCreateV1>, declaration: unknown
  try { body = SurveyQualityScoringCreateV1.parse(parseQualityScoringJson(record.requestJson)); declaration = parseDeclaration(record.kind, record.declarationJson) }
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
  if (record.result.requestSha256 !== await hash(JSON.stringify(record.declaration))) invalid()
  checkResultBinding(record)
  return record
}
export async function listQualityScorings(binding: QualityScoringBinding, offset = 0): Promise<QualityScoringHistory> {
  if (!Number.isInteger(offset) || offset < 0 || offset > LIMITS.recordsPerProject) throw new QualityScoringRequestError('invalid-input')
  const page = decode(SurveyQualityScoringListV1, await request(`${runtimeSurveyQualityScoringPath(binding.projectId)}?limit=${LIMITS.pageSize}&offset=${offset}`))
  const count = page.records.length + page.unavailable.length
  if (count > LIMITS.recordsPerProject - offset || page.nextOffset !== null && (page.nextOffset !== offset + LIMITS.pageSize || count !== LIMITS.pageSize)) invalid()
  await Promise.all(page.records.map(summary => checkSummary(summary, binding)))
  return { ...page, offset }
}
export async function readQualityScoring(binding: QualityScoringBinding, expected: QualityScoringSummary): Promise<QualityScoringRecord> {
  return checkRecord(await request(runtimeSurveyQualityScoringPath(binding.projectId, expected.id)), binding, expected)
}
export async function exportQualityScoring(binding: QualityScoringBinding, expected: QualityScoringSummary): Promise<QualityScoringRecord> {
  // The export endpoint performs fresh server replay; never export a cached view.
  return checkRecord(await request(runtimeSurveyQualityScoringPath(binding.projectId, expected.id, 'export')), binding, expected)
}
export async function createQualityScoring(binding: QualityScoringBinding, input: QualityScoringInput, idempotencyKey: string, stillCurrent: () => boolean = () => true): Promise<QualityScoringRecord> {
  if (!validateQualityScoringInput(binding, input)) throw new QualityScoringRequestError('invalid-input')
  const body = SurveyQualityScoringCreateV1.parse({ ...input, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey })
  const raw = JSON.stringify(body)
  if (bytes(raw) > LIMITS.requestBytes) throw new QualityScoringRequestError('invalid-input')
  const summary = await checkSummary(await request(runtimeSurveyQualityScoringPath(binding.projectId), 'POST', raw), binding)
  const [requestHash, declarationHash, modelHash, basisHash] = await Promise.all([hash(raw), hash(input.declarationJson), hash(canonical(parseDeclaration(input.kind, input.declarationJson))), hash(input.modelBasisStatement)])
  if (summary.kind !== input.kind || summary.idempotencyKey !== idempotencyKey || summary.requestSha256 !== requestHash
    || summary.declarationSha256 !== declarationHash || summary.modelHash !== modelHash || summary.modelBasisSha256 !== basisHash
    || summary.requestSizeBytes !== bytes(raw) || summary.declarationSizeBytes !== bytes(input.declarationJson) || summary.modelBasisSizeBytes !== bytes(input.modelBasisStatement)) invalid()
  if (!stillCurrent()) throw new QualityScoringRequestError('stale')
  return readQualityScoring(binding, summary)
}
export async function reverifyQualityScoring(binding: QualityScoringBinding, expected: QualityScoringSummary, stillCurrent: () => boolean = () => true): Promise<QualityScoringRecord> {
  const verification = decode(SurveyQualityScoringVerificationV1, await request(runtimeSurveyQualityScoringPath(binding.projectId, expected.id, 'reverify'), 'POST', '{}'))
  if (verification.projectId !== binding.projectId || verification.recordId !== expected.id || verification.kind !== expected.kind
    || verification.recordHash !== expected.recordHash || verification.modelHash !== expected.modelHash || verification.resultHash !== expected.resultHash
    || verification.requestSha256 !== expected.requestSha256 || verification.declarationSha256 !== expected.declarationSha256) invalid()
  if (!stillCurrent()) throw new QualityScoringRequestError('stale')
  return readQualityScoring(binding, expected)
}
