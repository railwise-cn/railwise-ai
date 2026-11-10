import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from './capability-registry.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'

const context = (sandboxMode: ToolHostContext['sandboxMode']): ToolHostContext => ({
  threadId: 'thread', turnId: 'turn', workspace: '/workspace', sandboxMode,
  approvalPolicy: 'on-request', abortSignal: new AbortController().signal,
  awaitApproval: async () => 'deny'
})

const bash: LocalTool = {
  name: 'bash', description: 'host shell', inputSchema: {}, toolKind: 'command_execution', policy: 'on-request',
  execute: async () => ({ output: '' })
}

describe('CapabilityRegistry sandbox advertisement', () => {
  it('does not advertise or resolve host shell in workspace-write', () => {
    const registry = CapabilityRegistry.fromLocalTools([bash])
    expect(registry.listTools(context('workspace-write'))).toEqual([])
    expect(() => registry.resolveTool('bash', context('workspace-write'))).toThrow(/active sandbox/)
  })
})
