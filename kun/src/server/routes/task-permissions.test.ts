import { describe, expect, it, vi } from 'vitest'
import type { ServerRuntime } from './server-runtime.js'
import { buildRouter } from './index.js'

describe('scoped task permission routes', () => {
  it('authenticates the snapshot and never performs an implicit permission change', async () => {
    const snapshot = vi.fn(async () => ({ taskId:'task-1',canConfirm:true,scopeHash:'a'.repeat(64) }))
    const confirm = vi.fn()
    const router = buildRouter({runtimeToken:'token',insecure:false,taskPermissionService:{snapshot,confirm}} as unknown as ServerRuntime)
    const match = router.match('GET','/v1/tasks/task-1/permissions')!
    const invoke = (auth:boolean) => match.handler(new Request('http://runtime/v1/tasks/task-1/permissions',{
      headers:auth?{authorization:'Bearer token'}:{}
    }),{params:match.params})
    expect((await invoke(false)).status).toBe(401)
    expect(snapshot).not.toHaveBeenCalled()
    expect((await invoke(true)).status).toBe(200)
    expect(snapshot).toHaveBeenCalledExactlyOnceWith('task-1')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('authenticates revocation and pauses the same task after the original permission is invalidated', async () => {
    const revoke=vi.fn(async()=>({task:{id:'task-1',revision:8}})),snapshot=vi.fn(async()=>({grant:{status:'invalid'}}))
    const mutate=vi.fn(async()=>({task:{id:'task-1',status:'paused'}}))
    const router=buildRouter({runtimeToken:'token',insecure:false,taskPermissionService:{revoke,snapshot},taskControlService:{mutate},taskRepository:{get:()=>({id:'task-1',revision:8,status:'paused'})}} as unknown as ServerRuntime)
    const match=router.match('DELETE','/v1/tasks/task-1/permissions')!
    const body={expectedRevision:7,permissionId:'reviewed-permission',idempotencyKey:'revoke'}
    const invoke=(auth:boolean,value:unknown=body)=>match.handler(new Request('http://runtime/v1/tasks/task-1/permissions',{method:'DELETE',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer token'}:{})},body:JSON.stringify(value)}),{params:match.params})
    expect((await invoke(false)).status).toBe(401)
    expect((await invoke(true,{...body,allow:true})).status).toBe(400)
    expect(revoke).not.toHaveBeenCalled()
    expect((await invoke(true)).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('task-1',body)
    expect(mutate).toHaveBeenCalledWith('task-1','pause',{expectedRevision:8,idempotencyKey:'permission-revoke:revoke',reason:expect.any(String)})
  })

  it('requires a strict scoped confirmation and forwards its exact revision and fingerprint', async () => {
    const confirm = vi.fn(async () => ({resumed:false}))
    const router = buildRouter({runtimeToken:'token',insecure:false,taskPermissionService:{snapshot:vi.fn(),confirm}} as unknown as ServerRuntime)
    const match = router.match('POST','/v1/tasks/task-1/permissions')!
    const body = {expectedRevision:2,idempotencyKey:'permission-once',scopeHash:'a'.repeat(64),confirmed:true,approvalPolicy:'on-request',ttlSeconds:300}
    const invoke = (value:unknown,auth=true) => match.handler(new Request('http://runtime/v1/tasks/task-1/permissions',{
      method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer token'}:{})},body:JSON.stringify(value)
    }),{params:match.params})
    expect((await invoke(body,false)).status).toBe(401)
    expect((await invoke({...body,allowedTools:['bash']})).status).toBe(400)
    expect((await invoke({...body,confirmed:false})).status).toBe(400)
    expect(confirm).not.toHaveBeenCalled()
    expect((await invoke(body)).status).toBe(200)
    expect(confirm).toHaveBeenCalledExactlyOnceWith('task-1',body)
  })
})
