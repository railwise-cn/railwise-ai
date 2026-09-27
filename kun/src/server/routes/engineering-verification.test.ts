import { describe, expect, it, vi } from 'vitest'
import type { EngineeringService } from '../../engineering/engineering-service.js'
import { verifyDeliverable } from './engineering.js'

describe('deliverable verification handler', () => {
  it('requires a service and forwards both project and manifest scope', async () => {
    expect((await verifyDeliverable(undefined, 'project', 'manifest')).status).toBe(503)
    const verify = vi.fn().mockReturnValue({ valid: false, checks: [{ id: 'outputs', status: 'failed' }] })
    const service = { verifyDeliverable: verify } as unknown as EngineeringService
    const response = await verifyDeliverable(service, 'project', 'manifest')
    expect(verify).toHaveBeenCalledExactlyOnceWith('project', 'manifest')
    expect(JSON.parse(response.body).verification.valid).toBe(false)
    expect(response.status).toBe(200)
    verify.mockImplementation(() => { throw new Error('deliverable manifest not found in project') })
    expect((await verifyDeliverable(service, 'other-project', 'manifest')).status).toBe(404)
  })
})
