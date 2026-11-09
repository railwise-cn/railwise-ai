import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { IM_FIRST_HEARTBEAT_DEADLINE_MS } from '../../shared/im-communication'
const testState = vi.hoisted(() => ({
  root: `/tmp/workwise-im-health-${process.pid}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.root }
}))

import { ImHealthService } from './im-health-service'

describe('ImHealthService', () => {
  it('marks a connection stale after its first heartbeat deadline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'))
    const service = new ImHealthService()
    const started = service.start({ channelId: 'wx-1', provider: 'weixin', accountId: 'account-1' })
    vi.setSystemTime(new Date('2026-08-14T00:01:31.000Z'))
    const stale = vi.fn()
    service.supervise(stale)
    expect(service.get('wx-1')).toMatchObject({ status: 'stale', reasonCode: 'first_poll_timeout', failureCount: 1 })
    expect(stale).toHaveBeenCalledOnce()
    expect(service.get('wx-1')?.runId).toBe(started.runId)
    vi.useRealTimers()
  })

  it('does not revive stopped or expired channels during supervision', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'))
    const service = new ImHealthService()
    service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1' })
    service.stop('fs-1')
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    service.supervise()
    expect(service.get('fs-1')?.status).toBe('stopped')
    vi.useRealTimers()
  })

  it('ignores late provider heartbeats and errors after an explicit stop', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'fs-late', provider: 'feishu', accountId: 'app-late' })
    const stopped = service.stop('fs-late')

    expect(service.heartbeat('fs-late', '迟到的重连事件')).toBe(stopped)
    expect(service.fail('fs-late', {
      reasonCode: 'network',
      message: '迟到的断开事件'
    })).toBe(stopped)
    expect(service.get('fs-late')).toMatchObject({
      status: 'stopped',
      reasonCode: 'user_stopped',
      failureCount: 0
    })
  })

  it('requires an explicit start before an expired channel can become connected again', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'wx-expired', provider: 'weixin', accountId: 'account-expired' })
    const expired = service.fail('wx-expired', {
      reasonCode: 'auth_expired',
      message: '微信连接已过期。',
      expired: true
    })

    expect(service.heartbeat('wx-expired')).toBe(expired)
    expect(service.fail('wx-expired', {
      reasonCode: 'network',
      message: '迟到的网络错误'
    })).toBe(expired)

    service.start({ channelId: 'wx-expired', provider: 'weixin', accountId: 'account-expired' })
    expect(service.heartbeat('wx-expired')).toMatchObject({
      status: 'connected',
      reasonCode: 'none'
    })
  })

  it('does not inflate failure counts for an unchanged supervisor snapshot', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1' })
    const first = service.fail('fs-1', { reasonCode: 'network', message: '飞书连接正在重连。' })
    const second = service.fail('fs-1', { reasonCode: 'network', message: '飞书连接正在重连。' })

    expect(first?.failureCount).toBe(1)
    expect(second).toBe(first)
    expect(service.get('fs-1')?.failureCount).toBe(1)
  })

  it('preserves a bridge-reported stale state without inflating duplicate failures', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'wx-1', provider: 'weixin', accountId: 'account-1' })
    const first = service.markStale('wx-1', {
      reasonCode: 'poll_stale',
      message: '微信连接心跳已超时。'
    })
    const duplicate = service.markStale('wx-1', {
      reasonCode: 'poll_stale',
      message: '微信连接心跳已超时。'
    })

    expect(first).toMatchObject({
      status: 'stale',
      reasonCode: 'poll_stale',
      failureCount: 1
    })
    expect(first?.nextRetryAt).toBeDefined()
    expect(duplicate).toBe(first)
  })

  it('adopts the bridge run identity when a persisted connection starts recovering', () => {
    const service = new ImHealthService()
    const health = service.start({
      channelId: 'wx-1',
      provider: 'weixin',
      accountId: 'account-1',
      runId: 'bridge-run-1',
      startedAt: '2026-08-15T03:52:40.000Z',
      message: '正在连接微信。'
    })

    expect(health).toMatchObject({
      status: 'starting',
      runId: 'bridge-run-1',
      startedAt: '2026-08-15T03:52:40.000Z',
      message: '正在连接微信。'
    })
  })

  it('reports unavailable credentials as a terminal error without a fake retry deadline', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'wx-1', provider: 'weixin', accountId: 'account-1' })
    const failed = service.fail('wx-1', {
      reasonCode: 'credential_missing',
      message: '微信账号凭据不存在。'
    })

    expect(failed).toMatchObject({ status: 'error', reasonCode: 'credential_missing' })
    expect(failed?.nextRetryAt).toBeUndefined()
  })

  it('backs off and retries Feishu when protected credential storage is temporarily unavailable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    const service = new ImHealthService()
    service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1' })
    const failed = service.fail('fs-1', {
      reasonCode: 'credential_unavailable',
      message: '系统钥匙串暂时不可用。'
    })
    const recoveryDue = vi.fn()

    expect(failed).toMatchObject({ status: 'retrying', reasonCode: 'credential_unavailable' })
    expect(failed?.nextRetryAt).toBeDefined()
    vi.setSystemTime(new Date(failed!.nextRetryAt!))
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'fs-1',
      provider: 'feishu',
      reasonCode: 'credential_unavailable'
    }))
    vi.useRealTimers()
  })

  it('keeps WeChat credential unavailability explicit instead of auto-reconnecting', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'wx-1', provider: 'weixin', accountId: 'account-1' })
    const failed = service.fail('wx-1', {
      reasonCode: 'credential_unavailable',
      message: '系统钥匙串暂时不可用。'
    })

    expect(failed).toMatchObject({ status: 'error', reasonCode: 'credential_unavailable' })
    expect(failed?.nextRetryAt).toBeUndefined()
  })

  it('signals recovery when a retrying channel reaches its backoff deadline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    const service = new ImHealthService()
    service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1' })
    const failed = service.fail('fs-1', { reasonCode: 'network', message: '飞书连接异常。' })
    const recoveryDue = vi.fn()

    vi.setSystemTime(new Date(Date.parse(failed!.nextRetryAt!) - 1))
    service.supervise(recoveryDue)
    expect(recoveryDue).not.toHaveBeenCalled()

    vi.setSystemTime(new Date(failed!.nextRetryAt!))
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'fs-1',
      status: 'retrying',
      reasonCode: 'network'
    }))
    vi.useRealTimers()
  })

  it('does not launch overlapping recovery attempts for one retry snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    const service = new ImHealthService()
    service.start({ channelId: 'fs-claim', provider: 'feishu', accountId: 'app-claim' })
    const failed = service.fail('fs-claim', { reasonCode: 'network', message: '飞书连接异常。' })
    const recoveryDue = vi.fn()

    vi.setSystemTime(new Date(failed!.nextRetryAt!))
    service.supervise(recoveryDue)
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.parse(failed!.nextRetryAt!) + IM_FIRST_HEARTBEAT_DEADLINE_MS + 1))
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('retries a stale channel after its first recovery callback does not change state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
    const service = new ImHealthService()
    service.start({ channelId: 'fs-stale-retry', provider: 'feishu', accountId: 'app-stale-retry' })
    const stale = service.markStale('fs-stale-retry', {
      reasonCode: 'poll_stale',
      message: '飞书连接心跳已超时。'
    })
    const recoveryDue = vi.fn()

    vi.setSystemTime(new Date(stale!.nextRetryAt!))
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.parse(stale!.nextRetryAt!) + IM_FIRST_HEARTBEAT_DEADLINE_MS + 1))
    service.supervise(recoveryDue)
    expect(recoveryDue).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('returns redacted diagnostics without credential material or local paths', () => {
    const service = new ImHealthService()
    service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1', credentialStorage: 'keychain' })
    const diagnostics = service.diagnostics('0.3.6', '/Users/private/Library/Application Support/WorkWise')
    const serialized = JSON.stringify(diagnostics)
    expect(diagnostics.userDataFingerprint).toHaveLength(12)
    expect(diagnostics.channels[0]?.accountFingerprint).toHaveLength(12)
    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('app-1')
    expect(serialized).not.toContain('credentialStorage')
  })

  it('reports failure summaries that match each failed self-check', () => {
    const service = new ImHealthService()
    const started = service.start({ channelId: 'fs-1', provider: 'feishu', accountId: 'app-1' })
    const result = service.selfCheck({
      runId: started.runId,
      channelId: 'fs-1',
      credentialAvailable: true,
      bridgeAvailable: false,
      runtimeAvailable: false,
      ledgerHealthy: false,
      userDataFingerprint: '/private/tmp/candidate'
    })

    expect(result.overall).toBe('FAIL')
    expect(result.checks.find((check) => check.id === 'credential')?.summary).toBe('连接凭据可用。')
    expect(result.checks.find((check) => check.id === 'bridge')?.summary).toBe('通信桥当前不可访问。')
    expect(result.checks.find((check) => check.id === 'runtime')?.summary).toBe('RailWise AI Runtime 当前不可访问。')
    expect(result.checks.find((check) => check.id === 'heartbeat')?.summary).toBe('当前连接尚无新鲜心跳。')
    expect(result.checks.find((check) => check.id === 'ledger')?.summary).toBe('通信账本完整性检查失败。')
  })

  it('flushes the latest health snapshot before shutdown completes', async () => {
    const service = new ImHealthService()
    service.start({ channelId: 'wx-flush', provider: 'weixin', accountId: 'account-flush' })
    service.heartbeat('wx-flush', '微信连接正常。')

    await service.flush()

    const persisted = JSON.parse(await readFile(`${testState.root}/communication/im-health.json`, 'utf8'))
    expect(persisted['wx-flush']).toMatchObject({
      channelId: 'wx-flush',
      status: 'connected',
      message: '微信连接正常。'
    })
  })
})
