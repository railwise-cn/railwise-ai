import { describe, expect, it, vi } from 'vitest'
import type { SurveyService } from '../../engineering/survey-service.js'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'

describe('professional review HTTP admission', () => {
  function setup() {
    const getProfessionalReview = vi.fn(() => ({ projectId: 'project', runId: 'run', reviewStatus: 'unsigned' }))
    const runtime = { runtimeToken: 'private-test-token', insecure: false, surveyService: { getProfessionalReview } } as unknown as ServerRuntime
    const router = buildRouter(runtime)
    const path = '/v1/engineering/adjustments/run/professional-review'
    return { router, path, getProfessionalReview }
  }
  it('requires authentication before reading any stored evidence', async () => {
    const { router, path, getProfessionalReview } = setup()
    const route = router.match('GET', path)!
    const response = await route.handler(new Request(`http://runtime${path}`), { params: route.params })
    expect(response.status).toBe(401)
    expect(getProfessionalReview).not.toHaveBeenCalled()
  })
  it('serves the exact read alias and never registers a write endpoint', async () => {
    const { router, path, getProfessionalReview } = setup()
    const route = router.match('GET', path)!
    const response = await route.handler(new Request(`http://runtime${path}`, { headers: { Authorization: 'Bearer private-test-token' } }), { params: route.params })
    expect(response.status).toBe(200)
    expect(getProfessionalReview).toHaveBeenCalledExactlyOnceWith('run')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(router.match(method, path)).toBeUndefined()
  })
})
