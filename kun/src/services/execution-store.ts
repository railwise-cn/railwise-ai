import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { ExecutionSessionSchema, ExecutionAttemptSchema, InputDeliverySchema, type ExecutionSession, type ExecutionAttempt, type ExecutionToken, type InputDelivery } from '../contracts/execution.js'
import type { TaskRun } from '../contracts/tasks.js'

/** Shares tasks.sqlite's connection so input ACK and its checkpoint commit atomically. */
export class ExecutionStore {
  constructor(readonly db: Database, sqlitePath?: string) {
    const version = db.pragma('user_version', { simple: true }) as number
    if (version < 2 && sqlitePath && !existsSync(`${sqlitePath}.pre-execution-v2.bak`)) db.prepare('VACUUM INTO ?').run(`${sqlitePath}.pre-execution-v2.bak`)
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS execution_sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,turn_id TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_attempt_task ON execution_attempts(task_id);
      CREATE TABLE IF NOT EXISTS input_deliveries(id TEXT PRIMARY KEY,input_id TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL,UNIQUE(input_id,session_id),UNIQUE(session_id,sequence));
      CREATE TABLE IF NOT EXISTS task_budget_usage(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,kind TEXT NOT NULL,amount REAL NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_work_spans(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,started_ms INTEGER NOT NULL,finished_ms INTEGER,kind TEXT NOT NULL,execution_id TEXT);
      CREATE TABLE IF NOT EXISTS task_command_receipts(owner_id TEXT NOT NULL,command_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT,PRIMARY KEY(owner_id,command_key));
      ${version < 2 ? 'PRAGMA user_version=2;' : ''}
    `))()
    const sessionSql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='execution_sessions'").get() as {sql:string}).sql
    if (/thread_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sessionSql)) db.transaction(()=>db.exec(`ALTER TABLE execution_sessions RENAME TO execution_sessions_v2;
      CREATE TABLE execution_sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL,data_json TEXT NOT NULL);
      INSERT INTO execution_sessions SELECT * FROM execution_sessions_v2;
      DROP TABLE execution_sessions_v2;`))()
    db.exec('CREATE INDEX IF NOT EXISTS execution_session_thread ON execution_sessions(thread_id)')
    if (!(db.prepare('PRAGMA table_info(task_work_spans)').all() as Array<{name:string}>).some(column => column.name === 'execution_id')) db.exec('ALTER TABLE task_work_spans ADD COLUMN execution_id TEXT')
  }
  sessionForTask(taskId: string): ExecutionSession | null { return this.readSession('task_id', taskId) }
  sessionForThread(threadId: string): ExecutionSession | null { return this.readSession('thread_id', threadId) }
  private readSession(column: 'task_id' | 'thread_id', id: string): ExecutionSession | null {
    const row = this.db.prepare(`SELECT data_json FROM execution_sessions WHERE ${column}=? ORDER BY rowid DESC LIMIT 1`).get(id) as { data_json: string } | undefined
    return row ? ExecutionSessionSchema.parse(JSON.parse(row.data_json)) : null
  }
  ensureSession(task: TaskRun, now: string): ExecutionSession {
    const existing = this.sessionForTask(task.id)
    if (existing) return existing
    const session = ExecutionSessionSchema.parse({ id: `exec_session_${task.id}`, taskId: task.id, threadId: task.threadId, originThreadId: task.originThreadId ?? task.threadId, visibility: task.visibility === 'internal' ? 'internal' : task.originThreadId ? 'task' : 'legacy', createdAt: now, updatedAt: now, revision: 0 })
    this.db.prepare('INSERT OR IGNORE INTO execution_sessions(id,task_id,thread_id,data_json) VALUES(?,?,?,?)').run(session.id, task.id, task.threadId, JSON.stringify(session))
    return this.sessionForTask(task.id)!
  }
  beginAttempt(token: ExecutionToken, now: string): ExecutionAttempt {
    const attempt = ExecutionAttemptSchema.parse({ ...token, status: 'running', startedAt: now })
    this.db.prepare('INSERT INTO execution_attempts(id,task_id,turn_id,data_json) VALUES(?,?,?,?)').run(token.executionId, token.taskId, token.turnId, JSON.stringify(attempt))
    return attempt
  }
  attempt(id: string): ExecutionAttempt | null {
    const row = this.db.prepare('SELECT data_json FROM execution_attempts WHERE id=?').get(id) as { data_json: string } | undefined
    return row ? ExecutionAttemptSchema.parse(JSON.parse(row.data_json)) : null
  }
  latestAttempt(taskId: string): ExecutionAttempt | null {
    const row = this.db.prepare('SELECT data_json FROM execution_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as { data_json: string } | undefined
    return row ? ExecutionAttemptSchema.parse(JSON.parse(row.data_json)) : null
  }
  attempts(taskId: string): ExecutionAttempt[] {
    return (this.db.prepare('SELECT data_json FROM execution_attempts WHERE task_id=? ORDER BY rowid').all(taskId) as Array<{data_json: string}>)
      .map(row => ExecutionAttemptSchema.parse(JSON.parse(row.data_json)))
  }
  finishAttempt(id: string, status: ExecutionAttempt['status'], now: string): void {
    const attempt = this.attempt(id)
    if (!attempt || (attempt.status !== 'running' && !(attempt.status === 'lost' && status === 'cancelled'))) return
    this.db.prepare('UPDATE execution_attempts SET data_json=? WHERE id=?').run(JSON.stringify({ ...attempt, status, finishedAt: now }), id)
  }
  enqueue(inputId: string, taskId: string, sessionId: string): InputDelivery {
    const prior = this.db.prepare('SELECT data_json FROM input_deliveries WHERE input_id=? AND session_id=?').get(inputId, sessionId) as { data_json: string } | undefined
    if (prior) return InputDeliverySchema.parse(JSON.parse(prior.data_json))
    const seq = this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM input_deliveries WHERE session_id=?').get(sessionId) as { seq: number }
    const delivery = InputDeliverySchema.parse({ id: `delivery_${randomUUID()}`, inputId, taskId, sessionId, sequence: seq.seq, status: 'queued', messageItemId: `item_task_input_${inputId}` })
    this.db.prepare('INSERT INTO input_deliveries(id,input_id,session_id,sequence,status,data_json) VALUES(?,?,?,?,?,?)').run(delivery.id,inputId,sessionId,delivery.sequence,delivery.status,JSON.stringify(delivery))
    return delivery
  }
  deliveriesForThread(threadId: string): InputDelivery[] {
    const rows = this.db.prepare('SELECT d.data_json FROM input_deliveries d JOIN execution_sessions s ON s.id=d.session_id WHERE s.thread_id=? ORDER BY d.rowid').all(threadId) as Array<{data_json:string}>
    return rows.map(row => InputDeliverySchema.parse(JSON.parse(row.data_json)))
  }
  pending(sessionId: string): InputDelivery[] {
    return (this.db.prepare("SELECT data_json FROM input_deliveries WHERE session_id=? AND status!='consumed' ORDER BY sequence").all(sessionId) as Array<{data_json:string}>).map(row => InputDeliverySchema.parse(JSON.parse(row.data_json)))
  }
  delivered(delivery:InputDelivery,sessionItemId:string,sessionHash:string,now:string):void {
    const row=this.db.prepare('SELECT data_json FROM input_deliveries WHERE id=?').get(delivery.id) as {data_json:string}|undefined
    if(!row)throw new Error('input delivery not found')
    const current=InputDeliverySchema.parse(JSON.parse(row.data_json))
    if(current.status==='consumed')return
    const next=InputDeliverySchema.parse({...current,status:'delivered',deliveredAt:current.deliveredAt ?? now,sessionItemId,sessionHash})
    this.db.prepare("UPDATE input_deliveries SET status='delivered',data_json=? WHERE id=? AND status!='consumed'").run(JSON.stringify(next),delivery.id)
  }
  acknowledge(delivery: InputDelivery, checkpointId: string, now: string): void {
    const row=this.db.prepare('SELECT data_json FROM input_deliveries WHERE id=?').get(delivery.id) as {data_json:string}|undefined
    if(!row)throw new Error('input delivery not found')
    const current=InputDeliverySchema.parse(JSON.parse(row.data_json))
    if(current.status==='consumed')return
    if(current.status!=='delivered')throw new Error('input must be durably delivered before checkpoint acknowledgement')
    const next = InputDeliverySchema.parse({ ...current, status: 'consumed', consumedAt: now, checkpointId })
    this.db.prepare("UPDATE input_deliveries SET status='consumed',data_json=? WHERE id=? AND status!='consumed'").run(JSON.stringify(next), delivery.id)
  }
  beginWork(id: string, rootId: string, kind: string, nowMs: number, executionId?: string): void {
    this.db.prepare('INSERT OR IGNORE INTO task_work_spans(id,root_id,started_ms,kind,execution_id) VALUES(?,?,?,?,?)').run(id,rootId,nowMs,kind,executionId ?? null)
  }
  finishWork(id: string, nowMs: number): void { this.db.prepare('UPDATE task_work_spans SET finished_ms=? WHERE id=? AND finished_ms IS NULL').run(nowMs,id) }
  usedExecutionMs(rootId: string, nowMs: number): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(MAX(0,COALESCE(finished_ms,?)-started_ms)),0) AS total FROM task_work_spans WHERE root_id=?').get(nowMs,rootId) as {total:number}
    return row.total
  }
  recordCost(rootId: string, id: string, costUsd: number): void {
    this.db.prepare("INSERT INTO task_budget_usage(id,root_id,kind,amount,data_json) VALUES(?,?,'cost',?,'{}') ON CONFLICT(id) DO UPDATE SET amount=MAX(amount,excluded.amount)").run(id,rootId,Math.max(0,costUsd))
  }
  finishOrphanedWork(executionId: string, throughMs: number): void { this.db.prepare('UPDATE task_work_spans SET finished_ms=MAX(started_ms,?) WHERE execution_id=? AND finished_ms IS NULL').run(throughMs,executionId) }
  usedCost(rootId: string): number { return (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM task_budget_usage WHERE root_id=? AND kind='cost'").get(rootId) as {total:number}).total }
  command(ownerId: string, key: string, request: unknown): { created: boolean; result?: unknown } {
    const fingerprint = createHash('sha256').update(canonical(request)).digest('hex')
    const prior = this.db.prepare('SELECT fingerprint,result_json FROM task_command_receipts WHERE owner_id=? AND command_key=?').get(ownerId,key) as {fingerprint:string;result_json:string|null} | undefined
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Object.assign(new Error('command key is bound to a different request'),{code:'idempotency_conflict'})
      return { created:false, ...(prior.result_json ? {result:JSON.parse(prior.result_json)} : {}) }
    }
    this.db.prepare('INSERT INTO task_command_receipts(owner_id,command_key,fingerprint) VALUES(?,?,?)').run(ownerId,key,fingerprint)
    return { created:true }
  }
  finishCommand(ownerId:string,key:string,result:unknown):void { this.db.prepare('UPDATE task_command_receipts SET result_json=? WHERE owner_id=? AND command_key=?').run(JSON.stringify(result),ownerId,key) }
}
function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if(value && typeof value==='object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
