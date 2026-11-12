import { describe, expect, it, vi } from 'vitest'
import { checkDingTalkTaskAccess } from './dws-connection-check'
import { dwsTestConfig, dwsTestIdentity } from '../../../kun/tests/helpers/dws-identity'
import type { ManagedDwsStatus } from '../../shared/managed-dws'

const connected: ManagedDwsStatus = { ...dwsTestConfig, state: 'installed' }

describe('DingTalk task access check', () => {
  it('uses the production typed read and exposes only its count', async () => {
    const runner = vi.fn(async (_path: string, args: string[]) => ({
      ok: true,
      output: args[0] === 'auth' ? dwsTestIdentity : {
        success: true,
        result: { todoCards: [{ taskId: 'private-target', subject: 'private-title' }] }
      }
    }))
    const result = await checkDingTalkTaskAccess(connected, runner)
    expect(result).toMatchObject({ ok: true, itemCount: 1, message: '待办读取已验证。' })
    expect(JSON.stringify(result)).not.toMatch(/private-target|private-title|corp-synthetic|user-synthetic/)
    expect(runner.mock.calls.map(call => call[1])).toEqual([
      ['auth', 'status', '--readonly', '--profile', connected.profile, '--format', 'json'],
      ['todo', 'task', 'list', '--status', 'false', '--page', '1', '--size', '1', '--profile', connected.profile, '--format', 'json']
    ])
  })

  it('accepts an empty result and preserves scope in its message', async () => {
    const runner = vi.fn(async (_path: string, args: string[]) => ({
      ok: true,
      output: args[0] === 'auth' ? dwsTestIdentity : { success: true, result: { todoCards: [] } }
    }))
    expect(await checkDingTalkTaskAccess(connected, runner)).toMatchObject({ ok: true, itemCount: 0, message: '待办读取已验证，本次查询未返回待办。' })
  })

  it.each([
    [{ ...connected, enabled: false }, 'connector_disabled'],
    [{ state: 'not_installed' }, 'connector_not_installed'],
    [{ state: 'needs_login' }, 'connector_authorization_required'],
    [{ ...connected, identityFingerprint: undefined }, 'connector_identity_unverified']
  ] as const)('rejects unavailable identity before dispatch', async (status, code) => {
    const runner = vi.fn()
    expect(await checkDingTalkTaskAccess(status, runner)).toMatchObject({ ok: false, code })
    expect(runner).not.toHaveBeenCalled()
  })

  it('distinguishes platform denial without exposing its raw response', async () => {
    const runner = vi.fn(async (_path: string, args: string[]) => args[0] === 'auth'
      ? { ok: true, output: dwsTestIdentity }
      : { ok: false, output: { ok: false, outcome: 'failure', error: { type: 'permission', http_status: 403, message: 'private diagnostics' } } })
    const result = await checkDingTalkTaskAccess(connected, runner)
    expect(result).toMatchObject({ ok: false, code: 'connector_access_denied' })
    expect(JSON.stringify(result)).not.toContain('private diagnostics')
  })

  it('stops when identity changes before the business read', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: { ...dwsTestIdentity, user_id: 'changed-account' } }))
    expect(await checkDingTalkTaskAccess(connected, runner)).toMatchObject({ ok: false, code: 'connector_identity_changed' })
    expect(runner).toHaveBeenCalledOnce()
  })
})
