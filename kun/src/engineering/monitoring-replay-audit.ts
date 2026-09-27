import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MonitoringReplayVerificationV1 } from '../contracts/engineering.js'

export class MonitoringReplayAuditError extends Error {
  constructor() { super('monitoring replay audit could not be saved') }
}
export type MonitoringReplayAttempt = { id: string; projectId: string; manifestId: string; startedAt: string }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const instant = (value: string): number => {
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('invalid audit time')
  return Date.parse(value)
}

/** Independent event table: never changes the existing verification denominator. */
export class MonitoringReplayAudit {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS engineering_monitoring_replay_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('started', 'finished')), project_id TEXT NOT NULL, manifest_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(attempt_id, phase));
      CREATE TRIGGER IF NOT EXISTS monitoring_replay_no_update BEFORE UPDATE ON engineering_monitoring_replay_events BEGIN SELECT RAISE(ABORT, 'monitoring replay is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS monitoring_replay_no_delete BEFORE DELETE ON engineering_monitoring_replay_events BEGIN SELECT RAISE(ABORT, 'monitoring replay is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS monitoring_replay_no_replace BEFORE INSERT ON engineering_monitoring_replay_events
      WHEN EXISTS(SELECT 1 FROM engineering_monitoring_replay_events WHERE sequence=NEW.sequence OR (attempt_id=NEW.attempt_id AND phase=NEW.phase)) BEGIN SELECT RAISE(ABORT, 'monitoring replay is append-only'); END;`)
  }
  begin(projectId: string, manifestId: string): MonitoringReplayAttempt {
    try {
      if (this.db.inTransaction) throw new Error('start must commit independently')
      if (![projectId, manifestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 240)) throw new Error('invalid audit scope')
      const attempt = { id: `monitoring_replay_${randomUUID()}`, projectId, manifestId, startedAt: this.now() }
      instant(attempt.startedAt)
      this.db.transaction(() => this.append(attempt, 'started', attempt.startedAt, { schemaVersion: 1, ...attempt, phase: 'started' })).immediate()
      return attempt
    } catch { throw new MonitoringReplayAuditError() }
  }
  finish(attempt: MonitoringReplayAttempt, result: MonitoringReplayVerificationV1): void {
    try {
      if (this.db.inTransaction || instant(result.checkedAt) < instant(attempt.startedAt)
        || result.attemptId !== attempt.id || result.projectId !== attempt.projectId || result.manifestId !== attempt.manifestId) throw new Error('invalid replay finish')
      this.db.transaction(() => {
        const start = this.db.prepare("SELECT * FROM engineering_monitoring_replay_events WHERE attempt_id=? AND phase='started'").get(attempt.id) as { record_hash: string; data_json: string; project_id: string; manifest_id: string; occurred_at: string } | undefined
        if (!start || hash(start.data_json) !== start.record_hash || start.project_id !== attempt.projectId || start.manifest_id !== attempt.manifestId || start.occurred_at !== attempt.startedAt
          || start.data_json !== JSON.stringify({ schemaVersion: 1, ...attempt, phase: 'started' })) throw new Error('invalid replay start')
        // Result and finish receipt are a single immutable row/transaction.
        this.append(attempt, 'finished', result.checkedAt, { schemaVersion: 1, ...attempt, phase: 'finished', previousHash: start.record_hash, resultHash: hash(JSON.stringify(result)), result })
      }).immediate()
    } catch { throw new MonitoringReplayAuditError() }
  }
  private append(attempt: MonitoringReplayAttempt, phase: string, at: string, value: unknown): void {
    const text = JSON.stringify(value)
    this.db.prepare('INSERT INTO engineering_monitoring_replay_events(attempt_id,phase,project_id,manifest_id,occurred_at,record_hash,data_json) VALUES(?,?,?,?,?,?,?)')
      .run(attempt.id, phase, attempt.projectId, attempt.manifestId, at, hash(text), text)
  }
}
