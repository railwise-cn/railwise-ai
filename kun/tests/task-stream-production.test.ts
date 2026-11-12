import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startKunServe } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { FileWorkspaceTrustReader } from '../src/services/workspace-trust-reader.js'

type Frame = { id: number; data: { taskId?: string; kind: string } }

async function openStream(url: string, after: number) {
  const abort = new AbortController()
  const response = await fetch(url, { headers: { authorization: 'Bearer synthetic-stream', 'Last-Event-ID': String(after) }, signal: abort.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const readThrough = async (watermark: number): Promise<Frame[]> => {
    const frames: Frame[] = []
    while (!frames.length || frames.at(-1)!.id < watermark) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Task stream closed before the persisted watermark')
      pending += decoder.decode(chunk.value, { stream: true })
      const complete = pending.split('\n\n')
      pending = complete.pop()!
      for (const frame of complete) {
        const id = /^id: (\d+)$/m.exec(frame)
        const data = /^data: (.+)$/m.exec(frame)
        if (id && data) frames.push({ id: Number(id[1]), data: JSON.parse(data[1]) as Frame['data'] })
      }
    }
    return frames
  }
  return { readThrough, close: async () => { abort.abort(); await reader.cancel().catch(() => undefined) } }
}

it('replays root and child task events over real HTTP after a disconnect and Runtime restart without gaps or duplicate IDs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-task-stream-')))
  const trust = vi.spyOn(FileWorkspaceTrustReader.prototype, 'get').mockImplementation(async workspace => ({ canonicalRoot: workspace, level: 'workspace-write', revision: 1 }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-stream', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused-synthetic',
    approvalPolicy: 'on-request' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}) }
  let handle = await startKunServe(options)
  let stream: Awaited<ReturnType<typeof openStream>> | undefined
  try {
    const origin = await handle.runtime.threadService.create({ workspace: root, model: 'unused-synthetic', mode: 'agent' })
    const result = await handle.runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'synthetic-waiting', request: { prompt: '帮我处理钉钉待办' } })
    if (result.kind !== 'capability_required' || !result.task) throw new Error('Expected an unconfigured provider waiting task')
    const taskId = result.task.id
    let activeSubscriptions = 0
    const subscribe = handle.runtime.taskRepository!.onChange.bind(handle.runtime.taskRepository!)
    vi.spyOn(handle.runtime.taskRepository!, 'onChange').mockImplementation(listener => {
      activeSubscriptions++
      const release = subscribe(listener)
      return () => { activeSubscriptions--; release() }
    })
    const firstWatermark = handle.runtime.taskViewService!.watermark()
    stream = await openStream(`http://127.0.0.1:${handle.port}/v1/tasks/stream`, 0)
    const first = await stream.readThrough(firstWatermark)
    expect(first.map(frame => frame.id)).toEqual(handle.runtime.taskViewService!.changes(0).map(event => event.seq))
    await stream.close()
    stream = undefined
    await vi.waitFor(() => expect(activeSubscriptions).toBe(0))
    const repository = handle.runtime.taskRepository!
    const task = repository.get(taskId)!
    repository.create({ ...task, id: 'synthetic-child', threadId: 'synthetic-child-thread', parentTaskId: taskId, rootTaskId: taskId,
      childTaskIds: [], nodes: [], status: 'paused', revision: 0 })
    repository.update(taskId, task.revision, value => ({ ...value, status: 'paused', childTaskIds: ['synthetic-child'], updatedAt: new Date().toISOString() }))
    const expected = handle.runtime.taskViewService!.changes(firstWatermark).map(event => event.seq)
    expect(expected.length).toBeGreaterThan(0)
    handle.server.closeAllConnections()
    await handle.close()
    handle = await startKunServe(options)
    const restoredWatermark = handle.runtime.taskViewService!.watermark()
    stream = await openStream(`http://127.0.0.1:${handle.port}/v1/tasks/stream`, firstWatermark)
    const restored = await stream.readThrough(restoredWatermark)
    expect(restored.map(frame => frame.id)).toEqual(handle.runtime.taskViewService!.changes(firstWatermark).map(event => event.seq))
    expect(restored.map(frame => frame.id).slice(0, expected.length)).toEqual(expected)
    expect(new Set([...first, ...restored].map(frame => frame.id)).size).toBe(first.length + restored.length)
    expect(restored.some(frame => frame.data.taskId === 'synthetic-child')).toBe(true)
    expect(handle.runtime.taskRepository!.get(taskId)?.status).toBe('paused')
    await stream.close()
    stream = undefined
    // A caught-up stream must return headers immediately, even with no backlog.
    stream = await openStream(`http://127.0.0.1:${handle.port}/v1/tasks/stream`, restoredWatermark)
    await stream.close()
    stream = undefined
    const taskEvents = handle.runtime.taskRepository!.events(taskId)
    const lastTaskSequence = taskEvents.at(-1)!.sequence
    stream = await openStream(`http://127.0.0.1:${handle.port}/v1/tasks/${taskId}/stream`, lastTaskSequence - 1)
    expect((await stream.readThrough(lastTaskSequence)).map(frame => frame.id)).toEqual([lastTaskSequence])
    await stream.close()
    stream = undefined
    const execution = await handle.runtime.threadService.get(result.task.threadId)
    expect(execution).not.toBeNull()
    expect(execution!.turns).toHaveLength(0)
  } finally {
    await stream?.close()
    handle.server.closeAllConnections()
    await handle.close()
    trust.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
