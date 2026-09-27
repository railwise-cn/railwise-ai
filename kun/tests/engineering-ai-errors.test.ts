import { describe, expect, it, vi } from 'vitest'
import { EngineeringAiError } from '../src/engineering/engineering-ai-orchestrator.js'
import { startPlan } from '../src/server/routes/engineering-ai.js'
import type { ServerRuntime } from '../src/server/routes/server-runtime.js'

describe('engineering plan error envelope', () => {
  it('preserves the stale approval code and conflict status for localized recovery', async () => {
    const execute = vi.fn(async () => {
      throw new EngineeringAiError('engineering_plan_stale', 'engineering context changed after approval; refresh context and replan')
    })
    const runtime = { engineeringAi: { startPlan: execute } } as unknown as ServerRuntime
    const response = await startPlan(runtime, 'plan', new Request('http://localhost/plan/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, contextHash: 'context', idempotencyKey: 'stale-plan-start' })
    }))
    expect(response.status).toBe(409)
    const body = response instanceof Response ? await response.json() : JSON.parse(response.body)
    expect(body).toMatchObject({ code: 'engineering_plan_stale' })
    expect(execute).toHaveBeenCalledOnce()
  })
})
