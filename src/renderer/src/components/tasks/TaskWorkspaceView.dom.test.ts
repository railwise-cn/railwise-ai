// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskAttentionV1, TaskOperationReceiptV1, TaskPermissionSnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { TaskSidebar } from './TaskSidebar'
import { taskDisplayTitle } from '@shared/task-presentation'
import { TaskWorkspaceView, filterWorkspaceTasks, groupWorkspaceTasks, taskGroupProgress } from './TaskWorkspaceView'
import { useChatStore } from '../../store/chat-store'
import { clearFileReferenceValidationCache } from '../../lib/file-reference-validation'
import { getTaskState, resetTaskStateForTests, refreshTaskState, updateTaskNavigation } from '../../store/task-live-store'

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
  it('orders task groups by current-branch business updates for snapshot and live input order', () => {
    const original = { ...task('original', 'failed'), updatedAt: '2026-11-09T06:00:00.000Z' }
    const retry = { ...task('retry', 'completed'), rootTaskId: original.id, retryOfTaskId: original.id, createdAt: '2026-11-09T02:00:00.000Z', updatedAt: '2026-11-09T02:00:00.000Z' }
    const child = { ...task('child', 'completed'), rootTaskId: original.id, parentTaskId: retry.id, updatedAt: '2026-11-09T03:00:00.000Z' }
    const other = { ...task('other', 'completed'), updatedAt: '2026-11-09T04:00:00.000Z' }
    const inputs = [[original, retry, child, other], [other, child, retry, original], [child, other, original, retry]]
    for (const input of inputs) {
      expect(filterWorkspaceTasks(input, [], 'all').map(item => item.id)).toEqual([other.id, original.id])
      const live = [...input.filter(item => item.id !== child.id), { ...child, updatedAt: '2026-11-09T05:00:00.000Z' }]
      expect(filterWorkspaceTasks(live, [], 'all').map(item => item.id)).toEqual([original.id, other.id])
      expect(filterWorkspaceTasks(live, [], 'completed').map(item => item.id)).toEqual([original.id, other.id])
      expect(filterWorkspaceTasks(live, [], 'attention')).toEqual([])
    }
  })

  it('keeps equal-time task group order stable without changing the source tasks', () => {
    const first = task('a', 'completed'), second = task('b', 'completed')
    for (const input of [[first, second], [second, first]]) {
      const before = JSON.stringify(input)
      expect(groupWorkspaceTasks(input).map(group => group.root.id)).toEqual([first.id, second.id])
      expect(JSON.stringify(input)).toBe(before)
      expect(groupWorkspaceTasks(input).find(group => group.root.id === first.id)?.root).toBe(first)
    }
  })

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
      listTaskTemplates: vi.fn(async () => ({ templates: [{ id: 'research-document', name: 'Research', description: 'Research docs', stages: [], outputs: [], requiredInputs: [], availability: { draftAvailable: true, model: 'synthetic-model', exportStatus: 'unavailable' } }] })),
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
  await act(async () => root.render(createElement('div', null, createElement(TaskSidebar, { workspaceRoot: '/workspace', runtimeReady: true, onChooseWorkspace: vi.fn() }), createElement(TaskWorkspaceView, {
    workspaceRoot: '/workspace', runtimeReady: true, leftSidebarCollapsed: false,
    onToggleLeftSidebar: vi.fn(), onOpenThread, onOpenArtifact
  }))))
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
  it.each(['root', 'child'] as const)('promotes live current-branch updates without reviving old failed attempts or losing %s selection', async selection => {
    const original = task('original', 'failed', 'Recovered report')
    const oldRetry = { ...task('old-retry', 'failed'), rootTaskId: original.id, retryOfTaskId: original.id, createdAt: '2026-11-09T01:30:00.000Z' }
    const current = { ...task('current', 'completed'), rootTaskId: original.id, retryOfTaskId: oldRetry.id, createdAt: '2026-11-09T02:00:00.000Z', updatedAt: '2026-11-09T02:05:00.000Z' }
    const child = { ...task('current-child', 'completed'), rootTaskId: original.id, parentTaskId: current.id, updatedAt: current.updatedAt }
    const other = { ...task('other', 'completed', 'Other report'), updatedAt: '2026-11-09T02:10:00.000Z' }
    tasks = [other, original, oldRetry, current, child]; inbox = []
    const selectedTaskId = selection === 'root' ? original.id : child.id
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId, filter: 'all' }) }); await settle()
    const rows = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('.ds-task-sidebar button[title]')].filter(button => [original.goal, other.goal].includes(button.title))
    expect(rows().map(button => button.title)).toEqual([other.goal, original.goal])
    const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!, receive = vi.mocked(window.workwise.onSseEvent).mock.calls[0][0]
    const publish = async (seq: number, updated: TaskRunV1): Promise<void> => {
      await act(async () => receive({ streamId, events: [{ seq, kind: 'task_changed', taskId: updated.id, payload: updated }] })); await settle()
    }
    await publish(1, { ...child, revision: 2, updatedAt: '2026-11-09T02:15:00.000Z' })
    expect(getTaskState().tasks.at(-1)?.id).toBe(child.id)
    expect(rows().map(button => button.title)).toEqual([original.goal, other.goal])
    await publish(2, { ...other, revision: 2, updatedAt: '2026-11-09T02:20:00.000Z' })
    expect(rows().map(button => button.title)).toEqual([other.goal, original.goal])
    await publish(3, { ...original, revision: 2, updatedAt: '2026-11-09T03:00:00.000Z' })
    await publish(4, { ...oldRetry, revision: 2, updatedAt: '2026-11-09T04:00:00.000Z' })
    expect(rows().map(button => button.title)).toEqual([other.goal, original.goal])
    const selected = rows().find(button => button.title === original.goal)!
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(selected.textContent).toContain(i18n.t('common:taskRunStatus_completed'))
    expect(selected.textContent).not.toContain(i18n.t('common:taskRunStatus_failed'))
    expect(getTaskState().navigation.selectedTaskId).toBe(selectedTaskId)
    expect(filterWorkspaceTasks(getTaskState().tasks, [], 'attention')).toEqual([])
    expect(window.workwise.resumeTask).not.toHaveBeenCalled(); expect(window.workwise.retryTask).not.toHaveBeenCalled()
  })

  it('shows current retry expiry attention and keeps superseded parent data unchanged', async () => {
    await i18n.changeLanguage('zh')
    const raw='Execution grant expired; start a newly authorized Turn.'
    const original={...task('original','failed'),waitingReason:raw}
    const child={...task('retry-child','waiting_user'),rootTaskId:original.id,retryOfTaskId:original.id,waitingReason:raw}
    tasks=[original,child]
    inbox=tasks.map(owner=>({id:`capability_${owner.id}`,ownerKind:'task',ownerId:owner.id,taskId:owner.id,threadId:owner.threadId,
      kind:'blocked',title:'确认任务执行权限',message:raw,status:'pending',revision:0,createdAt:now,updatedAt:now,
      payload:{kind:'capability_required',request:{prompt:owner.goal},capability:{provider:'workspace',status:'blocked',errorCode:'execution_grant_expired',message:raw,checkedAt:now,
        action:{kind:'grant',route:'task/permissions',label:'确认任务权限'}}}}))
    await act(async()=>{await refreshTaskState();updateTaskNavigation({selectedTaskId:original.id,filter:'all'})});await settle();await settle()
    const cards=[...container.querySelectorAll('h4')].filter(node=>node.textContent==='确认任务执行权限').map(node=>node.parentElement!)
    expect(cards).toHaveLength(1)
    expect(inbox).toHaveLength(2)
    for(const card of cards){
      expect(card.querySelector(':scope > p')?.textContent).toBe('执行授权已到期')
      expect(card.textContent).not.toContain(raw)
      const diagnostics=[...card.querySelectorAll('details')].find(node=>node.querySelector('summary')?.textContent===i18n.t('common:capabilityDiagnosticDetails'))!
      expect(diagnostics).toBeTruthy();expect(diagnostics.open).toBe(false)
    }
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('hides only current retry ancestors while retaining parallel capabilities, exact owners and unresolved reviews', async () => {
    const original=task('lineage-root','failed'),middle={...task('lineage-middle','failed'),rootTaskId:original.id,retryOfTaskId:original.id,createdAt:'2026-11-09T02:00:00.000Z'}
    const current={...task('lineage-current','stalled'),threadId:original.threadId,rootTaskId:original.id,retryOfTaskId:middle.id,createdAt:'2026-11-09T04:00:00.000Z'}
    const parallel={...task('parallel-child','waiting_user'),rootTaskId:original.id,parentTaskId:original.id}
    const sibling={...task('other-retry','waiting_user'),rootTaskId:original.id,retryOfTaskId:original.id,createdAt:'2026-11-09T03:00:00.000Z'}
    const outside={...task('outside-owner','waiting_user'),threadId:original.threadId}
    tasks=[original,middle,current,parallel,sibling,outside]
    const capability=(owner:TaskRunV1,message:string,browser=false):TaskAttentionV1=>({id:`capability_${owner.id}`,ownerKind:'task',ownerId:owner.id,taskId:owner.id,threadId:owner.threadId,
      kind:'blocked',title:message,message,status:'pending',revision:0,createdAt:now,updatedAt:now,
      payload:{kind:'capability_required',request:{prompt:owner.goal},capability:{provider:browser?'browser-skill':'workspace',status:'needs_authorization',message,checkedAt:now,
        errorCode:browser?'browser_public_query_schedule_scope_required':'workspace_path_blocked',action:{kind:'grant',route:browser?'task/public-query-recovery':'task/permissions',label:'Review scope'}}}})
    inbox=[capability(original,'Old parent authorization not granted',true),capability(middle,'Old middle authorization not granted'),
      capability(current,'Current child needs permission'),capability(parallel,'Parallel child needs permission'),capability(sibling,'Other retry still needs permission'),
      {...capability(outside,'Outside explicit owner must not leak')},
      {id:'legacy-thread-only',ownerKind:'task',ownerId:'unknown',threadId:original.threadId,kind:'blocked',title:'Ambiguous legacy thread review',message:'Retain uncertain legacy owner',status:'pending',revision:0,createdAt:now,updatedAt:now,payload:{kind:'capability_required'}},
      {...approval,id:'ancestor-approval',ownerId:original.id,taskId:original.id,threadId:original.threadId,title:'Preserved source approval'},
      {id:'ancestor-unknown',ownerKind:'task',ownerId:original.id,taskId:original.id,threadId:original.threadId,kind:'blocked',title:'Preserved UNKNOWN review',message:'Unknown original action still requires review',status:'pending',revision:0,createdAt:now,updatedAt:now,payload:{kind:'operation_outcome_unknown'}},
      {id:'ancestor-question',ownerKind:'task',ownerId:original.id,taskId:original.id,threadId:original.threadId,kind:'question',title:'Preserved source question',message:'Original user input remains pending',requestId:'question-source',status:'pending',revision:0,createdAt:now,updatedAt:now,payload:{questions:[{id:'q',label:'Source clarification'}]}}]
    Object.assign(window.workwise,{diagnoseBrowserSkill:vi.fn(async()=>({ok:true,status:{enabled:true,state:'ready',version:'0.5.0',revision:1,browsers:[],origins:[],interaction:'observe'}})),
      coordinateTaskCommand:vi.fn(),confirmTaskPermissions:vi.fn(),
      getTaskPublicQueryRecovery:vi.fn(async(taskId:string)=>({taskId,taskRevision:1,state:'unavailable',reason:'browser_public_query_current_scope_active',message:'Current scope remains valid',unknownOperationCount:0,mode:'task_reauthorization',consentReceiptId:'current-consent',consentExpiresAt:new Date(Date.now()+60000).toISOString()}))})
    const before=JSON.stringify({tasks,inbox})
    await act(async()=>{await refreshTaskState();updateTaskNavigation({selectedTaskId:original.id,filter:'all'})});await settle();await settle()
    const detail=container.querySelector('article')!
    expect(detail.textContent).toContain(i18n.t('common:taskPublicQueryRecoveryScopeActive'))
    expect(detail.textContent).not.toContain('Old parent authorization not granted');expect(detail.textContent).not.toContain('Old middle authorization not granted')
    for(const message of ['Current child needs permission','Parallel child needs permission','Other retry still needs permission','Retain uncertain legacy owner','Preserved source approval','Preserved UNKNOWN review','Preserved source question'])expect(detail.textContent).toContain(message)
    expect(detail.textContent).not.toContain('Outside explicit owner must not leak')
    expect(JSON.stringify({tasks,inbox})).toBe(before)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled();expect(window.workwise.retryTask).not.toHaveBeenCalled()
    expect(window.workwise.coordinateTaskCommand).not.toHaveBeenCalled();expect(window.workwise.confirmTaskPermissions).not.toHaveBeenCalled()
    expect(window.workwise.runtimeRequest).not.toHaveBeenCalled()
  })

  it('updates sampled time and business phase without a Task revision change or another detail/list request', async () => {
    await i18n.changeLanguage('zh')
    tasks=[{...task('working','running'),activeTurnId:'turn-current',timing:{executionMs:319000,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt:now,coverage:'complete'}}];inbox=[]
    await act(async()=>{await refreshTaskState();updateTaskNavigation({selectedTaskId:'working',filter:'all'})});await settle()
    expect(container.textContent).toContain('319s')
    const pages=vi.mocked(window.workwise.listTaskPage).mock.calls.length,details=vi.mocked(window.workwise.listTaskOperationReceipts).mock.calls.length,before=JSON.stringify(tasks[0])
    const streamId=vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!,receive=vi.mocked(window.workwise.onSseEvent).mock.calls[0][0]
    const sampledAt=new Date().toISOString(),leaseExpiresAt=new Date(Date.now()+60000).toISOString()
    await act(async()=>receive({streamId,events:[{kind:'task_progress',taskId:'working',payload:{taskId:'working',taskRevision:1,turnId:'turn-current',executionId:'execution-current',
      leaseRevision:1,leaseExpiresAt,active:true,sampledAt,activity:{phase:'reading'},
      timing:{executionMs:334000,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt,coverage:'complete'}}}]}))
    await settle();expect(container.textContent).toContain('334s');expect(container.textContent).toContain('正在读取页面内容')
    expect(JSON.stringify(tasks[0])).toBe(before);expect(window.workwise.listTaskPage).toHaveBeenCalledTimes(pages);expect(window.workwise.listTaskOperationReceipts).toHaveBeenCalledTimes(details)
    vi.spyOn(Date,'now').mockReturnValue(Date.parse(leaseExpiresAt)+1)
    await act(async()=>receive({streamId,events:[{seq:1,kind:'attention_changed',payload:{id:'resolved-observation',status:'answered'}}]}))
    expect(container.textContent).not.toContain('正在读取页面内容');expect(container.textContent).toContain('334s')
  })

  it.each([
    ['stalled', 'taskNodeStatus_blocked'], ['paused', 'taskRunStatus_paused'], ['waiting_user', 'taskRunStatus_waiting_user'],
    ['waiting_approval', 'taskRunStatus_waiting_approval'], ['queued', 'taskRunStatus_queued']
  ] as const)('does not call a historical running step active when the execution task is %s', async (status, label) => {
    tasks[0] = { ...tasks[0], status, nodes: [{ id: 'historical-running', taskId: tasks[0].id, kind: 'execute', title: 'Read public notices', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 8, idempotencyKey: 'original-node', evidence: [], revision: 1 }] }
    const originalNodes = JSON.stringify(tasks[0].nodes)
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) }); await settle()
    const steps = container.querySelector('article ol')!
    expect(steps.textContent).toContain(i18n.t(`common:${label}`))
    expect(steps.textContent).not.toContain(i18n.t('common:taskNodeStatus_running'))
    expect(JSON.stringify(tasks[0].nodes)).toBe(originalNodes)
  })

  it.each(['failed', 'cancelled'] as const)('shows stopped execution for a running node of a %s task, preserving completed and other nodes', async status => {
    tasks[0] = { ...tasks[0], status, nodes: (['completed', 'running', 'pending', 'failed'] as const).map((nodeStatus, index) => ({ id: `history-${index}`, taskId: tasks[0].id, kind: 'execute', title: `Step ${index}`, status: nodeStatus, dependsOn: [], attempt: 1, maxAttempts: 8, idempotencyKey: `original-${index}`, evidence: [], revision: 1 })) }
    const originalNodes = JSON.stringify(tasks[0].nodes)
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) }); await settle()
    const rows = [...container.querySelectorAll('article ol > li')]
    expect(rows.map(row => row.lastElementChild?.textContent)).toEqual([i18n.t('common:taskNodeStatus_completed'), 'Stopped', i18n.t('common:taskNodeStatus_pending'), i18n.t('common:taskNodeStatus_failed')])
    expect(JSON.stringify(tasks[0].nodes)).toBe(originalNodes)
    expect(taskGroupProgress(groupWorkspaceTasks(tasks)[0])).toEqual({ completed: 1, total: 4 })
  })

  it('marks a running step under a completed task for review without claiming step completion', async () => {
    tasks[0] = { ...tasks[0], status: 'completed', nodes: [{ id: 'contradictory-running', taskId: tasks[0].id, kind: 'execute', title: 'Check source', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 8, idempotencyKey: 'old-running', evidence: [], revision: 1 }] }
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) }); await settle()
    const steps = container.querySelector('article ol')!
    expect(steps.textContent).toContain('Needs review')
    expect(steps.textContent).not.toContain(i18n.t('common:taskNodeStatus_completed'))
    expect(tasks[0].nodes[0].status).toBe('running')
    expect(taskGroupProgress(groupWorkspaceTasks(tasks)[0])).toEqual({ completed: 0, total: 1 })
  })

  it('keeps an actually running task step labelled running', async () => {
    tasks[0] = { ...tasks[0], nodes: [{ id: 'active-node', taskId: tasks[0].id, kind: 'execute', title: 'Read source', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 8, idempotencyKey: 'active', evidence: [], revision: 1 }] }
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) }); await settle()
    expect(container.querySelector('article ol')?.textContent).toContain(i18n.t('common:taskNodeStatus_running'))
  })

  it('keeps a completed delivery note collapsed until requested and preserves its Markdown and diagnostic text', async () => {
    await import('../chat/StreamdownAssistant')
    tasks[0] = { ...tasks[0], status: 'completed', finalResponse: '## 交付清单\n\n**已经保存**\n\n- 已生成报告\n- 已核对单位 `毫米`\n\nverify_web_artifact\n\nSHA256: ' + 'a'.repeat(64) }
    inbox = []
    await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) })
    await settle()
    const result = [...container.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === i18n.t('common:taskWorkspaceResult'))!
    expect(result.open).toBe(false)
    await act(async () => result.querySelector('summary')!.click())
    expect(result.open).toBe(true)
    expect(result.textContent).toContain('verify_web_artifact')
    expect(result.textContent).toContain('SHA256: ' + 'a'.repeat(64))
    expect(result.querySelector('h2')?.textContent).toBe('交付清单')
    expect(result.querySelector('[data-streamdown="strong"]')?.textContent, result.innerHTML).toBe('已经保存')
    expect([...result.querySelectorAll('ul > li')].map(item => item.textContent)).toEqual(['已生成报告', '已核对单位 毫米'])
    expect(result.querySelector('code')?.textContent).toBe('毫米')
    expect(result.textContent).not.toContain('##')
    expect(result.textContent).not.toContain('**')
  })
  it('resolves delivery-note links in the selected task workspace instead of the active chat', async () => {
    await import('../chat/StreamdownAssistant')
    const previousWorkspace = useChatStore.getState().workspaceRoot
    const resolveWorkspaceFile = vi.fn(async (request: { path: string; workspaceRoot?: string }) => ({ ok: true, path: `${request.workspaceRoot}/${request.path}` }))
    Object.assign(window.workwise, { resolveWorkspaceFile })
    clearFileReferenceValidationCache()
    try {
      await act(async () => useChatStore.setState({ workspaceRoot: '/unrelated-chat' }))
      tasks[0] = { ...tasks[0], status: 'completed', finalResponse: '[已保存的报告](reports/delivery.md)' }
      inbox = []
      await act(async () => { await refreshTaskState(); updateTaskNavigation({ selectedTaskId: tasks[0].id, filter: 'all' }) })
      await settle()
      await settle()
      expect(resolveWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'reports/delivery.md', workspaceRoot: tasks[0].workspaceRoot }))
      expect(resolveWorkspaceFile.mock.calls.every(([request]) => request.workspaceRoot !== '/unrelated-chat')).toBe(true)
      expect(container.querySelector('a.ds-file-reference-link')?.textContent).toBe('已保存的报告')
    } finally {
      await act(async () => useChatStore.setState({ workspaceRoot: previousWorkspace }))
      clearFileReferenceValidationCache()
    }
  })

  it('offers public-query recovery only from the current task server projection', async () => {
    tasks[0] = { ...tasks[0], status: 'stalled', revision: 2 }
    inbox = []
    Object.assign(window.workwise, {
      getTaskPublicQueryRecovery: vi.fn(async (taskId: string) => ({ taskId, taskRevision: 2, state: 'eligible', message: 'A new public search is available.', unknownOperationCount: 2 }))
    })
    await act(async () => refreshTaskState())
    await settle()
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Prepare a new search')).toBe(true)
    expect([...container.querySelectorAll('button')].some(button => button.textContent === i18n.t('common:taskRunResume'))).toBe(false)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(window.workwise.retryTask).not.toHaveBeenCalled()
  })

  it('keeps an expired one-off scope informational instead of offering a misleading Continue action', async () => {
    tasks[0] = { ...tasks[0], status: 'stalled', revision: 2 }
    inbox = []
    Object.assign(window.workwise, {
      getTaskPublicQueryRecovery: vi.fn(async (taskId: string) => ({ taskId, taskRevision: 2, state: 'unavailable', reason: 'browser_public_query_schedule_scope_required', message: 'Fresh scope required.', unknownOperationCount: 0 }))
    })
    await act(async () => refreshTaskState())
    await settle()
    expect(container.textContent).toContain(i18n.t('common:taskPublicQueryRecoveryFreshScopeRequired'))
    expect([...container.querySelectorAll('button')].some(button => button.textContent === i18n.t('common:taskRunResume'))).toBe(false)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(window.workwise.retryTask).not.toHaveBeenCalled()
  })

  it.each(['waiting_user', 'waiting_approval', 'stalled'] as const)('lets the user explicitly pause a %s task before resolving its blocker', async status => {
    tasks[0] = { ...tasks[0], status }
    inbox = []
    await act(async () => refreshTaskState())
    const pause = [...container.querySelectorAll('button')].find(button => button.textContent === 'Pause')
    expect(pause).toBeTruthy()
    await act(async () => pause!.click())
    await settle()
    expect(window.workwise.pauseTask).toHaveBeenCalledExactlyOnceWith('t1', expect.objectContaining({ expectedRevision: 1 }))
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Pause')).toBe(false)
    expect([...container.querySelectorAll('button')].some(button => button.textContent === i18n.t('common:taskRunResume'))).toBe(true)
  })
  it('leaves a resolved standalone attention card and returns to an available task', async () => {
    inbox = [{ ...approval, id: 'standalone-review', taskId: undefined, threadId: undefined, workspaceRoot: '/workspace', title: 'Standalone review' }]
    await act(async () => refreshTaskState())
    await act(async () => updateTaskNavigation({ selectedTaskId: null, selectedAttentionId: 'standalone-review' }))
    await settle()
    expect(container.querySelector('[aria-label="Task details"]')).toBeNull()
    inbox = []
    await act(async () => refreshTaskState())
    await settle()
    expect(container.querySelector('[aria-label="Task details"]')).not.toBeNull()
  })
  it('renders an empty task workspace without a repeated selection update', async () => {
    tasks = []
    inbox = []
    await act(async () => refreshTaskState())
    await settle()
    expect(container.querySelectorAll('.ds-task-sidebar button[aria-pressed="true"]')).toHaveLength(1)
    expect(container.querySelector('.ds-task-workspace-empty')?.textContent).toContain('Select a task in the sidebar')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('keeps one task list in the left sidebar and a single current task in the work surface', async () => {
    await i18n.changeLanguage('zh')
    const goal = '创建一个完整、独立运行的 HTML 文件，使用 SVG 绘制一只正在骑自行车的鹈鹕，并制作成二维动画。所有代码包含在同一个文件中。'
    tasks[0] = { ...tasks[0], goal, status: 'stalled' }
    await act(async () => refreshTaskState())
    const workspace = container.querySelector('[aria-label="任务"]')!
    expect(container.querySelectorAll('[aria-label="任务列表"]')).toHaveLength(1)
    expect(workspace.querySelector('[aria-label="任务列表"]')).toBeNull()
    expect(workspace.querySelector('[aria-label="任务筛选"]')).toBeNull()
    expect(workspace.querySelector('input[type="search"]')).toBeNull()
    expect(workspace.querySelector('h2')?.textContent).toContain('鹈鹕')
    const original = [...workspace.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === '原始要求')!
    expect(original.open).toBe(false)
    expect(original.textContent).toContain(goal)
    expect([...workspace.querySelectorAll('button')].some(button => button.textContent === '暂停')).toBe(true)
  })

  it('shows an explicit task name in navigation and details while preserving the full original request', async () => {
    await i18n.changeLanguage('zh')
    const goal = '新任务：大单网临时实钟验收（0.5.7，临时验证）。此任务与原来的正式采集计划独立。\n使用已核对的原任务范围。'
    tasks[0] = { ...tasks[0], goal, status: 'stalled' }
    const original = JSON.stringify(tasks[0])
    await act(async () => refreshTaskState())
    const details = container.querySelector('[aria-label="任务详情"]')!
    expect(details.querySelector('h2')?.textContent).toBe('大单网临时实钟验收')
    const item = [...container.querySelectorAll('.ds-task-sidebar button[title]')].find(item => item.getAttribute('title') === goal)!
    expect(item.textContent).toContain('大单网临时实钟验收')
    expect(item.textContent).not.toContain('采集计划独立')
    const request = [...details.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === '原始要求')!
    expect(request.textContent).toContain(goal)
    expect(JSON.stringify(tasks[0])).toBe(original)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('explicitly rechecks an existing local HTML output without starting a model or discarding the task', async () => {
    tasks[0] = { ...tasks[0], status: 'stalled', goal: '使用 SVG 绘制一只骑自行车的鹈鹕，生成独立 HTML 动画，打开浏览器即可查看。',
      acceptance: { ...tasks[0].acceptance, kind: 'files', requiredFormats: ['html'], requiresWebEvidence: true, requiredSourceOrigins: [] },
      artifacts: [{ id: 'html', relativePath: 'pelican.html', storage: 'task', validation: 'valid', sha256: 'a'.repeat(64), sourceEvidenceStatus: 'draft', createdAt: now }] }
    const revalidate = vi.fn(async () => {
      tasks[0] = { ...tasks[0], status: 'completed', revision: 2, acceptance: { ...tasks[0].acceptance, requiresWebEvidence: false }, artifacts: [{ ...tasks[0].artifacts[0], sourceEvidenceStatus: undefined }] }
      return { task: tasks[0], corrected: true, completed: true, reason: 'Local output checked.' }
    })
    Object.assign(window.workwise, { revalidateTaskArtifacts: revalidate })
    await act(async () => refreshTaskState())
    await click('Recheck existing output')
    expect(revalidate).toHaveBeenCalledWith('t1', { expectedRevision: 1, idempotencyKey: expect.any(String), confirmed: true })
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(window.workwise.retryTask).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Task details"]')?.textContent).toContain('pelican.html')
    expect(container.querySelector('nav[aria-label="Task filters"] button[aria-pressed="true"]')?.textContent).toContain('Completed')
  })

  it('labels sourced HTML drafts and verified outputs separately while keeping ordinary file validation and draft preview', async () => {
    await i18n.changeLanguage('zh')
    tasks[0].acceptance.requiresWebEvidence = true
    tasks[0].artifacts = [
      { id: 'draft', relativePath: '待核验报告.html', validation: 'valid', sourceEvidenceStatus: 'draft', sha256: 'a'.repeat(64), createdAt: now },
      { id: 'verified', relativePath: '已核验报告.html', validation: 'valid', sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof-report', sha256: 'b'.repeat(64), createdAt: now },
      { id: 'legacy', relativePath: '旧报告.htm', validation: 'valid', sha256: 'c'.repeat(64), createdAt: now },
      { id: 'file', relativePath: '统计数据.csv', validation: 'valid', sha256: 'd'.repeat(64), createdAt: now }
    ]
    await act(async () => refreshTaskState())
    await click('Monthly report')
    const row = (name: string) => [...container.querySelectorAll('li')].find(item => item.textContent?.includes(name))!
    expect(row('待核验报告.html').textContent).toContain('草稿·来源待核验')
    expect(row('待核验报告.html').textContent).not.toContain('验证通过')
    expect(row('旧报告.htm').textContent).toContain('草稿·来源待核验')
    expect(row('已核验报告.html').textContent).toContain('文件及来源已核验')
    expect(row('统计数据.csv').textContent).toContain('验证通过')
    expect(row('统计数据.csv').textContent).not.toContain('来源待核验')
    await click('待核验报告.html')
    expect(onOpenArtifact).toHaveBeenCalledWith(tasks[0], '待核验报告.html', 'draft')
  })

  it('restores an eligible failed task in place and starts it only after a separate Continue', async () => {
    const original: TaskRunV1 = {...task('original-expired','failed','Original public query'),attempts:8,
      timing:{executionMs:1013026,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt:now,coverage:'complete'}}
    tasks = [original]; inbox = []
    let permission: TaskPermissionSnapshotV1 = {
      taskId:original.id,taskRevision:1,taskTitle:original.goal,scopeHash:'expired-scope',workspaceRoot:'/workspace',workspaceTrust:'read-only',workspaceRevision:2,agentRevision:3,
      approvalPolicy:'on-request',targetApprovalPolicy:'on-request',maxTtlSeconds:900,canConfirm:true,recoveryEligible:true,canRestoreBase:true,
      grant:{id:'temporary-diagnostic',status:'expired',confirmedAt:now,expiresAt:now,scope:{readPaths:['/workspace','/old/diagnostic'],writePaths:[]}}
    }
    Object.assign(window.workwise,{
      getTaskPermissions:vi.fn(async()=>permission),getTaskRun:vi.fn(async()=>tasks[0]),listAgentProfiles:vi.fn(async()=>({profiles:[]})),confirmTaskPermissions:vi.fn(),
      runtimeRequest:vi.fn(async(path:string,method:string,body?:string)=>{
        if(method==='GET')return {ok:true,status:200,body:JSON.stringify({agentRevision:3})}
        expect(path).toBe('/v1/tasks/original-expired/permissions'); expect(method).toBe('DELETE')
        expect(JSON.parse(body!)).toEqual({expectedRevision:1,permissionId:'temporary-diagnostic',idempotencyKey:expect.any(String),restoreBase:true})
        tasks = [{...tasks[0],status:'paused',revision:2}]
        permission = {...permission,taskRevision:2,recoveryEligible:false,canRestoreBase:false,grant:undefined}
        return {ok:true,status:200,body:JSON.stringify({task:tasks[0],permission,resumed:false})}
      })
    })
    await act(async()=>refreshTaskState())
    await click('All tasks'); await click('Original public query')
    const summary = [...container.querySelectorAll('details > summary')].find(item=>item.textContent===i18n.t('common:taskPermissionReview'))!
    await act(async()=>{(summary as HTMLElement).click()})
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true)
    await settle()
    await click(i18n.t('common:taskPermissionRestoreBase'))
    expect([...container.querySelectorAll('[role="status"]')].some(item=>item.textContent===i18n.t('common:taskPermissionBaseRestored'))).toBe(true)
    expect(tasks[0]).toMatchObject({id:original.id,status:'paused',attempts:8,timing:original.timing,budget:original.budget})
    expect(window.workwise.resumeTask).not.toHaveBeenCalled(); expect(window.workwise.retryTask).not.toHaveBeenCalled()
    expect(window.workwise.confirmTaskPermissions).not.toHaveBeenCalled(); expect(window.workwise.startTaskTemplate).not.toHaveBeenCalled()
    await click(i18n.t('common:taskRunResume'))
    expect(window.workwise.resumeTask).toHaveBeenCalledExactlyOnceWith(original.id,{expectedRevision:2,idempotencyKey:expect.any(String)})
    expect(window.workwise.retryTask).not.toHaveBeenCalled()
  })

  it('keeps detailed task permissions closed until the user opens them', async () => {
    await click('Monthly report')
    const summary = [...container.querySelectorAll('details > summary')].find(item => item.textContent === i18n.t('common:taskPermissionReview'))
    expect(summary).toBeTruthy()
    expect((summary!.parentElement as HTMLDetailsElement).open).toBe(false)
  })

  it('opens an authorized external artifact by task identity and displays its file name', async () => {
    const openTaskArtifact = vi.fn(async () => ({ ok: true as const }))
    Object.assign(window.workwise, { openTaskArtifact })
    tasks[0].artifacts = [{ id: 'artifact-external', relativePath: 'reports/result.md', absolutePath: '/authorized-private/reports/result.md', authorizedRoot: '/authorized-private', executionGrantId: 'grant-private', validation: 'valid', sha256: 'a'.repeat(64), createdAt: now }]
    await act(async () => refreshTaskState())
    await settle()
    await click('Monthly report')
    await click('result.md')
    expect(openTaskArtifact).toHaveBeenCalledWith({ taskId: 't1', artifactId: 'artifact-external' })
    expect(onOpenArtifact).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('/authorized-private')
    expect(container.textContent).not.toContain('grant-private')
  })

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
    expect(section.textContent).not.toMatch(/hidden-(?:thread|session|turn)-identifier/)
    const visible = section.cloneNode(true) as HTMLElement
    visible.querySelectorAll('details:not([open])').forEach(details => details.replaceChildren(details.querySelector('summary')!.cloneNode(true)))
    expect(visible.textContent).not.toMatch(/lark_task_complete|remote-operation-42|result-sha256|request-sha256/)
    const executionDetails = [...section.querySelectorAll('details')].find(details => details.textContent?.includes('lark_task_complete'))!
    expect(executionDetails.open).toBe(false)
    executionDetails.open = true
    expect(executionDetails.textContent).toContain('lark_task_complete')
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
    expect(container.querySelector(`[aria-label="${details}"] h2`)?.textContent).toBe(taskDisplayTitle({ goal }))
    expect([...container.querySelectorAll('[aria-label] button[title]')].some(button => button.getAttribute('title') === goal)).toBe(true)
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

  it.each(['completed', 'not_completed'] as const)('uses the browser review command and preserves a paused task after explicit %s confirmation', async decision => {
    const pending = { ...task('browser-review', 'paused', 'Review original query'), revision: 7 }
    tasks = [pending]; inbox = []
    const receipt: TaskOperationReceiptV1 = { id: 'browser-receipt', taskId: pending.id, purpose: 'browser_action',
      provider: 'browser-skill', operation: 'click', toolName: 'browser_click', requestHash: 'a'.repeat(64), status: 'outcome_unknown',
      browser: { action: 'click', pageUrl: 'https://example.com/notices', canReview: true }, createdAt: now, updatedAt: now }
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([receipt])
    vi.mocked(window.workwise.verifyTaskOperationReceipt).mockResolvedValue({ taskId: pending.id, receiptId: receipt.id, status: 'outcome_unknown',
      browserReview: { id: 'review-1', action: 'click', pageUrl: 'https://example.com/notices', observationText: 'Public query completed', expiresAt: new Date(Date.now() + 120_000).toISOString() } })
    const runtimeRequest = vi.mocked(window.workwise.runtimeRequest)
    runtimeRequest.mockImplementation(async path => {
      if (path.endsWith('/browser-confirm')) {
        tasks = [{ ...pending, revision: 8 }]
        return { ok: true, status: 200, body: JSON.stringify({ taskId: pending.id, receiptId: receipt.id, status: 'verified', outcome: decision === 'not_completed' ? 'not_completed' : 'succeeded', evidence: { kind: 'human_confirmation', provider: 'browser-skill', operation: 'click', target: 'https://example.com/notices', status: decision === 'not_completed' ? 'public_query_reviewed_incomplete' : 'public_query_confirmed_by_user', verified: true, verifiedAt: new Date().toISOString(), resultHash: 'b'.repeat(64) } }) }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    await act(async () => { await refreshTaskState() })
    await click('In progress')
    await click('Check the original page')
    const checkbox = container.querySelector<HTMLInputElement>('[aria-label="Review this browser operation"] input[type="checkbox"]')!
    expect(checkbox).toBeTruthy()
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLInputElement>(`input[value="${decision}"]`)!.click())
    await act(async () => checkbox.click())
    const refreshes = vi.mocked(window.workwise.listTaskPage).mock.calls.length
    await click('Save my confirmation')
    const request = runtimeRequest.mock.calls.find(([path]) => path.endsWith('/browser-confirm'))!
    expect(request[0]).toBe('/v1/tasks/browser-review/receipts/browser-receipt/browser-confirm')
    expect(request[1]).toBe('POST')
    expect(JSON.parse(request[2]!)).toEqual({ expectedRevision: 7, idempotencyKey: expect.any(String), reviewId: 'review-1', decision })
    expect(tasks[0].status).toBe('paused')
    expect(tasks[0].revision).toBe(8)
    expect(vi.mocked(window.workwise.listTaskPage).mock.calls.length).toBeGreaterThan(refreshes)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(window.workwise.appendTaskInput).not.toHaveBeenCalled()
  })

  it('keeps a failed browser review reason visible through its refresh and later updates of the same root', async () => {
    const pending = { ...task('browser-failure', 'paused', '核对原网页'), revision: 7 }
    tasks = [pending]; inbox = []
    const receipt: TaskOperationReceiptV1 = { id: 'failed-browser-receipt', taskId: pending.id, purpose: 'browser_action',
      provider: 'browser-skill', operation: 'fill', toolName: 'browser_fill', requestHash: 'a'.repeat(64), status: 'outcome_unknown',
      browser: { action: 'fill', pageUrl: 'https://example.com/notices', canReview: true }, createdAt: now, updatedAt: now }
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([receipt])
    vi.mocked(window.workwise.verifyTaskOperationReceipt).mockResolvedValue({ taskId: pending.id, receiptId: receipt.id,
      status: 'outcome_unknown', errorCode: 'browser_review_read_failed' })
    await act(async () => { await i18n.changeLanguage('zh'); await refreshTaskState() })
    await click('进行中')
    const originalCard = container.querySelector('[aria-label="网页操作核验"] li')!
    expect(originalCard).toBeTruthy()
    const refreshes = vi.mocked(window.workwise.listTaskPage).mock.calls.length
    await click('检查原网页结果')
    const message = i18n.t('common:taskBrowserReviewUnavailable')
    expect(container.textContent).toContain(message)
    expect(container.querySelector('[aria-label="网页操作核验"] li')).toBe(originalCard)
    expect(vi.mocked(window.workwise.listTaskPage).mock.calls.length).toBeGreaterThan(refreshes)
    const event = vi.mocked(window.workwise.onSseEvent).mock.calls.at(-1)![0]
    const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls.at(-1)![1]!
    tasks = [{ ...pending, revision: 8 }]
    await act(async () => event({ streamId, events: [{ seq: 1, taskId: pending.id, kind: 'task_changed', payload: tasks[0], createdAt: now }] }))
    await settle()
    expect(container.textContent).toContain(message)
    expect(container.querySelector('[aria-label="网页操作核验"] li')).toBe(originalCard)
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
    expect(window.workwise.appendTaskInput).not.toHaveBeenCalled()
    expect(tasks[0].status).toBe('paused')
  })

  it('clears the previous root review immediately when switching tasks and ignores its late detail response', async () => {
    const first = task('browser-first', 'paused', '第一个公开查询')
    const second = task('browser-second', 'paused', '另一个独立任务')
    tasks = [first, second]; inbox = []
    const receipt: TaskOperationReceiptV1 = { id: 'first-browser-receipt', taskId: first.id, purpose: 'browser_action',
      provider: 'browser-skill', operation: 'click', toolName: 'browser_click', requestHash: 'a'.repeat(64), status: 'outcome_unknown',
      browser: { action: 'click', pageUrl: 'https://example.com/first', canReview: true }, createdAt: now, updatedAt: now }
    vi.mocked(window.workwise.listTaskOperationReceipts).mockImplementation(async id => id === first.id ? [receipt] : [])
    vi.mocked(window.workwise.verifyTaskOperationReceipt).mockResolvedValue({ taskId: first.id, receiptId: receipt.id, status: 'outcome_unknown',
      browserReview: { id: 'first-private-review', action: 'click', pageUrl: 'https://example.com/first', observationText: '只属于第一个任务的观察内容', expiresAt: new Date(Date.now() + 120_000).toISOString() } })
    await act(async () => { await i18n.changeLanguage('zh'); await refreshTaskState() })
    await click('进行中')
    await click('第一个公开查询')
    await click('检查原网页结果')
    expect(container.textContent).toContain('只属于第一个任务的观察内容')
    let finishOldRead: ((value: TaskOperationReceiptV1[]) => void) | undefined
    vi.mocked(window.workwise.listTaskOperationReceipts).mockImplementation(id => id === first.id
      ? new Promise(resolve => { finishOldRead = resolve }) : new Promise(() => undefined))
    tasks = [{ ...first, revision: 2 }, second]
    await act(async () => refreshTaskState())
    expect(finishOldRead).toBeTypeOf('function')
    expect(container.textContent).toContain('只属于第一个任务的观察内容')
    await click('另一个独立任务')
    expect(container.querySelector('[aria-label="任务详情"] h2')?.textContent).toBe('另一个独立任务')
    expect(container.textContent).not.toContain('只属于第一个任务的观察内容')
    expect(container.textContent).not.toContain('https://example.com/first')
    expect(container.querySelector('[aria-label="网页操作核验"]')).toBeNull()
    await act(async () => finishOldRead!([receipt]))
    await settle()
    expect(container.textContent).not.toContain('只属于第一个任务的观察内容')
    expect(container.querySelector('[aria-label="网页操作核验"]')).toBeNull()
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('uses the browser business review without exposing technical fingerprints in task attention', async () => {
    const summary = ['确认浏览器操作', '站点 "https://example.com"', '动作 "填写网页输入框"', '目标 "采购关键词"',
      '输入内容 "轨道交通监测"', `输入摘要 "${'a'.repeat(64)}"`, `目标摘要 "${'b'.repeat(64)}"`, `请求摘要 "${'c'.repeat(64)}"`,
      '授权期限 "仅本次操作"', '操作说明 "执行后读取页面核验。"'].join('\n')
    inbox = [{ ...approval, message: summary }]
    tasks = tasks.map(item => item.id === approval.taskId ? { ...item, waitingReason: summary } : item)
    await act(async () => refreshTaskState())
    await click('Needs you')
    expect(container.textContent).toContain('采购关键词')
    expect(container.textContent).toContain('轨道交通监测')
    expect(container.textContent).not.toContain('a'.repeat(64))
    expect(container.textContent).not.toContain('输入摘要')
  })

  it('projects a blocked resume into its durable actionable card while preserving pause', async () => {
    const capability = { provider: 'browser-skill', status: 'needs_authorization', errorCode: 'browser_binding_changed',
      message: '请确认当前任务的浏览器范围。', action: { kind: 'grant', route: 'task/browser-binding', label: '确认当前任务的浏览器范围' } }
    tasks = [{ ...tasks[0], status: 'paused' }]
    inbox = []
    const original = tasks[0]
    const binding = { taskId: original.id, taskRevision: original.revision, browserRevision: 3, browserInstanceId: 'new-browser',
      browserLabel: 'Chrome 验收', origins: ['https://example.com'], interaction: 'interact', previousInteraction: 'observe' }
    Object.assign(window.workwise, {
      diagnoseBrowserSkill: vi.fn(async () => ({ status: { enabled: true, state: 'ready', origins: binding.origins, interaction: 'interact', revision: 3, browsers: [] } })),
      getBrowserTaskBinding: vi.fn(async () => binding),
      confirmBrowserTaskBinding: vi.fn(async () => ({ binding, resumed: false })),
      resumeTask: vi.fn(async () => {
        inbox = [{ ...approval, id: `capability_${original.id}`, ownerId: original.id, taskId: original.id, threadId: original.threadId,
          kind: 'blocked', title: '继续原任务前需要处理', message: capability.message, requestId: undefined,
          payload: { kind: 'capability_required', capability, request: { prompt: original.goal } } }]
        return { task: original, capability, attentionId: inbox[0].id }
      })
    })
    await act(async () => refreshTaskState())
    await settle()
    await click('Resume')
    expect(window.workwise.resumeTask).toHaveBeenCalledOnce()
    expect(tasks[0]).toEqual(original)
    expect(container.textContent).toContain(capability.message)
    const workspaceValue = container.querySelector(`[aria-label="${i18n.t('common:capabilityRequiredTitle')}"] dl`)?.textContent
    expect(workspaceValue).toContain(original.workspaceRoot)
    expect(workspaceValue).not.toContain('No workspace selected')
    expect(container.querySelector('nav[aria-label="Task filters"] button[aria-pressed="true"]')?.textContent).toContain('Needs you')
    await click('确认当前任务的浏览器范围')
    expect(window.workwise.getBrowserTaskBinding).toHaveBeenCalledWith(original.id)
    expect(container.textContent).toContain('Chrome 验收')
    await click('Confirm browser scope for this task')
    expect(window.workwise.confirmBrowserTaskBinding).toHaveBeenCalledWith(original.id, expect.objectContaining({ interaction: 'interact', expectedTaskRevision: original.revision }))
    expect(window.workwise.resumeTask).toHaveBeenCalledOnce()
    await act(async () => refreshTaskState())
    expect(container.textContent).toContain('继续原任务前需要处理')
  })

  it.each(['resume', 'retry', 'blocked'] as const)('marks an explicitly continued scheduled task as foreground only after a real new Turn (%s)', async action => {
    tasks = [Object.assign({ ...tasks[0], status: action === 'retry' ? 'failed' as const : 'paused' as const,
      originThreadId: 'original-chat' }, { scheduledBy: { scheduleId: 'daily', dueAt: now } })]
    inbox = []
    const result = action === 'blocked'
      ? { task: tasks[0], capability: { provider: 'ego-browser', status: 'needs_authorization', message: '需要处理' } }
      : { task: tasks[0], turn: { threadId: tasks[0].threadId, turnId: 'explicit-user-turn' } }
    Object.assign(window.workwise, { resumeTask: vi.fn(async () => result), retryTask: vi.fn(async () => result) })
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    try {
      await act(async () => refreshTaskState())
      await click(action === 'retry' ? i18n.t('common:taskRunRetry') : i18n.t('common:taskRunResume'))
      const foreground = dispatch.mock.calls.map(([event]) => event as CustomEvent).filter(event => event.type === 'railwise:foreground-task-artifact-preview')
      expect(foreground.map(event => event.detail)).toEqual(action === 'blocked'
        ? [] : [{ threadId: 'original-chat', taskId: tasks[0].id }])
    } finally { dispatch.mockRestore() }
  })

  it('requires attention without displaying host command history or approval internals by default', async () => {
    const command = 'Run request_host_shell\nCommand (JSON): private example command\nRequest SHA256: abc123'
    inbox = [{ ...approval, message: command, presentation: { reason: 'approval_host_shell', scope: 'host', actions: ['approve', 'deny', 'open_thread'] } }]
    vi.mocked(window.workwise.listTaskOperationReceipts).mockResolvedValue([{
      id: 'shell-receipt', taskId: 't2', purpose: 'host_shell', provider: 'host', operation: 'shell', toolName: 'request_host_shell',
      requestHash: 'request-sha', status: 'failed', createdAt: now, updatedAt: now
    }])
    await act(async () => refreshTaskState())
    await click('Needs you')
    const taskView = container.querySelector('article')!
    const approvalDetails = [...taskView.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent?.includes('View scope and technical details'))!
    const history = [...taskView.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent?.includes('Local command history'))!
    expect(taskView.textContent).toContain('full host access')
    expect(taskView.textContent).not.toContain('private example command')
    expect(history.open).toBe(false)
    expect(approvalDetails.open).toBe(false)
    expect(JSON.stringify(vi.mocked(window.workwise.notifyTask).mock.calls)).not.toContain('private example command')
    await act(async () => {
      approvalDetails.open = true
      approvalDetails.dispatchEvent(new Event('toggle'))
    })
    expect(approvalDetails.textContent).toContain(command)
    await click('Allow this action')
    expect(container.textContent).toContain('Your decision is saved')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
  })

  it('imports a selected document into the original task and describes a scanned PDF accurately', async () => {
    const first = { ...tasks[0], originThreadId: 'original-chat', status: 'waiting_user' as const }
    tasks = [first]
    inbox = []
    const getPathForFile = vi.fn(() => '/user-selected/brochure.pdf')
    const importChatAttachment = vi.fn(async () => ({ attachment: {
      id: 'document-id', name: 'brochure.pdf', kind: 'document', state: 'degraded',
      degradationReasons: ['no_extractable_pdf_text']
    } }))
    const coordinateTaskCommand = vi.fn(async () => ({ kind: 'input_queued', task: first }))
    Object.assign(window.workwise, { getPathForFile, importChatAttachment, coordinateTaskCommand })
    await act(async () => refreshTaskState())
    const chooser = container.querySelector<HTMLInputElement>('article input[type="file"]')!
    const file = new File(['yes'], 'brochure.pdf', { type: 'application/pdf' })
    await act(async () => {
      Object.defineProperty(chooser, 'files', { configurable: true, value: [file] })
      chooser.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(importChatAttachment).toHaveBeenCalledExactlyOnceWith({ sourcePath: '/user-selected/brochure.pdf', threadId: 'original-chat', workspace: '/workspace' })
    expect(container.textContent).toContain('No text could be extracted')
    await click('Save and send to task')
    expect(coordinateTaskCommand).toHaveBeenCalledExactlyOnceWith({
      taskId: first.id, threadId: 'original-chat', intent: 'supplement', expectedRevision: first.revision,
      idempotencyKey: expect.any(String),
      request: { prompt: 'Use the attached document for the current task.', attachmentIds: ['document-id'] }
    })
    expect(container.textContent).toContain('The update is saved')
    expect(window.workwise.resumeTask).not.toHaveBeenCalled()
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
