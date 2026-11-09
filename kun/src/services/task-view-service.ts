import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AttentionItem, TaskRun } from '../contracts/tasks.js'
import type { TaskRunRepository } from './task-run-repository.js'

export type TaskViewFilter = 'ongoing' | 'attention' | 'completed' | 'all'
export type TaskPageQuery = { workspaceRoot?: string; threadId?: string; search?: string; filter?: TaskViewFilter; limit?: number; cursor?: string }
export type TaskPage = { items: TaskRun[]; relatedTasks: TaskRun[]; attention: AttentionItem[]; total: number; counts: Record<TaskViewFilter, number>; nextCursor?: string; snapshotId: string; expiresAt: string; eventWatermark: number }
export type TaskFeedEvent = { seq: number; taskId?: string; kind: 'task_changed' | 'attention_changed'; payload: Record<string, unknown>; createdAt: string }
const TTL_MS = 15 * 60_000
const error = (message: string) => Object.assign(new Error(message), { code: 'invalid_cursor' })

/** Query snapshots and the global stream share the task DB and its write transactions. */
export class TaskViewService {
  readonly db: Database
  constructor(readonly repository: TaskRunRepository, private readonly now = () => Date.now()) {
    this.db = repository.connection()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_change_feed(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_query_snapshots(id TEXT PRIMARY KEY, query_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_status_spans(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT);
      CREATE INDEX IF NOT EXISTS task_status_span_task ON task_status_spans(task_id);
      CREATE TRIGGER IF NOT EXISTS task_timing_insert AFTER INSERT ON task_runs BEGIN
        INSERT INTO task_status_spans(task_id,status,started_at) VALUES(new.id,json_extract(new.data_json,'$.status'),json_extract(new.data_json,'$.createdAt'));
      END;
      CREATE TRIGGER IF NOT EXISTS task_timing_update AFTER UPDATE OF data_json ON task_runs WHEN json_extract(old.data_json,'$.status') != json_extract(new.data_json,'$.status') BEGIN
        UPDATE task_status_spans SET finished_at=json_extract(new.data_json,'$.updatedAt') WHERE task_id=new.id AND finished_at IS NULL;
        INSERT INTO task_status_spans(task_id,status,started_at) VALUES(new.id,json_extract(new.data_json,'$.status'),json_extract(new.data_json,'$.updatedAt'));
      END;
      CREATE TRIGGER IF NOT EXISTS task_view_insert AFTER INSERT ON task_runs BEGIN
        INSERT INTO task_change_feed(task_id,kind,payload_json,created_at) VALUES(new.id,'task_changed',new.data_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS task_view_update AFTER UPDATE OF data_json ON task_runs BEGIN
        INSERT INTO task_change_feed(task_id,kind,payload_json,created_at) VALUES(new.id,'task_changed',new.data_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS task_attention_insert AFTER INSERT ON inbox_items BEGIN
        INSERT INTO task_change_feed(task_id,kind,payload_json,created_at) VALUES(json_extract(new.data_json,'$.taskId'),'attention_changed',new.data_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS task_attention_update AFTER UPDATE OF data_json ON inbox_items BEGIN
        INSERT INTO task_change_feed(task_id,kind,payload_json,created_at) VALUES(json_extract(new.data_json,'$.taskId'),'attention_changed',new.data_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
    `)
  }
  watermark(): number { return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM task_change_feed').get() as { seq: number }).seq }
  changes(after: number, limit = 200): TaskFeedEvent[] {
    return (this.db.prepare('SELECT * FROM task_change_feed WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as Array<{ seq: number; task_id: string | null; kind: TaskFeedEvent['kind']; payload_json: string; created_at: string }>).map(row => ({ seq: row.seq, ...(row.task_id ? { taskId: row.task_id } : {}), kind: row.kind, payload: row.kind === 'task_changed' ? this.withTiming(JSON.parse(row.payload_json) as TaskRun) as unknown as Record<string,unknown> : JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at }))
  }
  private withTiming(task: TaskRun): TaskRun {
    const spans = this.db.prepare('SELECT status,started_at,finished_at FROM task_status_spans WHERE task_id=? ORDER BY id').all(task.id) as Array<{status:string;started_at:string;finished_at:string|null}>
    if (!spans.length) return task
    const now = this.now()
    const duration = (statuses: string[]) => spans.filter(span => statuses.includes(span.status)).reduce((total, span) => total + Math.max(0, (span.finished_at ? Date.parse(span.finished_at) : now) - Date.parse(span.started_at)), 0)
    const timing = { executionMs: this.repository.execution.usedExecutionMs(task.rootTaskId ?? task.id, now), queuedMs: duration(['queued']), humanWaitMs: duration(['waiting_user','waiting_approval']), pausedMs: duration(['paused']), sampledAt: new Date(now).toISOString(), coverage: spans[0].started_at === task.createdAt ? 'complete' : 'partial' }
    return { ...task, timing } as TaskRun
  }
  page(query: TaskPageQuery): TaskPage {
    const normalized = { workspaceRoot: query.workspaceRoot ? resolve(query.workspaceRoot) : '', threadId: query.threadId ?? '', search: (query.search ?? '').trim().toLocaleLowerCase(), filter: query.filter ?? 'all' }
    const queryHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const limit = Math.min(200, Math.max(1, query.limit ?? 50))
    return this.repository.transact(() => {
      this.db.prepare('DELETE FROM task_query_snapshots WHERE expires_at <= ?').run(this.now())
      let id: string; let offset = 0; let expiresAt: number; let saved: { groups: Array<{ root: TaskRun; members: TaskRun[] }>; attention: AttentionItem[]; counts: TaskPage['counts']; eventWatermark: number }
      if (query.cursor) {
        let cursor: { id: string; offset: number }
        try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as typeof cursor } catch { throw error('Invalid task cursor.') }
        if (!cursor || typeof cursor.id !== 'string' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw error('Invalid task cursor.')
        const row = this.db.prepare('SELECT * FROM task_query_snapshots WHERE id=?').get(cursor.id) as { id: string; query_hash: string; expires_at: number; data_json: string } | undefined
        if (!row || row.query_hash !== queryHash) throw error('Task query snapshot expired or filters changed. Refresh the list.')
        id = row.id; offset = cursor.offset; expiresAt = row.expires_at; saved = JSON.parse(row.data_json) as typeof saved
      } else {
        const all = (this.db.prepare('SELECT data_json FROM task_runs ORDER BY updated_at DESC,id DESC').all() as Array<{ data_json: string }>).map(row => this.withTiming(JSON.parse(row.data_json) as TaskRun) as TaskRun & { visible?: boolean; originThreadId?: string })
        const byId = new Map(all.map(task => [task.id, task]))
        const grouped = new Map<string, TaskRun[]>()
        for (const task of all) {
          let root = task; const seen = new Set<string>()
          while ((root.rootTaskId || root.parentTaskId) && !seen.has(root.id)) { seen.add(root.id); const parent = byId.get(root.rootTaskId ?? root.parentTaskId!); if (!parent) break; root = parent }
          if (root.visible === false || ['internal','chat'].includes((root as TaskRun & { visibility?: string }).visibility ?? '')) continue
          const group = grouped.get(root.id) ?? []; group.push(task); grouped.set(root.id, group)
        }
        const attention = this.repository.inbox(normalized.workspaceRoot || undefined)
        const groups = [...grouped.entries()].map(([id, members]) => ({ root: byId.get(id)!, members })).filter(({ root, members }) =>
          (!normalized.workspaceRoot || root.workspaceRoot === normalized.workspaceRoot) &&
          (!normalized.threadId || members.some(task => task.threadId === normalized.threadId || (task as TaskRun & { originThreadId?: string }).originThreadId === normalized.threadId)) &&
          (!normalized.search || members.some(task => `${task.goal}\n${task.workspaceRoot}\n${task.artifacts.map(a => a.relativePath).join('\n')}`.toLocaleLowerCase().includes(normalized.search))))
        const branch = (group: typeof groups[number]) => {
          const candidates = group.members.filter(task => !task.parentTaskId || Boolean(task.retryOfTaskId))
          const superseded = new Set(candidates.flatMap(task => task.retryOfTaskId ? [task.retryOfTaskId] : []))
          const current = candidates.filter(task => !superseded.has(task.id)).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? group.root
          const included = new Set([current.id]); let changed = true
          while(changed) { changed = false; for(const task of group.members) if(task.parentTaskId && included.has(task.parentTaskId) && !included.has(task.id)) { included.add(task.id); changed = true } }
          return { current, members: group.members.filter(task => included.has(task.id)) }
        }
        const needsAttention = (group: typeof groups[number]) => branch(group).members.some(task => ['waiting_user','waiting_approval','stalled','failed'].includes(task.status) || attention.some(item => item.status === 'pending' && item.taskId === task.id))
        const effective = (group: typeof groups[number]) => branch(group).current
        const matches = (group: typeof groups[number], filter: TaskViewFilter) => filter === 'all' || (filter === 'attention' ? needsAttention(group) : filter === 'completed' ? effective(group).status === 'completed' : !['completed','failed','cancelled'].includes(effective(group).status) && !needsAttention(group))
        const counts = Object.fromEntries((['ongoing','attention','completed','all'] as const).map(filter => [filter, groups.filter(group => matches(group,filter)).length])) as TaskPage['counts']
        saved = { groups: groups.filter(group => matches(group,normalized.filter)).sort((a,b) => b.members.reduce((m,t) => t.updatedAt > m ? t.updatedAt : m,'').localeCompare(a.members.reduce((m,t) => t.updatedAt > m ? t.updatedAt : m,'')) || b.root.id.localeCompare(a.root.id)), attention, counts, eventWatermark: this.watermark() }
        id = randomUUID(); expiresAt = this.now() + TTL_MS
        this.db.prepare('INSERT INTO task_query_snapshots VALUES(?,?,?,?)').run(id,queryHash,expiresAt,JSON.stringify(saved))
      }
      const slice = saved.groups.slice(offset, offset + limit)
      return { items: slice.map(g => g.root), relatedTasks: slice.flatMap(g => g.members.filter(t => t.id !== g.root.id)), attention: saved.attention, total: saved.groups.length, counts: saved.counts, snapshotId: id, expiresAt: new Date(expiresAt).toISOString(), eventWatermark: saved.eventWatermark, ...(offset + limit < saved.groups.length ? { nextCursor: Buffer.from(JSON.stringify({ id, offset: offset + limit })).toString('base64url') } : {}) }
    })
  }
}

export function taskFeedResponse(service: TaskViewService, request: Request): Response {
  const url = new URL(request.url)
  let seq = Math.max(Number(url.searchParams.get('since_seq') ?? 0), Number(request.headers.get('Last-Event-ID') ?? 0))
  if (!Number.isSafeInteger(seq) || seq < 0) return new Response('Invalid event cursor', { status: 400 })
  const encoder = new TextEncoder()
  let cleanup = () => {}
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)) }
      const deliver = () => {
        if (closed) return
        try {
          let batch: TaskFeedEvent[]
          do { batch = service.changes(seq); for (const event of batch) { seq = event.seq; send(`id: ${seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`) } } while (batch.length === 200)
        } catch { cleanup() }
      }
      const unsubscribe = service.repository.onChange(deliver)
      const heartbeat = setInterval(() => { deliver(); send(`: heartbeat ${seq}\n\n`) }, 15_000)
      heartbeat.unref?.()
      cleanup = () => { if (closed) return; closed = true; unsubscribe(); clearInterval(heartbeat); request.signal.removeEventListener('abort',cleanup); try { controller.close() } catch { /* already closed */ } }
      request.signal.addEventListener('abort',cleanup, { once: true })
      if (request.signal.aborted) cleanup(); else deliver()
    }, cancel() { cleanup() }
  }), { headers: { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform' } })
}
