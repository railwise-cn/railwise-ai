import { describe, expect, it } from 'vitest'
import type { ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

describe('AgentLoop sandbox policy', () => {
  it('uses the active turn sandbox when advertising tools to the model', async () => {
    let observedRequest: ModelRequest | null = null
    const h = makeHarness({
      provider: 'sandbox-observer',
      model: 'sandbox-observer',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        observedRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h, {
      request: {
        prompt: 'inspect only',
        approvalPolicy: 'on-request',
        sandboxMode: 'read-only'
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    const request = observedRequest as ModelRequest | null
    if (!request) throw new Error('expected model request')
    const toolNames = request.tools.map((tool) => tool.name)
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']))
    expect(toolNames).not.toContain('bash')
    expect(toolNames).not.toContain('edit')
    expect(toolNames).not.toContain('write')
    expect(request.contextInstructions?.join('\n') ?? '').not.toContain('Shell runtime:')
  })
})

describe('AgentLoop persisted execution grants', () => {
  it('uses actual workspace trust and persists an immutable Turn-bound grant', async () => {
    const { FileWorkspaceTrustReader } = await import('../src/services/workspace-trust-reader.js')
    const { mkdtemp, mkdir, writeFile, rm, realpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'railwise-loop-trust-')))
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    const manifest = join(dir, 'trust.json')
    await writeFile(manifest, JSON.stringify({ schema: 'workwise.workspace-trust', version: 1, workspaces: [{ canonicalRoot: workspace, level: 'read-only', revision: 4 }] }))
    let observedRequest: ModelRequest | undefined
    const h = makeHarness({ provider: 'test', model: 'test', async *stream(request) { observedRequest = request; yield { kind: 'completed', stopReason: 'stop' } } }, { workspaceTrust: new FileWorkspaceTrustReader(manifest) })
    try {
      await bootstrapThread(h, { workspace, request: { prompt: '查看资料', sandboxMode: 'danger-full-access' } })
      expect(await h.loop.runTurn(h.threadId, h.turnId)).toBe('completed')
      expect(observedRequest?.tools.map(tool => tool.name)).not.toContain('bash')
      expect(observedRequest?.tools.map(tool => tool.name)).not.toContain('write')
      const turn = await h.turns.getTurn(h.threadId, h.turnId)
      expect(turn?.executionGrant).toMatchObject({ threadId: h.threadId, turnId: h.turnId, workspaceTrust: 'read-only', workspaceRevision: 4, sandboxMode: 'read-only', pathAllowlist: [workspace] })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

it('revokes an already displayed approval when workspace permissions change', async () => {
  const { FileWorkspaceTrustReader } = await import('../src/services/workspace-trust-reader.js')
  const { LocalToolHost } = await import('../src/adapters/tool/local-tool-host.js')
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'railwise-loop-revoke-')))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const manifest = join(dir, 'trust.json')
  const setTrust = (level: string, revision: number) => writeFile(manifest, JSON.stringify({ schema: 'workwise.workspace-trust', version: 1, workspaces: [{ canonicalRoot: workspace, level, revision }] }))
  await setTrust('workspace-write', 1)
  let executed = 0
  const h = makeHarness({ provider: 'test', model: 'test', async *stream() {
    yield { kind: 'tool_call_complete', callId: 'external-write', toolName: 'complete_task', arguments: { taskId: 'remote-1' } }
    yield { kind: 'completed', stopReason: 'tool_calls' }
  } }, {
    workspaceTrust: new FileWorkspaceTrustReader(manifest),
    tools: [LocalToolHost.defineTool({ name: 'complete_task', description: 'Complete task', inputSchema: {}, policy: 'on-request', requireExplicitApproval: true, execute: async () => { executed++; return { output: { remoteOperationId: 'remote-1' } } } })]
  })
  try {
    await bootstrapThread(h, { workspace, request: { prompt: '处理当前事项', approvalPolicy: 'auto', sandboxMode: 'workspace-write' } })
    const run = h.loop.runTurn(h.threadId, h.turnId)
    let pending: ReturnType<typeof h.approvalGate.pending>[number] | undefined
    for (let index = 0; index < 100; index++) {
      pending = h.approvalGate.pending(h.threadId)[0]
      if (pending) break
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    if (!pending) throw new Error('expected explicit external write approval')
    await setTrust('read-only', 2)
    h.approvalGate.resolve(pending.id, 'allow')
    expect(await run).toBe('failed')
    expect(executed).toBe(0)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.find(item => item.kind === 'tool_result')).toMatchObject({ isError: true, output: { code: 'execution_grant_revoked' } })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
