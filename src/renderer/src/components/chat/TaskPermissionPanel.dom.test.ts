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
  listAgentProfiles:vi.fn(async()=>({profiles:[]})),runtimeRequest:vi.fn(async()=>({ok:true,body:JSON.stringify({agentRevision:7})})),
  confirmTaskPermissions:vi.fn(async()=>({permission:{...snapshot,canConfirm:false},resumed:false})),setThreadAgent:vi.fn()
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
  api.getTaskRun.mockResolvedValue({id:'task-1',threadId:'hidden-1',status:'waiting_user'} as TaskRunV1)
  await i18n.changeLanguage('zh')
  Object.defineProperty(window,'workwise',{configurable:true,value:api})
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  await act(async()=>root.render(createElement(TaskPermissionPanel,{taskId:'task-1',onConfirmed})))
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();Reflect.deleteProperty(window,'workwise');await i18n.changeLanguage('en')})

describe('task permission authority overview',()=>{
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
    for(const value of ['任务权限上限','本次执行目录和服务端授权','工作区信任','项目审阅 Agent','执行沙箱','从不执行','lark_task_list','未允许任何项目','task-42','任务要求；尚不代表已授权','上次服务端执行授权记录；须重新核验当前状态'])expect(container.textContent).toContain(value)
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
    expect(onConfirmed).toHaveBeenCalledWith(expect.stringContaining('尚未执行任何外部操作'))
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
