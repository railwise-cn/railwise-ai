import { SurveyFreeLevelingTrialV1, SurveyFreeLevelingTrialListV1, SurveyFreeLevelingTrialRequestV1 } from '@shared/survey-free-leveling'
import { runtimeSurveyFreeLevelingTrialPath, runtimeSurveyFreeLevelingTrialsPath } from '@shared/runtime-endpoints'
import { rendererRuntimeClient } from './runtime-client'

export type FreeLevelingBinding = Pick<SurveyFreeLevelingTrialV1, 'projectId' | 'networkId' | 'networkRevision' | 'sourceSha256'>
const failureReasons = ['source-ineligible', 'stale', 'unsupported-network', 'unsupported-observations', 'mixed-weights', 'dimension-limit', 'idempotency-conflict', 'numeric-unresolved', 'disconnected-network', 'insufficient-redundancy'] as const
type FailureReason = typeof failureReasons[number] | 'unavailable' | 'invalid-response' | 'request-failed'
export class FreeLevelingRequestError extends Error {
  constructor(readonly reason: FailureReason) { super(reason) }
}

async function request(path: string, method = 'GET', body?: string): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body) }
  catch { throw new FreeLevelingRequestError('request-failed') }
  if (!response.ok) {
    if (response.status === 409 && response.body.length <= 16_384) {
      try {
        const failure = JSON.parse(response.body) as { code?: unknown; details?: { reason?: unknown } }
        const reason = failureReasons.find(candidate => candidate === failure.details?.reason && failure.code === `free_leveling_${candidate.replaceAll('-', '_')}`)
        if (reason) throw new FreeLevelingRequestError(reason)
      } catch (cause) { if (cause instanceof FreeLevelingRequestError) throw cause }
    }
    throw new FreeLevelingRequestError(response.status === 409 ? 'stale' : response.status === 404 || response.status === 503 ? 'unavailable' : 'request-failed')
  }
  try {
    // Full 256-observation cofactors are retained in the versioned record.
    const maxBytes = 8 * 1024 * 1024
    if (response.body.length > maxBytes || new TextEncoder().encode(response.body).byteLength > maxBytes) throw new Error('size')
    return JSON.parse(response.body)
  } catch { throw new FreeLevelingRequestError('invalid-response') }
}

function checkBinding(record: FreeLevelingBinding, binding: FreeLevelingBinding): void {
  for (const key of Object.keys(binding) as Array<keyof FreeLevelingBinding>) {
    if (record[key] !== binding[key]) throw new FreeLevelingRequestError('invalid-response')
  }
}
function parseTrial(value: unknown, binding: FreeLevelingBinding, id?: string): SurveyFreeLevelingTrialV1 {
  const parsed = SurveyFreeLevelingTrialV1.safeParse(value)
  if (!parsed.success) throw new FreeLevelingRequestError('invalid-response')
  const trial = parsed.data
  checkBinding(trial, binding)
  if (id !== undefined && trial.id !== id) throw new FreeLevelingRequestError('invalid-response')
  // Check the displayed tables against their identities and summary counts.
  const output = trial.output
  if (trial.pointCount !== output.points.length || trial.observationCount !== output.observations.length
    || trial.degreesOfFreedom !== output.degreesOfFreedom
    || new Set(output.pointIds).size !== trial.pointCount || new Set(output.observationIds).size !== trial.observationCount
    || JSON.stringify(output.pointIds) !== JSON.stringify(output.points.map(point => point.id))
    || JSON.stringify(output.observationIds) !== JSON.stringify(output.observations.map(observation => observation.id))
    || trial.originalPointRoles.length !== trial.pointCount
    || trial.originalPointRoles.some(role => !output.pointIds.includes(role.id))
    || new Set(trial.originalPointRoles.map(role => role.id)).size !== trial.pointCount) throw new FreeLevelingRequestError('invalid-response')
  const square = (matrix: number[][], size: number): boolean => matrix.length === size && matrix.every(row => row.length === size)
  if (JSON.stringify(output.constraint.pointIds) !== JSON.stringify(output.pointIds)
    || output.rank !== trial.pointCount - 1 || output.degreesOfFreedom !== trial.observationCount - output.rank
    || !square(output.heightCofactor, trial.pointCount) || !square(output.residualCofactor, trial.observationCount)
    || !square(output.adjustedHeightDifferenceCofactor, trial.observationCount)
    || output.observations.some(row => !row.sourceAnchor.trim() || !output.pointIds.includes(row.from) || !output.pointIds.includes(row.to) || row.from === row.to)
    || new Set(output.observations.map(row => row.sourceAnchor)).size !== trial.observationCount
    || trial.originalPointRoles.some(role => {
      const point = output.points.find(item => item.id === role.id)!
      return role.id !== role.originalPoint.id || role.known !== role.originalPoint.known
        || role.referenceHeightBasis !== (role.originalPoint.height === undefined ? 'zero-initial-approximation' : 'declared-height')
        || point.referenceHeight !== (role.originalPoint.height ?? 0)
    })
    || new Set(trial.defaultWeightObservationIds).size !== trial.defaultWeightObservationIds.length
    || trial.defaultWeightObservationIds.some(id => !output.observationIds.includes(id))) throw new FreeLevelingRequestError('invalid-response')
  return trial
}

export async function createFreeLevelingTrial(binding: FreeLevelingBinding, idempotencyKey: string): Promise<SurveyFreeLevelingTrialV1> {
  const body = SurveyFreeLevelingTrialRequestV1.parse({ expectedRevision: binding.networkRevision, idempotencyKey,
    constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true, weightPolicy: 'source-or-unit-fallback' })
  return parseTrial(await request(runtimeSurveyFreeLevelingTrialsPath(binding.projectId, binding.networkId), 'POST', JSON.stringify(body)), binding)
}
export async function readFreeLevelingTrial(binding: FreeLevelingBinding, trialId: string, expected?: Pick<SurveyFreeLevelingTrialV1, 'inputHash' | 'outputHash' | 'recordHash'>): Promise<SurveyFreeLevelingTrialV1> {
  const record = parseTrial(await request(runtimeSurveyFreeLevelingTrialPath(binding.projectId, binding.networkId, trialId)), binding, trialId)
  if (expected && (record.inputHash !== expected.inputHash || record.outputHash !== expected.outputHash || record.recordHash !== expected.recordHash)) throw new FreeLevelingRequestError('invalid-response')
  return record
}
export async function listFreeLevelingTrials(binding: FreeLevelingBinding, offset = 0): Promise<SurveyFreeLevelingTrialListV1> {
  const parsed = SurveyFreeLevelingTrialListV1.safeParse(await request(`${runtimeSurveyFreeLevelingTrialsPath(binding.projectId, binding.networkId)}?limit=20&offset=${offset}`))
  if (!parsed.success) throw new FreeLevelingRequestError('invalid-response')
  for (const trial of parsed.data.trials) checkBinding(trial, binding)
  if (new Set(parsed.data.trials.map(trial => trial.id)).size !== parsed.data.trials.length
    || (parsed.data.nextOffset !== null && parsed.data.nextOffset <= offset)) throw new FreeLevelingRequestError('invalid-response')
  return parsed.data
}
