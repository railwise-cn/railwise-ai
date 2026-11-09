import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3'
import {
  ContextBundleSchema,
  ContextObjectRefSchema,
  HandoffPacketSchema,
  TaskSourceEventSchema,
  TaskSubscriptionSchema,
  makeTaskSourceEvent,
  screenTaskSourceEvent,
  stableContextStringify,
  type ContextBundle,
  type ContextObjectRef,
  type HandoffPacket,
  type TaskSourceEvent,
  type TaskSourceEventInput,
  type TaskSourceRule,
  type TaskSubscription
} from '../contracts/task-context.js'

export class TaskContextRevisionConflictError extends Error {
  readonly code = 'task_context_revision_conflict'
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`task context revision conflict: expected ${expectedRevision}, actual ${actualRevision}`)
  }
}

export class SourceEventIdempotencyConflictError extends Error {
  readonly code = 'source_event_idempotency_conflict'
  constructor(readonly source: string, readonly idempotencyKey: string) {
    super(`source event idempotency key is bound to a different request: ${source}/${idempotencyKey}`)
  }
}

export type ContextObjectInput = {
  kind: string
  mediaType?: string
  data: string | Buffer
  source?: ContextBundle['documents'][number]
}

export type SourceEventIngestResult = {
  event: TaskSourceEvent
  created: boolean
  subscriptions: TaskSubscription[]
}

export class TaskContextRepository {
  private readonly db: BetterSqliteDatabase
  private readonly objectRoot: string
  private readonly nowIso: () => string
  private readonly inlineLimitBytes: number
  private readonly ownsDatabase: boolean

  constructor(path: string | BetterSqliteDatabase, options: { nowIso?: () => string; inlineLimitBytes?: number; objectRoot?: string } = {}) {
    const sqlitePath = typeof path === 'string' ? (path === ':memory:' ? path : resolve(path)) : ':memory:'
    if (sqlitePath !== ':memory:') mkdirSync(dirname(sqlitePath), { recursive: true })
    this.ownsDatabase = typeof path === 'string'
    this.db = typeof path === 'string' ? new Database(sqlitePath) : path
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.inlineLimitBytes = Math.max(1, options.inlineLimitBytes ?? 8 * 1024)
    this.objectRoot = options.objectRoot
      ? resolve(options.objectRoot)
      : sqlitePath === ':memory:'
        ? join(tmpdir(), `workwise-task-context-${randomUUID()}`)
        : join(dirname(sqlitePath), `${basename(sqlitePath)}.objects`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_context_bundles (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_context_bundles_task ON task_context_bundles(task_id, updated_at);
      CREATE TABLE IF NOT EXISTS task_handoff_packets (
        id TEXT PRIMARY KEY,
        from_task_id TEXT NOT NULL,
        to_task_id TEXT,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_handoff_packets_from ON task_handoff_packets(from_task_id, updated_at);
      CREATE INDEX IF NOT EXISTS task_handoff_packets_to ON task_handoff_packets(to_task_id, updated_at);
      CREATE TABLE IF NOT EXISTS task_source_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE(source, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS task_source_events_status ON task_source_events(status, received_at);
      CREATE TABLE IF NOT EXISTS task_subscriptions (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_subscriptions_source ON task_subscriptions(source, enabled);
      CREATE TABLE IF NOT EXISTS task_source_deliveries (
        event_id TEXT NOT NULL, worker_id TEXT NOT NULL, task_id TEXT NOT NULL,
        input_id TEXT, status TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(event_id, worker_id)
      );
      CREATE TABLE IF NOT EXISTS task_assignments (
        id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
        status TEXT NOT NULL, data_json TEXT NOT NULL
      );
    `)
  }

  close(): void { if (this.ownsDatabase) this.db.close() }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)() }

  putContextObject(input: ContextObjectInput): ContextObjectRef {
    const bytes = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const objectId = `context_object_${sha256.slice(0, 24)}`
    const source = input.source
    if (bytes.byteLength <= this.inlineLimitBytes) {
      return ContextObjectRefSchema.parse({
        objectId, kind: input.kind, mediaType: input.mediaType ?? 'text/plain', sizeBytes: bytes.byteLength,
        sha256, storage: 'inline', encoding: 'base64', inlineData: bytes.toString('base64'), ...(source ? { source } : {})
      })
    }
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 })
    const spillPath = `${objectId}.bin`
    const target = this.safeObjectPath(spillPath)
    if (!existsSync(target)) writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' })
    else if (createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) throw new Error(`context object integrity check failed: ${objectId}`)
    return ContextObjectRefSchema.parse({
      objectId, kind: input.kind, mediaType: input.mediaType ?? 'application/octet-stream', sizeBytes: bytes.byteLength,
      sha256, storage: 'spill', encoding: 'base64', spillPath, ...(source ? { source } : {})
    })
  }

  readContextObject(reference: ContextObjectRef): Buffer {
    const parsed = ContextObjectRefSchema.parse(reference)
    if (parsed.objectId !== `context_object_${parsed.sha256.slice(0, 24)}`) throw new Error(`context object identity check failed: ${parsed.objectId}`)
    const bytes = parsed.storage === 'inline'
      ? Buffer.from(parsed.inlineData!, parsed.encoding)
      : readFileSync(this.safeObjectPath(parsed.spillPath!))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== parsed.sha256 || bytes.byteLength !== parsed.sizeBytes) throw new Error(`context object integrity check failed: ${parsed.objectId}`)
    return bytes
  }

  saveContextBundle(bundle: ContextBundle, expectedRevision?: number): ContextBundle {
    const parsed = ContextBundleSchema.parse(bundle)
    const { contentHash, ...hashInput } = parsed
    if (contextBundleHash(hashInput) !== contentHash) throw new Error(`context bundle content hash mismatch: ${parsed.id}`)
    return this.db.transaction(() => {
      const prior = this.getContextBundle(parsed.id)
      if (!prior) {
        const first = ContextBundleSchema.parse({ ...parsed, revision: 0, updatedAt: parsed.updatedAt || this.nowIso() })
        this.db.prepare('INSERT INTO task_context_bundles(id, task_id, revision, updated_at, data_json) VALUES (?, ?, ?, ?, ?)').run(first.id, first.taskId, first.revision, first.updatedAt, JSON.stringify(first))
        return first
      }
      if (expectedRevision === undefined || prior.revision !== expectedRevision) throw new TaskContextRevisionConflictError(expectedRevision ?? -1, prior.revision)
      const nextData = { ...parsed, revision: prior.revision + 1, createdAt: prior.createdAt, updatedAt: this.nowIso() }
      const { contentHash: _oldHash, ...hashData } = nextData
      const next = ContextBundleSchema.parse({ ...hashData, contentHash: contextBundleHash(hashData) })
      const result = this.db.prepare('UPDATE task_context_bundles SET revision = ?, updated_at = ?, data_json = ? WHERE id = ? AND revision = ?').run(next.revision, next.updatedAt, JSON.stringify(next), next.id, prior.revision)
      if (result.changes !== 1) throw new TaskContextRevisionConflictError(expectedRevision, this.getContextBundle(next.id)?.revision ?? prior.revision)
      return next
    })()
  }

  getContextBundle(id: string): ContextBundle | null {
    const row = this.db.prepare('SELECT data_json FROM task_context_bundles WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? ContextBundleSchema.parse(JSON.parse(row.data_json)) : null
  }

  listContextBundles(taskId: string): ContextBundle[] {
    return (this.db.prepare('SELECT data_json FROM task_context_bundles WHERE task_id = ? ORDER BY updated_at DESC, rowid DESC').all(taskId) as Array<{ data_json: string }>).map(row => ContextBundleSchema.parse(JSON.parse(row.data_json)))
  }

  latestContextBundleForTurn(taskId: string, turnId: string): ContextBundle | null {
    // Invalidating an older bundle updates updated_at. Only insertion order
    // reflects which original model request was most recently prepared.
    const prefix = `context_${turnId}_`
    const row = this.db.prepare('SELECT data_json FROM task_context_bundles WHERE task_id=? AND substr(id,1,?)=? ORDER BY rowid DESC LIMIT 1').get(taskId, prefix.length, prefix) as { data_json: string } | undefined
    return row ? ContextBundleSchema.parse(JSON.parse(row.data_json)) : null
  }

  markSourceChanged(path: string, currentHash: string, workspaceRoot: string): ContextBundle[] {
    return this.markSourceVersion({ path, sha256: currentHash, workspaceRoot }, workspaceRoot)
  }

  markSourceVersion(current: ContextBundle['documents'][number], workspaceRoot: string): ContextBundle[] {
    const changed: ContextBundle[] = []
    const rows = this.db.prepare('SELECT data_json FROM task_context_bundles').all() as Array<{ data_json: string }>
    for (const row of rows) {
      const bundle = ContextBundleSchema.parse(JSON.parse(row.data_json))
      if (bundle.workspaceRoot !== workspaceRoot || !bundle.documents.some(source => source.path === current.path && (current.sha256 ? source.sha256 !== current.sha256 : current.revision && source.revision !== current.revision))) continue
      if (bundle.stale && bundle.staleSources?.includes(current.path)) continue
      const next = { ...bundle, stale: true, staleSources: [...new Set([...(bundle.staleSources ?? []), current.path])] }
      const { contentHash: _old, ...hashData } = next
      changed.push(this.saveContextBundle({ ...hashData, contentHash: contextBundleHash(hashData) }, bundle.revision))
    }
    return changed
  }

  saveAssignment(assignment: ContextTaskAssignment): void {
    this.db.prepare('INSERT INTO task_assignments(id,parent_task_id,child_task_id,status,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json').run(assignment.id, assignment.parentTaskId, assignment.childTaskId, assignment.status, JSON.stringify(assignment))
  }
  getAssignment(childTaskId: string): ContextTaskAssignment | null {
    const row = this.db.prepare('SELECT data_json FROM task_assignments WHERE child_task_id=?').get(childTaskId) as { data_json: string } | undefined
    return row ? JSON.parse(row.data_json) as ContextTaskAssignment : null
  }

  getSourceDelivery(eventId: string, workerId: string): SourceDelivery | null {
    const row = this.db.prepare('SELECT data_json FROM task_source_deliveries WHERE event_id=? AND worker_id=?').get(eventId, workerId) as { data_json: string } | undefined
    return row ? JSON.parse(row.data_json) as SourceDelivery : null
  }
  saveSourceDelivery(delivery: SourceDelivery): void {
    this.db.prepare('INSERT INTO task_source_deliveries(event_id,worker_id,task_id,input_id,status,data_json) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,worker_id) DO UPDATE SET input_id=excluded.input_id,status=excluded.status,data_json=excluded.data_json').run(delivery.eventId, delivery.workerId, delivery.taskId, delivery.inputId ?? null, delivery.status, JSON.stringify(delivery))
  }
  listSourceDeliveries(eventId: string): SourceDelivery[] {
    return (this.db.prepare('SELECT data_json FROM task_source_deliveries WHERE event_id=?').all(eventId) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json) as SourceDelivery)
  }

  saveHandoffPacket(packet: HandoffPacket, expectedRevision?: number): HandoffPacket {
    const parsed = HandoffPacketSchema.parse(packet)
    return this.db.transaction(() => {
      const prior = this.getHandoffPacket(parsed.id)
      if (!prior) {
        const first = HandoffPacketSchema.parse({ ...parsed, revision: 0, updatedAt: parsed.updatedAt || this.nowIso() })
        this.db.prepare('INSERT INTO task_handoff_packets(id, from_task_id, to_task_id, revision, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)').run(first.id, first.fromTaskId, first.toTaskId ?? null, first.revision, first.updatedAt, JSON.stringify(first))
        return first
      }
      if (expectedRevision === undefined || prior.revision !== expectedRevision) throw new TaskContextRevisionConflictError(expectedRevision ?? -1, prior.revision)
      const next = HandoffPacketSchema.parse({ ...parsed, revision: prior.revision + 1, createdAt: prior.createdAt, updatedAt: this.nowIso() })
      const result = this.db.prepare('UPDATE task_handoff_packets SET revision = ?, updated_at = ?, data_json = ? WHERE id = ? AND revision = ?').run(next.revision, next.updatedAt, JSON.stringify(next), next.id, prior.revision)
      if (result.changes !== 1) throw new TaskContextRevisionConflictError(expectedRevision, this.getHandoffPacket(next.id)?.revision ?? prior.revision)
      return next
    })()
  }

  getHandoffPacket(id: string): HandoffPacket | null {
    const row = this.db.prepare('SELECT data_json FROM task_handoff_packets WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? HandoffPacketSchema.parse(JSON.parse(row.data_json)) : null
  }

  listHandoffPackets(taskId: string): HandoffPacket[] {
    return (this.db.prepare('SELECT data_json FROM task_handoff_packets WHERE from_task_id = ? OR to_task_id = ? ORDER BY updated_at DESC').all(taskId, taskId) as Array<{ data_json: string }>).map(row => HandoffPacketSchema.parse(JSON.parse(row.data_json)))
  }

  saveSubscription(subscription: TaskSubscription, expectedRevision?: number): TaskSubscription {
    const parsed = TaskSubscriptionSchema.parse(subscription)
    return this.db.transaction(() => {
      const prior = this.getSubscription(parsed.id)
      if (!prior) {
        const first = TaskSubscriptionSchema.parse({ ...parsed, revision: 0, updatedAt: parsed.updatedAt || this.nowIso() })
        this.db.prepare('INSERT INTO task_subscriptions(id, worker_id, source, enabled, revision, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(first.id, first.workerId, first.source, first.enabled ? 1 : 0, first.revision, first.updatedAt, JSON.stringify(first))
        return first
      }
      if (expectedRevision === undefined || prior.revision !== expectedRevision) throw new TaskContextRevisionConflictError(expectedRevision ?? -1, prior.revision)
      const next = TaskSubscriptionSchema.parse({ ...parsed, revision: prior.revision + 1, createdAt: prior.createdAt, updatedAt: this.nowIso() })
      const result = this.db.prepare('UPDATE task_subscriptions SET worker_id = ?, source = ?, enabled = ?, revision = ?, updated_at = ?, data_json = ? WHERE id = ? AND revision = ?').run(next.workerId, next.source, next.enabled ? 1 : 0, next.revision, next.updatedAt, JSON.stringify(next), next.id, prior.revision)
      if (result.changes !== 1) throw new TaskContextRevisionConflictError(expectedRevision, this.getSubscription(next.id)?.revision ?? prior.revision)
      return next
    })()
  }

  getSubscription(id: string): TaskSubscription | null {
    const row = this.db.prepare('SELECT data_json FROM task_subscriptions WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? TaskSubscriptionSchema.parse(JSON.parse(row.data_json)) : null
  }

  listSubscriptions(input: { workerId?: string; source?: TaskSourceEvent['source']; enabledOnly?: boolean } = {}): TaskSubscription[] {
    const clauses = ['1 = 1']; const values: Array<string | number> = []
    if (input.workerId) { clauses.push('worker_id = ?'); values.push(input.workerId) }
    if (input.source) { clauses.push('(source = ? OR source = \'*\')'); values.push(input.source) }
    if (input.enabledOnly !== false) clauses.push('enabled = 1')
    const rows = this.db.prepare(`SELECT data_json FROM task_subscriptions WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`).all(...values) as Array<{ data_json: string }>
    return rows.map(row => TaskSubscriptionSchema.parse(JSON.parse(row.data_json)))
  }

  ingestSourceEvent(input: TaskSourceEventInput, rules: readonly TaskSourceRule[] = []): SourceEventIngestResult {
    const screen = screenTaskSourceEvent(input, rules, input.receivedAt ?? this.nowIso())
    const event = makeTaskSourceEvent(input, screen, input.receivedAt ?? this.nowIso())
    return this.db.transaction(() => {
      const priorRow = this.db.prepare('SELECT data_json FROM task_source_events WHERE source = ? AND idempotency_key = ?').get(event.source, event.idempotencyKey) as { data_json: string } | undefined
      if (priorRow) {
        const prior = TaskSourceEventSchema.parse(JSON.parse(priorRow.data_json))
        if (prior.requestHash !== event.requestHash) throw new SourceEventIdempotencyConflictError(event.source, event.idempotencyKey)
        return { event: prior, created: false, subscriptions: this.matchingSubscriptions(prior) }
      }
      this.db.prepare('INSERT INTO task_source_events(id, source, idempotency_key, request_hash, status, received_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.id, event.source, event.idempotencyKey, event.requestHash, event.status, event.receivedAt, JSON.stringify(event))
      return { event, created: true, subscriptions: this.matchingSubscriptions(event) }
    })()
  }

  getSourceEvent(id: string): TaskSourceEvent | null {
    const row = this.db.prepare('SELECT data_json FROM task_source_events WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? TaskSourceEventSchema.parse(JSON.parse(row.data_json)) : null
  }

  listSourceEvents(input: { status?: TaskSourceEvent['status']; source?: TaskSourceEvent['source']; limit?: number } = {}): TaskSourceEvent[] {
    const clauses = ['1 = 1']; const values: Array<string | number> = []
    if (input.status) { clauses.push('status = ?'); values.push(input.status) }
    if (input.source) { clauses.push('source = ?'); values.push(input.source) }
    values.push(Math.max(1, Math.min(input.limit ?? 100, 1_000)))
    const rows = this.db.prepare(`SELECT data_json FROM task_source_events WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC LIMIT ?`).all(...values) as Array<{ data_json: string }>
    return rows.map(row => TaskSourceEventSchema.parse(JSON.parse(row.data_json)))
  }

  markSourceEventQueued(id: string, expectedStatus: TaskSourceEvent['status'] = 'screened'): TaskSourceEvent {
    const event = this.getSourceEvent(id)
    if (!event) throw new Error(`source event not found: ${id}`)
    if (event.status !== expectedStatus && event.status !== 'queued') throw new Error(`source event cannot be queued from ${event.status}`)
    if (event.status === 'queued') return event
    const next = TaskSourceEventSchema.parse({ ...event, status: 'queued' })
    this.db.prepare('UPDATE task_source_events SET status = ?, data_json = ? WHERE id = ? AND status = ?').run(next.status, JSON.stringify(next), id, expectedStatus)
    return this.getSourceEvent(id) ?? next
  }

  markSourceEventConsumed(id: string, expectedStatus: TaskSourceEvent['status'] = 'queued'): TaskSourceEvent {
    const event = this.getSourceEvent(id)
    if (!event) throw new Error(`source event not found: ${id}`)
    if (event.status !== expectedStatus && event.status !== 'consumed') throw new Error(`source event cannot be consumed from ${event.status}`)
    if (event.status === 'consumed') return event
    const next = TaskSourceEventSchema.parse({ ...event, status: 'consumed', consumedAt: this.nowIso() })
    this.db.prepare('UPDATE task_source_events SET status = ?, data_json = ? WHERE id = ? AND status = ?').run(next.status, JSON.stringify(next), id, expectedStatus)
    return this.getSourceEvent(id) ?? next
  }

  matchingSubscriptions(event: TaskSourceEvent): TaskSubscription[] {
    if (event.screening.decision !== 'accepted') return []
    return this.listSubscriptions({ source: event.source, enabledOnly: true }).filter((subscription) => {
      if (subscription.workspaceRoot && subscription.workspaceRoot !== event.workspaceRoot) return false
      if (subscription.resourceKeys?.length && (!event.threadKey || !subscription.resourceKeys.includes(event.threadKey))) return false
      if (!subscription.filter) return true
      return screenTaskSourceEvent({ source: event.source, eventType: event.eventType, subject: event.subject, labels: event.labels, workspaceRoot: event.workspaceRoot, payload: event.payload, payloadBytes: event.payloadBytes }, [subscription.filter]).decision === 'accepted'
    })
  }

  private safeObjectPath(relativePath: string): string {
    const root = resolve(this.objectRoot)
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('context object path escapes storage root')
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('context object storage root must not be a symlink')
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('context object must not be a symlink')
    return target
  }
}

export type SourceDelivery = { eventId: string; workerId: string; taskId: string; inputId?: string; status: 'queued' | 'delivered' | 'consumed'; createdAt: string; consumedAt?: string }
export type ContextTaskAssignment = { id: string; parentTaskId: string; childTaskId: string; sessionId: string; goal: string; acceptance: string[]; authority: HandoffPacket['authority']; contextBundleId?: string; status: 'queued' | 'running' | 'completed' | 'failed'; handoffId?: string }

export function contextBundleHash(input: Omit<ContextBundle, 'contentHash'>): string {
  return createHash('sha256').update(stableContextStringify(input)).digest('hex')
}

