import * as childProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowNodeV1 } from '../contracts/flow.js'
import { restrictedCodeAdapter, runRestrictedCode } from './restricted-code.js'

vi.mock('node:child_process', { spy: true })

const node = (source: string, config: Record<string, unknown> = {}): FlowNodeV1 => ({
  id: 'code', type: 'restricted_code', label: 'Code', position: { x: 0, y: 0 }, bindings: {},
  config: { source, ...config }, policy: { timeoutMs: 1_000, retryAttempts: 0, retryBackoffMs: 0, errorBehavior: 'fail', concurrencyLimit: 1, resumable: false, breakpoint: false }, disabled: false
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('restricted Flow code', () => {
  it('uses a JSON-only child process and returns JSON', async () => {
    const result = await restrictedCodeAdapter({ node: node('return { total: input.a + input.b }'), input: { a: 2, b: 3 }, signal: new AbortController().signal, run: {} as never, definition: {} as never })
    expect(result).toEqual({ kind: 'output', output: { total: 5 } })
  })

  it('runs the real child with only the Node-mode bootstrap environment', async () => {
    vi.stubEnv('RAILWISE_TEST_HOST_SECRET', 'host-secret-must-not-reach-restricted-code')
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings')
    const spawn = vi.mocked(childProcess.spawn)

    const result = await runRestrictedCode({ source: 'return { total: input.a + input.b }', input: { a: 4, b: 7 } }, 1_000)

    expect(result).toEqual({ total: 11 })
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }))
  })

  it('does not expose process, require, or fetch', async () => {
    const result = await runRestrictedCode({ source: 'return { process: typeof process, require: typeof require, fetch: typeof fetch }', input: {} }, 1_000)
    expect(result).toEqual({ process: 'undefined', require: 'undefined', fetch: 'undefined' })
  })

  it('times out CPU-bound code and rejects extra permissions', async () => {
    await expect(runRestrictedCode({ source: 'while (true) {}', input: {} }, 100)).rejects.toMatchObject({ code: 'restricted_code_timeout' })
    await expect(restrictedCodeAdapter({ node: node('return input', { permissions: { network: true } }), input: {}, signal: new AbortController().signal, run: { checkpoint: {} } as never, definition: {} as never })).resolves.toMatchObject({ kind: 'wait', reason: 'approval' })
    await expect(restrictedCodeAdapter({ node: node('return input', { permissions: { network: true } }), input: {}, signal: new AbortController().signal, run: { checkpoint: { restrictedCodePermissionGrants: ['code'] } } as never, definition: {} as never })).rejects.toMatchObject({ code: 'restricted_code_permission_denied' })
  })
})
