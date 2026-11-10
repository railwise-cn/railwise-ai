import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { HybridSessionStore, HybridThreadStore } from '../src/adapters/hybrid/index.js'
import { makeAssistantTextItem, makeToolCallItem, makeUserItem } from '../src/domain/item.js'
import { appendTurnItem, createTurnRecord, startTurn } from '../src/domain/turn.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { TurnService } from '../src/services/turn-service.js'
import { InflightTracker } from '../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../src/loop/steering-queue.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import { SequentialIdGenerator } from '../src/ports/id-generator.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import Database from 'better-sqlite3'
import { getThread } from '../src/server/routes/threads.js'

describe('HybridThreadStore', () => {
  let dataDir = ''
  let openStores: HybridThreadStore[] = []
  let sqliteAvailable = false

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-hybrid-'))
    openStores = []
    sqliteAvailable = await canOpenBetterSqlite()
  })

  afterEach(async () => {
    for (const store of openStores) store.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('replays local coordination receipts as conversation history without constructing execution Turns', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({ id:'thr_receipt', title:'Connector admission', workspace:dataDir, model:'fixture', createdAt:'2026-11-10T00:00:00.000Z' })
    await threadStore.upsert(thread)
    const commandId = 'a'.repeat(32)
    const turns = createTurnService(threadStore, sessionStore)
    await turns.recordCommandExchange({ threadId:thread.id, commandId, userText:'帮我处理飞书审批', assistantText:'请先安装并授权飞书连接器', createdAt:'2026-11-10T00:00:01.000Z' })
    await turns.recordCommandExchange({ threadId:thread.id, commandId, userText:'帮我处理飞书审批', assistantText:'请先安装并授权飞书连接器', createdAt:'2026-11-10T00:00:01.000Z' })
    expect((await threadStore.get(thread.id))?.turns).toEqual([])
    expect((await sessionStore.loadEventsSince(thread.id, 0)).map(event => event.kind)).toEqual(['item_created','item_created'])
    const items = await sessionStore.loadItems(thread.id)
    expect(items).toHaveLength(2)
    expect(items.every(item => item.conversationReceiptId === `command_${commandId}`)).toBe(true)
    const detail = await getThread({ get:(id:string) => threadStore.get(id) } as Parameters<typeof getThread>[0], thread.id, sessionStore)
    expect(JSON.parse(detail.body)).toMatchObject({ turns:[], conversationItems:[{kind:'user_message'},{kind:'assistant_text'}] })

    // Earlier packages persisted these same IDs without an explicit marker.
    await sessionStore.rewriteItems(thread.id, items.map(({conversationReceiptId:_marker,...item}) => item))
    threadStore.close()
    const reopened = await createHybridStores()
    expect((await reopened.threadStore.get(thread.id))?.turns).toEqual([])
    const restored = await getThread({get:(id:string) => reopened.threadStore.get(id)} as Parameters<typeof getThread>[0], thread.id, reopened.sessionStore)
    expect(JSON.parse(restored.body).conversationItems).toHaveLength(2)

    const realTurn = createTurnRecord({id:'turn_real',threadId:thread.id,prompt:'继续原任务',createdAt:'2026-11-10T00:00:00.500Z'})
    const realUser = makeUserItem({id:'item_real_user',turnId:realTurn.id,threadId:thread.id,text:'继续原任务'})
    await reopened.sessionStore.appendItem(thread.id, realUser)
    // Drop a receipt projection saved by an old reader without dropping a
    // genuine running Turn in the same conversation.
    await reopened.threadStore.upsert({...thread,status:'running',turns:[
      startTurn(appendTurnItem(realTurn,realUser),'2026-11-10T00:00:00.500Z'),
      {...createTurnRecord({id:`command_${commandId}`,threadId:thread.id,prompt:'帮我处理飞书审批',createdAt:'2026-11-10T00:00:01.000Z'}),status:'completed'}
    ]})
    const mixed = await getThread({get:(id:string) => reopened.threadStore.get(id)} as Parameters<typeof getThread>[0], thread.id, reopened.sessionStore)
    expect(JSON.parse(mixed.body)).toMatchObject({status:'running',turns:[{id:'turn_real',status:'running'}]})
    expect(JSON.parse(mixed.body).turns).toHaveLength(1)
    expect(JSON.parse(mixed.body).conversationItems).toHaveLength(2)
  })

  it('keeps item bodies in JSONL and uses SQLite metadata indexing when available', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const record = await seedThreadWithMessage(threadStore, sessionStore, 'hello from jsonl')

    const summaries = await threadStore.list({ search: 'Hybrid demo' })
    expect(summaries.map((thread) => thread.id)).toEqual([record.id])
    if (sqliteAvailable) {
      await expect(stat(join(dataDir, 'index.sqlite3'))).resolves.toBeTruthy()
    } else {
      await expect(stat(join(dataDir, 'index.sqlite3'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const metadata = await readFile(
      join(dataDir, 'threads', record.id, 'metadata.jsonl'),
      'utf-8'
    )
    const messages = await readFile(
      join(dataDir, 'threads', record.id, 'messages.jsonl'),
      'utf-8'
    )
    expect(metadata).not.toContain('hello from jsonl')
    expect(messages).toContain('hello from jsonl')

    const fetched = await threadStore.get(record.id)
    expect(fetched?.turns[0]?.prompt).toBe('hello from jsonl')
    expect(fetched?.turns[0]?.items[0]).toMatchObject({
      kind: 'user_message',
      text: 'hello from jsonl'
    })
  })

  it('lists existing SQLite rows without replaying damaged message or event logs', async () => {
    const first = await createHybridStores()
    const record = await seedThreadWithMessage(first.threadStore, first.sessionStore, 'indexed already')
    first.threadStore.close()

    await writeFile(join(dataDir, 'threads', record.id, 'messages.jsonl'), '{not-json\n', 'utf8')
    await writeFile(join(dataDir, 'threads', record.id, 'events.jsonl'), '{not-json\n', 'utf8')

    const reopened = await createHybridStores()
    const summaries = await reopened.threadStore.list({ search: 'Hybrid demo' })

    expect(summaries.map((thread) => thread.id)).toEqual([record.id])
  })

  it('rebuilds the SQLite index from JSONL after the database is deleted', async () => {
    const first = await createHybridStores()
    const record = await seedThreadWithMessage(first.threadStore, first.sessionStore, 'recover me')
    first.threadStore.close()

    await rm(join(dataDir, 'index.sqlite3'), { force: true })
    await rm(join(dataDir, 'index.sqlite3-wal'), { force: true })
    await rm(join(dataDir, 'index.sqlite3-shm'), { force: true })

    const rebuilt = await createHybridStores()
    await rebuilt.threadStore.waitForBackfill()
    const summaries = await rebuilt.threadStore.list({ search: 'Hybrid demo' })
    expect(summaries.map((thread) => thread.id)).toEqual([record.id])

    const fetched = await rebuilt.threadStore.get(record.id)
    expect(fetched?.turns[0]?.items[0]).toMatchObject({
      kind: 'user_message',
      text: 'recover me'
    })
  })

  it('indexes event high water and usage events as they are appended', async () => {
    if (!sqliteAvailable) return
    const { threadStore, sessionStore } = await createHybridStores()
    const record = await seedThreadWithMessage(threadStore, sessionStore, 'track usage')
    await sessionStore.appendEvent(record.id, {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-04T00:00:03.000Z',
      threadId: record.id,
      turnId: 'turn_hybrid',
      model: 'deepseek-chat',
      usage: usage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, turns: 1 })
    })
    await sessionStore.appendEvent(record.id, {
      kind: 'usage',
      seq: 5,
      timestamp: '2026-06-04T00:00:05.000Z',
      threadId: record.id,
      turnId: 'turn_hybrid',
      model: 'deepseek-chat',
      usage: usage({ promptTokens: 30, completionTokens: 10, totalTokens: 40, turns: 2 })
    })

    await writeFile(join(dataDir, 'threads', record.id, 'events.jsonl'), '{not-json\n', 'utf8')

    await expect(sessionStore.highestSeq(record.id)).resolves.toBe(5)
    await expect(sessionStore.loadLatestUsageSnapshots()).resolves.toMatchObject([
      {
        threadId: record.id,
        seq: 5,
        usage: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40,
          turns: 2
        }
      }
    ])
    await expect(sessionStore.loadUsageRecords({ threadId: record.id })).resolves.toMatchObject([
      {
        threadId: record.id,
        model: 'deepseek-chat',
        completedAt: '2026-06-04T00:00:03.000Z',
        usage: { totalTokens: 15, turns: 1 }
      },
      {
        threadId: record.id,
        model: 'deepseek-chat',
        completedAt: '2026-06-04T00:00:05.000Z',
        usage: { totalTokens: 25, turns: 1 }
      }
    ])
  })

  it('recovers turn attachment ids from user messages when metadata is stripped', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_attach',
      title: 'Attachment demo',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    const turn = createTurnRecord({
      id: 'turn_attach',
      threadId: thread.id,
      prompt: 'describe',
      model: thread.model,
      createdAt: '2026-06-04T00:00:01.000Z'
    })
    const item = makeUserItem({
      id: 'item_turn_attach_user',
      turnId: turn.id,
      threadId: thread.id,
      text: 'describe',
      attachmentIds: ['att_image']
    })
    const record = {
      ...thread,
      updatedAt: '2026-06-04T00:00:02.000Z',
      turns: [startTurn(appendTurnItem(turn, item), '2026-06-04T00:00:01.000Z')]
    }
    await sessionStore.appendItem(record.id, item)
    await threadStore.upsert(record)

    const fetched = await threadStore.get(record.id)

    expect(fetched?.turns[0]?.attachmentIds).toEqual(['att_image'])
    expect(fetched?.turns[0]?.items[0]).toMatchObject({
      kind: 'user_message',
      attachmentIds: ['att_image']
    })
  })

  it('does not synthesize duplicate turns when startTurn writes through the hybrid store', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_start',
      title: 'Start demo',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)

    const response = await turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'describe this data',
        model: 'deepseek-v4-pro',
        attachmentIds: ['att_image'],
        mode: 'agent'
      }
    })
    const fetched = await threadStore.get(thread.id)
    const items = await sessionStore.loadItems(thread.id)

    expect(fetched?.turns.map((turn) => turn.id)).toEqual([response.turnId])
    expect(fetched?.turns[0]).toMatchObject({
      id: response.turnId,
      attachmentIds: ['att_image'],
      model: 'deepseek-v4-pro'
    })
    expect(fetched?.turns[0]?.items[0]).toMatchObject({
      kind: 'user_message',
      attachmentIds: ['att_image']
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'user_message',
      attachmentIds: ['att_image']
    })
  })

  it('returns one Runtime Turn for concurrent starts with the same idempotency key', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_idempotent_start',
      title: 'Idempotent IM start',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)
    const request = {
      threadId: thread.id,
      request: {
        prompt: 'handle this remote message once',
        idempotencyKey: 'im:weixin:account-1:message-1'
      }
    }

    const [first, duplicate] = await Promise.all([
      turns.startTurn(request),
      turns.startTurn(request)
    ])
    const fetched = await threadStore.get(thread.id)
    const items = await sessionStore.loadItems(thread.id)

    expect(duplicate).toEqual(first)
    expect(fetched?.turns).toHaveLength(1)
    expect(fetched?.turns[0]).toMatchObject({
      id: first.turnId,
      idempotencyKey: 'im:weixin:account-1:message-1'
    })
    expect(items.filter((item) => item.kind === 'user_message')).toHaveLength(1)
  })

  it('records a completed deterministic plan transcript without opening model work', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_completed_plan',
      title: 'Completed plan transcript',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      domain: 'engineering',
      projectId: 'project-plan',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)

    const first = await turns.recordCompletedTurn({
      threadId: thread.id,
      userText: '先生成计划，不执行',
      assistantText: '计划已生成，审批前不执行任何工具。',
      idempotencyKey: 'engineering-plan-transcript:eplan-1'
    })
    const replay = await turns.recordCompletedTurn({
      threadId: thread.id,
      userText: '先生成计划，不执行',
      assistantText: '计划已生成，审批前不执行任何工具。',
      idempotencyKey: 'engineering-plan-transcript:eplan-1'
    })
    const restored = await threadStore.get(thread.id)

    expect(replay).toEqual(first)
    expect(restored?.status).toBe('idle')
    expect(restored?.turns).toHaveLength(1)
    expect(restored?.turns[0]?.status).toBe('completed')
    expect(restored?.turns[0]?.items.map((item) => item.kind)).toEqual(['user_message', 'assistant_text'])
    expect((await sessionStore.loadItems(thread.id)).map((item) => item.kind)).toEqual(['user_message', 'assistant_text'])
  })

  it('migrates message counts to user and assistant messages only', async () => {
    if (!sqliteAvailable) return
    const first = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_message_count_migration',
      title: 'Message count migration',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    const turn = createTurnRecord({
      id: 'turn_message_count_migration',
      threadId: thread.id,
      prompt: '复核计划',
      createdAt: '2026-06-04T00:00:01.000Z',
      status: 'completed'
    })
    const items = [
      makeUserItem({ id: 'item_count_user', turnId: turn.id, threadId: thread.id, text: '复核计划' }),
      makeAssistantTextItem({ id: 'item_count_assistant', turnId: turn.id, threadId: thread.id, text: '计划摘要', status: 'completed' }),
      makeToolCallItem({ id: 'item_count_tool', turnId: turn.id, threadId: thread.id, callId: 'call-count', toolName: 'read', arguments: {}, status: 'completed' })
    ]
    const completedTurn = items.reduce((current, item) => appendTurnItem(current, item), turn)
    for (const item of items) await first.sessionStore.appendItem(thread.id, item)
    await first.threadStore.upsert({ ...thread, status: 'idle', turns: [completedTurn], updatedAt: '2026-06-04T00:00:02.000Z' })
    first.threadStore.close()

    const db = new Database(join(dataDir, 'index.sqlite3'))
    db.prepare('UPDATE threads SET message_count = 93, message_count_version = 0 WHERE id = ?').run(thread.id)
    db.close()

    const reopened = await createHybridStores()
    const summary = (await reopened.threadStore.list({ includeArchived: true })).find((item) => item.id === thread.id)
    expect(summary?.messageCount).toBe(2)
  })

  it('replays the same persisted workspace references for an idempotent reconnect', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    await writeFile(join(dataDir, 'reconnect brief.md'), 'PRIVATE-RECONNECT-BODY')
    const thread = createThreadRecord({
      id: 'thr_reference_reconnect',
      title: 'Reference reconnect',
      workspace: dataDir,
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)
    const request = {
      prompt: 'inspect the reconnect brief',
      workspaceReferences: [{ path: 'reconnect brief.md', kind: 'file' as const }],
      idempotencyKey: 'renderer:reconnect:reference-1'
    }

    const first = await turns.startTurn({ threadId: thread.id, request })
    const replayed = await turns.startTurn({ threadId: thread.id, request })
    const persisted = await threadStore.get(thread.id)

    expect(replayed).toEqual(first)
    expect(persisted?.turns).toHaveLength(1)
    expect(persisted?.turns[0]?.workspaceReferences).toEqual([
      { path: 'reconnect brief.md', kind: 'file' }
    ])
    expect(persisted?.turns[0]?.prompt).not.toContain('PRIVATE-RECONNECT-BODY')
  })

  it('rejects reusing a generic idempotency key for a different prompt', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_idempotent_prompt_conflict',
      title: 'Idempotent prompt conflict',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)
    const idempotencyKey = 'im:feishu:account-1:message-1'

    await turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'first request', idempotencyKey }
    })

    await expect(turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'different request', idempotencyKey }
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('allows retrying the same idempotency key after start fan-out compensation', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_idempotent_start_retry',
      title: 'Idempotent start retry',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const idempotencyKey = 'im:feishu:account-1:message-retry'
    const turns = createTurnService(threadStore, sessionStore, { failEventKind: 'turn_started' })

    await expect(turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'retryable request', idempotencyKey }
    })).rejects.toThrow('event store unavailable')

    const failed = await threadStore.get(thread.id)
    expect(failed?.turns[0]?.status).toBe('failed')
    expect(failed?.turns[0]?.idempotencyKey).not.toBe(idempotencyKey)

    const retry = await turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'retryable request', idempotencyKey }
    })
    expect(retry.turnId).not.toBe(failed?.turns[0]?.id)
    expect((await threadStore.get(thread.id))?.turns.map((turn) => turn.status)).toEqual(['failed', 'running'])
  })

  it('enforces the global turn limit across concurrent starts on different threads', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const turns = createTurnService(threadStore, sessionStore)
    const threads = Array.from({ length: 6 }, (_, index) => createThreadRecord({
      id: `thr_global_limit_${index}`,
      title: `Global limit ${index}`,
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    }))
    await Promise.all(threads.map((thread) => threadStore.upsert(thread)))

    const settled = await Promise.allSettled(threads.map((thread) => turns.startTurn({
      threadId: thread.id,
      request: { prompt: `run ${thread.id}` }
    })))

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(4)
    const rejected = settled.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(2)
    for (const result of rejected) {
      if (result.status !== 'rejected') continue
      expect(result.reason).toMatchObject({ code: 'resource_limit' })
    }
  })

  it('validates workspace references when no validator is injected', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_default_reference_validator',
      title: 'Default reference validator',
      workspace: dataDir,
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)

    await expect(turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'inspect the reference',
        workspaceReferences: [{ path: '../outside.txt', kind: 'file' }]
      }
    })).rejects.toThrow(/escapes the workspace/u)
    await expect(sessionStore.loadItems(thread.id)).resolves.toEqual([])
  })

  it('releases a reserved global slot when workspace reference validation rejects', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_reference_slot_release',
      title: 'Reference slot release',
      workspace: dataDir,
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(turns.startTurn({
        threadId: thread.id,
        request: {
          prompt: `reject ${attempt}`,
          workspaceReferences: [{ path: '../outside.txt', kind: 'file' }]
        }
      })).rejects.toThrow(/escapes the workspace/u)
    }

    await expect(turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'a valid turn can still start' }
    })).resolves.toMatchObject({ threadId: thread.id })
  })

  it('marks a partially started Turn failed when turn-start event persistence fails', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_start_event_failure',
      title: 'Start event failure',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    await threadStore.upsert(thread)
    const turns = createTurnService(threadStore, sessionStore, {
      failEventKind: 'turn_started'
    })

    await expect(turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'this start will fail' }
    })).rejects.toThrow(/event store unavailable/u)

    const recovered = await threadStore.get(thread.id)
    expect(recovered).toMatchObject({ status: 'idle' })
    expect(recovered?.turns).toMatchObject([
      { status: 'failed', error: 'event store unavailable' }
    ])
    await expect(turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'a later start is not blocked' }
    })).resolves.toMatchObject({ threadId: thread.id })
  })

  it('deduplicates damaged turn metadata and recovers attachment ids from earlier metadata lines', async () => {
    const { threadStore, sessionStore } = await createHybridStores()
    const thread = createThreadRecord({
      id: 'thr_damaged',
      title: 'Damaged metadata',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    const turn = startTurn(
      createTurnRecord({
        id: 'turn_damaged',
        threadId: thread.id,
        prompt: 'describe',
        model: 'deepseek-v4-pro',
        attachmentIds: ['att_from_history'],
        createdAt: '2026-06-04T00:00:01.000Z'
      }),
      '2026-06-04T00:00:01.500Z'
    )
    const damagedTurn = {
      ...turn,
      status: 'completed' as const,
      prompt: '',
      items: [],
      attachmentIds: [],
      finishedAt: '2026-06-04T00:00:03.000Z'
    }
    await mkdir(join(dataDir, 'threads', thread.id), { recursive: true })
    await writeFile(
      join(dataDir, 'threads', thread.id, 'metadata.jsonl'),
      [
        {
          kind: 'thread_metadata',
          version: 1,
          timestamp: '2026-06-04T00:00:02.000Z',
          thread: { ...thread, status: 'running', turns: [{ ...turn, prompt: '', items: [] }] }
        },
        {
          kind: 'thread_metadata',
          version: 1,
          timestamp: '2026-06-04T00:00:03.000Z',
          thread: {
            ...thread,
            status: 'idle',
            updatedAt: '2026-06-04T00:00:03.000Z',
            turns: [damagedTurn, damagedTurn]
          }
        }
      ].map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8'
    )
    await sessionStore.appendItem(thread.id, makeUserItem({
      id: 'item_turn_damaged_user',
      turnId: turn.id,
      threadId: thread.id,
      text: 'describe'
    }))

    const fetched = await threadStore.get(thread.id)

    expect(fetched?.turns).toHaveLength(1)
    expect(fetched?.turns[0]).toMatchObject({
      id: turn.id,
      attachmentIds: ['att_from_history']
    })
    expect(fetched?.turns[0]?.items[0]).toMatchObject({
      kind: 'user_message',
      text: 'describe'
    })
  })

  async function createHybridStores(): Promise<{
    threadStore: HybridThreadStore
    sessionStore: HybridSessionStore
  }> {
    const threadStore = new HybridThreadStore({ dataDir })
    await threadStore.ready()
    openStores.push(threadStore)
    return {
      threadStore,
      sessionStore: new HybridSessionStore({ dataDir, index: threadStore })
    }
  }

  async function seedThreadWithMessage(
    threadStore: HybridThreadStore,
    sessionStore: HybridSessionStore,
    text: string
  ) {
    const thread = createThreadRecord({
      id: 'thr_hybrid',
      title: 'Hybrid demo',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      createdAt: '2026-06-04T00:00:00.000Z'
    })
    const turn = createTurnRecord({
      id: 'turn_hybrid',
      threadId: thread.id,
      prompt: text,
      model: thread.model,
      createdAt: '2026-06-04T00:00:01.000Z'
    })
    const item = makeUserItem({
      id: 'item_turn_hybrid_user',
      turnId: turn.id,
      threadId: thread.id,
      text
    })
    const record = {
      ...thread,
      updatedAt: '2026-06-04T00:00:02.000Z',
      turns: [startTurn(appendTurnItem(turn, item), '2026-06-04T00:00:01.000Z')]
    }
    await sessionStore.appendItem(record.id, item)
    await threadStore.upsert(record)
    return record
  }

  function createTurnService(
    threadStore: HybridThreadStore,
    sessionStore: HybridSessionStore,
    options: { failEventKind?: string } = {}
  ): TurnService {
    const bus = new InMemoryEventBus()
    const events = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (threadId) => bus.allocateSeq(threadId),
      nowIso: () => '2026-06-04T00:00:02.000Z'
    })
    if (options.failEventKind) {
      const originalRecord = events.record.bind(events)
      let failed = false
      vi.spyOn(events, 'record').mockImplementation(async (event) => {
        if (!failed && event.kind === options.failEventKind) {
          failed = true
          throw new Error('event store unavailable')
        }
        return originalRecord(event)
      })
    }
    return new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor(),
      ids: new SequentialIdGenerator(),
      nowIso: () => '2026-06-04T00:00:02.000Z'
    })
  }

  async function canOpenBetterSqlite(): Promise<boolean> {
    try {
      const sqlite = await import('better-sqlite3')
      const Database = sqlite.default
      const db = new Database(':memory:')
      db.close()
      return true
    } catch {
      return false
    }
  }

  function usage(overrides: Partial<UsageSnapshot>): UsageSnapshot {
    const promptTokens = overrides.promptTokens ?? 10
    const completionTokens = overrides.completionTokens ?? 5
    const cacheHitTokens = overrides.cacheHitTokens ?? 0
    const cacheMissTokens = overrides.cacheMissTokens ?? Math.max(promptTokens - cacheHitTokens, 0)
    const cacheTotal = cacheHitTokens + cacheMissTokens
    return {
      promptTokens,
      completionTokens,
      totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
      cachedTokens: overrides.cachedTokens ?? cacheHitTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheHitRate: cacheTotal === 0 ? null : cacheHitTokens / cacheTotal,
      turns: overrides.turns ?? 1
    }
  }
})
