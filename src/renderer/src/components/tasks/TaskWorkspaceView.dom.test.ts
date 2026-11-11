// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskAttentionV1, TaskOperationReceiptV1, TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { TaskWorkspaceView, filterWorkspaceTasks, groupWorkspaceTasks, taskGroupProgress } from './TaskWorkspaceView'
import { resetTaskStateForTests, refreshTaskState } from '../../store/task-live-store'

const now = '2026-11-09T01:00:00.000Z'
function task(id: string, status: TaskRunV1['status'], goal = id): TaskRunV1 {
  return {
    id, threadId: `thread-${id}`, childTaskIds: [], workspaceRoot: '/workspace', goal, status,
    acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    agentId: 'default', budget: { maxAttempts: 8, maxDurationMs: 1800000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [], artifacts: [], revision: 1, createdAt: now, updatedAt: now
  }
}
const approval: TaskAttentionV1 = {
  id: 'attention-approval', ownerKind: 'task', ownerId: 't2', taskId: 't2', threadId: 'thread-t2',
  kind: 'approval', title: 'Publish report', message: 'Send the reviewed report to the selected destination?', status: 'pending',
  revision: 0, createdAt: now, updatedAt: now, requestId: 'approval-1'
}

describe('task filtering', () => {
  it('keeps paused tasks visible and derives counts from the exact same filter as the list', () => {
    const tasks = [task('t1', 'running', 'Monthly monitoring'), task('t2', 'running', 'Tender'), task('t3', 'paused', 'Research'), task('t4', 'completed', 'Completed')]
    expect(filterWorkspaceTasks(tasks, [approval], 'ongoing').map(item => item.id)).toEqual(['t1', 't3'])
    expect(filterWorkspaceTasks(tasks, [approval], 'attention').map(item => item.id)).toEqual(['t2'])
    expect(filterWorkspaceTasks(tasks, [approval], 'completed').map(item => item.id)).toEqual(['t4'])
    expect(filterWorkspaceTasks(tasks, [approval], 'all', 'monitoring').map(item => item.id)).toEqual(['t1'])
  })

  it('keeps child runs under one root task and promotes child attention to the root', () => {
    const root = task('root', 'running', 'Prepare report')
    const child = {
      ...task('child', 'waiting_user', 'Check source data'),
      parentTaskId: root.id,
      rootTaskId: root.id,
      nodes: [{ id: 'child-node', taskId: 'child', kind: 'execute' as const, title: 'Check', status: 'completed' as const, dependsOn: [], attempt: 1, maxAttempts: 2, idempotencyKey: 'child-node', evidence: [], revision: 1 }]
    }
    const groups = groupWorkspaceTasks([root, child])
    expect(groups).toHaveLength(1)
    expect(groups[0].root.id).toBe('root')
    expect(groups[0].children.map(item => item.id)).toEqual(['child'])
    expect(taskGroupProgress(groups[0])).toEqual({ completed: 1, total: 1 })
    expect(filterWorkspaceTasks([root, child], [], 'ongoing')).toEqual([])
    expect(filterWorkspaceTasks([root, child], [], 'attention').map(item => item.id)).toEqual(['root'])
  })
})

let container: HTMLDivElement
let root: Root
let tasks: TaskRunV1[]
let inbox: TaskAttentionV1[]
const onOpenThread = vi.fn()
const onOpenArtifact = vi.fn()

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function input(element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label))
  expect(button, label).toBeTruthy()
  await act(async () => button!.click())
  await settle()
}

beforeEach(async () => {
  resetTaskStateForTests()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  tasks = [task('t1', 'running', 'Monthly report'), task('t2', 'waiting_approval', 'Tender document')]
  inbox = [approval]
  onOpenThread.mockClear()
  onOpenArtifact.mockClear()
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      listTaskPage: vi.fn(async () => ({ items: tasks, relatedTasks: [], attention: inbox, total: tasks.length, counts: { all: tasks.length }, snapshotId: 'snapshot', expiresAt: now, eventWatermark: 0 })),
      startTaskSse: vi.fn(async () => ({ streamId: 'tasks' })),
      stopSse: vi.fn(async () => undefined),
      onSseEvent: vi.fn(() => () => undefined),
      onSseEnd: vi.fn(() => () => undefined),
      onSseError: vi.fn(() => () => undefined),
      notifyTask: vi.fn(async () => undefined),
      listTaskRuns: vi.fn(async () => tasks),
      listTaskInbox: vi.fn(async () => inbox),
      listTaskTemplates: vi.fn(async () => ({ templates: [{ id: 'research-document', name: 'Research', description: 'Research docs', stages: [], outputs: [], requiredInputs: [] }] })),
      listTaskInputs: vi.fn(async () => []),
      listTaskEvents: vi.fn(async () => []),
      listTaskOperationReceipts: vi.fn(async () => []),
      verifyTaskOperationReceipt: vi.fn(async () => ({ status: 'outcome_unknown' })),
      appendTaskInput: vi.fn(async (_id: string, request: { text: string }) => ({ input: { id: 'input1', text: request.text }, task: tasks[0] })),
      pauseTask: vi.fn(async () => { tasks = [{ ...tasks[0], status: 'paused', revision: 2 }, tasks[1]]; return tasks[0] }),
      resumeTask: vi.fn(async () => ({ task: tasks[0], turn: {} })),
      retryTask: vi.fn(), cancelTask: vi.fn(),
      runtimeRequest: vi.fn(async () => { inbox = []; return { ok: true, status: 200, body: '{}' } }),
      startTaskTemplate: vi.fn(async () => ({ threadId: 'thread-new', taskId: 'new' })),
      saveTaskTemplate: vi.fn(async () => ({ flow: {} }))
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(TaskWorkspaceView, {
    workspaceRoot: '/workspace', runtimeReady: true, leftSidebarCollapsed: false,
    onToggleLeftSidebar: vi.fn(), onOpenThread, onOpenArtifact
  })))
  await settle()
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
})

describe('TaskWorkspaceView', () => {
  it('keeps Markdown draft delivery available when the document export bridge is unconfigured', async () => {
    await click('Research and documents')
    expect(container.textContent).toContain('The export service is unconfigured')
    const form = container.querySelector<HTMLFormElement>('form[role="dialog"]')!
    await input(form.querySelectorAll('textarea')[0], 'Prepare a cited synthetic draft')
    for (const format of ['DOCX', 'PDF']) {
      const label = [...form.querySelectorAll('label')].find(item => item.textContent === format)!
      await act(async () => label.querySelector<HTMLInputElement>('input')!.click())
    }
    await click('Start task')
    expect(window.workwise.startTaskTemplate).toHaveBeenCalledWith('research-document', expect.objectContaining({ outputFormats: ['md'] }))
  })
  it('requires an explicit single-platform request before resolving a dual-provider decision', async () => {
    tasks = []
    inbox = [{id:'provider-choice',ownerKind:'task',ownerId:'original-conversation',threadId:'original-conversation',workspaceRoot:'/workspace',
      kind:'question',title:'选择本次执行的平台',message:'这条请求同时涉及钉钉和飞书',status:'pending',revision:0,createdAt:now,updatedAt:now,
      payload:{kind:'external_provider_choice',providers:['dingtalk','lark'],originalText:'帮我处理钉钉和飞书待办',request:{prompt:'帮我处理钉钉和飞书待办'}}}]
    const coordinateTaskCommand = vi.fn(async () => ({kind:'capability_required'}))
    Object.assign(window.workwise,{coordinateTaskCommand})
    await act(async () => {await refreshTaskState()})
    await click('Needs you')
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Create independent platform task')?.disabled).toBe(true)
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Platform for this task"]')!
    await act(async () => {select.value='lark';select.dispatchEvent(new Event('change',{bubbles:true}))})
    await input(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request for the selected platform"]')!,'列出飞书待办')
    await click('Create independent platform task')
    expect(coordinateTaskCommand).toHaveBeenCalledWith(expect.objectContaining({threadId:'original-conversation',intent:'new',resolveAttentionId:'provider-choice',selectedExternalProvider:'lark',request:{prompt:'列出飞书待办',displayText:'列出飞书待办'}}))
    expect(inbox[0].payload?.originalText).toBe('帮我处理钉钉和飞书待办')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })
  it('renders a usable capability card in task attention without opening the hidden execution conversation', async () => {
    tasks = [{...task('blocked-connector','waiting_user','处理飞书待办'),threadId:'hidden-execution-thread',originThreadId:'original-conversation'}]
    inbox = [{id:'connector-attention',ownerKind:'task',ownerId:'blocked-connector',taskId:'blocked-connector',threadId:'original-conversation',
      workspaceRoot:'/workspace',kind:'blocked',title:'连接目标服务',message:'未安装飞书连接器',status:'pending',revision:0,createdAt:now,updatedAt:now,
      payload:{kind:'capability_required',request:{prompt:'帮我处理飞书待办'},capability:{provider:'lark',status:'not_installed',message:'未安装飞书连接器'}}}]
    const installManagedTool = vi.fn(async () => ({ok:true,status:{id:'lark-cli',state:'needs_login'}}))
    Object.assign(window.workwise,{installManagedTool})
    await act(async () => {await refreshTaskState()})
    await click('Needs you')
    expect(container.textContent).toContain('Install Lark CLI')
    expect(container.textContent).not.toContain('hidden-execution-thread')
    await click('Install Lark CLI')
    expect(installManagedTool).toHaveBeenCalledExactlyOnceWith('lark-cli')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it('explains an explicit new attempt for failed actions while preserving their receipts', async () => {
    tasks = [{...task('failed-action','stalled','处理飞书待办'),acceptance:{kind:'effect',requiredNodeKinds:[],requireFinalResponse:true,requireActionableArtifactCard:false,effect:{provider:'lark',operation:'complete',target:'todo-failed'}}}]
    inbox = []
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([{id:'failed-receipt',taskId:'failed-action',provider:'lark',operation:'complete',toolName:'lark_task_complete',target:'todo-failed',requestHash:'request-hash',status:'failed',errorCode:'network_failed',createdAt:now,updatedAt:now}])
    await act(async () => {await refreshTaskState()})
    await click('Needs you')
    expect(container.textContent).toContain('The failure record is preserved')
    expect(container.textContent).toContain('unknown outcome must be verified')
    expect(window.workwise.retryTask).not.toHaveBeenCalled()
  })
  it.each([
    { language: 'zh', completed: '已完成', provider: '飞书 / Lark', execution: '外部执行与核验', verified: '已执行并验证', receipts: '操作回执' },
    { language: 'en', completed: 'Completed', provider: 'Feishu / Lark', execution: 'External execution and verification', verified: 'Executed and verified', receipts: 'Operation receipts' }
  ])('shows the provider, target and verified receipt without internal execution IDs in $language', async ({ language, completed, provider, execution, verified, receipts }) => {
    const evidence = { kind: 'external_operation' as const, provider: 'lark', operation: 'complete', target: 'todo-042', status: 'done', verified: true, verifiedAt: now, resultHash: 'result-sha256', remoteOperationId: 'remote-operation-42' }
    tasks = [{ ...task('effect-task', 'completed', '处理飞书待办'),
      threadId: 'hidden-thread-identifier', executionSessionId: 'hidden-session-identifier', activeTurnId: 'hidden-turn-identifier',
      acceptance: { kind: 'effect', requireFinalResponse: true, requireActionableArtifactCard: false, requiredNodeKinds: [],
        effect: { provider: 'lark', operation: 'complete', target: 'todo-042' } }, resultEvidence: [evidence]
    }]
    const receipt: TaskOperationReceiptV1 = { id: 'receipt-42', taskId: 'effect-task', provider: 'lark', operation: 'complete', toolName: 'lark_task_complete', target: 'todo-042', requestHash: 'request-sha256', status: 'succeeded', evidence, createdAt: now, updatedAt: now }
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([receipt])
    inbox = []
    await act(async () => { await i18n.changeLanguage(language); await refreshTaskState() })
    await click(completed)
    const section = container.querySelector(`[aria-label="${execution}"]`)!
    expect(section.textContent).toContain(provider)
    expect(section.textContent).toContain('todo-042')
    expect(section.textContent).toContain(verified)
    expect(section.textContent).toContain(receipts)
    expect(section.textContent).toContain('remote-operation-42')
    expect(section.textContent).toContain('result-sha256')
    expect(section.textContent).not.toMatch(/hidden-(?:thread|session|turn)-identifier|lark_task_complete/)
    expect(window.workwise.listTaskOperationReceipts).toHaveBeenCalledWith('effect-task')
  })

  it('shows an unknown external outcome without claiming verified execution or replaying it', async () => {
    tasks = [{ ...task('unknown-effect', 'waiting_user', '处理钉钉待办'), acceptance: {
      kind: 'effect', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false,
      effect: { provider: 'dingtalk', operation: 'complete', target: 'todo-unknown' }
    } }]
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([{
      id: 'receipt-unknown', taskId: 'unknown-effect', provider: 'dingtalk', operation: 'complete', toolName: 'dingtalk_complete_task',
      target: 'todo-unknown', requestHash: 'request-sha256', status: 'outcome_unknown', errorCode: 'external_outcome_unknown', createdAt: now, updatedAt: now
    }])
    inbox = []
    await act(async () => { await refreshTaskState() })
    await click('Needs you')
    const section = container.querySelector('[aria-label="External execution and verification"]')!
    expect(section.textContent).toContain('DingTalk')
    expect(section.textContent).toContain('Outcome needs verification')
    expect(section.textContent).toContain('will not replay automatically')
    expect(section.textContent).not.toContain('Executed and verified')
    await click('Verify result')
    expect(window.workwise.verifyTaskOperationReceipt).toHaveBeenCalledWith('unknown-effect', 'receipt-unknown', { expectedRevision: 1, idempotencyKey: expect.any(String) })
    expect(container.textContent).toContain('The result is still unknown')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('shows verified readback while preserving the original unknown receipt and keeping execution paused', async () => {
    tasks = [{ ...task('resolved-effect', 'paused', '处理飞书待办'), acceptance: {
      kind: 'effect', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false,
      effect: { provider: 'lark', operation: 'complete', target: 'todo-resolved' }
    } }]
    const evidence = { kind: 'external_operation' as const, provider: 'lark', operation: 'complete', target: 'todo-resolved', status: 'done', verified: true, verifiedAt: now, resultHash: 'verified-hash' }
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([{
      id: 'receipt-resolved', taskId: 'resolved-effect', provider: 'lark', operation: 'complete', toolName: 'lark_task_complete', target: 'todo-resolved', requestHash: 'request-hash', status: 'outcome_unknown',
      resolution: { status: 'verified', receiptId: 'verification-receipt', evidence, resolvedAt: now }, createdAt: now, updatedAt: now
    }])
    inbox = []
    await act(async () => { await refreshTaskState() })
    const section = container.querySelector('[aria-label="External execution and verification"]')!
    expect(section.textContent).toContain('Remote result verified')
    expect(section.textContent).toContain('original unknown dispatch is preserved')
    expect(section.textContent).not.toContain('Verify result')
    expect(window.workwise.verifyTaskOperationReceipt).not.toHaveBeenCalled()
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it.each([{ language: 'zh', completed: '已完成', details: '任务详情' }, { language: 'en', completed: 'Completed', details: 'Task details' }])('shows only the user goal for historical completed templates in $language', async ({ language, completed, details }) => {
    const goal = '总结监测资料，保留待确认项。'
    tasks = [{ ...task('legacy-template', 'completed', `完成研究与文档任务，持续推进到可审阅成果。\n\n用户目标：${goal}\n\n工作区：/workspace\n\n执行步骤：整理资料\n\n使用 propose_document，source_refs 保存来源；导出 API 仅用于内部执行。`), templateId: 'research-document' }]
    inbox = []
    await act(async () => { await i18n.changeLanguage(language); await refreshTaskState() })
    await click(completed)
    expect(container.querySelector(`[aria-label="${details}"] h2`)?.textContent).toBe(goal)
    expect(container.querySelector(`[aria-label="${language === 'zh' ? '任务列表' : 'Task list'}"]`)?.textContent).toContain(goal)
    expect(container.textContent).not.toContain('propose_document')
    expect(container.textContent).not.toContain('source_refs')
    expect(container.textContent).not.toMatch(/taskWorkspace[A-Z]/)
  })

  it('keeps hidden execution threads out of attention conversation navigation',async()=>{
    tasks=[{...task('t1','waiting_approval','Review draft'),visibility:'task'}]
    inbox=[{...approval,id:'hidden-attention',ownerId:'t1',taskId:'t1',threadId:'thread-t1'}]
    await act(async()=>{await refreshTaskState()})
    await click('Needs you')
    expect(container.textContent).not.toContain('Open conversation')
    expect(container.textContent).not.toContain('thread-t1')
  })

  it('includes workspace Flow attention and acts through the original Flow decision API', async () => {
    inbox = [{ id: 'flow-attention', ownerKind: 'flow', ownerId: 'run1', flowId: 'flow1', flowRunId: 'run1', nodeId: 'review', workspaceRoot: '/workspace', kind: 'approval', title: 'Review workflow report', message: 'Review the candidate', status: 'pending', revision: 0, createdAt: now, updatedAt: now, payload: { action: 'review_flow' } }]
    await act(async () => { await refreshTaskState() })
    await click('Needs you')
    expect(container.textContent).toContain('Review workflow report')
    const cards = [...container.querySelectorAll('div')].filter(element => element.querySelector('h4')?.textContent === 'Review workflow report')
    const card = cards.at(-1)!
    const allow = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Allow this action')!
    await act(async () => allow.click())
    expect(window.workwise.runtimeRequest).toHaveBeenCalledWith('/v1/flow-runs/decision', 'POST', JSON.stringify({ runId: 'run1', nodeId: 'review', decision: 'approve' }))
  })

  it('persists a supplement on the selected task and pauses it without creating a replacement thread', async () => {
    expect(container.querySelector('[aria-label="Task details"]')?.textContent).toContain('Monthly report')
    await input(container.querySelector<HTMLTextAreaElement>('#task-supplement')!, 'Add risk analysis')
    await click('Save and send to task')
    expect(window.workwise.appendTaskInput).toHaveBeenCalledWith('t1', expect.objectContaining({ text: 'Add risk analysis', kind: 'supplement', expectedRevision: 1, idempotencyKey: expect.any(String) }))
    await click('Pause')
    expect(window.workwise.pauseTask).toHaveBeenCalledWith('t1', expect.objectContaining({ expectedRevision: 1 }))
    expect(container.querySelector('[aria-label="Task details"]')?.textContent).toContain('Resume')
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it('shows pending decisions and resolves them through the original approval API', async () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Task filters"] button')].find(item => item.textContent?.includes('Needs you'))!
    await act(async () => button.click())
    await settle()
    expect(container.querySelector('[aria-label="Task details"]')?.textContent).toContain('Publish report')
    await click('Allow this action')
    expect(window.workwise.runtimeRequest).toHaveBeenCalledWith('/v1/approvals/approval-1', 'POST', JSON.stringify({ decision: 'allow' }))
  })

  it('starts a configured template and preserves its goal and source paths', async () => {
    await click('Research and documents')
    const dialog = container.querySelector('[role="dialog"]')!
    const fields = dialog.querySelectorAll<HTMLTextAreaElement>('textarea')
    await input(fields[0], 'Compare maintenance options')
    await input(fields[1], 'sources/a.md\nsources/b.md')
    await click('Start task')
    expect(window.workwise.startTaskTemplate).toHaveBeenCalledWith('research-document', expect.objectContaining({ workspaceRoot: '/workspace', goal: 'Compare maintenance options', sourcePaths: ['sources/a.md', 'sources/b.md'], idempotencyKey: expect.any(String) }))
  })
})

it('projects a successful retry under the stable root without showing old failure as attention', () => {
 const failed=task('failed','failed','Original goal')
 const retry={...task('retry','completed','Original goal'),rootTaskId:'failed',retryOfTaskId:'failed',createdAt:'2026-11-09T02:00:00.000Z'}
 expect(filterWorkspaceTasks([failed,retry],[],'attention')).toEqual([])
 expect(filterWorkspaceTasks([failed,retry],[],'completed').map(task=>task.id)).toEqual(['failed'])
 expect(groupWorkspaceTasks([failed,retry])).toHaveLength(1)
})
