import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SurveyImportDispositionV1 } from '../contracts/survey.js'

export type ImportStage = 'validation' | 'preparation' | 'replay' | 'project' | 'parse' | 'commit' | 'projection'
export type ImportRejection = ImportStage | 'invalid-json' | 'body-too-large' | 'body-read' | 'structured-http'
export interface SurveyImportAttempt {
  id: string
  stage: ImportStage
}

export class SurveyImportAuditError extends Error {
  readonly code = 'survey_import_audit_unavailable'
  constructor() { super('survey import audit could not be persisted') }
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Local, append-only evidence of service calls, not certified production telemetry. */
export class SurveyImportAudit {
  constructor(private readonly db: Database.Database, private readonly nowIso: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS survey_import_attempt_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('started', 'committed', 'finished')),
      occurred_at TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(attempt_id, phase));
      CREATE TRIGGER IF NOT EXISTS survey_import_attempt_events_no_update BEFORE UPDATE ON survey_import_attempt_events
        BEGIN SELECT RAISE(ABORT, 'survey import audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS survey_import_attempt_events_no_delete BEFORE DELETE ON survey_import_attempt_events
        BEGIN SELECT RAISE(ABORT, 'survey import audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS survey_import_attempt_events_no_replace BEFORE INSERT ON survey_import_attempt_events
        WHEN EXISTS (SELECT 1 FROM survey_import_attempt_events WHERE sequence = NEW.sequence OR (attempt_id = NEW.attempt_id AND phase = NEW.phase))
        BEGIN SELECT RAISE(ABORT, 'survey import audit is append-only'); END;`)
  }

  begin(input: unknown): SurveyImportAttempt {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    // Bound identity extraction independently of schema parsing. Never persist
    // user filenames, raw content, credentials, keys, coordinates or errors.
    const identifiable = typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId.length <= 512
      && typeof value.idempotencyKey === 'string' && value.idempotencyKey.length >= 8 && value.idempotencyKey.length <= 200
    const taskHash = identifiable ? hash(JSON.stringify([value.projectId, value.idempotencyKey])) : null
    const mode = Object.prototype.hasOwnProperty.call(value, 'network') ? 'legacy-structured'
      : typeof value.name === 'string' && typeof value.dataBase64 === 'string' ? 'file' : 'unclassified'
    const attempt: SurveyImportAttempt = { id: randomUUID(), stage: 'validation' }
    this.append(attempt, 'started', { taskHash, mode })
    return attempt
  }

  committed(attempt: SurveyImportAttempt, replay: boolean, disposition?: SurveyImportDispositionV1): void {
    this.append(attempt, 'committed', { replay, sourceDisposition: disposition ?? 'legacy-unverified' })
  }

  finish(attempt: SurveyImportAttempt, rejection: ImportRejection | null): void {
    this.append(attempt, 'finished', { outcome: rejection === null ? 'succeeded' : 'rejected', rejection })
  }

  private append(attempt: SurveyImportAttempt, phase: string, fields: Record<string, unknown>): void {
    try {
      const occurredAt = this.nowIso()
      if (!Number.isFinite(Date.parse(occurredAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt)) throw new Error('invalid audit clock')
      // Read the durable predecessor: a surrounding network transaction may
      // have rolled back its commit receipt after that receipt was inserted.
      const previous = this.db.prepare('SELECT record_hash FROM survey_import_attempt_events WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1')
        .get(attempt.id) as { record_hash: string } | undefined
      const data = JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, phase, occurredAt, previousHash: previous?.record_hash ?? null, ...fields })
      const digest = hash(data)
      this.db.prepare('INSERT INTO survey_import_attempt_events(attempt_id, phase, occurred_at, record_hash, data_json) VALUES (?, ?, ?, ?, ?)')
        .run(attempt.id, phase, occurredAt, digest, data)
    } catch { throw new SurveyImportAuditError() }
  }
}
