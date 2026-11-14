// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPermissionSnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { TaskPermissionPanel } from './TaskPermissionPanel'

const snapshot: TaskPermissionSnapshotV1 = {
  taskId:'task-1',taskRevision:4,taskTitle:'整理项目飞书待办',scopeHash:'reviewed-scope',workspaceRoot:'/project/synthetic',workspaceTrust:'workspace-write',workspaceRevision:3,agentRevision:7,
  approvalPolicy:'never',targetApprovalPolicy:'on-request',maxTtlSeconds:900,canConfirm:true,sandboxMode:'read-only',agentTrust:'read-only',agentName:'项目审阅 Agent',
  toolAllowlist:['lark_task_list'],mcpAllowlist:[],externalTargets:['["lark","complete","task-42"]'],
  connectorScopeSources:[{provider:'lark',scopes:['task:task:write'],source:'task_requirements'},
    {provider:'lark',scopes:['task:task:read'],source:'last_execution_grant',issuedAt:'2026-11-09T00:00:00.000Z',expiresAt:'2026-11-09T00:15:00.000Z'}]
}
let root: Root
let container: HTMLDivElement
const onConfirmed=vi.fn()
const api={
  getTaskPermissions:vi.fn(async()=>snapshot),getTaskRun:vi.fn(async()=>({id:'task-1',threadId:'hidden-1',status:'waiting_user'}) as TaskRunV1|null),
  listAgentProfiles:vi.fn(async()=>({profiles:[]})),runtimeRequest:vi.fn(async(_path?:string,_method?:string,_body?:string)=>({ok:true,body:JSON.stringify({agentRevision:7})})),
  confirmTaskPermissions:vi.fn(async():Promise<{task?:TaskRunV1;permission:TaskPermissionSnapshotV1;resumed:boolean}>=>({permission:{...snapshot,canConfirm:false},resumed:false})),setThreadAgent:vi.fn(),resumeTask:vi.fn(),retryTask:vi.fn()
}

function button(label:string):HTMLButtonElement {
  const result=[...container.querySelectorAll('button')].find(candidate=>candidate.textContent===label)
  if(!result)throw new Error(`Missing button ${label}`)
  return result
}
async function click(label:string):Promise<void>{await act(async()=>{button(label).click();await Promise.resolve();await Promise.resolve()})}

beforeEach(async()=>{
  vi.clearAllMocks()
  api.getTaskPermissions.mockResolvedValue(snapshot)
  api.runtimeRequest.mockResolvedValue({ok:true,body:JSON.stringify({agentRevision:7})})
  api.confirmTaskPermissions.mockResolvedValue({permission:{...snapshot,canConfirm:false},resumed:false})
  api.getTaskRun.mockResolvedValue({id:'task-1',threadId:'hidden-1',status:'waiting_user'} as TaskRunV1)
  await i18n.changeLanguage('zh')
  Object.defineProperty(window,'workwise',{configurable:true,value:api})
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  await act(async()=>root.render(createElement(TaskPermissionPanel,{taskId:'task-1',onConfirmed})))
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();Reflect.deleteProperty(window,'workwise');await i18n.changeLanguage('en')})

describe('task permission authority overview',()=>{
  it('recovers the same failed task through explicit base restoration without resuming or replacing it', async () => {
    const expired = { ...snapshot, workspaceTrust: 'read-only', sandboxMode: 'read-only', canWritePaths: false, canConfirm: true,
      recoveryEligible: true, canRestoreBase: true, grant: { id: 'expired-diagnostic', status: 'active', confirmedAt: '2026-11-14T12:11:56.795Z', expiresAt: new Date(Date.now() - 60_000).toISOString(), scope: { readPaths: ['/project/synthetic', '/old/diagnostic'], writePaths: [] } } } as TaskPermissionSnapshotV1
    const original: TaskRunV1 = {id:'task-1',threadId:'hidden-1',status:'failed',revision:4,attempts:8,budget:{maxAttempts:8,maxDurationMs:1800000},
      timing:{executionMs:1013026,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt:'2026-11-14T14:00:00.000Z',coverage:'complete'},
      childTaskIds:[],workspaceRoot:'/project/synthetic',goal:'Original public query',acceptance:{kind:'answer',requiredNodeKinds:[],requireFinalResponse:true,requireActionableArtifactCard:false},
      agentId:'default',replans:0,noProgressCount:0,nodes:[],artifacts:[],createdAt:'2026-11-14T12:00:00.000Z',updatedAt:'2026-11-14T14:00:00.000Z'}
    api.getTaskPermissions.mockResolvedValue(expired); api.getTaskRun.mockResolvedValue(original)
    api.runtimeRequest.mockImplementation(async (_path, method, body) => {
      if (method !== 'DELETE') return {ok:true,body:JSON.stringify({agentRevision:7})}
      expect(JSON.parse(body!)).toEqual({expectedRevision:4,permissionId:'expired-diagnostic',idempotencyKey:expect.any(String),restoreBase:true})
      const paused = {...original,status:'paused',revision:5} as TaskRunV1
      const permission = {...snapshot,taskRevision:5,workspaceTrust:'read-only',recoveryEligible:false,canRestoreBase:false} as TaskPermissionSnapshotV1
      api.getTaskRun.mockResolvedValue(paused); api.getTaskPermissions.mockResolvedValue(permission)
      return {ok:true,body:JSON.stringify({task:paused,permission,resumed:false})}
    })
    await click('查看当前任务权限')
    expect(container.textContent).toContain(i18n.t('common:taskPermissionExpired'))
    await click(i18n.t('common:taskPermissionRestoreBase'))
    expect(onConfirmed).toHaveBeenCalledWith(i18n.t('common:taskPermissionBaseRestored'))
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled(); expect(api.resumeTask).not.toHaveBeenCalled(); expect(api.retryTask).not.toHaveBeenCalled()
    expect(original.attempts).toBe(8); expect(original.timing?.executionMs).toBe(1013026)
  })

  it('requires explicit reconfirmation for an eligible failed expired grant and rejects automatic-resume replies', async () => {
    const expired = {...snapshot,canConfirm:true,recoveryEligible:true,canRestoreBase:true,grant:{id:'expired',status:'expired',confirmedAt:'2026-11-14T12:11:56.795Z',expiresAt:'2026-11-14T12:26:56.795Z'}} as TaskPermissionSnapshotV1
    api.getTaskPermissions.mockResolvedValue(expired); api.getTaskRun.mockResolvedValue({id:'task-1',threadId:'hidden-1',status:'failed'} as TaskRunV1)
    api.confirmTaskPermissions.mockResolvedValue({task:{id:'task-1',threadId:'hidden-1',status:'paused'} as TaskRunV1,permission:{...snapshot,recoveryEligible:true} as TaskPermissionSnapshotV1,resumed:true})
    await click('查看当前任务权限')
    const allow = button(i18n.t('common:taskPermissionRenew'))
    expect(allow.disabled).toBe(true)
    await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await click(i18n.t('common:taskPermissionRenew'))
    expect(api.confirmTaskPermissions).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(i18n.t('common:taskPermissionRecoveryReadFailed'))
    expect(onConfirmed).not.toHaveBeenCalled(); expect(api.resumeTask).not.toHaveBeenCalled()
  })

  it('reconfirms the reviewed temporary scope of an eligible failed task without starting work', async () => {
    const expired = {...snapshot,recoveryEligible:true,canRestoreBase:true,grant:{id:'expired',status:'expired',confirmedAt:'2026-11-14T12:11:56.795Z',expiresAt:'2026-11-14T12:26:56.795Z',scope:{readPaths:['/project/synthetic','/old/diagnostic'],writePaths:[]}}} as TaskPermissionSnapshotV1
    const original = {id:'task-1',threadId:'hidden-1',status:'failed',revision:4,attempts:8} as TaskRunV1
    api.getTaskPermissions.mockResolvedValue(expired); api.getTaskRun.mockResolvedValue(original)
    api.confirmTaskPermissions.mockResolvedValue({task:{...original,status:'paused',revision:5},permission:{...expired,taskRevision:5,recoveryEligible:false,canRestoreBase:false,grant:{...expired.grant!,status:'active',expiresAt:new Date(Date.now()+900_000).toISOString()}},resumed:false})
    await click('查看当前任务权限')
    expect(container.textContent).toContain('/old/diagnostic')
    expect(button(i18n.t('common:taskPermissionRenew')).disabled).toBe(true)
    await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await click(i18n.t('common:taskPermissionRenew'))
    expect(api.confirmTaskPermissions).toHaveBeenCalledExactlyOnceWith('task-1',{
      expectedRevision:4,scopeHash:'reviewed-scope',confirmed:true,approvalPolicy:'on-request',ttlSeconds:900,idempotencyKey:expect.any(String),duration:'task'
    })
    expect(onConfirmed).toHaveBeenCalledWith(i18n.t('common:taskPermissionSaved'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(api.resumeTask).not.toHaveBeenCalled(); expect(api.retryTask).not.toHaveBeenCalled()
    expect(original.status).toBe('failed'); expect(original.attempts).toBe(8)
  })

  it.each(['completed','cancelled','failed'] as const)('keeps %s read-only when the task is not eligible for recovery', async status => {
    api.getTaskRun.mockResolvedValue({id:'task-1',threadId:'hidden-1',status} as TaskRunV1)
    api.getTaskPermissions.mockResolvedValue({...snapshot,canConfirm:true,canRestoreBase:true,recoveryEligible:status !== 'failed',grant:{id:'expired',status:'expired',confirmedAt:'2026-11-14T12:11:56.795Z',expiresAt:'2026-11-14T12:26:56.795Z'}} as TaskPermissionSnapshotV1)
    await click('查看当前任务权限')
    expect(container.querySelector('input, select, textarea')).toBeNull()
    expect([...container.querySelectorAll('button')].map(item=>item.textContent)).toEqual(['查看当前任务权限'])
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
    expect(api.runtimeRequest).toHaveBeenCalledExactlyOnceWith('/v1/threads/hidden-1','GET')
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('keeps the permission summary and execution history without new authorization controls for %s tasks', async status => {
    api.getTaskRun.mockResolvedValue({ id: 'task-1', threadId: 'hidden-1', status } as TaskRunV1)
    api.getTaskPermissions.mockResolvedValue({ ...snapshot, canConfirm: false,
      reason: '请先让任务停止执行并进入等待或暂停状态。',
      executionGrants: [{ turnId: 'historical-turn', workspaceRoot: '/project/synthetic', workspaceTrust: 'workspace-write',
        agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', allowedToolNames: ['lark_task_get'],
        pathAllowlist: ['/project/synthetic'], networkAllowlist: ['https://open.feishu.cn'],
        connectorScopes: ['task:task:read'], externalTargets: [], issuedAt: '2026-11-09T00:00:00.000Z' }] })
    await click('查看当前任务权限')
    expect(container.textContent).toContain(snapshot.taskTitle)
    expect(container.textContent).toContain('/project/synthetic')
    expect(container.querySelector('details summary')?.textContent).toBe(i18n.t('common:taskPermissionExecutionHistory'))
    expect(container.querySelector('details')?.textContent).toContain('lark_task_get')
    expect(container.querySelector('input, select, textarea')).toBeNull()
    expect([...container.querySelectorAll('button')].map(item => item.textContent)).toEqual(['查看当前任务权限'])
    expect(container.textContent).not.toContain('请先让任务停止执行')
    expect(container.textContent).not.toContain(i18n.t('common:taskPermissionScope'))
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
    expect(api.setThreadAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['running', false], ['waiting_user', true], ['waiting_approval', true], ['paused', true], ['stalled', true]
  ] as const)('keeps server-authorized confirmation behavior for %s tasks', async (status, canConfirm) => {
    api.getTaskRun.mockResolvedValue({ id: 'task-1', threadId: 'hidden-1', status } as TaskRunV1)
    api.getTaskPermissions.mockResolvedValue({ ...snapshot, canConfirm,
      ...(!canConfirm ? { reason: '请先让任务停止执行并进入等待或暂停状态。' } : {}) })
    await click('查看当前任务权限')
    const confirmation = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(confirmation).not.toBeNull()
    await act(async () => { confirmation!.click() })
    expect(button('允许当前任务请求审批').disabled).toBe(!canConfirm)
    expect(container.textContent?.includes('请先让任务停止执行')).toBe(!canConfirm)
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })

  it('refreshes an expanded permission panel into summary-only display after completion', async () => {
    await act(async () => root.render(createElement(TaskPermissionPanel, { taskId: 'task-1', revision: 4, autoLoad: true, onConfirmed })))
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    expect(button('允许当前任务请求审批').disabled).toBe(false)
    api.getTaskRun.mockResolvedValue({ id: 'task-1', threadId: 'hidden-1', status: 'completed' } as TaskRunV1)
    // A stale permission snapshot must not keep mutation controls visible for a terminal task.
    api.getTaskPermissions.mockResolvedValue({ ...snapshot, taskRevision: 5, canConfirm: true })
    await act(async () => root.render(createElement(TaskPermissionPanel, { taskId: 'task-1', revision: 5, autoLoad: true, onConfirmed })))
    expect(container.querySelector('input, select, textarea')).toBeNull()
    expect([...container.querySelectorAll('button')].map(item => item.textContent)).toEqual(['查看当前任务权限'])
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })

  it('clears historical write paths after the Agent ceiling becomes read-only', async () => {
    api.getTaskPermissions.mockResolvedValue({ ...snapshot, grant: { id: 'previous', status: 'invalid', confirmedAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-10T00:15:00.000Z', scope: { writePaths: ['/previous/output'] } } })
    await click('查看当前任务权限')
    await click('调整本次路径与平台范围')
    const writePaths = container.querySelector<HTMLTextAreaElement>('textarea:disabled')
    expect(writePaths).not.toBeNull()
    expect(writePaths!.value).toBe('')
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })
  it('only loads on request and distinguishes ceilings, task requirements and historical scopes from executable tools',async()=>{
    expect(api.getTaskPermissions).not.toHaveBeenCalled()
    await click('查看当前任务权限')
    for(const value of ['实际执行权限由任务范围、工作区、Agent 和沙箱共同计算','工作区信任','Agent 权限上限','项目审阅 Agent','执行沙箱','从不执行','lark_task_list','未允许任何项目','task-42','任务要求；尚不代表已授权','上次服务端执行授权记录；须重新核验当前状态'])expect(container.textContent).toContain(value)
    expect(container.textContent).not.toContain('当前可用工具')
    expect(container.textContent).not.toContain('hidden-1')
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
    expect(api.setThreadAgent).not.toHaveBeenCalled()
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(button('允许当前任务请求审批').disabled).toBe(true)
  })

  it('confirms only after explicit review using the server scope and revision without resuming execution',async()=>{
    await click('查看当前任务权限')
    await act(async()=>{container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()})
    await click('允许当前任务请求审批')
    expect(api.confirmTaskPermissions).toHaveBeenCalledWith('task-1',expect.objectContaining({expectedRevision:4,scopeHash:'reviewed-scope',confirmed:true,approvalPolicy:'on-request',ttlSeconds:900}))
    expect(onConfirmed).toHaveBeenCalledWith('当前任务权限已保存。点击“继续原任务”执行。')
    expect(api.runtimeRequest).toHaveBeenCalledExactlyOnceWith('/v1/threads/hidden-1', 'GET')
    expect(api.setThreadAgent).not.toHaveBeenCalled()
  })

  it('handles a deleted task without inventing authority or reading an invalid thread',async()=>{
    api.getTaskRun.mockResolvedValue(null)
    await click('查看当前任务权限')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法读取当前任务权限')
    expect(api.runtimeRequest).not.toHaveBeenCalled()
    expect(api.listAgentProfiles).not.toHaveBeenCalled()
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })

  it('shows unverified limits for a legacy Runtime rather than inventing an unrestricted catalog',async()=>{
    api.getTaskPermissions.mockResolvedValue({taskId:snapshot.taskId,taskRevision:4,taskTitle:snapshot.taskTitle,scopeHash:snapshot.scopeHash,
      workspaceRoot:snapshot.workspaceRoot,workspaceTrust:'workspace-write',workspaceRevision:3,agentRevision:0,
      approvalPolicy:'never',targetApprovalPolicy:'on-request',maxTtlSeconds:900,canConfirm:false})
    await click('查看当前任务权限')
    expect(container.textContent).toContain('尚未核实')
    expect(container.textContent).not.toContain('无额外白名单限制')
    expect(container.textContent).not.toContain('当前可用工具')
    expect(api.confirmTaskPermissions).not.toHaveBeenCalled()
  })
})
