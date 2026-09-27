import { SurveyStatisticalDiagnosticsV1 } from '@shared/survey-statistics'
import { runtimeSurveyStatisticalDiagnosticsPath } from '@shared/runtime-endpoints'
import { rendererRuntimeClient } from './runtime-client'

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 1024 * 1024

export type SurveyStatisticalBinding = Pick<SurveyStatisticalDiagnosticsV1,
  'projectId' | 'networkId' | 'runId' | 'resultId' | 'inputHash' | 'algorithmVersion' | 'sourceSha256'>

export class SurveyStatisticalRequestError extends Error {
  constructor(readonly reason: 'stale' | 'unavailable' | 'invalid-response' | 'request-failed') {
    super(reason)
  }
}

export async function readSurveyStatisticalDiagnostics(binding: SurveyStatisticalBinding, download = false): Promise<SurveyStatisticalDiagnosticsV1> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try {
    response = await rendererRuntimeClient.runtimeRequest(runtimeSurveyStatisticalDiagnosticsPath(binding.projectId, binding.runId, download), 'GET')
  } catch {
    throw new SurveyStatisticalRequestError('request-failed')
  }
  if (!response.ok) {
    throw new SurveyStatisticalRequestError(response.status === 409 ? 'stale' : response.status === 404 || response.status === 503 ? 'unavailable' : 'request-failed')
  }
  try {
    if (response.body.length > MAX_DIAGNOSTIC_RESPONSE_BYTES || new TextEncoder().encode(response.body).byteLength > MAX_DIAGNOSTIC_RESPONSE_BYTES) {
      throw new Error('diagnostic response exceeds size limit')
    }
    const diagnostic = SurveyStatisticalDiagnosticsV1.parse(JSON.parse(response.body))
    for (const key of Object.keys(binding) as Array<keyof SurveyStatisticalBinding>) {
      if (diagnostic[key] !== binding[key]) throw new Error('diagnostic identity mismatch')
    }
    return diagnostic
  } catch {
    throw new SurveyStatisticalRequestError('invalid-response')
  }
}
