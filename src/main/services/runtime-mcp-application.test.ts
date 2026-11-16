import { describe, expect, it } from 'vitest'
import { assertMcpConfigurationApplied } from './runtime-mcp-application'

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, body: JSON.stringify(body) })

describe('Runtime MCP application acknowledgement', () => {
  it('accepts an applied revision while preserving a failed server health result', () => {
    const result = { applied: true, revision: 7, ok: false, errors: [{ id: 'unavailable', message: 'Connection failed' }] }
    expect(() => assertMcpConfigurationApplied(response(result), 7)).not.toThrow()
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  it('retains healthy legacy Runtime acknowledgement compatibility', () => {
    expect(() => assertMcpConfigurationApplied(response({ ok: true, revision: 7 }), 7)).not.toThrow()
  })

  it.each([
    response({ applied: false, ok: true, revision: 7 }),
    response({ applied: true, ok: true, revision: 6 }),
    response({ ok: false, revision: 7 }),
    response({ applied: true, ok: true, revision: 7 }, 409),
    response(null),
    { ok: true, status: 200, body: 'not JSON' }
  ])('rejects an unacknowledged, conflicting or invalid response', result => {
    expect(() => assertMcpConfigurationApplied(result, 7)).toThrow('Runtime 尚未确认应用')
  })
})
