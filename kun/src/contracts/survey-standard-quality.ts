import { z } from 'zod'

const identity = z.string().trim().min(1).max(200)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.iso.datetime({ offset: true })

export const SurveyStandardRuleRefV1 = z.object({
  standardCode: identity, standardVersion: identity, ruleId: identity, ruleVersion: identity
}).strict()
export type SurveyStandardRuleRefV1 = z.infer<typeof SurveyStandardRuleRefV1>

const sourceFields = {
  url: z.url().refine(value => new URL(value).protocol === 'https:', 'HTTPS source required'),
  retrievedAt: timestamp
}
const recordedActor = z.object({ id: identity, kind: z.enum(['human', 'agent', 'system']) }).strict()
const pixelDimension = z.number().int().positive().max(32768)

export const SURVEY_SCANNED_PDF_LIMITS = Object.freeze({
  maxPdfBytes: 64 * 1024 * 1024,
  maxReviewBytes: 1024 * 1024,
  maxPagePixels: 16_000_000,
  maxRgbBytes: 48_000_000
})

export const SurveyScannedPdfEvidenceV1 = z.object({
  pdfPage: z.number().int().positive(),
  printedPage: identity.optional(),
  rendering: z.object({ renderer: identity, version: identity, dpi: z.number().int().positive().max(1200) }).strict(),
  // RGB8 row-major pixels, top-left origin, after PDF page rotation; no encoded-image metadata.
  pageImage: z.object({ sha256: digest, widthPixels: pixelDimension, heightPixels: pixelDimension }).strict(),
  region: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: pixelDimension, height: pixelDimension, sha256: digest }).strict().optional(),
  transcription: z.object({
    text: z.string().min(1).max(65536).refine(value => value.trim().length > 0, 'Empty transcription'),
    sha256: digest, method: z.enum(['manual', 'ocr', 'agent']), recordedAt: timestamp, recordedBy: recordedActor
  }).strict(),
  // These are recorded claims, not authenticated identities or professional signatures.
  review: z.object({ outcome: z.enum(['confirmed', 'needs-correction']), reviewedAt: timestamp,
    reviewedBy: recordedActor, transcriptionSha256: digest, evidenceSha256: digest }).strict().optional()
}).strict().superRefine((scan, ctx) => {
  if (scan.pageImage.widthPixels * scan.pageImage.heightPixels > SURVEY_SCANNED_PDF_LIMITS.maxPagePixels) {
    ctx.addIssue({ code: 'custom', path: ['pageImage'], message: 'Rendered page exceeds pixel budget' })
  }
  if (scan.region && (scan.region.x > scan.pageImage.widthPixels - scan.region.width
    || scan.region.y > scan.pageImage.heightPixels - scan.region.height)) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: 'Region outside rendered page' })
  }
  if (scan.review && Date.parse(scan.review.reviewedAt) < Date.parse(scan.transcription.recordedAt)) {
    ctx.addIssue({ code: 'custom', path: ['review', 'reviewedAt'], message: 'Review predates transcription' })
  }
})
export type SurveyScannedPdfEvidenceV1 = z.infer<typeof SurveyScannedPdfEvidenceV1>

export const SurveyStandardSourceV1 = z.discriminatedUnion('kind', [
  z.object({ ...sourceFields, kind: z.enum(['official-metadata', 'full-text']), sha256: digest.optional(),
    excerpt: z.object({ byteOffset: z.number().int().nonnegative(), byteLength: z.number().int().positive(), sha256: digest
    }).strict().optional(), scan: z.never().optional()
  }).strict(),
  z.object({ ...sourceFields, kind: z.literal('scanned-pdf'), sha256: digest,
    scan: SurveyScannedPdfEvidenceV1, excerpt: z.never().optional()
  }).strict()
])
export type SurveyStandardSourceV1 = z.infer<typeof SurveyStandardSourceV1>

/** Descriptive registration is permitted without licensing or acquiring full text. */
export const SurveyStandardRuleV1 = SurveyStandardRuleRefV1.extend({
  schemaVersion: z.literal(1),
  locator: z.object({ clause: identity, table: identity.optional() }).strict().optional(),
  source: SurveyStandardSourceV1,
  scope: z.object({
    taskTypes: z.array(identity).min(1), grades: z.array(identity).min(1), jurisdictions: z.array(identity).min(1)
  }).strict(),
  effectiveFrom: timestamp.optional(), effectiveUntil: timestamp.optional(),
  assertion: z.object({
    metric: identity, unit: identity, operator: z.enum(['lte', 'gte', 'abs-lte']), threshold: z.number().finite()
  }).strict().optional()
}).strict().refine(rule => !rule.effectiveFrom || !rule.effectiveUntil
  || Date.parse(rule.effectiveFrom) < Date.parse(rule.effectiveUntil), 'Invalid effective interval')
export type SurveyStandardRuleV1 = z.infer<typeof SurveyStandardRuleV1>

export const SurveyRuleContextV1 = z.object({
  taskType: identity, grade: identity, jurisdiction: identity, at: timestamp,
  metric: identity, unit: identity, value: z.number().finite()
}).strict()
export type SurveyRuleContextV1 = z.infer<typeof SurveyRuleContextV1>

export const SurveyQualityEventV1 = z.object({
  schemaVersion: z.literal(1), id: identity, projectId: identity, artifactSha256: digest,
  sequence: z.number().int().positive(), previousHash: digest, thisHash: digest,
  occurredAt: timestamp,
  actor: z.object({ id: identity, kind: z.enum(['human', 'agent', 'system']) }).strict(),
  // Local process labels only; this schema does not assert a normative stage order.
  stage: identity,
  event: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('check'), checkId: identity, rule: SurveyStandardRuleRefV1.optional(),
      outcome: z.enum(['passed', 'failed', 'not-evaluated']), evidenceSha256: digest }).strict(),
    // Repeat a logical check against explicit bytes without rewriting its original record.
    z.object({ kind: z.literal('artifact-check'), checkId: identity, checkedArtifactSha256: digest,
      rule: SurveyStandardRuleRefV1.optional(), outcome: z.enum(['passed', 'failed', 'not-evaluated']),
      evidenceSha256: digest }).strict(),
    z.object({ kind: z.literal('issue-opened'), issueId: identity, checkId: identity,
      evidenceSha256: digest }).strict(),
    z.object({ kind: z.literal('correction-recorded'), issueId: identity, correctionId: identity,
      correctedArtifactSha256: digest, evidenceSha256: digest }).strict(),
    z.object({ kind: z.literal('issue-rechecked'), issueId: identity, correctionId: identity,
      recheckedArtifactSha256: digest, outcome: z.enum(['resolved', 'unresolved']), evidenceSha256: digest }).strict()
  ])
}).strict()
export type SurveyQualityEventV1 = z.infer<typeof SurveyQualityEventV1>

/** Persist independently to detect replacement of a whole chain or truncation of its tail. */
export const SurveyQualityCheckpointV1 = z.object({
  projectId: identity, artifactSha256: digest, eventCount: z.number().int().nonnegative(), headHash: digest
}).strict()
export type SurveyQualityCheckpointV1 = z.infer<typeof SurveyQualityCheckpointV1>

/** Required checks and checkpoint must come from an independently retained project plan. */
export const SurveyFinalArtifactCoverageRequestV1 = z.object({
  schemaVersion: z.literal(1), projectId: identity, finalArtifactSha256: digest,
  requiredCheckIds: z.array(identity).min(1).refine(ids => new Set(ids).size === ids.length, 'Duplicate required check ID'),
  checkpoint: SurveyQualityCheckpointV1
}).strict()
export type SurveyFinalArtifactCoverageRequestV1 = z.infer<typeof SurveyFinalArtifactCoverageRequestV1>

export const SurveyFinalArtifactCoverageV1 = z.object({
  schemaVersion: z.literal(1), projectId: identity, finalArtifactSha256: digest,
  assessmentBasis: z.literal('recorded-events-only'),
  coverageStatus: z.enum(['covered', 'incomplete', 'not-evaluated']),
  recordIntegrity: z.boolean(), reasons: z.array(z.string()),
  checks: z.array(z.object({
    checkId: identity,
    status: z.enum(['passed', 'failed', 'not-evaluated', 'missing', 'artifact-mismatch', 'stale-after-correction']),
    eventId: identity.optional(), sequence: z.number().int().positive().optional(),
    checkedArtifactSha256: digest.optional(), evidenceSha256: digest.optional()
  }).strict()),
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated')
}).strict()
export type SurveyFinalArtifactCoverageV1 = z.infer<typeof SurveyFinalArtifactCoverageV1>
