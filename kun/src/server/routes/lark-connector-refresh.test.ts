import { describe, expect, it, vi } from 'vitest'
import type { ServerRuntime } from './server-runtime.js'
import { buildRouter } from './index.js'
import type { JsonResponse } from '../response.js'

async function responseJson(response: JsonResponse | Response): Promise<unknown> {
  return typeof response.body === 'string' ? JSON.parse(response.body) : (response as Response).json()
}

describe.each([{ provider: 'lark', callback: 'refreshLark' }, { provider: 'dws', callback: 'refreshDws' }] as const)('managed $provider connector refresh route', ({ provider, callback }) => {
  it('requires the local runtime token and invokes only the managed refresh callback', async () => {
    const refreshLark = vi.fn(async () => ({ provider: 'lark', status: 'available' }))
    const router = buildRouter({ runtimeToken: 'local-token', insecure: false, [callback]: refreshLark } as unknown as ServerRuntime)
    const route = router.match('POST', `/v1/connectors/${provider}/refresh`)
    if (!route) throw new Error('Lark refresh route was not registered')

    const denied = await route.handler(new Request(`http://runtime/v1/connectors/${provider}/refresh`, { method: 'POST' }), { params: {} })
    expect(denied.status).toBe(401)
    expect(refreshLark).not.toHaveBeenCalled()

    const allowed = await route.handler(new Request(`http://runtime/v1/connectors/${provider}/refresh`, {
      method: 'POST', headers: { authorization: 'Bearer local-token' }
    }), { params: {} })
    expect(allowed.status).toBe(200)
    expect(await responseJson(allowed)).toEqual({ provider: 'lark', status: 'available' })
    expect(refreshLark).toHaveBeenCalledOnce()
  })

  it('rejects request bodies before refreshing configuration', async () => {
    const refreshLark = vi.fn(async () => ({ provider: 'lark' }))
    const router = buildRouter({ runtimeToken: 'local-token', insecure: false, [callback]: refreshLark } as unknown as ServerRuntime)
    const route = router.match('POST', `/v1/connectors/${provider}/refresh`)!
    const response = await route.handler(new Request(`http://runtime/v1/connectors/${provider}/refresh`, {
      method: 'POST', headers: { authorization: 'Bearer local-token' }, body: '{}'
    }), { params: {} })
    expect(response.status).toBe(400)
    expect(refreshLark).not.toHaveBeenCalled()
  })
})
