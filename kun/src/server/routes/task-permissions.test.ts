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
