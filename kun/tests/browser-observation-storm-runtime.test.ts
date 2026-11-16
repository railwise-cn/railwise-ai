import { describe, expect, it } from 'vitest'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { ToolStormBreaker } from '../src/loop/tool-storm-breaker.js'
import type { ToolCallLike, ToolHost, ToolHostContext, ToolHostResult } from '../src/ports/tool-host.js'
import { AgentLoop } from '../src/loop/agent-loop.js'
import { makeToolResultItem } from '../src/domain/item.js'
import type { TaskController } from '../src/services/task-controller.js'
import type { ModelClient } from '../src/ports/model-client.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

const grant = ExecutionGrantSchema.parse({ id: 'browser-fixture-grant', taskId: 'browser-fixture-task', threadId: 'browser-fixture-thread', turnId: 'browser-fixture-turn',
  workspaceRoot: '/controlled-workspace', workspaceTrust: 'read-only', agentTrust: 'workspace-write', sandboxMode: 'read-only', approvalPolicy: 'auto',
  pathAllowlist: [], readPathAllowlist: [], writePathAllowlist: [], workspaceRevision: 0, agentRevision: 0, revision: 0,
  browserScope: { browserInstanceId: 'controlled-browser', revision: 4, origins: ['https://gov.example.test'], interaction: 'interact', verificationPolicy: 'public_query_target' },
  allowedProviderIds: ['browser-skill'], allowedToolNames: ['browser_session_start', 'browser_observe', 'browser_navigate', 'browser_get_html', 'browser_fill', 'browser_click'],
  idempotencyKey: 'browser-fixture-grant', issuedAt: '2026-11-16T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' })

describe('trusted browser observation recovery storm boundary', () => {
  it('executes a fresh same-session observation after the actual no-effect native observation_changed shape', async () => {
    let observations = 0
    const names = grant.allowedToolNames!
    const host = new LocalToolHost({ registry: new CapabilityRegistry([{ id: 'browser-skill', kind: 'skill', enabled: true, available: true,
      tools: names.map(name => LocalToolHost.defineTool({ name, description: 'Controlled browser protocol fixture; no browser process or website.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true }, policy: 'auto',
        execute: async () => {
          if (name === 'browser_session_start') return { output: { status: 'succeeded', browserInstanceId: 'controlled-browser', sessionId: 'gvao', tabId: 7, agentWindowId: 6 } }
          if (name === 'browser_observe') {
            observations++
            const observation = { context_id: 'native-context-'+observations, observation_id: 'native-observation-'+observations,
              control_policy: 'target', observation: { text: 'RootWebArea "公开采购首页"\n107 refs', ref_count: 107, truncated: false } }
            return { isError: observations === 1, output: { status: observations === 1 ? 'failed' : 'succeeded', provider: 'browser-skill', sessionId: 'gvao', tabId: 7,
              sourceUrl: 'https://gov.example.test/', observation, ...(observations === 1 ? { code: 'browser_navigation_timeout', stage: 'readback', readback: { status: 'partial', navigationReplayed: false } } : {}) } }
          }
          if (name === 'browser_navigate') return { isError: true, output: { status: 'failed', provider: 'browser-skill', action: 'navigate', stage: 'action',
            code: 'permission_denied', vendorCode: 'permission_denied', vendorReason: 'observation_changed', vendorPhase: 'observation', effectState: 'none', exitCode: 1 } }
          return { output: { status: 'succeeded', provider: 'browser-skill', sessionId: 'gvao', html: '<main>实际受控页面字节</main>', truncated: false, readScope: 'document' } }
        } })) }]) })
    const context: ToolHostContext = { threadId: grant.threadId, turnId: grant.turnId, workspace: grant.workspaceRoot, threadMode: 'agent',
      sandboxMode: 'read-only', approvalPolicy: 'auto', executionGrant: grant, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' }
    const breaker = new ToolStormBreaker(), executed: ToolHostResult[] = []
    const calls: Array<[string, Record<string, unknown>]> = [
      ['browser_session_start', {}], ['browser_observe', { sessionId: 'gvao' }], ['browser_get_html', { sessionId: 'gvao' }],
      ['browser_observe', { sessionId: 'gvao' }], ['browser_navigate', { sessionId: 'gvao', url: 'https://gov.example.test/site/search', contextId: 'native-context-2' }],
      ['browser_observe', { sessionId: 'gvao' }]
    ]
    for (const [index, [toolName, args]] of calls.entries()) {
      const call: ToolCallLike = { callId: 'call-'+index, toolName, providerId: 'browser-skill', arguments: args }
      const inspected = breaker.inspect(call, grant)
      if (inspected.suppress) continue
      const result = await host.execute(call, context)
      executed.push(result)
      breaker.observeResult(call, result, grant)
    }
    expect(observations).toBe(3)
    expect(executed.at(-1)?.item).toMatchObject({ kind: 'tool_result', isError: false, output: { status: 'succeeded', observation: { context_id: 'native-context-3' } } })
  })

  it('wires actual scoped Host recovery results through AgentLoop before the next model dispatch', async () => {
    let observations = 0, step = 0
    const script: Array<[string, Record<string, unknown>]> = [
      ['browser_session_start', {}], ['browser_observe', { sessionId: 'gvao' }], ['browser_get_html', { sessionId: 'gvao' }],
      ['browser_observe', { sessionId: 'gvao' }], ['browser_navigate', { sessionId: 'gvao', url: 'https://gov.example.test/site/search', contextId: 'context-2' }],
      ['browser_observe', { sessionId: 'gvao' }]
    ]
    const model: ModelClient = { provider: 'controlled-no-model', model: 'controlled-no-model', async *stream() {
      const next = script[step++]
      if (next) { yield { kind: 'tool_call_complete', callId: 'loop-call-'+step, toolName: next[0], arguments: next[1] }; yield { kind: 'completed', stopReason: 'tool_calls' }; return }
      yield { kind: 'assistant_text_delta', text: '已读取本轮受控页面。' }; yield { kind: 'completed', stopReason: 'stop' }
    } }
    const host: ToolHost = { id: 'controlled-browser-host', async listTools() {
      return grant.allowedToolNames!.map(name => ({ name, description: 'Controlled no-browser fixture', inputSchema: { type: 'object' }, toolKind: 'tool_call' as const,
        providerId: 'browser-skill', providerKind: 'skill' as const }))
    }, async execute(call, context) {
      expect(call.providerId).toBe('browser-skill')
      let output: Record<string, unknown> = { status: 'succeeded', provider: 'browser-skill', sessionId: 'gvao', browserInstanceId: 'controlled-browser', tabId: 7 }
      let isError = false
      if (call.toolName === 'browser_observe') {
        observations++; isError = observations === 1
        output = { ...output, status: isError ? 'failed' : 'succeeded', observation: { context_id: 'context-'+observations,
          observation_id: 'observation-'+observations, observation: { text: 'RootWebArea "公开采购首页"', ref_count: 107 } },
          ...(isError ? { code: 'browser_navigation_timeout', stage: 'readback' } : {}) }
      } else if (call.toolName === 'browser_navigate') {
        isError = true; output = { status: 'failed', provider: 'browser-skill', code: 'permission_denied', vendorReason: 'observation_changed',
          vendorPhase: 'observation', effectState: 'none', stage: 'action' }
      }
      return { approved: true, item: makeToolResultItem({ id: call.callId+'-result', threadId: context.threadId, turnId: context.turnId,
        callId: call.callId, toolName: call.toolName, output, isError }) }
    } }
    const h = makeHarness(model), active = { id: 'browser-fixture-task', attempts: 1 }
    const tasks = { activeTask: () => active, managedArtifactRoot: () => undefined, registerExecutionAbort: () => () => undefined,
      beginAttempt: () => active, pendingDeliveries: () => [], tokenForTurn: () => undefined, beginWork: () => () => undefined,
      workBudget: () => undefined, recordCost: () => undefined, beginToolOperation: () => undefined, endRun: () => undefined,
      hasUnknownToolOutcome: () => false, suspendWebArtifactProgress: async () => null,
      recordAttemptFailure: (_thread: string, _turn: string, code: string, reason: string) => ({ kind: 'failed', reason: code+': '+reason }),
      assessCandidate: async () => ({ kind: 'completed', task: active }) } as unknown as TaskController
    const loop = new AgentLoop({ ...h, model, toolHost: host, tasks,
      workspaceTrust: { get: async () => ({ canonicalRoot: '', level: 'read-only', revision: 0 }) },
      executionScope: async () => ({ browserScope: grant.browserScope, allowedProviderIds: ['browser-skill'],
        externalTargets: [], networkAllowlist: ['https://gov.example.test'], connectorScopes: [] }) })
    await bootstrapThread(h, { workspace: '', request: { prompt: '读取受控页面并报告读取状态。' } })
    const status = await loop.runTurn(h.threadId, h.turnId)
    expect(status, JSON.stringify((await h.threadStore.get(h.threadId))?.turns.at(-1))).toBe('completed')
    expect(observations).toBe(3)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.find(item => item.kind === 'tool_result' && item.callId === 'loop-call-6')).toMatchObject({
      kind: 'tool_result', isError: false, output: { observation: { context_id: 'context-3' } }
    })
  })
})
