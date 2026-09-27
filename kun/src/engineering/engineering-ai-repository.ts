import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  EngineeringProjectSuggestionV1,
  EngineeringApprovalV1,
  EngineeringRunPlanV1,
  type EngineeringApprovalV1 as EngineeringApproval,
  type EngineeringRunPlanV1 as EngineeringRunPlan
} from '../contracts/engineering-ai.js'

type JsonRow = { data_json: string }
type ReplayRow = { result_json: string }

/**
 * Durable storage for Engineering AI control-plane state.
 *
 * Plans and approval tokens deliberately live outside renderer state. This
 * keeps an awaiting-approval plan reviewable after a Runtime restart without
 * turning it into an executable Turn or a second task queue.
 */
export class EngineeringAiRepository {
  private readonly db: Database.Database
  private readonly nowIso: () => string

  constructor(options: { rootDir: string; nowIso?: () => string }) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    mkdirSync(resolve(options.rootDir), { recursive: true })
    this.db = new Database(resolve(options.rootDir, 'engineering-ai.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engineering_ai_plans (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS engineering_ai_plans_thread_updated_idx
        ON engineering_ai_plans(thread_id, project_id, updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS engineering_ai_approvals (
        token TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS engineering_ai_approvals_plan_idx
        ON engineering_ai_approvals(plan_id, plan_revision, expires_at DESC);
      CREATE TABLE IF NOT EXISTS engineering_ai_idempotency (
        key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engineering_ai_step_evidence (
        plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        handles_json TEXT NOT NULL,
        PRIMARY KEY(plan_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS engineering_ai_project_suggestions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        request_key TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  projectSuggestions(threadId: string, projectId: string): Array<{ suggestion: EngineeringProjectSuggestionV1; token: string }> {
    const rows = this.db.prepare('SELECT data_json, token FROM engineering_ai_project_suggestions WHERE thread_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(threadId, projectId) as Array<{ data_json: string; token: string }>
    return rows.map(row => ({ suggestion: EngineeringProjectSuggestionV1.parse(JSON.parse(row.data_json)), token: row.token }))
  }

  projectSuggestion(id: string, byRequestKey = false): { suggestion: EngineeringProjectSuggestionV1; token: string } | null {
    const row = this.db.prepare(`SELECT data_json, token FROM engineering_ai_project_suggestions WHERE ${byRequestKey ? 'request_key' : 'id'} = ?`).get(id) as { data_json: string; token: string } | undefined
    return row ? { suggestion: EngineeringProjectSuggestionV1.parse(JSON.parse(row.data_json)), token: row.token } : null
  }

  createProjectSuggestion(suggestion: EngineeringProjectSuggestionV1, token: string, requestKey: string): void {
    this.db.prepare('INSERT INTO engineering_ai_project_suggestions(id, thread_id, project_id, request_key, token, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(suggestion.id, suggestion.threadId, suggestion.projectId, requestKey, token, JSON.stringify(suggestion), suggestion.createdAt)
  }

  saveProjectSuggestion(suggestion: EngineeringProjectSuggestionV1): void {
    this.db.prepare('UPDATE engineering_ai_project_suggestions SET data_json = ? WHERE id = ?').run(JSON.stringify(suggestion), suggestion.id)
  }

  stepEvidence(planId: string, stepId: string): { parameters: Record<string, unknown>; handles: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT parameters_json, handles_json FROM engineering_ai_step_evidence WHERE plan_id = ? AND step_id = ?').get(planId, stepId) as { parameters_json: string; handles_json: string } | undefined
    return row ? { parameters: JSON.parse(row.parameters_json), handles: JSON.parse(row.handles_json) } : null
  }

  recordStepEvidence(planId: string, stepId: string, parameters: Record<string, unknown>, handles: Record<string, unknown>): void {
    this.db.prepare('INSERT OR IGNORE INTO engineering_ai_step_evidence(plan_id, step_id, parameters_json, handles_json) VALUES (?, ?, ?, ?)').run(planId, stepId, JSON.stringify(parameters), JSON.stringify(handles))
  }

  getPlan(id: string): EngineeringRunPlan | null {
    const row = this.db
      .prepare('SELECT data_json FROM engineering_ai_plans WHERE id = ?')
      .get(id) as JsonRow | undefined
    return row ? EngineeringRunPlanV1.parse(JSON.parse(row.data_json)) : null
  }

  latestPlan(threadId: string, projectId: string): EngineeringRunPlan | null {
    const row = this.db.prepare(`
      SELECT data_json FROM engineering_ai_plans
      WHERE thread_id = ? AND project_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId, projectId) as JsonRow | undefined
    return row ? EngineeringRunPlanV1.parse(JSON.parse(row.data_json)) : null
  }

  getApproval(token: string): EngineeringApproval | null {
    const row = this.db
      .prepare('SELECT data_json FROM engineering_ai_approvals WHERE token = ?')
      .get(token) as JsonRow | undefined
    return row ? EngineeringApprovalV1.parse(JSON.parse(row.data_json)) : null
  }

  planForTurn(threadId: string, turnId: string): EngineeringRunPlan | null {
    const row = this.db.prepare(`
      SELECT data_json FROM engineering_ai_plans
      WHERE thread_id = ? AND json_extract(data_json, '$.executionTurnId') = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(threadId, turnId) as JsonRow | undefined
    return row ? EngineeringRunPlanV1.parse(JSON.parse(row.data_json)) : null
  }

  planForTask(threadId: string, taskId: string): EngineeringRunPlan | null {
    const row = this.db.prepare(`SELECT data_json FROM engineering_ai_plans WHERE thread_id = ? AND json_extract(data_json, '$.taskId') = ? ORDER BY updated_at DESC LIMIT 1`).get(threadId, taskId) as JsonRow | undefined
    return row ? EngineeringRunPlanV1.parse(JSON.parse(row.data_json)) : null
  }

  approvalForPlan(planId: string, planRevision: number): EngineeringApproval | null {
    const row = this.db.prepare(`
      SELECT data_json FROM engineering_ai_approvals
      WHERE plan_id = ? AND plan_revision = ?
      ORDER BY expires_at DESC
      LIMIT 1
    `).get(planId, planRevision) as JsonRow | undefined
    return row ? EngineeringApprovalV1.parse(JSON.parse(row.data_json)) : null
  }

  replay(key: string): unknown | null {
    const row = this.db
      .prepare('SELECT result_json FROM engineering_ai_idempotency WHERE key = ?')
      .get(key) as ReplayRow | undefined
    return row ? JSON.parse(row.result_json) : null
  }

  createPlan(
    plan: EngineeringRunPlan,
    approval: EngineeringApproval,
    idempotencyKey: string,
    result: unknown
  ): void {
    this.db.transaction(() => {
      this.writePlan(plan)
      this.writeApproval(approval)
      this.writeReplay(idempotencyKey, result)
    })()
  }

  saveApproval(approval: EngineeringApproval): void {
    this.writeApproval(approval)
  }

  savePlan(plan: EngineeringRunPlan): void {
    this.writePlan(plan)
  }

  saveTransition(options: {
    plan: EngineeringRunPlan
    idempotencyKey: string
    result: unknown
    consumedApprovalToken?: string
  }): void {
    this.db.transaction(() => {
      this.writePlan(options.plan)
      if (options.consumedApprovalToken) {
        this.db
          .prepare('DELETE FROM engineering_ai_approvals WHERE token = ?')
          .run(options.consumedApprovalToken)
      }
      this.writeReplay(options.idempotencyKey, options.result)
    })()
  }

  private writePlan(plan: EngineeringRunPlan): void {
    this.db.prepare(`
      INSERT INTO engineering_ai_plans(id, thread_id, project_id, revision, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        project_id = excluded.project_id,
        revision = excluded.revision,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(plan.id, plan.threadId, plan.projectId, plan.revision, JSON.stringify(plan), plan.updatedAt)
  }

  private writeApproval(approval: EngineeringApproval): void {
    this.db.prepare(`
      INSERT INTO engineering_ai_approvals(token, plan_id, plan_revision, data_json, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        plan_id = excluded.plan_id,
        plan_revision = excluded.plan_revision,
        data_json = excluded.data_json,
        expires_at = excluded.expires_at
    `).run(
      approval.token,
      approval.planId,
      approval.planRevision,
      JSON.stringify(approval),
      approval.expiresAt
    )
  }

  private writeReplay(key: string, result: unknown): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO engineering_ai_idempotency(key, result_json, created_at)
      VALUES (?, ?, ?)
    `).run(key, JSON.stringify(result), this.nowIso())
  }
}
