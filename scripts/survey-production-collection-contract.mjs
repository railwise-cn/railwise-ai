import { z } from 'zod'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.iso.datetime({ offset: true })
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const COLLECTION_LIMITS = Object.freeze({ contractBytes: 32 * 1024 * 1024,
  evidenceFileBytes: 50 * 1024 * 1024, evidenceTotalBytes: 256 * 1024 * 1024,
  snapshotBytes: 64 * 1024 * 1024 })
const evidenceKinds = ['protocol', 'scope', 'selection-policy', 'population-register', 'authorization',
  'shutdown-receipt', 'event-receipt', 'identity', 'signature-envelope', 'signature-verification', 'revocation']
const baseEvent = z.object({
  id: z.uuid(), taskKey: digest, sequence: count.min(1), occurredAt: timestamp,
  recordedAt: timestamp, evidenceSha256: digest
}).strict()
const events = z.discriminatedUnion('type', [
  baseEvent.extend({ type: z.literal('task-started'), boundary: z.literal('before-first-user-request'), backfilled: z.literal(false) }),
  baseEvent.extend({ type: z.literal('import-attempt-started'), attemptKey: digest, serviceTaskHash: digest.nullable() }),
  baseEvent.extend({ type: z.literal('import-attempt-finished'), attemptKey: digest,
    outcome: z.enum(['returned', 'rejected', 'cancelled']),
    sourceDisposition: z.enum(['adjustment-ready', 'archive-only', 'converter-required', 'gnss-processing-required', 'legacy-unverified']).nullable() }),
  baseEvent.extend({ type: z.literal('formal-signoff-declared'), manifestSha256: digest, bundleSha256: digest,
    inputBindingSha256: digest, actorKey: digest, identityEvidenceSha256: digest,
    authorizationEvidenceSha256: digest, signatureEnvelopeSha256: digest, verificationReceiptSha256: digest,
    intent: z.literal('approve-frozen-delivery'), actorKind: z.literal('human-declared'),
    signatureValidation: z.literal('external-receipt-not-authenticated') }),
  baseEvent.extend({ type: z.literal('signoff-revoked'), signoffEventId: z.uuid(), revocationEvidenceSha256: digest })
])

export const SurveyProductionCollection = z.object({
  schemaVersion: z.literal(1), contract: z.literal('survey-production-collection-v1'),
  cohort: z.enum(['candidate-fixture', 'production']),
  period: z.object({ startInclusive: timestamp, endExclusive: timestamp }).strict(),
  protocol: z.object({ frozenAt: timestamp, historyFrom: timestamp, evidenceSha256: digest,
    scopeSha256: digest, selectionPolicySha256: digest, sourceSystemKey: digest,
    taskUnit: z.literal('predeclared-business-task'), retryPolicy: z.literal('same-task-new-attempt'),
    unknownHistory: z.literal('never-backfill') }).strict(),
  authorization: z.object({ evidenceSha256: digest, grantorKey: digest, custodianKey: digest,
    scopeSha256: digest, purpose: z.literal('aggregate-survey-workflow-metrics'),
    validFrom: timestamp, validUntil: timestamp, revokedAt: timestamp.nullable(),
    authenticity: z.literal('not-authenticated') }).strict().nullable(),
  population: z.object({ registerEvidenceSha256: digest, asOf: timestamp,
    declaredTaskCount: count, unknownTaskCount: count.nullable(),
    coverageClaim: z.enum(['complete-declared', 'partial-declared', 'unknown']),
    members: z.array(z.object({ taskKey: digest, projectKey: digest,
      origin: z.enum(['candidate-fixture', 'production']),
      inclusion: z.enum(['included', 'excluded']),
      exclusionReason: z.enum(['outside-period', 'outside-task-type', 'duplicate-register-entry', 'authorization-withheld']).nullable()
    }).strict()).max(100000) }).strict(),
  extraction: z.object({ capturedAt: timestamp, runtimeCommit: z.string().regex(/^[0-9a-f]{40}$/),
    shutdownEvidenceSha256: digest,
    snapshots: z.object({ engineering: z.object({ sha256: digest, sizeBytes: count.min(1).max(COLLECTION_LIMITS.snapshotBytes) }).strict(),
      survey: z.object({ sha256: digest, sizeBytes: count.min(1).max(COLLECTION_LIMITS.snapshotBytes) }).strict() }).strict()
  }).strict(),
  evidence: z.array(z.object({ sha256: digest, sizeBytes: count.max(COLLECTION_LIMITS.evidenceFileBytes),
    kind: z.enum(evidenceKinds) }).strict()).max(10000),
  events: z.array(events).max(100000)
}).strict()

const time = value => Date.parse(value)
function requireThat(condition, code) { if (!condition) throw new Error(code) }

// Structural consistency is deliberately separate from external identity/trust.
export function validateCollection(value) {
  const parsed = SurveyProductionCollection.safeParse(value)
  requireThat(parsed.success, 'schema-invalid')
  const c = parsed.data, start = time(c.period.startInclusive), end = time(c.period.endExclusive)
  const captured = time(c.extraction.capturedAt)
  requireThat(start < end && end <= captured, 'period-invalid')
  requireThat(time(c.protocol.frozenAt) <= start && time(c.protocol.historyFrom) <= start, 'protocol-not-prospective')
  requireThat(time(c.population.asOf) >= end && time(c.population.asOf) <= captured, 'register-cutoff-invalid')
  const evidence = new Map()
  for (const item of c.evidence) {
    requireThat(!evidence.has(item.sha256), 'evidence-duplicate')
    evidence.set(item.sha256, item)
  }
  requireThat(c.evidence.reduce((sum, item) => sum + item.sizeBytes, 0) <= COLLECTION_LIMITS.evidenceTotalBytes, 'evidence-budget-exceeded')
  const ref = (sha, kind) => requireThat(evidence.get(sha)?.kind === kind, 'evidence-reference-invalid')
  ref(c.protocol.evidenceSha256, 'protocol'); ref(c.protocol.scopeSha256, 'scope')
  ref(c.protocol.selectionPolicySha256, 'selection-policy')
  ref(c.population.registerEvidenceSha256, 'population-register')
  ref(c.extraction.shutdownEvidenceSha256, 'shutdown-receipt')
  if (c.authorization) {
    const a = c.authorization
    ref(a.evidenceSha256, 'authorization')
    requireThat(a.scopeSha256 === c.protocol.scopeSha256, 'authorization-scope-mismatch')
    requireThat(time(a.validFrom) <= start && time(a.validUntil) >= captured
      && time(a.validFrom) < time(a.validUntil), 'authorization-interval-invalid')
    requireThat(a.revokedAt === null || time(a.revokedAt) > captured, 'authorization-revoked')
  }
  const tasks = new Map()
  for (const member of c.population.members) {
    requireThat(!tasks.has(member.taskKey), 'task-duplicate')
    requireThat(member.origin === c.cohort, 'mixed-cohort')
    requireThat((member.inclusion === 'excluded') === (member.exclusionReason !== null), 'exclusion-reason-invalid')
    tasks.set(member.taskKey, { member, start: null, attempts: new Map() })
  }
  requireThat(tasks.size === c.population.declaredTaskCount, 'population-count-mismatch')
  requireThat(c.population.coverageClaim !== 'complete-declared' || c.population.unknownTaskCount === 0, 'unknown-population-hidden')
  const ids = new Set(), attemptKeys = new Set(), signoffs = new Map()
  let previousSequence = 0, previousRecorded = -Infinity
  const countsByType = {}
  for (const event of c.events) {
    requireThat(!ids.has(event.id) && event.sequence > previousSequence, 'event-order-or-identity-invalid')
    ids.add(event.id); previousSequence = event.sequence
    const occurred = time(event.occurredAt), recorded = time(event.recordedAt)
    requireThat(occurred <= recorded && recorded <= captured && recorded >= previousRecorded
      && occurred >= time(c.protocol.historyFrom), 'event-time-invalid')
    previousRecorded = recorded
    ref(event.evidenceSha256, 'event-receipt')
    const task = tasks.get(event.taskKey)
    requireThat(task, 'event-task-outside-register')
    countsByType[event.type] = (countsByType[event.type] ?? 0) + 1
    if (event.type === 'task-started') {
      requireThat(!task.start && occurred >= time(c.protocol.frozenAt), 'first-start-invalid')
      task.start = event
      continue
    }
    requireThat(task.start && occurred >= time(task.start.occurredAt), 'event-before-first-start')
    if (event.type === 'import-attempt-started') {
      requireThat(!attemptKeys.has(event.attemptKey) && occurred >= time(task.start.recordedAt), 'attempt-start-invalid')
      attemptKeys.add(event.attemptKey)
      task.attempts.set(event.attemptKey, { start: event, finish: null })
    } else if (event.type === 'import-attempt-finished') {
      const attempt = task.attempts.get(event.attemptKey)
      requireThat(attempt && !attempt.finish && occurred >= time(attempt.start.recordedAt), 'attempt-finish-invalid')
      requireThat((event.outcome === 'returned') === (event.sourceDisposition !== null), 'import-outcome-invalid')
      attempt.finish = event
    } else if (event.type === 'formal-signoff-declared') {
      ref(event.identityEvidenceSha256, 'identity'); ref(event.authorizationEvidenceSha256, 'authorization')
      ref(event.signatureEnvelopeSha256, 'signature-envelope'); ref(event.verificationReceiptSha256, 'signature-verification')
      // A declared signoff is evidence to review, never a locally granted approval.
      signoffs.set(event.id, { event, revoked: false })
    } else {
      const signoff = signoffs.get(event.signoffEventId)
      requireThat(signoff && !signoff.revoked && signoff.event.taskKey === event.taskKey
        && occurred >= time(signoff.event.occurredAt), 'revocation-binding-invalid')
      ref(event.revocationEvidenceSha256, 'revocation')
      signoff.revoked = true
    }
  }
  const members = [...tasks.values()], included = members.filter(t => t.member.inclusion === 'included')
  return { contract: c, report: {
    schemaVersion: 1, contractValidation: 'structurally-consistent', evidenceByteIntegrity: 'not-checked',
    sourceAuthorization: 'not-authenticated', populationCoverage: 'not-certified',
    humanSignoff: 'not-authenticated', firstStartAuthenticity: 'not-authenticated',
    externalReceiptContent: 'not-interpreted', taskToSnapshotIdentity: 'not-verified',
    productionMetricPromotion: 'prohibited',
    counts: { declaredTasks: tasks.size, included: included.length, excluded: tasks.size - included.length,
      includedWithoutStart: included.filter(t => !t.start).length,
      startsBeforePeriod: included.filter(t => t.start && time(t.start.occurredAt) < start).length,
      startsInPeriod: included.filter(t => t.start && time(t.start.occurredAt) >= start && time(t.start.occurredAt) < end).length,
      incompleteAttemptsAtExtraction: members.reduce((sum, task) => sum + [...task.attempts.values()].filter(a => !a.finish).length, 0),
      eventsByType: countsByType },
    missingDeclarations: [c.authorization === null ? 'collection-authorization' : null,
      c.population.coverageClaim !== 'complete-declared' || c.population.unknownTaskCount !== 0 ? 'complete-population-declaration' : null,
      included.some(t => !t.start) ? 'included-task-first-starts' : null].filter(Boolean),
    boundary: 'Checks declared event/register consistency only. No source authentication, signature validation, production representativeness or KPI success is inferred.'
  } }
}
