import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowNodeInspector, FlowWorkspaceView, RunDetailsPanel, ScheduleAuthoritySummary, createStarterFlowInput, flowPortCompatibility, flowRegistryAvailabilityLabel, flowStatusClass } from './FlowWorkspaceView'
import i18n from '../../i18n'

beforeEach(async () => { await i18n.changeLanguage('zh') })

it('shows the stored recurring scope and lifetime with technical read scopes collapsed', () => {
  const html = renderToStaticMarkup(createElement(ScheduleAuthoritySummary, { value: {
    authorization: { until: 'disabled', expiresAt: null }, scope: { readPathAllowlist: ['F:\\Projects'], writePathAllowlist: ['F:\\Reports'], networkAllowlist: ['https://example.test'] }
  } }))
  expect(html).toContain('持续至暂停计划或撤销原任务权限')
  expect(html).toContain('F:\\Reports')
  expect(html).toContain('<details>')
  expect(html).not.toContain('<details open')
  expect(renderToStaticMarkup(createElement(ScheduleAuthoritySummary, { value: { grant: {} } }))).toContain('重新核对持续执行权限')
})

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
    expect(html).toContain('流程变量')
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
    expect(html).toContain('继续运行')
    expect(html).toContain('重试此步骤')
    expect(html).toContain('批准')
    expect(html).toContain('拒绝')
    expect(html).not.toContain('<details open')
    expect(html).toContain('技术详情')
    expect(html).toContain('等待审批')
    expect(html).toContain('timeout')
    expect(html).toContain('执行记录（1 项）')
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

  it('gives unavailable capabilities an action-oriented hint without showing internal routes', () => {
    expect(flowRegistryAvailabilityLabel({
      type: 'feishu_trigger', category: 'integration', label: 'Feishu', inputs: [], outputs: [], available: false,
      disabledReason: '尚未连接飞书', configurationRoute: 'settings/integrations/feishu'
    }, i18n.getFixedT('zh', 'common'))).toBe('请在技能与连接器中检查连接或配置。')
  })

  it('renders the route-level draft, validation, export, publish, and run controls accessibly', () => {
    const html = renderToStaticMarkup(createElement(FlowWorkspaceView, {
      leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), filter: 'all'
    }))
    expect(html).toContain('自动化流程')
    expect(html).not.toContain('Preview')
    expect(html).toContain('保存')
    expect(html).toContain('检查设置')
    expect(html).toContain('安全导出')
    expect(html).toContain('发布')
    expect(html).toContain('运行')
    expect(html).toContain('还没有自动化流程')
  })
})

it('shows scheduled workflow navigation in English without a preview badge', async () => {
  await i18n.changeLanguage('en')
  const html = renderToStaticMarkup(createElement(FlowWorkspaceView, {
    leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), filter: 'scheduled'
  }))
  expect(html).toContain('Scheduled workflows')
  expect(html).toContain('Choose a workflow')
  expect(html).not.toContain('Preview')
  expect(html).not.toContain('定时流程')
})
