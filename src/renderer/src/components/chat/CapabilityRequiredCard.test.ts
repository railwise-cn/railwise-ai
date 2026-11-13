// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import type { TaskAttentionV1, TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { takeRequestedFlow } from '../../store/flow-navigation'
import { CapabilityRequiredCard } from './CapabilityRequiredCard'
import { refreshTaskState, resetTaskStateForTests } from '../../store/task-live-store'

const state = vi.hoisted(() => ({
  openFlow: vi.fn(), openPlugins: vi.fn(), openSettings: vi.fn(), chooseWorkspace: vi.fn(),
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
let tasks: TaskRunV1[]
let inbox: TaskAttentionV1[]
let watermark: number
let taskEvent: (payload: { streamId: string; events: unknown[] }) => void
function attentionFor(value: ExternalTaskCapabilityCard): TaskAttentionV1 {
  return { id: value.attentionId!, ownerKind: 'task', ownerId: value.taskId, taskId: value.taskId, threadId: value.threadId,
    kind: 'blocked', title: '确认任务权限', message: value.capability.message, status: 'pending', revision: 0,
    createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z',
    payload: { kind: 'capability_required', capability: value.capability, request: { prompt: value.prompt } } }
}
const browserCard: ExternalTaskCapabilityCard = { ...card, capability: { provider: 'browser-skill', status: 'needs_authorization',
  message: '请核对浏览器和站点范围', errorCode: 'browser_binding_changed', checkedAt: '2026-11-13T00:00:00Z',
  resolution: { kind: 'grant', route: 'task/browser-binding', label: '确认当前任务的浏览器范围' } } }
const api = {
  installManagedTool: vi.fn(), diagnoseManagedTool: vi.fn(), beginManagedLarkLogin: vi.fn(),
  completeManagedLarkLogin: vi.fn(), coordinateTaskCommand: vi.fn(), openExternal: vi.fn(async () => undefined),
  beginManagedLarkAppSetup: vi.fn(), checkManagedLarkAppSetup: vi.fn(), cancelManagedLarkAppSetup: vi.fn(),
  diagnoseManagedDingTalk: vi.fn(), installManagedDingTalk: vi.fn(), beginManagedDingTalkLogin: vi.fn(),
  checkManagedDingTalkLogin: vi.fn(), cancelManagedDingTalkLogin: vi.fn()
  ,getTaskPermissions: vi.fn(async () => ({ taskId: 'task-original', taskRevision: 3, taskTitle: '处理飞书待办', scopeHash: 'reviewed-scope',
    workspaceRoot: '/workspace/project', workspaceTrust: 'workspace-write', workspaceRevision: 1, agentRevision: 0,
    approvalPolicy: 'never', targetApprovalPolicy: 'on-request', maxTtlSeconds: 900, canConfirm: true })),
  getTaskRun: vi.fn(async () => ({ id: 'task-original', threadId: 'hidden-execution', status: 'waiting_user' })),
  listAgentProfiles: vi.fn(async () => ({ profiles: [] })), runtimeRequest: vi.fn(async () => ({ ok: true, body: '{}' })),
  confirmTaskPermissions: vi.fn(async () => ({ resumed: false, permission: { canConfirm: false, taskTitle: '处理飞书待办' } })),
  listTaskPage: vi.fn(async () => ({ items: tasks, relatedTasks: [], attention: inbox, eventWatermark: watermark })),
  startTaskSse: vi.fn(async (_after: number, _streamId: string) => undefined), stopSse: vi.fn(async () => undefined),
  onSseEvent: vi.fn(callback => { taskEvent = callback; return () => undefined }),
  onSseEnd: vi.fn(() => () => undefined), onSseError: vi.fn(() => () => undefined), notifyTask: vi.fn(async () => undefined),
  diagnoseBrowserSkill: vi.fn(async () => ({ ok: true, status: { enabled: true, state: 'ready', revision: 3,
    browserInstanceId: 'browser-instance', origins: ['https://example.com'], interaction: 'interact', browsers: [] } })),
  getBrowserTaskBinding: vi.fn(async () => ({ taskId: card.taskId, taskRevision: 5, browserRevision: 3, browserInstanceId: 'browser-instance',
    browserLabel: '测试 Chrome', origins: ['https://example.com'], interaction: 'interact' })),
  confirmBrowserTaskBinding: vi.fn()
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function render(value = card, workspaceRoot?: string, attention = [attentionFor(value)]): Promise<void> {
  inbox = attention
  watermark += 1
  await act(async () => {
    await refreshTaskState()
    root.render(createElement(CapabilityRequiredCard, { key: JSON.stringify(value.capability), card: value, workspaceRoot }))
  })
}
async function click(label: string): Promise<void> {
  await act(async () => { button(label).click(); await Promise.resolve(); await Promise.resolve() })
}

describe('capability waiting card', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetTaskStateForTests()
    watermark = 0
    inbox = []
    tasks = [{ id: card.taskId, threadId: card.threadId, childTaskIds: [], workspaceRoot: '/workspace/project', goal: card.prompt,
      status: 'waiting_user', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
      agentId: 'general', budget: { maxAttempts: 8, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0,
      nodes: [], artifacts: [], revision: 1, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' }]
    state.activeThreadId = 'thread-original'
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { workwise: api })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); resetTaskStateForTests(); container.remove() })

  it('keeps a resolved browser card historical after remount and opens configuration only on request', async () => {
    tasks[0].status = 'running'
    await render(browserCard, undefined, [])
    expect(container.textContent).toContain('能力处理记录')
    expect(container.textContent).toContain(browserCard.capability.message)
    expect(container.textContent).toContain('当时状态')
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    expect(container.querySelector('select')).toBeNull()
    await act(async () => root.render(null))
    await render(browserCard, undefined, [])
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    await click('查看配置')
    expect(state.openPlugins).toHaveBeenCalledWith(undefined, 'browser-skill')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    expect(api.getBrowserTaskBinding).not.toHaveBeenCalled()
    expect(api.confirmBrowserTaskBinding).not.toHaveBeenCalled()
  })

  it('keeps a current pending browser request interactive and removes its connector when the real attention stream resolves it', async () => {
    await render(browserCard)
    expect(api.diagnoseBrowserSkill).toHaveBeenCalledOnce()
    expect(container.querySelector('select')).not.toBeNull()
    await click('确认当前任务的浏览器范围')
    expect(api.getBrowserTaskBinding).toHaveBeenCalledWith(card.taskId)
    expect(container.textContent).toContain('所选浏览器')
    expect(container.textContent).not.toContain('browserSkillInstance')
    const streamId = api.startTaskSse.mock.calls.at(-1)![1]
    await act(async () => taskEvent({ streamId, events: [{ seq: ++watermark, kind: 'attention_changed',
      payload: { ...attentionFor(browserCard), status: 'answered', revision: 1 } }] }))
    expect(container.textContent).toContain('能力处理记录')
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toContain('重新检查并继续原任务')
    expect(api.diagnoseBrowserSkill).toHaveBeenCalledOnce()
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('refreshes cached pending attention before remounting a historical browser connector', async () => {
    await render(browserCard)
    expect(api.diagnoseBrowserSkill).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    api.diagnoseBrowserSkill.mockClear()
    api.listTaskPage.mockClear()
    let resolve!: (page: Awaited<ReturnType<typeof api.listTaskPage>>) => void
    api.listTaskPage.mockImplementationOnce(() => new Promise(accept => { resolve = accept }))
    await act(async () => root.render(createElement(CapabilityRequiredCard, { card: browserCard })))
    expect(api.listTaskPage).toHaveBeenCalledOnce()
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    expect(container.querySelector('select')).toBeNull()
    await act(async () => resolve({ items: tasks, relatedTasks: [], attention: [], eventWatermark: ++watermark }))
    expect(container.textContent).toContain('能力处理记录')
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
  })

  it('does not mount an old request when its attention ID now belongs to a later capability check', async () => {
    const latest = { ...browserCard, capability: { ...browserCard.capability, checkedAt: '2026-11-13T00:01:00Z' } }
    inbox = [attentionFor(latest)]
    await act(async () => {
      root.render(createElement(CapabilityRequiredCard, { card: browserCard }))
    })
    expect(container.textContent).toContain('能力处理记录')
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(CapabilityRequiredCard, { card: latest })))
    expect(api.diagnoseBrowserSkill).toHaveBeenCalledOnce()
    expect(container.querySelector('select')).not.toBeNull()
  })

  it('keeps configuration explicit while the persisted attention state is loading or unavailable', async () => {
    let reject!: (error: Error) => void
    api.listTaskPage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await act(async () => root.render(createElement(CapabilityRequiredCard, { card: browserCard })))
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    expect(container.querySelector('select')).toBeNull()
    expect(button('查看配置')).toBeTruthy()
    await act(async () => reject(new Error('synthetic task store failure')))
    expect(api.diagnoseBrowserSkill).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('能力处理记录')
    await click('查看配置')
    expect(state.openPlugins).toHaveBeenCalledWith(undefined, 'browser-skill')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('shows the owner task workspace for historical cards without workspace metadata', async () => {
    const historical = { ...card, capability: { provider: 'workspace' as const, status: 'needs_authorization' as const,
      message: '需要确认权限', action: { kind: 'grant' as const, route: 'task/permissions', label: '确认权限' } } }
    await render(historical, '/workspace/original-task')
    expect(container.textContent).toContain('/workspace/original-task')
    expect(container.textContent).not.toContain('尚未选择工作区')
    await render(historical)
    expect(container.textContent).toContain('工作区信息尚未加载')
    expect(container.textContent).not.toContain('尚未选择工作区')
    expect(api.getTaskRun).not.toHaveBeenCalled()
  })

  it('continues the original source task to obtain a real periodic action review without opening a nonexistent plan', async () => {
    api.coordinateTaskCommand.mockResolvedValue({ kind: 'task_started', task: { id: card.taskId }, turn: { threadId: 'worker', turnId: 'new-turn' } })
    await render({ ...card, capability: { provider: 'schedule', status: 'blocked', errorCode: 'browser_schedule_action_scope_required',
      message: '重新观察页面并审阅周期动作', action: { kind: 'retry', route: 'task/schedule-review', label: '继续原任务并审阅周期动作' } } })
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    await click('继续原任务并审阅周期动作')
    expect(api.coordinateTaskCommand).toHaveBeenCalledWith(expect.objectContaining({ threadId: card.threadId, taskId: card.taskId,
      resolveAttentionId: card.attentionId, intent: 'resume' }))
    expect(state.openFlow).not.toHaveBeenCalled()
    expect(state.openSettings).not.toHaveBeenCalled()
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })

  it('routes a periodic browser scope blocker to its actual plan without resuming it', async () => {
    await render({ ...card, capability: { provider: 'schedule', status: 'needs_authorization', errorCode: 'browser_schedule_action_scope_changed',
      message: '周期网页动作需要重新核对', action: { kind: 'grant', route: 'flow/schedule_original', label: '查看并核对定时计划' } } })
    await click('查看并核对定时计划')
    expect(state.openFlow).toHaveBeenCalledOnce()
    expect(takeRequestedFlow()).toEqual({ flowId: 'schedule_original' })
    expect(state.openSettings).not.toHaveBeenCalled()
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('opens the dedicated DingTalk connection hub without executing the task', async () => {
    await render({ ...card, capability: { provider: 'dingtalk', status: 'unsupported', message: '尚无钉钉连接器' } })
    expect(container.textContent).toContain('尚无钉钉连接器')
    expect(container.textContent).toContain('尚未执行')
    expect(container.textContent).not.toContain('thread-original')
    await click('配置钉钉连接')
    expect(state.openPlugins).toHaveBeenCalledWith(undefined, 'dingtalk')
    expect(state.openSettings).not.toHaveBeenCalled()
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

  it('resolves blocked task policy through the mounted task permission panel without resuming', async () => {
    await render({...card, capability:{...card.capability,status:'blocked',errorCode:'approval_policy_blocked',
      resolution:{kind:'grant',route:'settings',label:'调整任务审批策略'}}})
    await click('调整任务审批策略')
    expect(api.getTaskPermissions).toHaveBeenCalledWith('task-original')
    expect(container.textContent).toContain('查看当前任务权限')
    expect(state.openSettings).not.toHaveBeenCalled()
    expect(state.openPlugins).not.toHaveBeenCalled()
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await click('允许当前任务请求审批')
    expect(api.confirmTaskPermissions).toHaveBeenCalledWith('task-original', expect.objectContaining({ expectedRevision: 3, scopeHash: 'reviewed-scope', duration: 'task', ttlSeconds: 900 }))
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
  })

  it('routes Agent scope inspection and workspace selection to their specific controls', async () => {
    await render({...card, capability:{...card.capability,status:'blocked',errorCode:'agent_tool_blocked',
      resolution:{kind:'grant',route:'settings/agents',label:'检查 Agent 工具范围'}}})
    await click('检查 Agent 工具范围')
    expect(api.getTaskPermissions).toHaveBeenCalledWith('task-original')
    expect(state.openSettings).not.toHaveBeenCalled()
    await render({...card, capability:{...card.capability,status:'blocked',
      resolution:{kind:'switch_workspace',route:'workspace',label:'选择工作区'}}})
    await click('选择工作区')
    expect(state.chooseWorkspace).toHaveBeenCalledWith({createThreadAfter:false,selectThreadAfter:false})
    expect(state.openPlugins).not.toHaveBeenCalled()
  })

  it('routes legacy DingTalk setup links and Lark links to their independent connection details', async () => {
    await render({...card, capability:{provider:'dingtalk',status:'needs_authorization',message:'缺少钉钉凭据',
      resolution:{kind:'connect',route:'settings/mcp',label:'配置钉钉连接'}}})
    await click('配置钉钉连接')
    expect(state.openPlugins).toHaveBeenCalledWith(undefined, 'dingtalk')
    expect(state.openSettings).not.toHaveBeenCalled()
    await render({...card, capability:{...card.capability,resolution:{kind:'connect',route:'marketplace',label:'连接飞书'}}})
    await click('连接飞书')
    expect(state.openPlugins).toHaveBeenCalledWith(undefined, 'lark')
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
    api.beginManagedLarkLogin.mockResolvedValue({ ok: true, verificationUrl: 'https://accounts.feishu.cn/authorize', userCode: 'SYNTHETIC', expiresAt: new Date(Date.now() + 600_000).toISOString() })
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

  it('connects DingTalk with the official flow while requiring explicit resume of the original task', async () => {
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'needs_login' } })
    api.beginManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'waiting', verificationUrl: 'https://login.dingtalk.com/oauth2/device', userCode: 'SYNTHETIC' })
    api.checkManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'succeeded', status: { state: 'installed', identityFingerprint: 'synthetic-identity' } })
    api.coordinateTaskCommand.mockResolvedValue({ kind: 'task_started', task: { id: 'task-original' } })
    const dingTalkCard = { ...card, prompt: '帮我处理钉钉待办', capability: { provider: 'dingtalk' as const, status: 'needs_authorization' as const, message: '需要钉钉登录授权' } }
    await render(dingTalkCard)
    expect(api.diagnoseManagedDingTalk).not.toHaveBeenCalled()
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    await click(i18n.t('managedDwsConnect', { ns: 'common' }))
    expect(api.openExternal).toHaveBeenCalledWith('https://login.dingtalk.com/oauth2/device')
    expect(container.textContent).toContain('SYNTHETIC')
    await click('我已完成授权，检查登录')
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    expect(api.beginManagedLarkLogin).not.toHaveBeenCalled()
    await click('重新检查并继续原任务')
    expect(api.coordinateTaskCommand).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-original', taskId: 'task-original', resolveAttentionId: 'attention-original',
      intent: 'resume', request: { prompt: dingTalkCard.prompt }
    }))
  })

  it('offers official app scan setup first and keeps app setup, user login and task execution separate', async () => {
    api.beginManagedLarkLogin.mockResolvedValue({ ok: false, reason: 'app_configuration_required', message: 'App is not configured' })
    api.beginManagedLarkAppSetup.mockResolvedValue({ ok: true, state: 'waiting', verificationUrl: 'https://open.feishu.cn/device', expiresAt: new Date(Date.now() + 600_000).toISOString() })
    api.checkManagedLarkAppSetup.mockResolvedValue({ ok: true, state: 'configured' })
    await render()
    await click('登录并授权飞书')
    expect(container.textContent).toContain('无需在聊天中提供账号或密钥')
    expect(api.beginManagedLarkAppSetup).not.toHaveBeenCalled()
    await click('配置飞书应用（官方扫码）')
    expect(api.openExternal).toHaveBeenCalledWith('https://open.feishu.cn/device')
    expect(container.textContent).toContain('RailWise 不会替你确认平台权限')
    await click('我已完成应用配置，检查结果')
    expect(container.textContent).toContain('应用配置已核验')
    expect(api.beginManagedLarkLogin).toHaveBeenCalledTimes(1)
    expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
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
