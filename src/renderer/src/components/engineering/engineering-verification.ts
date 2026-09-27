import { DeliverableVerificationV1 } from '@shared/engineering-verification'

export type VerificationBinding = { projectId: string; manifestId: string; reviewStatus: string }
const checkIds = ['manifest', 'outputs', 'inputs', 'surveyReplay', 'sources'] as const
export class InvalidVerificationResponse extends Error {
  constructor() { super('invalid verification response') }
}

export function parseEngineeringVerification(value: unknown, binding: VerificationBinding): DeliverableVerificationV1 {
  const parsed = DeliverableVerificationV1.safeParse(value)
  if (!parsed.success) throw new InvalidVerificationResponse()
  const result = parsed.data
  const timestamp = Date.parse(result.checkedAt)
  if (result.projectId !== binding.projectId || result.manifestId !== binding.manifestId || result.reviewStatus !== binding.reviewStatus
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result.checkedAt)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== result.checkedAt.slice(0, 19)
    || result.checks.length !== checkIds.length || new Set(result.checks.map(check => check.id)).size !== checkIds.length
    || result.checks.some(check => (check.detail?.length ?? 0) > 16_384)
    || result.checks.some(check => ['manifest', 'outputs', 'inputs'].includes(check.id) && check.status === 'not-applicable')
    || (result.checks.find(check => check.id === 'surveyReplay')!.status === 'not-applicable') !== (result.checks.find(check => check.id === 'sources')!.status === 'not-applicable')
    || result.valid !== result.checks.every(check => check.status !== 'failed')) throw new InvalidVerificationResponse()
  return result
}

export function verificationFailureKey(value: string): string {
  if (/audit could not be saved/.test(value)) return 'engineeringVerifyAuditUnavailable'
  if (/identity mismatch|not found in project/.test(value)) return 'engineeringVerifyIdentityInvalid'
  if (/published manifest|durable manifest/.test(value)) return 'engineeringVerifyManifestChanged'
  if (/delivery output|output files/.test(value)) return 'engineeringVerifyOutputChanged'
  if (/input bindings|input snapshot|dataset source hash|input changed|thresholds|completed run/.test(value)) return 'engineeringVerifyInputChanged'
  if (/source integrity|source provenance|sources.*admissib|source.*admission/.test(value)) return 'engineeringVerifySourceChanged'
  if (/survey adjustment|deformation|replay/.test(value)) return 'engineeringVerifyReplayFailed'
  return 'engineeringVerifyRequestFailed'
}
