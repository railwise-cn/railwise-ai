import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export class EngineeringVerificationAuditError extends Error {
  constructor() { super('deliverable verification audit could not be saved; no persisted verification evidence is available for this attempt') }
}

export interface EngineeringVerificationAttempt {
  id: string
  projectId: string
  manifestId: string
  startedAt: string
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const timestamp = (text: string): number => {
  const time = Date.parse(text)
  if (!Number.isFinite(time) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error('invalid audit clock')
  return time
}

/** Additive lifecycle receipts; old terminal records are never backfilled. */
export class EngineeringVerificationAudit {
  constructor(private readonly db: Database.Database, private readonly nowIso: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS engineering_verification_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('started', 'finished')),
      occurred_at TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(attempt_id, phase));
      CREATE TRIGGER IF NOT EXISTS engineering_verification_events_no_update BEFORE UPDATE ON engineering_verification_events
        BEGIN SELECT RAISE(ABORT, 'verification lifecycle is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS engineering_verification_events_no_delete BEFORE DELETE ON engineering_verification_events
        BEGIN SELECT RAISE(ABORT, 'verification lifecycle is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS engineering_verification_events_no_replace BEFORE INSERT ON engineering_verification_events
        WHEN EXISTS (SELECT 1 FROM engineering_verification_events WHERE sequence = NEW.sequence OR (attempt_id = NEW.attempt_id AND phase = NEW.phase))
        BEGIN SELECT RAISE(ABORT, 'verification lifecycle is append-only'); END;`)
  }

  begin(projectId: string, manifestId: string): EngineeringVerificationAttempt {
    try {
      // A savepoint inside the verification transaction would disappear on crash.
      if (this.db.inTransaction) throw new Error('verification start requires an independent transaction')
      const attempt = { id: `verification_${randomUUID()}`, projectId, manifestId, startedAt: this.nowIso() }
      timestamp(attempt.startedAt)
      this.db.transaction(() => this.append(attempt.id, 'started', attempt.startedAt, null, { projectId, manifestId })).immediate()
      return attempt
    } catch { throw new EngineeringVerificationAuditError() }
  }

  finish(attempt: EngineeringVerificationAttempt, completedAt: string, terminalHash: string): void {
    try {
      if (!this.db.inTransaction || timestamp(completedAt) < timestamp(attempt.startedAt)) throw new Error('invalid finish transaction or clock')
      const start = this.db.prepare("SELECT record_hash, data_json FROM engineering_verification_events WHERE attempt_id = ? AND phase = 'started'")
        .get(attempt.id) as { record_hash: string; data_json: string } | undefined
      const terminal = this.db.prepare('SELECT record_hash, data_json FROM engineering_verification_attempts WHERE id = ?')
        .get(attempt.id) as { record_hash: string; data_json: string } | undefined
      if (!start || !terminal || hash(start.data_json) !== start.record_hash || hash(terminal.data_json) !== terminalHash || terminal.record_hash !== terminalHash) throw new Error('missing audit binding')
      const began = JSON.parse(start.data_json), ended = JSON.parse(terminal.data_json)
      if (began.projectId !== attempt.projectId || began.manifestId !== attempt.manifestId || began.occurredAt !== attempt.startedAt
        || ended.id !== attempt.id || ended.projectId !== attempt.projectId || ended.manifestId !== attempt.manifestId
        || ended.startedAt !== attempt.startedAt || ended.completedAt !== completedAt || !['passed', 'failed', 'error'].includes(ended.outcome)) throw new Error('invalid terminal binding')
      this.append(attempt.id, 'finished', completedAt, start.record_hash, { terminalId: attempt.id, terminalRecordHash: terminalHash, outcome: ended.outcome })
    } catch { throw new EngineeringVerificationAuditError() }
  }

  private append(attemptId: string, phase: string, occurredAt: string, previousHash: string | null, fields: Record<string, unknown>): void {
    const serialized = JSON.stringify({ schemaVersion: 1, attemptId, phase, occurredAt, previousHash, ...fields })
    this.db.prepare('INSERT INTO engineering_verification_events(attempt_id, phase, occurred_at, record_hash, data_json) VALUES (?, ?, ?, ?, ?)')
      .run(attemptId, phase, occurredAt, hash(serialized), serialized)
  }
}
