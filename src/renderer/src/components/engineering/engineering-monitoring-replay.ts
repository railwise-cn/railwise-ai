import { MonitoringReplayVerificationV1 } from '@shared/engineering-verification'
import { InvalidVerificationResponse } from './engineering-verification'

export function parseMonitoringReplay(value: unknown, binding: { projectId: string; manifestId: string }): MonitoringReplayVerificationV1 {
  const parsed = MonitoringReplayVerificationV1.safeParse(value)
  if (!parsed.success) throw new InvalidVerificationResponse()
  const result = parsed.data
  const timestamp = Date.parse(result.checkedAt)
  if (result.projectId !== binding.projectId || result.manifestId !== binding.manifestId
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result.checkedAt)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== result.checkedAt.slice(0, 19)
    || new Set(result.analyses.map(item => item.analysisId)).size !== result.analyses.length
    || (result.status === 'passed' && (!result.analyses.length || result.analyses.some(item => item.status !== 'passed' || item.algorithmVersion !== 'workwise-engineering-2'
      || item.storedResultsHash !== item.recomputedResultsHash)))) throw new InvalidVerificationResponse()
  return result
}

export const monitoringReplayReasonKeys = {
  matched: 'monitoringReplayMatched',
  'no-monitoring-analysis': 'monitoringReplayNoAnalysis',
  'unsupported-algorithm': 'monitoringReplayUnsupported',
  'prerequisite-failed': 'monitoringReplayPrerequisiteFailed',
  'input-invalid': 'monitoringReplayInputInvalid',
  'result-mismatch': 'monitoringReplayMismatch',
  'resource-limit': 'monitoringReplayResourceLimit',
  'source-unavailable': 'monitoringReplaySourceUnavailable',
  'source-mismatch': 'monitoringReplaySourceMismatch',
  'ambiguous-tie-order': 'monitoringReplayAmbiguousOrder'
} as const
