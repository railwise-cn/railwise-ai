import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'

const identity = z.string().min(1).max(200)
const labelSchema = z.string().trim().min(1).max(100)
export class SurveyContextAccessError extends Error {
  constructor(readonly code: 'not-found' | 'limit') { super(`survey_context_access_${code}`) }
}
type ClientRow = { client_id: string; label: string; created_at: string }

/** Host-owned credentials and explicit read-summary grants. Secrets are returned
 * once, stored only as digests, and never accepted from MCP clientInfo/arguments.
 * Revocations remain on disk and are checked on every read, including established
 * connections. This store does not change outbound/legacy MCP configuration. */
export class SurveyContextAccessStore {
  private readonly db: Database.Database
  constructor(rootDir: string, private readonly nowIso = () => new Date().toISOString()) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
    if (!lstatSync(rootDir).isDirectory() || lstatSync(rootDir).isSymbolicLink()) throw new Error('survey_context_access_storage_unavailable')
    if (process.platform !== 'win32') chmodSync(rootDir, 0o700)
    const file = join(rootDir, 'survey-context-access.sqlite3')
    if (!existsSync(file)) writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('survey_context_access_storage_unavailable')
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    this.db = new Database(file)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS survey_context_clients (
      client_id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, revoked_at TEXT,
      CHECK(length(client_id) BETWEEN 1 AND 200), CHECK(length(label) BETWEEN 1 AND 100), CHECK(length(token_hash)=64));
      CREATE TABLE IF NOT EXISTS survey_context_grants (
      client_id TEXT NOT NULL REFERENCES survey_context_clients(client_id), project_id TEXT NOT NULL,
      granted INTEGER NOT NULL CHECK(granted IN (0,1)), updated_at TEXT NOT NULL,
      PRIMARY KEY(client_id,project_id), CHECK(length(project_id) BETWEEN 1 AND 200));`)
  }
  close(): void { this.db.close() }
  createClient(label: string): { clientId: string; label: string; token: string; createdAt: string } {
    label = labelSchema.parse(label)
    return this.db.transaction(() => {
      const counts = this.db.prepare('SELECT count(*) AS total, sum(revoked_at IS NULL) AS active FROM survey_context_clients').get() as { total: number; active: number | null }
      if (counts.total >= 4096 || (counts.active ?? 0) >= 64) throw new SurveyContextAccessError('limit')
      const clientId = randomUUID(), token = randomBytes(32).toString('base64url'), createdAt = this.nowIso()
      this.db.prepare('INSERT INTO survey_context_clients(client_id,label,token_hash,created_at) VALUES (?,?,?,?)')
        .run(clientId, label, createHash('sha256').update(token).digest('hex'), createdAt)
      return { clientId, label, token, createdAt }
    })()
  }
  resolvePrincipal(token: string | null): string | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const row = this.db.prepare('SELECT client_id FROM survey_context_clients WHERE token_hash=? AND revoked_at IS NULL')
      .get(createHash('sha256').update(token).digest('hex')) as { client_id: string } | undefined
    return row?.client_id ?? null
  }
  canReadProject(clientId: string, projectId: string): boolean {
    if (!identity.safeParse(clientId).success || !identity.safeParse(projectId).success) return false
    return Boolean(this.db.prepare(`SELECT 1 FROM survey_context_grants g JOIN survey_context_clients c ON c.client_id=g.client_id
      WHERE g.client_id=? AND g.project_id=? AND g.granted=1 AND c.revoked_at IS NULL`).get(clientId, projectId))
  }
  listClients() {
    const clients = this.db.prepare('SELECT client_id,label,created_at FROM survey_context_clients WHERE revoked_at IS NULL ORDER BY created_at,client_id').all() as ClientRow[]
    return { clients: clients.map(row => ({ clientId: row.client_id, label: row.label, createdAt: row.created_at,
      grants: (this.db.prepare('SELECT project_id FROM survey_context_grants WHERE client_id=? AND granted=1 ORDER BY project_id').all(row.client_id) as { project_id: string }[]).map(grant => grant.project_id)
    })) }
  }
  setGrant(clientId: string, projectId: string, allowed: boolean): void {
    identity.parse(clientId); identity.parse(projectId)
    this.db.transaction(() => {
      this.requireClient(clientId)
      const count = this.db.prepare('SELECT count(*) AS total FROM survey_context_grants WHERE client_id=?').get(clientId) as { total: number }
      const existing = this.db.prepare('SELECT 1 FROM survey_context_grants WHERE client_id=? AND project_id=?').get(clientId, projectId)
      if (!existing && count.total >= 200) throw new SurveyContextAccessError('limit')
      this.db.prepare(`INSERT INTO survey_context_grants(client_id,project_id,granted,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(client_id,project_id) DO UPDATE SET granted=excluded.granted,updated_at=excluded.updated_at`)
        .run(clientId, projectId, allowed ? 1 : 0, this.nowIso())
    })()
  }
  revokeClient(clientId: string): void {
    identity.parse(clientId)
    this.db.transaction(() => {
      this.requireClient(clientId)
      this.db.prepare('UPDATE survey_context_clients SET revoked_at=? WHERE client_id=?').run(this.nowIso(), clientId)
    })()
  }
  private requireClient(clientId: string): void {
    if (!this.db.prepare('SELECT 1 FROM survey_context_clients WHERE client_id=? AND revoked_at IS NULL').get(clientId)) throw new SurveyContextAccessError('not-found')
  }
}
