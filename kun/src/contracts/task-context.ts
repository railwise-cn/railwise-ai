import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Versioned references are the only context exchanged between task workers. */
export const TaskContextSchemaVersion = z.literal(1)

export const ContextSourceReferenceSchema = z.object({
  path: z.string().min(1),
  revision: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  location: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  projectId: z.string().min(1).optional()
})
export type ContextSourceReference = z.infer<typeof ContextSourceReferenceSchema>

export const ContextObjectRefSchema = z.object({
  objectId: z.string().min(1),
  kind: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  storage: z.enum(['inline', 'spill']),
  encoding: z.enum(['utf8', 'base64']),
  inlineData: z.string().optional(),
  spillPath: z.string().min(1).optional(),
  source: ContextSourceReferenceSchema.optional()
}).superRefine((value, context) => {
  if (value.storage === 'inline' && value.inlineData === undefined) {
    context.addIssue({ code: 'custom', path: ['inlineData'], message: 'inline objects require inlineData' })
  }
  if (value.storage === 'spill' && value.spillPath === undefined) {
    context.addIssue({ code: 'custom', path: ['spillPath'], message: 'spilled objects require spillPath' })
  }
})
export type ContextObjectRef = z.infer<typeof ContextObjectRefSchema>

export const ContextBundleSchema = z.object({
  schemaVersion: TaskContextSchemaVersion,
  id: z.string().min(1),
  taskId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1),
  projectId: z.string().min(1).optional(),
  documents: z.array(ContextSourceReferenceSchema),
  objects: z.array(ContextObjectRefSchema),
  memoryIds: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  revision: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i)
  ,stale: z.boolean().optional()
  ,staleSources: z.array(z.string()).optional()
})
export type ContextBundle = z.infer<typeof ContextBundleSchema>

export const HandoffPacketSchema = z.object({
  schemaVersion: TaskContextSchemaVersion,
  id: z.string().min(1),
  fromTaskId: z.string().min(1),
  toTaskId: z.string().min(1).optional(),
  contextBundleId: z.string().min(1).optional(),
  conclusion: z.string(),
  evidence: z.array(z.string().min(1)),
  artifactIds: z.array(z.string().min(1)),
  completedOperationIds: z.array(z.string().min(1)),
  remaining: z.array(z.string()),
  blockers: z.array(z.string()),
  authority: z.object({
    workspaceRoot: z.string().min(1),
    toolAllowlist: z.array(z.string()).optional(),
    mcpAllowlist: z.array(z.string()).optional(),
    externalTargets: z.array(z.string()).default([])
  }),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  revision: z.number().int().nonnegative()
})
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>

export const TaskSourceKindSchema = z.enum(['chat', 'email', 'calendar', 'ci', 'pr', 'webhook', 'schedule', 'manual', 'other'])
export type TaskSourceKind = z.infer<typeof TaskSourceKindSchema>

export const TaskSourceRuleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  sources: z.array(TaskSourceKindSchema).min(1),
  eventTypes: z.array(z.string().min(1)).default([]),
  subjectIncludes: z.array(z.string().min(1)).default([]),
  labelsAny: z.array(z.string().min(1)).default([]),
  workspaceRoots: z.array(z.string().min(1)).default([]),
  maxPayloadBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1024 * 1024),
  mode: z.enum(['record_only', 'route']).default('record_only')
})
export type TaskSourceRule = z.infer<typeof TaskSourceRuleSchema>

export const TaskSourceScreeningSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  ruleId: z.string().min(1).optional(),
  reason: z.string().min(1),
  mode: z.enum(['record_only', 'route']).optional(),
  screenedAt: z.string().min(1)
})
export type TaskSourceScreening = z.infer<typeof TaskSourceScreeningSchema>

export const TaskSourceEventSchema = z.object({
  schemaVersion: TaskContextSchemaVersion,
  id: z.string().min(1),
  source: TaskSourceKindSchema,
  externalEventId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  eventType: z.string().min(1).optional(),
  threadKey: z.string().min(1).optional(),
  subject: z.string().optional(),
  labels: z.array(z.string()),
  workspaceRoot: z.string().min(1).optional(),
  payload: z.unknown(),
  payloadBytes: z.number().int().nonnegative(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  screening: TaskSourceScreeningSchema,
  status: z.enum(['screened', 'rejected', 'queued', 'consumed', 'expired']),
  receivedAt: z.string().min(1),
  consumedAt: z.string().min(1).optional()
})
export type TaskSourceEvent = z.infer<typeof TaskSourceEventSchema>

export const TaskSubscriptionSchema = z.object({
  schemaVersion: TaskContextSchemaVersion,
  id: z.string().min(1),
  workerId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  source: z.union([TaskSourceKindSchema, z.literal('*')]),
  filter: TaskSourceRuleSchema.optional(),
  enabled: z.boolean(),
  mode: z.enum(['record_only', 'route']),
  allowedFields: z.array(z.string().min(1)),
  workspaceRoot: z.string().min(1).optional(),
  resourceKeys: z.array(z.string().min(1)).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  revision: z.number().int().nonnegative()
})
export type TaskSubscription = z.infer<typeof TaskSubscriptionSchema>

export type TaskSourceEventInput = {
  source: TaskSourceKind
  externalEventId?: string
  idempotencyKey: string
  eventType?: string
  threadKey?: string
  subject?: string
  labels?: string[]
  workspaceRoot?: string
  payload: unknown
  receivedAt?: string
}

export type SourceScreenResult = {
  decision: TaskSourceScreening['decision']
  ruleId?: string
  reason: string
  mode?: TaskSourceScreening['mode']
}

export function stableContextStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContextStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableContextStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function contextSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function screenTaskSourceEvent(input: Pick<TaskSourceEventInput, 'source' | 'eventType' | 'subject' | 'labels' | 'workspaceRoot' | 'payload'> & { payloadBytes?: number }, rules: readonly TaskSourceRule[], screenedAt = new Date().toISOString()): SourceScreenResult {
  const payloadBytes = input.payloadBytes ?? Buffer.byteLength(stableContextStringify(input.payload), 'utf8')
  const subject = (input.subject ?? '').toLocaleLowerCase()
  const labels = new Set(input.labels ?? [])
  for (const rawCandidate of rules) {
    const parsedCandidate = TaskSourceRuleSchema.safeParse(rawCandidate)
    if (!parsedCandidate.success) continue
    const candidate = parsedCandidate.data
    if (!candidate.enabled || !candidate.sources.includes(input.source)) continue
    if (candidate.eventTypes.length && (!input.eventType || !candidate.eventTypes.includes(input.eventType))) continue
    if (candidate.subjectIncludes.length && !candidate.subjectIncludes.some((part) => subject.includes(part.toLocaleLowerCase()))) continue
    if (candidate.labelsAny.length && !candidate.labelsAny.some((label) => labels.has(label))) continue
    if (candidate.workspaceRoots.length && (!input.workspaceRoot || !candidate.workspaceRoots.includes(input.workspaceRoot))) continue
    if (payloadBytes > candidate.maxPayloadBytes) continue
    return { decision: 'accepted', ruleId: candidate.id, mode: candidate.mode, reason: 'matched deterministic source rule' }
  }
  return { decision: 'rejected', reason: rules.length ? 'no deterministic source rule matched' : 'no source rules configured' }
}

export function makeTaskSourceEvent(input: TaskSourceEventInput, screening: SourceScreenResult, now = input.receivedAt ?? new Date().toISOString()): TaskSourceEvent {
  const labels = [...new Set(input.labels ?? [])].sort()
  const payloadCanonical = stableContextStringify(input.payload)
  const payloadHash = contextSha256(payloadCanonical)
  const requestHash = contextSha256(stableContextStringify({ ...input, labels, receivedAt: undefined }))
  const id = `source_event_${requestHash.slice(0, 24)}`
  return TaskSourceEventSchema.parse({
    schemaVersion: 1,
    id,
    source: input.source,
    ...(input.externalEventId ? { externalEventId: input.externalEventId } : {}),
    idempotencyKey: input.idempotencyKey,
    requestHash,
    ...(input.eventType ? { eventType: input.eventType } : {}),
    ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    labels,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    payload: input.payload,
    payloadBytes: Buffer.byteLength(payloadCanonical, 'utf8'),
    payloadHash,
    screening: { ...screening, screenedAt: now },
    status: screening.decision === 'accepted' ? 'screened' : 'rejected',
    receivedAt: now
  })
}

