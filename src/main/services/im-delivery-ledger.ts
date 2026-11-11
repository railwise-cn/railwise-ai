import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ImDeliveryObservation } from '../../../kun/src/contracts/im-delivery.js'
import type { ClawImProvider } from '../../shared/app-settings-types'
import {
  IM_LEDGER_LEASE_MS,
  IM_LEDGER_PAYLOAD_RETENTION_MS,
  IM_LEDGER_RETENTION_MS
} from '../../shared/im-communication'

export type ImLedgerStatusV1 = 'received' | 'turn_starting' | 'turn_started' | 'result_ready' | 'delivering' | 'delivered' | 'delivery_failed' | 'delivery_unknown' | 'failed'

const MAX_DELIVERY_RETRIES = 8
const LEDGER_PRUNE_INTERVAL_MS = 24 * 60 * 60_000
const TERMINAL_STATUSES = "'delivered', 'delivery_failed', 'failed'"

export type ImLedgerMessageV1 = {
  id: string
  provider: ClawImProvider
  accountId: string
  channelId: string
  remoteMessageId: string
  chatId: string
  senderId: string
  threadId: string
  prompt: string
  payloadJson: string
  status: ImLedgerStatusV1
  idempotencyKey: string
  runtimeThreadId?: string
  runtimeTurnId?: string
  resultJson?: string
  errorMessage?: string
  retryCount: number
  nextAttemptAt?: string
  leaseRunId?: string
  leaseUntil?: string
  createdAt: string
  updatedAt: string
}

type Row = Record<string, unknown>
export type ImDeliveryOperation = {
  operationId: string; recordId: string; phase: 'upload' | 'send'; requestHash: string;
  status: 'started' | 'succeeded' | 'outcome_unknown'; remoteOperationId?: string
}
type LedgerPatch = Partial<{
  [K in keyof Pick<
    ImLedgerMessageV1,
    'status' | 'runtimeThreadId' | 'runtimeTurnId' | 'resultJson' | 'errorMessage' | 'retryCount' | 'nextAttemptAt' | 'leaseRunId' | 'leaseUntil'
  >]: ImLedgerMessageV1[K] | null
}>

function stringValue(row: Row, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' && value ? value : undefined
}

export class ImDeliveryLedger {
  private readonly db: Database.Database
  private lastPrunedAt = 0
  private closed = false

  constructor(path: string) {
    const databasePath = resolve(path)
    const databaseDirectory = dirname(databasePath)
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(databaseDirectory, 0o700)
    this.db = new Database(databasePath)
    if (process.platform !== 'win32') chmodSync(databasePath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS im_messages (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        remote_message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        runtime_thread_id TEXT,
        runtime_turn_id TEXT,
        result_json TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        lease_run_id TEXT,
        lease_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, account_id, remote_message_id)
      );
      CREATE INDEX IF NOT EXISTS im_messages_status_idx ON im_messages(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS im_messages_chat_idx ON im_messages(provider, account_id, chat_id, created_at);
      CREATE TABLE IF NOT EXISTS im_cursors (
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, account_id)
      );
      CREATE TABLE IF NOT EXISTS im_delivery_operations (
        operation_id TEXT PRIMARY KEY, record_id TEXT NOT NULL,
        data_json TEXT NOT NULL, FOREIGN KEY(record_id) REFERENCES im_messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS im_runtime_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE, acknowledged_at TEXT
      );
    `)
  }

  integrityCheck(): boolean {
    try {
      return this.db.pragma('quick_check', { simple: true }) === 'ok'
    } catch {
      return false
    }
  }

  prune(now = new Date().toISOString()): { redacted: number; deleted: number; skipped: boolean } {
    const timestamp = Date.parse(now)
    if (!Number.isFinite(timestamp)) throw new Error('IM ledger prune time is invalid.')
    if (this.lastPrunedAt > 0 && timestamp - this.lastPrunedAt < LEDGER_PRUNE_INTERVAL_MS) {
      return { redacted: 0, deleted: 0, skipped: true }
    }
    const payloadCutoff = new Date(timestamp - IM_LEDGER_PAYLOAD_RETENTION_MS).toISOString()
    const recordCutoff = new Date(timestamp - IM_LEDGER_RETENTION_MS).toISOString()
    const runPrune = this.db.transaction(() => {
      const deleted = this.db.prepare(`
        DELETE FROM im_messages
        WHERE status IN (${TERMINAL_STATUSES})
          AND created_at < ?
      `).run(recordCutoff).changes
      const redacted = this.db.prepare(`
        UPDATE im_messages
        SET prompt = '', payload_json = '{}', sender_id = ''
        WHERE status IN (${TERMINAL_STATUSES})
          AND created_at < ?
          AND (prompt <> '' OR payload_json <> '{}' OR sender_id <> '')
      `).run(payloadCutoff).changes
      return { redacted, deleted }
    })
    const result = runPrune()
    this.lastPrunedAt = timestamp
    return { ...result, skipped: false }
  }

  receive(input: Omit<ImLedgerMessageV1, 'id' | 'status' | 'retryCount' | 'createdAt' | 'updatedAt'> & { now?: string }): ImLedgerMessageV1 {
    const now = input.now ?? new Date().toISOString()
    const id = randomUUID()
    const insert = this.db.prepare(`
      INSERT INTO im_messages (
        id, provider, account_id, channel_id, remote_message_id, chat_id, sender_id, thread_id,
        prompt, payload_json, status, idempotency_key, retry_count, created_at, updated_at
      ) VALUES (@id, @provider, @accountId, @channelId, @remoteMessageId, @chatId, @senderId, @threadId,
        @prompt, @payloadJson, 'received', @idempotencyKey, 0, @now, @now)
      ON CONFLICT(provider, account_id, remote_message_id) DO NOTHING
    `)
    insert.run({ ...input, id, now })
    return this.getByRemoteId(input.provider, input.accountId, input.remoteMessageId)!
  }

  getByRemoteId(provider: string, accountId: string, remoteMessageId: string): ImLedgerMessageV1 | undefined {
    const row = this.db.prepare('SELECT * FROM im_messages WHERE provider = ? AND account_id = ? AND remote_message_id = ?').get(provider, accountId, remoteMessageId) as Row | undefined
    return row ? this.map(row) : undefined
  }

  getByIdempotencyKey(key: string): ImLedgerMessageV1 | undefined {
    const row = this.db.prepare('SELECT * FROM im_messages WHERE idempotency_key = ?').get(key) as Row | undefined
    return row ? this.map(row) : undefined
  }

  getById(id: string): ImLedgerMessageV1 | undefined {
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  update(id: string, patch: LedgerPatch, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    return this.updateWithLease(id, patch, now)
  }

  updateClaimed(id: string, runId: string, patch: LedgerPatch, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    const expectedStatuses: readonly ImLedgerStatusV1[] | undefined = patch.status === 'turn_starting'
      ? ['received', 'turn_starting']
      : patch.status === 'turn_started'
        ? ['received', 'turn_starting', 'turn_started']
        : undefined
    return this.updateWithLease(id, patch, now, runId, expectedStatuses)
  }

  private updateWithLease(
    id: string,
    patch: LedgerPatch,
    now: string,
    leaseRunId?: string,
    expectedStatuses?: readonly ImLedgerStatusV1[]
  ): ImLedgerMessageV1 | undefined {
    const sets: string[] = ['updated_at = @now']
    const values: Record<string, unknown> = { id, now }
    const fields: Record<string, string> = {
      status: 'status', runtimeThreadId: 'runtime_thread_id', runtimeTurnId: 'runtime_turn_id',
      resultJson: 'result_json', errorMessage: 'error_message', retryCount: 'retry_count',
      nextAttemptAt: 'next_attempt_at', leaseRunId: 'lease_run_id', leaseUntil: 'lease_until'
    }
    for (const [key, column] of Object.entries(fields)) {
      if (patch[key as keyof typeof patch] !== undefined) {
        sets.push(`${column} = @${key}`)
        values[key] = patch[key as keyof typeof patch]
      }
    }
    const ownedLease = leaseRunId?.trim()
    if (ownedLease) values.leaseOwner = ownedLease
    const ownershipClause = ownedLease
      ? ' AND lease_run_id = @leaseOwner AND lease_until >= @now'
      : ''
    const statusClause = expectedStatuses?.length
      ? ` AND status IN (${expectedStatuses.map((status, index) => {
          const key = `expectedStatus${index}`
          values[key] = status
          return `@${key}`
        }).join(', ')})`
      : ''
    const result = this.db.prepare(
      `UPDATE im_messages SET ${sets.join(', ')} WHERE id = @id${ownershipClause}${statusClause}`
    ).run(values)
    if (result.changes === 0) return undefined
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  markResultReady(
    id: string,
    resultJson: string,
    runtime?: { threadId?: string; turnId?: string },
    now = new Date().toISOString(),
    leaseRunId?: string
  ): ImLedgerMessageV1 | undefined {
    return this.updateWithLease(id, {
      status: 'result_ready',
      resultJson,
      ...(runtime?.threadId ? { runtimeThreadId: runtime.threadId } : {}),
      ...(runtime?.turnId ? { runtimeTurnId: runtime.turnId } : {}),
      errorMessage: null,
      nextAttemptAt: null
    }, now, leaseRunId, ['received', 'turn_starting', 'turn_started', 'result_ready'])
  }

  markDelivering(id: string, now = new Date().toISOString(), leaseRunId?: string): ImLedgerMessageV1 | undefined {
    return this.updateWithLease(
      id,
      { status: 'delivering', errorMessage: null },
      now,
      leaseRunId,
      ['result_ready', 'delivering']
    )
  }

  markDelivered(id: string, now = new Date().toISOString(), leaseRunId?: string): ImLedgerMessageV1 | undefined {
    const record = this.updateWithLease(id, {
      status: 'delivered',
      errorMessage: null,
      nextAttemptAt: null,
      leaseRunId: null,
      leaseUntil: null
    }, now, leaseRunId, ['result_ready', 'delivering', 'delivered'])
    return record
  }

  markFailed(id: string, message: string, now = new Date().toISOString(), leaseRunId?: string): ImLedgerMessageV1 | undefined {
    return this.updateWithLease(id, {
      status: 'failed',
      errorMessage: message || null,
      nextAttemptAt: null,
      leaseRunId: null,
      leaseUntil: null
    }, now, leaseRunId, [
      'received',
      'turn_starting',
      'turn_started',
      'result_ready',
      'delivering',
      'failed'
    ])
  }

  markDeliveryUnknown(id: string, message: string, leaseRunId?: string): ImLedgerMessageV1 | undefined {
    return this.updateWithLease(id, { status: 'delivery_unknown', errorMessage: message, nextAttemptAt: null, leaseRunId: null, leaseUntil: null },
      new Date().toISOString(), leaseRunId, ['result_ready', 'delivering', 'delivery_unknown'])
  }

  deliveryOperation(operationId: string): ImDeliveryOperation | undefined {
    const row = this.db.prepare('SELECT data_json FROM im_delivery_operations WHERE operation_id = ?').get(operationId) as Row | undefined
    return row ? JSON.parse(String(row.data_json)) as ImDeliveryOperation : undefined
  }
  hasDeliveryOperations(recordId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM im_delivery_operations WHERE record_id=? LIMIT 1').get(recordId))
  }

  /** Commit intent before crossing the transport boundary. An existing start is never replayed. */
  beginDeliveryOperation(recordId: string, operationId: string, phase: 'upload' | 'send', requestHash: string): { operation: ImDeliveryOperation; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.deliveryOperation(operationId)
      if (existing) {
        if (existing.recordId !== recordId || existing.phase !== phase || existing.requestHash !== requestHash) throw Object.assign(new Error('IM delivery key is bound to another request.'), { code: 'idempotency_conflict' })
        return { operation: existing, created: false }
      }
      const record = this.getById(recordId)
      if (!record || record.status !== 'delivering') throw new Error('IM delivery is not ready for dispatch.')
      const operation: ImDeliveryOperation = { operationId, recordId, phase, requestHash, status: 'started' }
      this.db.prepare('INSERT INTO im_delivery_operations(operation_id,record_id,data_json) VALUES (?,?,?)').run(operationId, recordId, JSON.stringify(operation))
      this.enqueueObservation(record, operation)
      return { operation, created: true }
    })()
  }

  finishDeliveryOperation(operationId: string, status: 'succeeded' | 'outcome_unknown', remoteOperationId?: string): ImDeliveryOperation {
    return this.db.transaction(() => {
      const previous = this.deliveryOperation(operationId)
      if (!previous) throw new Error('IM delivery operation is missing.')
      if (previous.status === 'succeeded') {
        if (remoteOperationId && previous.remoteOperationId !== remoteOperationId) throw new Error('IM delivery returned conflicting remote operations.')
        return previous
      }
      if (status === 'succeeded' && !remoteOperationId) throw new Error('IM delivery requires a remote operation ID.')
      const next = { ...previous, status, ...(remoteOperationId ? { remoteOperationId } : {}) }
      this.db.prepare('UPDATE im_delivery_operations SET data_json=? WHERE operation_id=?').run(JSON.stringify(next), operationId)
      this.enqueueObservation(this.getById(previous.recordId)!, next)
      return next
    })()
  }

  pendingRuntimeObservations(): Array<{ id: number; fingerprint: string; observation: ImDeliveryObservation }> {
    return (this.db.prepare('SELECT id,fingerprint,payload_json FROM im_runtime_outbox WHERE acknowledged_at IS NULL ORDER BY id LIMIT 50').all() as Row[])
      .map(row => ({ id: Number(row.id), fingerprint: String(row.fingerprint), observation: JSON.parse(String(row.payload_json)) as ImDeliveryObservation }))
  }

  acknowledgeRuntimeObservation(id: number, fingerprint: string): void {
    this.db.prepare('UPDATE im_runtime_outbox SET acknowledged_at=? WHERE id=? AND fingerprint=?').run(new Date().toISOString(), id, fingerprint)
  }

  private enqueueObservation(record: ImLedgerMessageV1, operation: ImDeliveryOperation): void {
    if (!record.runtimeThreadId || !record.runtimeTurnId || !['feishu', 'weixin'].includes(record.provider)) return
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const observation: ImDeliveryObservation = {
      operationId: operation.operationId, phase: operation.phase, purpose: 'assistant_reply', provider: record.provider as 'feishu' | 'weixin',
      accountFingerprint: hash(`${record.provider}:${record.accountId}`), targetFingerprint: hash(`${record.provider}:${record.accountId}:${record.chatId}`),
      requestHash: operation.requestHash, runtimeThreadId: record.runtimeThreadId, runtimeTurnId: record.runtimeTurnId,
      status: operation.status, ...(operation.remoteOperationId ? record.provider === 'weixin'
        ? { clientOperationId: operation.remoteOperationId } : { remoteOperationId: operation.remoteOperationId } : {}), observedAt: new Date().toISOString()
    }
    const fingerprint = hash(JSON.stringify({ ...observation, observedAt: undefined }))
    this.db.prepare('INSERT OR IGNORE INTO im_runtime_outbox(payload_json,fingerprint) VALUES (?,?)').run(JSON.stringify(observation), fingerprint)
  }

  markDeliveryRetry(
    id: string,
    message: string,
    delayMs: number,
    now = new Date().toISOString(),
    leaseRunId?: string
  ): ImLedgerMessageV1 | undefined {
    const ownedLease = leaseRunId?.trim()
    const current = ownedLease
      ? this.db.prepare('SELECT retry_count FROM im_messages WHERE id = ? AND lease_run_id = ? AND lease_until >= ?').get(id, ownedLease, now) as Row | undefined
      : this.db.prepare('SELECT retry_count FROM im_messages WHERE id = ?').get(id) as Row | undefined
    if (!current) return undefined
    const retryCount = (Number(current?.retry_count) || 0) + 1
    const terminal = retryCount >= MAX_DELIVERY_RETRIES
    return this.updateWithLease(id, {
      status: terminal ? 'delivery_failed' : 'result_ready',
      errorMessage: message,
      retryCount,
      nextAttemptAt: terminal ? null : new Date(Date.parse(now) + Math.max(1_000, delayMs)).toISOString(),
      leaseRunId: null,
      leaseUntil: null
    }, now, leaseRunId, ['result_ready', 'delivering'])
  }

  claim(id: string, runId: string, leaseMs = IM_LEDGER_LEASE_MS, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    const leaseUntil = new Date(Date.parse(now) + Math.max(1_000, leaseMs)).toISOString()
    const result = this.db.prepare(`
      UPDATE im_messages
      SET lease_run_id = @runId, lease_until = @leaseUntil, updated_at = @now,
          status = CASE WHEN status = 'received' THEN 'turn_starting' ELSE status END
      WHERE id = @id
        AND (lease_until IS NULL OR lease_until < @now OR lease_run_id = @runId)
        AND status NOT IN (${TERMINAL_STATUSES}, 'delivery_unknown')
        AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
    `).run({ id, runId, leaseUntil, now })
    if (result.changes === 0) return undefined
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  renewLease(id: string, runId: string, leaseMs = IM_LEDGER_LEASE_MS, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    const leaseUntil = new Date(Date.parse(now) + Math.max(1_000, leaseMs)).toISOString()
    const result = this.db.prepare(`
      UPDATE im_messages
      SET lease_until = @leaseUntil, updated_at = @now
      WHERE id = @id
        AND lease_run_id = @runId
        AND status NOT IN (${TERMINAL_STATUSES}, 'delivery_unknown')
    `).run({ id, runId, leaseUntil, now })
    if (result.changes === 0) return undefined
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  recoverLease(id: string, runId: string, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    return this.update(id, { leaseRunId: runId, leaseUntil: now }, now)
  }

  releaseLease(id: string, now = new Date().toISOString()): ImLedgerMessageV1 | undefined {
    this.db.prepare('UPDATE im_messages SET lease_run_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ?').run(now, id)
    const row = this.db.prepare('SELECT * FROM im_messages WHERE id = ?').get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  listRecoverable(now = new Date().toISOString()): ImLedgerMessageV1[] {
    const rows = this.db.prepare(`
      SELECT * FROM im_messages
      WHERE status IN ('received', 'turn_starting', 'turn_started', 'result_ready', 'delivering')
        AND (lease_until IS NULL OR lease_until < ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
    `).all(now, now) as Row[]
    return rows.map((row) => this.map(row))
  }

  setCursor(provider: string, accountId: string, cursor: string, now = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO im_cursors(provider, account_id, cursor, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(provider, accountId, cursor, now)
  }

  getCursor(provider: string, accountId: string): string | undefined {
    const row = this.db.prepare('SELECT cursor FROM im_cursors WHERE provider = ? AND account_id = ?').get(provider, accountId) as Row | undefined
    return stringValue(row ?? {}, 'cursor')
  }

  counts(provider: string, accountId: string): { pending: number; processing: number; delivery: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM im_messages WHERE provider = ? AND account_id = ? GROUP BY status`).all(provider, accountId) as Array<{ status: string; count: number }>
    const pending = rows.filter((row) => row.status === 'received').reduce((sum, row) => sum + row.count, 0)
    const processing = rows.filter((row) => row.status === 'turn_starting' || row.status === 'turn_started').reduce((sum, row) => sum + row.count, 0)
    const delivery = rows.filter((row) => row.status === 'result_ready' || row.status === 'delivering' || row.status === 'delivery_unknown').reduce((sum, row) => sum + row.count, 0)
    return { pending, processing, delivery }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private map(row: Row): ImLedgerMessageV1 {
    return {
      id: String(row.id), provider: row.provider as ClawImProvider, accountId: String(row.account_id),
      channelId: String(row.channel_id), remoteMessageId: String(row.remote_message_id), chatId: String(row.chat_id),
      senderId: String(row.sender_id), threadId: String(row.thread_id), prompt: String(row.prompt),
      payloadJson: String(row.payload_json), status: row.status as ImLedgerStatusV1,
      idempotencyKey: String(row.idempotency_key), runtimeThreadId: stringValue(row, 'runtime_thread_id'),
      runtimeTurnId: stringValue(row, 'runtime_turn_id'), resultJson: stringValue(row, 'result_json'),
      errorMessage: stringValue(row, 'error_message'), retryCount: Number(row.retry_count) || 0,
      nextAttemptAt: stringValue(row, 'next_attempt_at'), leaseRunId: stringValue(row, 'lease_run_id'),
      leaseUntil: stringValue(row, 'lease_until'), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    }
  }
}
