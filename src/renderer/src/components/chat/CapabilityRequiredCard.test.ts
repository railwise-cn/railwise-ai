// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import i18n from '../../i18n'
import { CapabilityRequiredCard } from './CapabilityRequiredCard'

const state = vi.hoisted(() => ({
  openPlugins: vi.fn(), openSettings: vi.fn(), chooseWorkspace: vi.fn(),
  refreshThreads: vi.fn(async () => undefined), selectThread: vi.fn(async () => undefined),
  activeThreadId: 'thread-original'
}))
vi.mock('../../store/chat-store', () => ({ useChatStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }))

const card: ExternalTaskCapabilityCard = {
  threadId: 'thread-original', taskId: 'task-original', attentionId: 'attention-original',
  prompt: '帮我处理飞书待办',
  capability: { provider: 'lark', status: 'needs_authorization', message: '需要飞书登录授权', workspaceRoot: '/workspace/project' }
}
let root: Root
let container: HTMLDivElement
const api = {
  installManagedTool: vi.fn(), diagnoseManagedTool: vi.fn(), beginManagedLarkLogin: vi.fn(),
  completeManagedLarkLogin: vi.fn(), coordinateTaskCommand: vi.fn(), openExternal: vi.fn(async () => undefined)
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function render(value = card): Promise<void> {
  await act(async () => { root.render(createElement(CapabilityRequiredCard, { key: JSON.stringify(value.capability), card: value })) })
}
async function click(label: string): Promise<void> {
  await act(async () => { button(label).click(); await Promise.resolve(); await Promise.resolve() })
}

describe('capability waiting card', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    state.activeThreadId = 'thread-original'
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { workwise: api })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })

  it('opens the dedicated DingTalk connection settings without executing the task', async () => {
    await render({ ...card, capability: { provider: 'dingtalk', status: 'unsupported', message: '尚无钉钉连接器' } })
    expect(container.textContent).toContain('尚无钉钉连接器')
    expect(container.textContent).toContain('尚未执行')
    expect(container.textContent).not.toContain('thread-original')
    await click('配置钉钉连接')
    expect(state.openSettings).toHaveBeenCalledWith('general')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('supports managed installation without constructing a shell command', async () => {
    api.installManagedTool.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'needs_login' } })
    await render({ ...card, capability: { ...card.capability, status: 'not_installed', resolution: { kind: 'install', route: 'marketplace', label: '安装 Lark CLI' } } })
    expect([...container.querySelectorAll('button')].filter(item => item.textContent === '安装 Lark CLI')).toHaveLength(1)
    await click('打开插件市场')
    expect(state.openPlugins).toHaveBeenCalledOnce()
    expect(api.installManagedTool).not.toHaveBeenCalled()
    await click('安装 Lark CLI')
    expect(api.installManagedTool).toHaveBeenCalledWith('lark-cli')
    expect(container.textContent).toContain('已安装，需要登录授权')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('routes a blocked task policy to settings rather than the connector marketplace', async () => {
    await render({...card, capability:{...card.capability,status:'blocked',errorCode:'approval_policy_blocked',
      resolution:{kind:'grant',route:'settings',label:'调整任务审批策略'}}})
    await click('调整任务审批策略')
    expect(state.openSettings).toHaveBeenCalledWith('general')
    expect(state.openPlugins).not.toHaveBeenCalled()
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('routes Agent scope inspection and workspace selection to their specific controls', async () => {
    await render({...card, capability:{...card.capability,status:'blocked',errorCode:'agent_tool_blocked',
      resolution:{kind:'grant',route:'settings/agents',label:'检查 Agent 工具范围'}}})
    await click('检查 Agent 工具范围')
    expect(state.openSettings).toHaveBeenCalledWith('agents')
    await render({...card, capability:{...card.capability,status:'blocked',
      resolution:{kind:'switch_workspace',route:'workspace',label:'选择工作区'}}})
    await click('选择工作区')
    expect(state.chooseWorkspace).toHaveBeenCalledWith({createThreadAfter:false,selectThreadAfter:false})
    expect(state.openPlugins).not.toHaveBeenCalled()
  })

  it('keeps DingTalk configuration in General and honors an explicit marketplace route for Lark', async () => {
    await render({...card, capability:{provider:'dingtalk',status:'needs_authorization',message:'缺少钉钉凭据',
      resolution:{kind:'connect',route:'settings/mcp',label:'配置钉钉连接'}}})
    await click('配置钉钉连接')
    expect(state.openSettings).toHaveBeenCalledWith('general')
    await render({...card, capability:{...card.capability,resolution:{kind:'connect',route:'marketplace',label:'连接飞书'}}})
    await click('连接飞书')
    expect(state.openPlugins).toHaveBeenCalledOnce()
  })

  it('shows actual authority limits without advertising hidden execution identities', async () => {
    await render({ ...card, capability: { ...card.capability, executionContext: {
      workspaceRoot: '/workspace/project', workspaceTrust: 'read-only', agentTrust: 'workspace-write', sandboxMode: 'read-only', approvalPolicy: 'never', availableTools: []
    } } })
    expect(container.textContent).toContain('工作区信任')
    expect(container.textContent).toContain('从不执行')
    expect(container.textContent).toContain('无可用工具')
    expect(container.textContent).not.toContain('thread-original')
  })

  it('keeps login and resume separate and resumes the original persisted task', async () => {
    api.beginManagedLarkLogin.mockResolvedValue({ ok: true, verificationUrl: 'https://accounts.feishu.cn/authorize', userCode: 'SYNTHETIC', expiresAt: '2026-11-11T00:00:00Z' })
    api.completeManagedLarkLogin.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'installed' } })
    api.coordinateTaskCommand.mockResolvedValue({ kind: 'task_started', task: { id: 'task-original' } })
    await render()
    await click('登录并授权飞书')
    expect(container.textContent).toContain('SYNTHETIC')
    await click('我已完成授权，检查登录')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    await click('重新检查并继续原任务')
    expect(api.coordinateTaskCommand).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-original', taskId: 'task-original', resolveAttentionId: 'attention-original',
      intent: 'resume', request: { prompt: card.prompt }
    }))
    expect(state.selectThread).toHaveBeenCalledWith('thread-original')
  })

  it('does not switch the current conversation when an original task is resumed elsewhere', async () => {
    state.activeThreadId = 'thread-other'
    api.coordinateTaskCommand.mockResolvedValue({ kind: 'capability_required', message: '仍缺少待办 scope', capability: card.capability })
    await render()
    await click('重新检查并继续原任务')
    expect(container.textContent).toContain('仍缺少待办 scope')
    expect(state.selectThread).not.toHaveBeenCalled()
  })
})
