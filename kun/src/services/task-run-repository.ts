import { ExecutionStore } from './execution-store.js'
import { inspectProcess } from './process-identity.js'
import { existsSync, mkdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3'
import {
  AttentionItemSchema,
  OperationReceiptSchema,
  TaskInputSchema,
  type AttentionItem,
  type OperationReceipt,
  type RuntimeOutboxItem,
  type TaskInput,
  TaskCheckpointSchema,
  TaskNodeSchema,
  TaskRunSchema,
  ShellSessionSchema,
  RuntimeSpanSchema,
  type TaskCheckpoint,
  type TaskEvent,
  type TaskLease,
  type TaskNode,
  type TaskRun,
  type TaskRunStatus,
  type ShellSession,
  type RuntimeSpan
} from '../contracts/tasks.js'

const TERMINAL_TASK_STATUSES = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])

type TaskRunRow = {
  id: string
  thread_id: string
  status: string
  updated_at: string
  revision: number
  data_json: string
}

type ShellSessionRow = {
  id: string
  task_id: string
  status: string
  updated_at: string
  revision: number
  data_json: string
}

type RuntimeSpanRow = {
  data_json: string
}

export class TaskRevisionConflictError extends Error {
  readonly code = 'stale_request'

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`task revision conflict: expected ${expectedRevision}, actual ${actualRevision}`)
  }
}

export class TaskLeaseLostError extends Error {
  readonly code = 'task_lease_lost'

  constructor(readonly taskId: string) {
    super(`task lease is no longer owned: ${taskId}`)
  }
}

export type TaskLeaseGuard = {
  ownerId: string
  leaseRevision: number
  nowIso: string
}

export class TaskRunRepository {
  private readonly db: BetterSqliteDatabase
  readonly execution: ExecutionStore
  private readonly changeListeners = new Set<() => void>()
  private notificationQueued = false

  constructor(path: string) {
    const sqlitePath = resolve(path)
    mkdirSync(dirname(sqlitePath), { recursive: true })
    this.db = new Database(sqlitePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const existingTasks = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_runs'").get())
    this.migrate()
    this.migrateDurable(sqlitePath, existingTasks)
    this.execution = new ExecutionStore(this.db, sqlitePath)
  }

  sharedDatabase(): BetterSqliteDatabase { return this.db }
  connection(): BetterSqliteDatabase { return this.db }
  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener) }
  notifyChange(): void {
    if (this.db.inTransaction || this.notificationQueued) return
    this.notificationQueued = true
    queueMicrotask(() => { this.notificationQueued = false; for (const listener of this.changeListeners) { try { listener() } catch { /* observers cannot roll back committed state */ } } })
  }

  close(): void {
    this.db.close()
  }

  create(task: TaskRun): TaskRun {
    const parsed = TaskRunSchema.parse(task)
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_runs(id, thread_id, status, updated_at, revision, data_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(parsed.id, parsed.threadId, parsed.status, parsed.updatedAt, parsed.revision, JSON.stringify(parsed))
      this.replaceNodes(parsed)
      this.appendEventInternal(parsed.id, `task-created:${parsed.id}`, 'task_created', { status: parsed.status }, parsed.createdAt)
    })
    return parsed
  }

  get(taskId: string): TaskRun | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(taskId) as TaskRunRow | undefined
    return row ? this.parseRun(row) : null
  }

  /** The visible root keeps its identity while controls target the latest retry. */
  currentExecution(taskId:string):TaskRun|null {
    let task=this.get(taskId)
    const seen=new Set<string>()
    while(task&&!seen.has(task.id)) {
      seen.add(task.id)
      const row=this.db.prepare("SELECT * FROM task_runs WHERE json_extract(data_json,'$.retryOfTaskId')=? ORDER BY json_extract(data_json,'$.createdAt') DESC,id DESC LIMIT 1").get(task.id) as TaskRunRow|undefined
      if(!row)break
      task=this.parseRun(row)
    }
    return task
  }

  findActiveByThread(threadId: string): TaskRun | null {
    const row = this.db.prepare(`
      SELECT * FROM task_runs
      WHERE thread_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY updated_at DESC LIMIT 1
    `).get(threadId) as TaskRunRow | undefined
    return row ? this.parseRun(row) : null
  }

  findByTurn(turnId:string):TaskRun|null {
    const row=this.db.prepare("SELECT * FROM task_runs WHERE json_extract(data_json,'$.activeTurnId')=? ORDER BY updated_at DESC,id DESC LIMIT 1").get(turnId) as TaskRunRow|undefined
    return row?this.parseRun(row):null
  }

  findActiveByOrigin(threadId: string): TaskRun | null {
    const row = this.db.prepare(`SELECT * FROM task_runs
      WHERE (thread_id = ? OR json_extract(data_json,'$.originThreadId') = ?)
      AND status NOT IN ('completed','failed','cancelled')
      AND json_extract(data_json,'$.parentTaskId') IS NULL
      AND COALESCE(json_extract(data_json,'$.visibility'),'task') NOT IN ('chat','internal')
      ORDER BY updated_at DESC,id DESC LIMIT 1`).get(threadId,threadId) as TaskRunRow | undefined
    return row ? this.parseRun(row) : null
  }

  list(input: { threadId?: string; workspaceRoot?: string; search?: string; status?: TaskRunStatus; limit?: number; offset?: number; cursor?: string } = {}): TaskRun[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (input.threadId) {
      clauses.push('thread_id = ?')
      values.push(input.threadId)
    }
    if (input.status) {
      clauses.push('status = ?')
      values.push(input.status)
    }
    if (input.workspaceRoot) {
      clauses.push("json_extract(data_json, '$.workspaceRoot') = ?")
      values.push(resolve(input.workspaceRoot))
    }
    if (input.search?.trim()) {
      clauses.push("instr(lower(json_extract(data_json, '$.goal')), lower(?)) > 0")
      values.push(input.search.trim())
    }
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { updatedAt?: string; id?: string }
        if (typeof decoded.updatedAt !== 'string' || typeof decoded.id !== 'string' || !decoded.updatedAt || !decoded.id) {
          throw new Error('invalid task cursor')
        }
        clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
        values.push(decoded.updatedAt, decoded.updatedAt, decoded.id)
      } catch {
        throw Object.assign(new Error('invalid task cursor'), { code: 'invalid_cursor' })
      }
    }
    values.push(Math.max(1, Math.min(input.limit ?? 100, 500)), Math.max(0, Math.trunc(input.offset ?? 0)))
    const rows = this.db.prepare(`
      SELECT * FROM task_runs
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...values) as TaskRunRow[]
    return rows.map((row) => this.parseRun(row))
  }

  update(
    taskId: string,
    expectedRevision: number,
    mutator: (current: TaskRun) => TaskRun,
    event?: { key: string; kind: string; payload?: Record<string, unknown>; createdAt?: string },
    leaseGuard?: TaskLeaseGuard
  ): TaskRun {
    return this.transaction(() => {
      if (leaseGuard && !this.hasLease(leaseGuard, taskId)) {
        throw new TaskLeaseLostError(taskId)
      }
      const current = this.get(taskId)
      if (!current) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'not_found' })
      if (current.revision !== expectedRevision) {
        throw new TaskRevisionConflictError(expectedRevision, current.revision)
      }
      const candidate = mutator(current)
      if (TERMINAL_TASK_STATUSES.has(current.status) && candidate.status !== current.status) {
        throw Object.assign(new Error(`terminal task cannot transition from ${current.status}`), {
          code: 'invalid_state'
        })
      }
      const next = TaskRunSchema.parse({
        ...candidate,
        id: current.id,
        threadId: current.threadId,
        createdAt: current.createdAt,
        revision: current.revision + 1
      })
      const result = this.db.prepare(`
        UPDATE task_runs SET status = ?, updated_at = ?, revision = ?, data_json = ?
        WHERE id = ? AND revision = ?
      `).run(next.status, next.updatedAt, next.revision, JSON.stringify(next), taskId, expectedRevision)
      if (result.changes !== 1) {
        const actual = this.get(taskId)?.revision ?? expectedRevision
        throw new TaskRevisionConflictError(expectedRevision, actual)
      }
      this.replaceNodes(next)
      if (event) {
        this.appendEventInternal(
          taskId,
          event.key,
          event.kind,
          event.payload ?? {},
          event.createdAt ?? next.updatedAt
        )
      }
      return next
    })
  }

  saveCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
    const parsed = TaskCheckpointSchema.parse(checkpoint)
    this.db.prepare(`
      INSERT INTO task_checkpoints(id, task_id, created_at, revision, data_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        revision = excluded.revision,
        data_json = excluded.data_json
      WHERE excluded.revision >= task_checkpoints.revision
    `).run(parsed.id, parsed.taskId, parsed.createdAt, parsed.revision, JSON.stringify(parsed))
    return parsed
  }

  latestCheckpoint(taskId: string): TaskCheckpoint | null {
    const row = this.db.prepare(`
      SELECT data_json FROM task_checkpoints WHERE task_id = ?
      ORDER BY created_at DESC, revision DESC LIMIT 1
    `).get(taskId) as { data_json: string } | undefined
    return row ? TaskCheckpointSchema.parse(JSON.parse(row.data_json)) : null
  }

  events(taskId: string, afterSequence = 0): TaskEvent[] {
    const rows = this.db.prepare(`
      SELECT task_id, sequence, event_key, kind, payload_json, created_at
      FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(taskId, afterSequence) as Array<{
      task_id: string
      sequence: number
      event_key: string
      kind: string
      payload_json: string
      created_at: string
    }>
    return rows.map((row) => ({
      taskId: row.task_id,
      sequence: row.sequence,
      eventKey: row.event_key,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    }))
  }

  acquireLease(taskId: string, ownerId: string, nowIso: string, expiresAt: string): TaskLease | null {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM task_leases WHERE task_id = ?').get(taskId) as {
        task_id: string
        owner_id: string
        acquired_at: string
        expires_at: string
        revision: number
      } | undefined
      if (existing && existing.owner_id !== ownerId && existing.expires_at > nowIso) return null
      const nextRevision = (existing?.revision ?? -1) + 1
      this.db.prepare(`
        INSERT INTO task_leases(task_id, owner_id, acquired_at, expires_at, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          revision = excluded.revision
      `).run(taskId, ownerId, nowIso, expiresAt, nextRevision)
      return { taskId, ownerId, acquiredAt: nowIso, expiresAt, revision: nextRevision }
    })
  }

  renewLease(taskId: string, ownerId: string, leaseRevision: number, nowIso: string, expiresAt: string): TaskLease | null {
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT acquired_at FROM task_leases
        WHERE task_id = ? AND owner_id = ? AND revision = ? AND expires_at > ?
      `).get(taskId, ownerId, leaseRevision, nowIso) as { acquired_at: string } | undefined
      if (!current) return null
      const result = this.db.prepare(`
        UPDATE task_leases
        SET expires_at = ?
        WHERE task_id = ? AND owner_id = ? AND revision = ? AND expires_at > ?
      `).run(expiresAt, taskId, ownerId, leaseRevision, nowIso)
      if (result.changes !== 1) return null
      return { taskId, ownerId, acquiredAt: current.acquired_at, expiresAt, revision: leaseRevision }
    })
  }

  releaseLease(taskId: string, ownerId: string, leaseRevision?: number): boolean {
    const result = leaseRevision === undefined
      ? this.db.prepare("UPDATE task_leases SET expires_at='1970-01-01T00:00:00.000Z' WHERE task_id = ? AND owner_id = ?").run(taskId, ownerId)
      : this.db.prepare("UPDATE task_leases SET expires_at='1970-01-01T00:00:00.000Z' WHERE task_id = ? AND owner_id = ? AND revision = ?").run(taskId, ownerId, leaseRevision)
    return result.changes === 1
  }

  getLease(taskId: string): TaskLease | null {
    const row = this.db.prepare('SELECT * FROM task_leases WHERE task_id = ?').get(taskId) as {
      task_id: string
      owner_id: string
      acquired_at: string
      expires_at: string
      revision: number
    } | undefined
    return row
      ? { taskId: row.task_id, ownerId: row.owner_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at, revision: row.revision }
      : null
  }

  hasLease(guard: TaskLeaseGuard, taskId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS owned FROM task_leases
      WHERE task_id = ? AND owner_id = ? AND revision = ? AND expires_at > ?
    `).get(taskId, guard.ownerId, guard.leaseRevision, guard.nowIso) as { owned: number } | undefined
    return row?.owned === 1
  }

  reconcileExpired(nowIso: string): TaskRun[] {
    const rows = this.db.prepare(`
      SELECT r.* FROM task_runs r
      LEFT JOIN task_leases l ON l.task_id = r.id
      WHERE (r.status IN ('running', 'retrying') OR (r.status='queued' AND json_extract(r.data_json,'$.originThreadId') IS NOT NULL)) AND (l.task_id IS NULL OR l.expires_at <= ?)
    `).all(nowIso) as TaskRunRow[]
    return rows.map((row) => this.parseRun(row))
  }

  createShellSession(session: ShellSession): ShellSession {
    const parsed = ShellSessionSchema.parse(session)
    this.db.prepare(`
      INSERT INTO shell_sessions(id, task_id, status, updated_at, revision, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id,
      parsed.taskId,
      parsed.status,
      parsed.startedAt ?? parsed.createdAt,
      parsed.revision,
      JSON.stringify(parsed)
    )
    return parsed
  }

  getShellSession(sessionId: string): ShellSession | null {
    const row = this.db.prepare('SELECT * FROM shell_sessions WHERE id = ?').get(sessionId) as ShellSessionRow | undefined
    return row ? ShellSessionSchema.parse(JSON.parse(row.data_json)) : null
  }

  listShellSessions(taskId?: string): ShellSession[] {
    const rows = (taskId
      ? this.db.prepare('SELECT * FROM shell_sessions WHERE task_id = ? ORDER BY updated_at DESC').all(taskId)
      : this.db.prepare('SELECT * FROM shell_sessions ORDER BY updated_at DESC LIMIT 500').all()) as ShellSessionRow[]
    return rows.map((row) => ShellSessionSchema.parse(JSON.parse(row.data_json)))
  }

  updateShellSession(
    sessionId: string,
    expectedRevision: number,
    mutator: (current: ShellSession) => ShellSession
  ): ShellSession {
    return this.transaction(() => {
      const current = this.getShellSession(sessionId)
      if (!current) throw Object.assign(new Error(`shell session not found: ${sessionId}`), { code: 'not_found' })
      if (current.revision !== expectedRevision) throw new TaskRevisionConflictError(expectedRevision, current.revision)
      const next = ShellSessionSchema.parse({
        ...mutator(current),
        id: current.id,
        taskId: current.taskId,
        createdAt: current.createdAt,
        revision: current.revision + 1
      })
      const updatedAt = next.finishedAt ?? next.startedAt ?? next.createdAt
      const result = this.db.prepare(`
        UPDATE shell_sessions SET status = ?, updated_at = ?, revision = ?, data_json = ?
        WHERE id = ? AND revision = ?
      `).run(next.status, updatedAt, next.revision, JSON.stringify(next), sessionId, expectedRevision)
      if (result.changes !== 1) throw new TaskRevisionConflictError(expectedRevision, this.getShellSession(sessionId)?.revision ?? expectedRevision)
      return next
    })
  }

  reconcileShellSessionsStartup(nowIso: string): ShellSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM shell_sessions WHERE status IN ('starting', 'running')
    `).all() as ShellSessionRow[]
    return rows.map((row) => {
      const current = ShellSessionSchema.parse(JSON.parse(row.data_json))
      return this.updateShellSession(current.id, current.revision, (session) => ({
        ...session,
        status: session.pid && session.processFingerprint && inspectProcess({ pid: session.pid, fingerprint: session.processFingerprint }) === 'exited' ? 'interrupted' : 'outcome_unknown',
        finishedAt: nowIso
      }))
    })
  }

  upsertRuntimeSpan(span: RuntimeSpan): RuntimeSpan {
    const parsed = RuntimeSpanSchema.parse(span)
    this.db.prepare(`
      INSERT INTO runtime_spans(id, task_id, turn_id, kind, status, started_at, finished_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        turn_id = excluded.turn_id,
        kind = excluded.kind,
        status = excluded.status,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        data_json = excluded.data_json
    `).run(
      parsed.id,
      parsed.taskId ?? null,
      parsed.turnId ?? null,
      parsed.kind,
      parsed.status,
      parsed.startedAt,
      parsed.finishedAt ?? null,
      JSON.stringify(parsed)
    )
    return parsed
  }

  getRuntimeSpan(spanId: string): RuntimeSpan | null {
    const row = this.db.prepare('SELECT data_json FROM runtime_spans WHERE id = ?').get(spanId) as RuntimeSpanRow | undefined
    return row ? RuntimeSpanSchema.parse(JSON.parse(row.data_json)) : null
  }

  listRuntimeSpans(input: { taskId?: string; turnId?: string; limit?: number } = {}): RuntimeSpan[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (input.taskId) {
      clauses.push('task_id = ?')
      values.push(input.taskId)
    }
    if (input.turnId) {
      clauses.push('turn_id = ?')
      values.push(input.turnId)
    }
    values.push(Math.max(1, Math.min(input.limit ?? 500, 5_000)))
    const rows = this.db.prepare(`
      SELECT data_json FROM runtime_spans
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY started_at DESC LIMIT ?
    `).all(...values) as RuntimeSpanRow[]
    return rows.map((row) => RuntimeSpanSchema.parse(JSON.parse(row.data_json)))
  }

  pruneRuntimeSpans(beforeIso: string, keepLatest = 5_000): number {
    const old = this.db.prepare('DELETE FROM runtime_spans WHERE started_at < ?').run(beforeIso).changes
    const overflow = this.db.prepare(`
      DELETE FROM runtime_spans WHERE id IN (
        SELECT id FROM runtime_spans ORDER BY started_at DESC LIMIT -1 OFFSET ?
      )
    `).run(Math.max(100, keepLatest)).changes
    return old + overflow
  }

  private replaceNodes(task: TaskRun): void {
    this.db.prepare('DELETE FROM task_nodes WHERE task_id = ?').run(task.id)
    const insert = this.db.prepare(`
      INSERT INTO task_nodes(id, task_id, kind, status, revision, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const rawNode of task.nodes) {
      const node = TaskNodeSchema.parse(rawNode)
      insert.run(node.id, node.taskId, node.kind, node.status, node.revision, JSON.stringify(node))
    }
  }

  private appendEventInternal(
    taskId: string,
    eventKey: string,
    kind: string,
    payload: Record<string, unknown>,
    createdAt: string
  ): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM task_events WHERE task_id = ?')
      .get(taskId) as { seq: number }
    this.db.prepare(`
      INSERT OR IGNORE INTO task_events(task_id, sequence, event_key, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, row.seq + 1, eventKey, kind, JSON.stringify(payload), createdAt)
  }

  private parseRun(row: TaskRunRow): TaskRun {
    return TaskRunSchema.parse(JSON.parse(row.data_json))
  }

  private transaction<T>(fn: () => T): T {
    const result = this.db.transaction(fn)()
    this.notifyChange()
    return result
  }

  /** All callbacks here are synchronous: external I/O must happen after commit. */
  transact<T>(fn: () => T): T { return this.transaction(fn) }

  appendInput(input: { taskId: string; expectedRevision: number; idempotencyKey: string; text: string; kind?: TaskInput['kind']; sourceId?: string; nowIso: string;attachmentIds?:TaskInput['attachmentIds'];workspaceReferences?:TaskInput['workspaceReferences'] }): { input: TaskInput; task: TaskRun } {
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT data_json FROM task_inputs WHERE task_id = ? AND idempotency_key = ?').get(input.taskId, input.idempotencyKey) as { data_json: string } | undefined
      const task = this.get(input.taskId)
      if (!task) throw Object.assign(new Error('task not found'), { code: 'not_found' })
      if (prior) {
        const saved = TaskInputSchema.parse(JSON.parse(prior.data_json))
        if (saved.text !== input.text.trim() || saved.kind !== (input.kind ?? 'supplement') || saved.sourceId !== input.sourceId || operationFingerprint(saved.attachmentIds ?? []) !== operationFingerprint(input.attachmentIds ?? []) || operationFingerprint(saved.workspaceReferences ?? []) !== operationFingerprint(input.workspaceReferences ?? [])) throw Object.assign(new Error('input key is bound to a different request'), { code: 'idempotency_conflict' })
        return { input: saved, task }
      }
      if (TERMINAL_TASK_STATUSES.has(task.status)) throw Object.assign(new Error('cannot append input to a terminal task'), { code: 'invalid_state' })
      const saved = TaskInputSchema.parse({ id: `input_${randomUUID()}`, taskId: task.id, kind: input.kind ?? 'supplement', text: input.text.trim(), idempotencyKey: input.idempotencyKey, sourceId: input.sourceId, createdAt: input.nowIso,attachmentIds:input.attachmentIds,workspaceReferences:input.workspaceReferences })
      const next = this.update(task.id, input.expectedRevision, current => ({ ...current, updatedAt: input.nowIso }), { key: `input:${saved.id}`, kind: 'task_input_received', payload: { inputId: saved.id, kind: saved.kind }, createdAt: input.nowIso })
      this.db.prepare('INSERT INTO task_inputs(id, task_id, idempotency_key, consumed_at, data_json) VALUES (?, ?, ?, NULL, ?)').run(saved.id, task.id, saved.idempotencyKey, JSON.stringify(saved))
      const session = this.execution.ensureSession(next, input.nowIso)
      this.execution.enqueue(saved.id, task.id, session.id)
      return { input: saved, task: next }
    })
  }

  inputs(taskId: string, pendingOnly = false): TaskInput[] {
    const rows = this.db.prepare(`SELECT data_json FROM task_inputs WHERE task_id = ? ${pendingOnly ? 'AND consumed_at IS NULL' : ''} ORDER BY rowid`).all(taskId) as Array<{ data_json: string }>
    return rows.map(row => TaskInputSchema.parse(JSON.parse(row.data_json)))
  }

  consumeInput(inputId: string, nowIso: string): void {
    const row = this.db.prepare('SELECT data_json FROM task_inputs WHERE id = ? AND consumed_at IS NULL').get(inputId) as { data_json: string } | undefined
    if (!row) return
    const input = TaskInputSchema.parse({ ...JSON.parse(row.data_json), consumedAt: nowIso })
    this.db.prepare('UPDATE task_inputs SET consumed_at = ?, data_json = ? WHERE id = ? AND consumed_at IS NULL').run(nowIso, JSON.stringify(input), inputId)
  }

  markInputDelivered(inputId: string, nowIso: string): void {
    const row = this.db.prepare('SELECT data_json FROM task_inputs WHERE id = ? AND consumed_at IS NULL').get(inputId) as { data_json: string } | undefined
    if (!row) return
    const input = TaskInputSchema.parse({ ...JSON.parse(row.data_json), deliveredAt: nowIso })
    this.db.prepare('UPDATE task_inputs SET data_json = ? WHERE id = ? AND consumed_at IS NULL').run(JSON.stringify(input), inputId)
  }

  beginOperation(input: { ownerId: string; idempotencyKey: string; kind: string; request: Record<string, unknown>; nowIso: string }): { receipt: OperationReceipt; created: boolean }
  beginOperation(ownerId: string, idempotencyKey: string, request: Record<string, unknown>, kind?: string): { receipt: OperationReceipt; created: boolean }
  beginOperation(inputOrOwner: { ownerId: string; idempotencyKey: string; kind: string; request: Record<string, unknown>; nowIso: string } | string, legacyKey?: string, legacyRequest?: Record<string, unknown>, legacyKind = 'runtime'): { receipt: OperationReceipt; created: boolean } {
    const input = typeof inputOrOwner === 'string'
      ? { ownerId: inputOrOwner, idempotencyKey: legacyKey!, kind: legacyKind, request: legacyRequest ?? {}, nowIso: new Date().toISOString() }
      : inputOrOwner
    return this.transaction(() => {
      const fingerprint = operationFingerprint(input.request)
      const existing = this.operation(input.ownerId, input.idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.kind !== input.kind) throw Object.assign(new Error('operation key is bound to a different request'), { code: 'idempotency_conflict' })
        return { receipt: existing, created: false }
      }
      const receipt = OperationReceiptSchema.parse({ id: `operation_${randomUUID()}`, ownerId: input.ownerId, idempotencyKey: input.idempotencyKey, kind: input.kind, fingerprint, request: input.request, status: 'prepared', createdAt: input.nowIso, updatedAt: input.nowIso })
      this.db.prepare('INSERT INTO operation_receipts(owner_id, idempotency_key, data_json) VALUES (?, ?, ?)').run(receipt.ownerId, receipt.idempotencyKey, JSON.stringify(receipt))
      return { receipt, created: true }
    })
  }

  operation(ownerId: string, key: string): OperationReceipt | null {
    const row = this.db.prepare('SELECT data_json FROM operation_receipts WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, key) as { data_json: string } | undefined
    return row ? OperationReceiptSchema.parse(JSON.parse(row.data_json)) : null
  }

  finishOperation(ownerId: string, key: string, patch: { status: OperationReceipt['status']; result?: unknown; error?: string }, nowIso?: string): OperationReceipt
  finishOperation(ownerId: string, key: string, status: OperationReceipt['status'], result?: unknown): OperationReceipt
  finishOperation(ownerId: string, key: string, patchOrStatus: { status: OperationReceipt['status']; result?: unknown; error?: string } | OperationReceipt['status'], nowOrResult?: string | unknown): OperationReceipt {
    const previous = this.operation(ownerId, key)
    if (!previous) throw Object.assign(new Error('operation not found'), { code: 'not_found' })
    const patch = typeof patchOrStatus === 'string'
      ? { status: patchOrStatus, result: nowOrResult }
      : patchOrStatus
    const nowIso = typeof patchOrStatus === 'string' ? new Date().toISOString() : (typeof nowOrResult === 'string' ? nowOrResult : new Date().toISOString())
    const next = OperationReceiptSchema.parse({ ...previous, ...patch, updatedAt: nowIso })
    this.db.prepare('UPDATE operation_receipts SET data_json = ? WHERE owner_id = ? AND idempotency_key = ?').run(JSON.stringify(next), ownerId, key)
    return next
  }

  unsettledOperations(ownerId: string): OperationReceipt[] {
    return (this.db.prepare('SELECT data_json FROM operation_receipts WHERE owner_id = ?').all(ownerId) as Array<{ data_json: string }>).map(row => OperationReceiptSchema.parse(JSON.parse(row.data_json))).filter(item => ['running', 'outcome_unknown'].includes(item.status))
  }
  operations(ownerId: string, kind?: string): OperationReceipt[] {
    return (this.db.prepare('SELECT data_json FROM operation_receipts WHERE owner_id=? ORDER BY rowid').all(ownerId) as Array<{data_json:string}>).map(row=>OperationReceiptSchema.parse(JSON.parse(row.data_json))).filter(item=>!kind || item.kind===kind)
  }

  enqueueOutbox(item: Omit<RuntimeOutboxItem, 'attempts'>): void {
    this.db.prepare('INSERT OR IGNORE INTO runtime_outbox(id, owner_id, kind, delivered_at, data_json) VALUES (?, ?, ?, NULL, ?)').run(item.id, item.ownerId, item.kind, JSON.stringify({ ...item, attempts: 0 }))
  }

  pendingOutbox(kind?: string): RuntimeOutboxItem[] {
    return (this.db.prepare(`SELECT data_json FROM runtime_outbox WHERE delivered_at IS NULL ${kind ? 'AND kind = ?' : ''} ORDER BY rowid LIMIT 100`).all(...(kind ? [kind] : [])) as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json) as RuntimeOutboxItem)
  }

  acknowledgeOutbox(id: string, nowIso: string): void {
    this.db.prepare('UPDATE runtime_outbox SET delivered_at = ? WHERE id = ?').run(nowIso, id)
  }

  putAttention(item: AttentionItem): AttentionItem {
    const parsed = AttentionItemSchema.parse(item)
    this.db.prepare('INSERT INTO inbox_items(id, owner_id, status, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json').run(parsed.id, parsed.ownerId, parsed.status, JSON.stringify(parsed))
    this.notifyChange()
    return parsed
  }

  attention(id: string): AttentionItem | null {
    const row = this.db.prepare('SELECT data_json FROM inbox_items WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? AttentionItemSchema.parse(JSON.parse(row.data_json)) : null
  }

  inbox(workspaceRoot?: string, pendingOnly = true): AttentionItem[] {
    const rows = this.db.prepare(`SELECT data_json FROM inbox_items ${pendingOnly ? "WHERE status = 'pending'" : ''} ORDER BY rowid DESC`).all() as Array<{ data_json: string }>
    return rows.map(row => AttentionItemSchema.parse(JSON.parse(row.data_json))).filter(item => !workspaceRoot || item.workspaceRoot === resolve(workspaceRoot) || (item.taskId && this.get(item.taskId)?.workspaceRoot === resolve(workspaceRoot)))
  }

  humanRequest(id: string): DurableHumanRequest | null {
    const row = this.db.prepare('SELECT data_json FROM human_requests WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? JSON.parse(row.data_json) as DurableHumanRequest : null
  }

  humanRequests(kind?: 'approval' | 'question', pendingOnly = true): DurableHumanRequest[] {
    return (this.db.prepare('SELECT data_json FROM human_requests ORDER BY rowid').all() as Array<{ data_json: string }>).map(row => JSON.parse(row.data_json) as DurableHumanRequest).filter(item => (!kind || item.kind === kind) && (!pendingOnly || item.status === 'pending'))
  }

  saveHumanRequest(request: DurableHumanRequest): DurableHumanRequest {
    return this.transaction(() => {
      const old = this.humanRequest(request.id)
      if (old) return old
      this.db.prepare('INSERT INTO human_requests(id, data_json) VALUES (?, ?)').run(request.id, JSON.stringify(request))
      const task = this.findActiveByThread(request.threadId)
      const now = request.createdAt
      if (task) {
        this.putAttention({ id: request.id, ownerKind: 'task', ownerId: task.id, taskId: task.id, threadId: task.threadId, requestId: request.id, kind: request.kind, title: request.kind === 'approval' ? '需要授权' : '需要补充信息', message: request.message, status: 'pending', revision: 0, createdAt: now, updatedAt: now, payload: request.payload })
        if (task.status !== 'paused') this.update(task.id, task.revision, current => ({ ...current, status: request.kind === 'approval' ? 'waiting_approval' : 'waiting_user', waitingReason: request.message, executionMs: (current.executionMs ?? 0) + (current.executionStartedAt ? Math.max(0, Date.parse(now) - Date.parse(current.executionStartedAt)) : 0), executionStartedAt: undefined, updatedAt: now }), { key: `human-request:${request.id}`, kind: 'task_waiting_user', payload: { requestId: request.id }, createdAt: now })
      }
      return request
    })
  }

  resolveHumanRequest(id: string, resolution: unknown, status: 'answered' | 'cancelled' | 'expired', nowIso: string): DurableHumanRequest | null {
    return this.transaction(() => {
      const request = this.humanRequest(id)
      if (!request) return null
      if (request.status !== 'pending') {
        if (operationFingerprint(request.resolution) !== operationFingerprint(resolution)) throw Object.assign(new Error('question already has a different answer'), { code: 'idempotency_conflict' })
        return request
      }
      const next = { ...request, status, resolution, updatedAt: nowIso }
      this.db.prepare('UPDATE human_requests SET data_json = ? WHERE id = ?').run(JSON.stringify(next), id)
      const attention = this.attention(id)
      if (attention) {
        this.putAttention({ ...attention, status, updatedAt: nowIso, revision: attention.revision + 1 })
        const task = attention.taskId ? this.get(attention.taskId) : null
        if (task && !TERMINAL_TASK_STATUSES.has(task.status)) {
          this.appendInput({ taskId: task.id, expectedRevision: task.revision, idempotencyKey: `human:${id}`, kind: 'user_answer', sourceId: id, text: JSON.stringify({ request: request.message, resolution }), nowIso })
          this.enqueueOutbox({ id: `human:${id}`, ownerId: task.id, kind: 'human_answer', payload: { taskId: task.id, requestId: id }, createdAt: nowIso })
        }
      }
      return next
    })
  }

  private migrateDurable(sqlitePath: string, existingTasks: boolean): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version >= 1) return
    const backupPath = `${sqlitePath}.pre-durable-v1.bak`
    if (existingTasks && !existsSync(backupPath)) this.db.prepare('VACUUM INTO ?').run(backupPath)
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_inputs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_runs(id), idempotency_key TEXT NOT NULL, consumed_at TEXT, data_json TEXT NOT NULL, UNIQUE(task_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS operation_receipts(owner_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(owner_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS runtime_outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,kind TEXT NOT NULL,delivered_at TEXT,data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox_items(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS human_requests(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
        PRAGMA user_version=1;
      `)
    })
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_runs_thread_updated_idx
        ON task_runs(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS task_runs_status_updated_idx
        ON task_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_nodes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_nodes_task_idx ON task_nodes(task_id);
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_checkpoints_task_created_idx
        ON task_checkpoints(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, sequence),
        UNIQUE(task_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shell_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shell_sessions_task_idx ON shell_sessions(task_id);
      CREATE TABLE IF NOT EXISTS runtime_spans (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        turn_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_spans_task_started_idx
        ON runtime_spans(task_id, started_at DESC);
    `)
  }
}

export type DurableHumanRequest = {
  id: string; kind: 'approval' | 'question'; threadId: string; turnId: string;
  message: string; payload: Record<string, unknown>;
  status: 'pending' | 'answered' | 'cancelled' | 'expired'; resolution?: unknown;
  createdAt: string; updatedAt: string
}

export function operationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex')
}
