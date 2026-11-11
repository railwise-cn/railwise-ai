import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'

function options(root: string) {
  return { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-update', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}) }
}

describe('update handoff through production Runtime and SQLite', () => {
  it('finds active work beyond user pagination and blocks new dispatch through both routes and services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-update-runtime-'))
    const runtime = await createKunServeRuntime(options(root))
    try {
      const thread = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'unused' })
      const template = runtime.taskController!.createWaitingTask({ id: 'waiting', thread, request: { prompt: '合成更新检查' }, reason: '待用户授权' })
      runtime.taskRepository!.create({ ...template, nodes: [], id: 'older-active', status: 'running', updatedAt: '2020-01-01T00:00:00.000Z' })
      for (let i = 0; i < 620; i += 1) runtime.taskRepository!.create({ ...template, nodes: [], id: `finished-${i}`, status: 'completed' })
      const router = buildRouter(runtime)
      const snapshotRoute = router.match('GET', '/v1/runtime/update')!
      const response = await snapshotRoute.handler(new Request('http://runtime/v1/runtime/update', { headers: { Authorization: 'Bearer synthetic-update' } }), { params: {} })
      const snapshot = JSON.parse(String((response as { body: unknown }).body))
      expect(snapshot.activeWork).toEqual([expect.objectContaining({ id: 'older-active' })])
      const prepare = router.match('POST', '/v1/runtime/update/prepare')!
      const prepared = await prepare.handler(new Request('http://runtime/v1/runtime/update/prepare', { method: 'POST', headers: { Authorization: 'Bearer synthetic-update', 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedSnapshotId: snapshot.snapshotId }) }), { params: {} })
      expect(JSON.parse(String((prepared as { body: unknown }).body)).ok).toBe(true)
      await expect(runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'Do not execute' } })).rejects.toThrow('preparing an update')
      await expect(runtime.flowService!.run('missing', {})).rejects.toThrow('preparing an update')
      const newThread = router.match('POST', '/v1/threads')!
      const blocked = await newThread.handler(new Request('http://runtime/v1/threads', { method: 'POST', headers: { Authorization: 'Bearer synthetic-update' }, body: '{}' }), { params: {} })
      expect((blocked as { status: number }).status).toBe(503)
      expect(runtime.taskRepository!.get('waiting')?.status).toBe('waiting_user')
      expect((await runtime.threadService.get(thread.id))?.turns).toHaveLength(0)
    } finally { await runtime.shutdown?.(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves waiting and paused work through handoff and restart without creating a Turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-update-waiting-'))
    let runtime = await createKunServeRuntime(options(root))
    try {
      const thread = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'unused' })
      const waiting = runtime.taskController!.createWaitingTask({ id: 'waiting', thread, request: { prompt: '合成等待事项' }, reason: '待授权' })
      runtime.taskRepository!.create({ ...waiting, nodes: [], id: 'paused', status: 'paused' })
      expect(runtime.updateLifecycle!.snapshot().activeWork).toHaveLength(0)
      await runtime.updateLifecycle!.prepare()
      await runtime.shutdown?.()
      runtime = await createKunServeRuntime(options(root))
      expect(runtime.taskRepository!.get('waiting')?.status).toBe('waiting_user')
      expect(runtime.taskRepository!.get('paused')?.status).toBe('paused')
      expect((await runtime.threadService.get(thread.id))?.turns).toHaveLength(0)
    } finally { await runtime.shutdown?.(); await rm(root, { recursive: true, force: true }) }
  })
})
