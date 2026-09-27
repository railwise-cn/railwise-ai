import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FlowNodeInspector, FlowWorkspaceView, RunDetailsPanel, createStarterFlowInput, flowPortCompatibility, flowRegistryAvailabilityLabel, flowStatusClass } from './FlowWorkspaceView'

describe('FlowNodeInspector', () => {
  it('renders binding, model/provider, node config, and complete execution policy controls', () => {
    const node = {
      id: 'agent_1', type: 'agent', label: '编制代理', position: { x: 0, y: 0 }, bindings: {},
      config: { prompt: '编制投标文件' },
      policy: { timeoutMs: 120000, retryAttempts: 2, retryBackoffMs: 1000, errorBehavior: 'error_edge' as const, concurrencyLimit: 2, resumable: true, breakpoint: false },
      disabled: false
    }
    const html = renderToStaticMarkup(createElement(FlowNodeInspector, {
      node, entry: { type: 'agent', category: 'intelligence', label: 'Agent', available: true, inputs: [{ id: 'input', label: '输入', type: 'json', required: true, multiple: false }], outputs: [] },
      allNodes: [node], registry: [], variables: { tender: {} }, onChange: vi.fn(), mockInput: '{}', onMockInput: vi.fn(), onTest: vi.fn(), busy: false
    }))
    expect(html).toContain('输入绑定')
    expect(html).toContain('Flow 变量')
    expect(html).toContain('节点输出')
    expect(html).toContain('提供商')
    expect(html).toContain('模型')
    expect(html).toContain('系统提示词 *')
    expect(html).toContain('错误处理')
    expect(html).toContain('错误分支')
    expect(html).toContain('可恢复')
  })
})

describe('RunDetailsPanel', () => {
  it('shows bounded node inspection and recovery, approval, and retry actions', () => {
    const html = renderToStaticMarkup(createElement(RunDetailsPanel, {
      details: {
        run: { id: 'run_1', status: 'failed', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z' },
        nodeRuns: [
          { id: 'nr_1', nodeId: 'agent_1', attempt: 2, status: 'failed', input: { tender: true }, error: 'timeout' },
          { id: 'nr_2', nodeId: 'approval_1', attempt: 1, status: 'waiting_approval', output: { summary: 'review' } }
        ],
        events: [{ id: 'ev_1', type: 'node_failed', nodeId: 'agent_1', payload: {}, createdAt: '2026-01-01T00:01:00Z' }]
      }, onAction: vi.fn(), busy: false
    }))
    expect(html).toContain('从检查点恢复')
    expect(html).toContain('从此节点重试')
    expect(html).toContain('批准')
    expect(html).toContain('拒绝')
    expect(html).toContain('timeout')
    expect(html).toContain('事件记录 (1)')
  })
})

describe('Flow engineering status semantics', () => {
  it('maps normal, attention, approval, failure, and active work consistently', () => {
    expect(flowStatusClass('succeeded')).toContain('green')
    expect(flowStatusClass('paused')).toContain('yellow')
    expect(flowStatusClass('waiting_approval')).toContain('orange')
    expect(flowStatusClass('failed')).toContain('red')
    expect(flowStatusClass('running')).toContain('blue')
  })
})

describe('Flow workspace controls and typed connections', () => {
  it('creates a runnable starter graph instead of an empty canvas', () => {
    const flow = createStarterFlowInput('flow_qa')
    expect(flow.nodes.map((node) => node.type)).toEqual(['manual_trigger', 'agent'])
    expect(flow.nodes.find((node) => node.type === 'agent')?.config.prompt).toBeTruthy()
    expect(flow.edges).toEqual([
      expect.objectContaining({
        sourcePortId: 'output',
        targetPortId: 'input',
        branch: 'normal'
      })
    ])
  })

  it('accepts identical and declared conversions while rejecting incompatible ports', () => {
    expect(flowPortCompatibility('json', 'json')).toEqual({})
    expect(flowPortCompatibility('file', 'document')).toEqual({ conversionId: 'file-to-document' })
    expect(flowPortCompatibility('boolean', 'image')).toBeNull()
  })

  it('keeps unavailable capabilities visible with their reason and configuration route', () => {
    expect(flowRegistryAvailabilityLabel({
      type: 'feishu_trigger', category: 'integration', label: 'Feishu', inputs: [], outputs: [], available: false,
      disabledReason: '尚未连接飞书', configurationRoute: 'settings/integrations/feishu'
    })).toBe('尚未连接飞书；配置入口：settings/integrations/feishu')
  })

  it('renders the route-level draft, validation, export, publish, and run controls accessibly', () => {
    const html = renderToStaticMarkup(createElement(FlowWorkspaceView, {
      leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), filter: 'all'
    }))
    expect(html).toContain('RailWise AI Flow')
    expect(html).toContain('Preview')
    expect(html).toContain('保存')
    expect(html).toContain('校验')
    expect(html).toContain('脱敏导出')
    expect(html).toContain('发布')
    expect(html).toContain('运行')
    expect(html).toContain('还没有 Flow')
  })
})
