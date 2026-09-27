import { z } from 'zod'
import {
  runtimeSurveySamplingPath, SurveySamplingPopulationCreateV1, SurveySamplingPopulationSummaryV1,
  SurveySamplingPopulationDetailV1, SurveySamplingRunCreateV1, SurveySamplingRunSummaryV1,
  SurveySamplingPopulationListV1, SurveySamplingRunListV1, SurveySamplingUnitPageV1,
  SurveySamplingSamplePageV1, SurveySamplingVerificationV1
} from '@shared/survey-quality-sampling-workspace'
import { rendererRuntimeClient } from './runtime-client'

export type SamplingBinding = { projectId: string; projectRevision: number; workspaceRoot: string }
export type SamplingPopulation = z.infer<typeof SurveySamplingPopulationSummaryV1> & { definitionStatement?: string }
export type SamplingRun = z.infer<typeof SurveySamplingRunSummaryV1>
export type SamplingInput = Pick<z.infer<typeof SurveySamplingPopulationCreateV1>, 'productType' | 'unitProductType' | 'definitionStatement' | 'orderedUnitProductIds'>
export type SamplingStage = SamplingRun['stage']
export type SamplingMode = SamplingRun['inspectionMode']
export type SamplingHistory<T> = { items: T[]; unavailable: Array<{ id: string; reason: 'stale' | 'integrity' }>; offset: number; nextOffset: number | null }
export type SamplingPage = { ids: string[]; batchIndices?: number[]; offset: number; nextOffset: number | null; total: number }
export class SamplingRequestError extends Error {
  constructor(readonly reason: 'stale' | 'integrity' | 'conflict' | 'limit' | 'invalid-response' | 'unavailable' | 'request-failed') { super(reason) }
}
const invalid = (): never => { throw new SamplingRequestError('invalid-response') }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : invalid()
}
function checkBinding(value: { projectId: string; projectRevision: number }, binding: SamplingBinding): void {
  if (value.projectId !== binding.projectId || value.projectRevision !== binding.projectRevision) invalid()
}
async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body)) }
  catch { throw new SamplingRequestError('request-failed') }
  if (!response.ok) {
    if (response.body.length < 16_384) {
      try {
        const { code } = JSON.parse(response.body) as { code?: unknown }
        const reason = (['stale', 'integrity', 'conflict', 'limit'] as const).find(value => code === `sampling_workspace_${value}`)
        if (reason) throw new SamplingRequestError(reason)
      } catch (error) { if (error instanceof SamplingRequestError) throw error }
    }
    throw new SamplingRequestError([404, 503].includes(response.status) ? 'unavailable' : response.status === 409 ? 'conflict' : 'request-failed')
  }
  try {
    if (response.body.length > 4 * 1024 * 1024 || new TextEncoder().encode(response.body).byteLength > 4 * 1024 * 1024) return invalid()
    return JSON.parse(response.body)
  } catch { return invalid() }
}
function parsePopulation(value: unknown, binding: SamplingBinding, detail = false): SamplingPopulation {
  const data: SamplingPopulation = detail ? decode(SurveySamplingPopulationDetailV1, value) : decode(SurveySamplingPopulationSummaryV1, value)
  checkBinding(data, binding)
  if (data.definitionStatement !== undefined && data.definitionSizeBytes !== new TextEncoder().encode(data.definitionStatement).byteLength) invalid()
  return data
}
function parseRun(value: unknown, binding: SamplingBinding, population?: SamplingPopulation): SamplingRun {
  const data = decode(SurveySamplingRunSummaryV1, value)
  checkBinding(data, binding)
  if (population && (data.populationId !== population.id || data.populationHash !== population.populationHash
    || data.definitionEvidenceSha256 !== population.definitionEvidenceSha256 || data.unitCount !== population.unitCount
    || data.projectBindingHash !== population.projectBindingHash)) invalid()
  return data
}
export function validateSamplingInput(binding: SamplingBinding, input: SamplingInput): boolean {
  return SurveySamplingPopulationCreateV1.safeParse({ ...input, expectedProjectRevision: binding.projectRevision, idempotencyKey: '00000000-0000-0000-0000-000000000000' }).success
}
export async function freezeSamplingPopulation(binding: SamplingBinding, input: SamplingInput, idempotencyKey: string): Promise<SamplingPopulation> {
  const body = SurveySamplingPopulationCreateV1.parse({ ...input, expectedProjectRevision: binding.projectRevision, idempotencyKey })
  const value = parsePopulation(await request(runtimeSurveySamplingPath(binding.projectId, 'populations'), 'POST', body), binding, true)
  const [definitionHash, populationHash] = await Promise.all([
    sha256(input.definitionStatement), sha256(JSON.stringify(['survey-unit-product-frame-1', input.orderedUnitProductIds]))
  ])
  if (value.productType !== input.productType || value.unitProductType !== input.unitProductType
    || value.definitionStatement !== input.definitionStatement || value.unitCount !== input.orderedUnitProductIds.length
    || value.definitionEvidenceSha256 !== definitionHash || value.populationHash !== populationHash) invalid()
  return value
}
export async function readSamplingPopulation(binding: SamplingBinding, expected: SamplingPopulation): Promise<SamplingPopulation> {
  const value = parsePopulation(await request(runtimeSurveySamplingPath(binding.projectId, 'populations', expected.id)), binding, true)
  const { definitionStatement: ignored, ...summary } = value
  const { definitionStatement: expectedDefinition, ...expectedSummary } = expected
  if (!equal(summary, expectedSummary) || (expectedDefinition !== undefined && value.definitionStatement !== expectedDefinition)
    || value.definitionStatement === undefined || await sha256(value.definitionStatement) !== value.definitionEvidenceSha256) invalid()
  void ignored
  return value
}
function checkHistory<T extends { id: string }>(items: T[], unavailable: SamplingHistory<T>['unavailable'], offset: number, nextOffset: number | null): void {
  const ids = [...items.map(item => item.id), ...unavailable.map(item => item.id)]
  if (ids.length > 20 || new Set(ids).size !== ids.length || (nextOffset !== null && (nextOffset !== offset + 20 || ids.length !== 20))) invalid()
}
export async function listSamplingPopulations(binding: SamplingBinding, offset = 0): Promise<SamplingHistory<SamplingPopulation>> {
  const data = decode(SurveySamplingPopulationListV1, await request(`${runtimeSurveySamplingPath(binding.projectId, 'populations')}?limit=20&offset=${offset}`))
  checkHistory(data.populations, data.unavailable, offset, data.nextOffset)
  return { items: data.populations.map(item => parsePopulation(item, binding)), unavailable: data.unavailable, offset, nextOffset: data.nextOffset }
}
export async function listSamplingRuns(binding: SamplingBinding, offset = 0): Promise<SamplingHistory<SamplingRun>> {
  const data = decode(SurveySamplingRunListV1, await request(`${runtimeSurveySamplingPath(binding.projectId, 'runs')}?limit=20&offset=${offset}`))
  checkHistory(data.runs, data.unavailable, offset, data.nextOffset)
  return { items: data.runs.map(item => parseRun(item, binding)), unavailable: data.unavailable, offset, nextOffset: data.nextOffset }
}
export async function drawSamplingRun(binding: SamplingBinding, population: SamplingPopulation, stage: SamplingStage, inspectionMode: SamplingMode, idempotencyKey: string): Promise<SamplingRun> {
  const body = SurveySamplingRunCreateV1.parse({ populationId: population.id, idempotencyKey, stage, inspectionMode })
  const value = parseRun(await request(runtimeSurveySamplingPath(binding.projectId, 'runs'), 'POST', body), binding, population)
  if (value.stage !== stage || value.inspectionMode !== inspectionMode) invalid()
  return value
}
export async function readSamplingRun(binding: SamplingBinding, expected: SamplingRun): Promise<SamplingRun> {
  const value = parseRun(await request(runtimeSurveySamplingPath(binding.projectId, 'runs', expected.id)), binding)
  if (!equal(value, expected)) invalid()
  return value
}
function checkPage(rows: Array<{ index: number; unitProductId: string }>, total: number, offset: number, nextOffset: number | null): void {
  if (rows.length !== Math.max(0, Math.min(50, total - offset)) || rows.some((row, index) => row.index !== offset + index)
    || new Set(rows.map(row => row.unitProductId)).size !== rows.length
    || nextOffset !== (offset + rows.length < total ? offset + rows.length : null)) invalid()
}
export async function readSamplingUnits(binding: SamplingBinding, population: SamplingPopulation, offset = 0): Promise<SamplingPage> {
  const data = decode(SurveySamplingUnitPageV1, await request(`${runtimeSurveySamplingPath(binding.projectId, 'populations', population.id, 'units')}?limit=50&offset=${offset}`))
  if (data.projectId !== binding.projectId || data.populationId !== population.id || data.populationHash !== population.populationHash || data.total !== population.unitCount || data.offset !== offset) invalid()
  checkPage(data.units, data.total, offset, data.nextOffset)
  return { ids: data.units.map(row => row.unitProductId), total: data.total, offset, nextOffset: data.nextOffset }
}
export async function readSamplingSamples(binding: SamplingBinding, run: SamplingRun, offset = 0): Promise<SamplingPage> {
  const data = decode(SurveySamplingSamplePageV1, await request(`${runtimeSurveySamplingPath(binding.projectId, 'runs', run.id, 'samples')}?limit=50&offset=${offset}`))
  if (data.projectId !== binding.projectId || data.runId !== run.id || data.planHash !== run.planHash || data.total !== run.sampleSize || data.offset !== offset) invalid()
  checkPage(data.samples, data.total, offset, data.nextOffset)
  if (data.samples.some(row => {
    let start = 0
    for (const batch of run.batches) { if (row.index < start + batch.sampleSize) return row.batchIndex !== batch.batchIndex; start += batch.sampleSize }
    return true
  })) invalid()
  return { ids: data.samples.map(row => row.unitProductId), batchIndices: data.samples.map(row => row.batchIndex), total: data.total, offset, nextOffset: data.nextOffset }
}
export async function verifySamplingRun(binding: SamplingBinding, run: SamplingRun, stillCurrent: () => boolean = () => true): Promise<SamplingRun> {
  const data = decode(SurveySamplingVerificationV1, await request(runtimeSurveySamplingPath(binding.projectId, 'runs', run.id, 'verify'), 'POST', {}))
  if (data.projectId !== binding.projectId || data.populationId !== run.populationId || data.runId !== run.id || data.planHash !== run.planHash || data.runHash !== run.runHash) invalid()
  if (!stillCurrent()) throw new SamplingRequestError('stale')
  return readSamplingRun(binding, run)
}
