import { randomUUID, createHash } from 'node:crypto'
import { app } from 'electron'
import { atomicWriteFile, readRecoveredFile } from './durable-file'
import {
  IM_FIRST_HEARTBEAT_DEADLINE_MS,
  IM_STALE_AFTER_MS,
  isFreshImHeartbeat,
  retryDelayMs,
  type ImChannelHealthV1,
  type ImCredentialStorageV1,
  type ImHealthReasonCodeV1,
  type ImHealthStatusV1,
  type ImSelfCheckResultV1,
  type ImDiagnosticsV1
} from '../../shared/im-communication'
import type { ClawImProvider } from '../../shared/app-settings-types'

type HealthListener = (health: ImChannelHealthV1) => void

function healthPath(): string {
  return `${app.getPath('userData')}/communication/im-health.json`
}

function nowIso(): string {
  return new Date().toISOString()
}

export class ImHealthService {
  private readonly states = new Map<string, ImChannelHealthV1>()
  private readonly listeners = new Set<HealthListener>()
  // A reconnect callback may take longer than the supervisor interval (for
  // example while a WebSocket handshake or Keychain helper is pending). Keep
  // the same retry snapshot from launching overlapping recovery attempts.
  private readonly recoveryClaims = new Map<string, number>()
  private writeQueue: Promise<void> = Promise.resolve()

  onChange(listener: HealthListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readRecoveredFile(healthPath())) as unknown
      if (!parsed || typeof parsed !== 'object') return
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const health = value as ImChannelHealthV1
        if (health.schema !== 'workwise.im-health' || health.version !== 1 || typeof health.channelId !== 'string') continue
        this.states.set(health.channelId, health)
      }
    } catch {
      // A missing or corrupt health snapshot must not prevent connections from starting.
    }
  }

  updateCounts(channelId: string, counts: Pick<ImChannelHealthV1, 'pendingMessages' | 'processingMessages' | 'deliveryMessages'>): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    return this.commit({ ...current, ...counts, updatedAt: nowIso() })
  }

  start(input: {
    channelId: string
    provider: ClawImProvider
    accountId: string
    credentialStorage?: ImCredentialStorageV1
    runId?: string
    startedAt?: string
    message?: string
  }): ImChannelHealthV1 {
    const startedAt = input.startedAt || nowIso()
    const health = this.make(input.channelId, {
      provider: input.provider,
      accountId: input.accountId,
      status: 'starting',
      reasonCode: 'none',
      message: input.message?.trim() || '正在建立连接。',
      runId: input.runId || randomUUID(),
      startedAt,
      updatedAt: startedAt,
      failureCount: 0,
      credentialStorage: input.credentialStorage
    })
    return this.commit(health)
  }

  heartbeat(channelId: string, message = '连接正常。'): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    // A provider callback can arrive after an explicit stop/disconnect or
    // after credentials expire. Only a new start() may create the next run.
    if (current.status === 'stopped' || current.status === 'expired') return current
    const timestamp = nowIso()
    return this.commit({
      ...current,
      status: 'connected',
      reasonCode: 'none',
      message,
      connectedAt: current.connectedAt ?? timestamp,
      updatedAt: timestamp,
      lastSuccessfulHeartbeatAt: timestamp,
      failureCount: 0,
      nextRetryAt: undefined,
      errorCode: undefined,
      lastErrorAt: undefined
    })
  }

  inbound(channelId: string): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    return this.commit({ ...current, lastInboundAt: nowIso(), updatedAt: nowIso() })
  }

  outbound(channelId: string): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    return this.commit({ ...current, lastOutboundAt: nowIso(), updatedAt: nowIso() })
  }

  fail(channelId: string, input: {
    reasonCode: Exclude<ImHealthReasonCodeV1, 'none' | 'user_stopped'>
    message: string
    errorCode?: number | string
    expired?: boolean
  }): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    if (current.status === 'stopped' || current.status === 'expired') return current
    const nextStatus: ImHealthStatusV1 = input.expired || input.reasonCode === 'auth_expired'
      ? 'expired'
      : input.reasonCode === 'credential_missing' ||
          input.reasonCode === 'state_corrupt'
        ? 'error'
        // A locked macOS Keychain is often transient (for example while the
        // user is confirming access after a candidate restart). Feishu can
        // safely retry its bridge after backoff; WeChat keeps its explicit
        // reauthorization behavior because its monitor owns token recovery.
        : input.reasonCode === 'credential_unavailable' && current.provider === 'feishu'
          ? 'retrying'
        : input.reasonCode === 'credential_unavailable'
          ? 'error'
        : 'retrying'
    if (
      current.status === nextStatus &&
      current.reasonCode === input.reasonCode &&
      current.message === input.message &&
      current.errorCode === input.errorCode
    ) {
      return current
    }
    const failureCount = current.failureCount + 1
    const timestamp = Date.now()
    const nextRetryAt = nextStatus === 'retrying'
      ? new Date(timestamp + retryDelayMs(failureCount)).toISOString()
      : undefined
    return this.commit({
      ...current,
      status: nextStatus,
      reasonCode: input.reasonCode,
      message: input.message,
      errorCode: input.errorCode,
      updatedAt: new Date(timestamp).toISOString(),
      lastErrorAt: new Date(timestamp).toISOString(),
      failureCount,
      nextRetryAt
    })
  }

  markStale(channelId: string, input: {
    reasonCode: 'first_poll_timeout' | 'poll_stale'
    message: string
    errorCode?: number | string
  }): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current || current.status === 'stopped' || current.status === 'expired') return current
    if (
      current.status === 'stale' &&
      current.reasonCode === input.reasonCode &&
      current.message === input.message &&
      current.errorCode === input.errorCode
    ) {
      return current
    }
    const timestamp = Date.now()
    const failureCount = current.failureCount + 1
    return this.commit({
      ...current,
      status: 'stale',
      reasonCode: input.reasonCode,
      message: input.message,
      errorCode: input.errorCode,
      updatedAt: new Date(timestamp).toISOString(),
      lastErrorAt: new Date(timestamp).toISOString(),
      nextRetryAt: new Date(timestamp + retryDelayMs(failureCount)).toISOString(),
      failureCount
    })
  }

  stop(channelId: string, message = '连接已暂停。'): ImChannelHealthV1 | undefined {
    const current = this.states.get(channelId)
    if (!current) return undefined
    return this.commit({
      ...current,
      status: 'stopped',
      reasonCode: 'user_stopped',
      message,
      updatedAt: nowIso(),
      nextRetryAt: undefined
    })
  }

  get(channelId: string): ImChannelHealthV1 | undefined {
    return this.states.get(channelId)
  }

  list(): ImChannelHealthV1[] {
    return [...this.states.values()].map((item) => ({ ...item }))
  }

  supervise(onRecoveryDue?: (health: ImChannelHealthV1) => void): void {
    const now = Date.now()
    for (const current of this.states.values()) {
      if (current.status === 'retrying') {
        const nextRetryAt = current.nextRetryAt ? Date.parse(current.nextRetryAt) : Number.NaN
        if (Number.isFinite(nextRetryAt) && now >= nextRetryAt) {
          const claimedUntil = this.recoveryClaims.get(current.channelId) ?? 0
          if (now < claimedUntil) continue
          this.recoveryClaims.set(current.channelId, now + IM_FIRST_HEARTBEAT_DEADLINE_MS)
          onRecoveryDue?.({ ...current })
        }
        continue
      }
      if (current.status === 'stale') {
        const nextRetryAt = current.nextRetryAt ? Date.parse(current.nextRetryAt) : Number.NaN
        if (Number.isFinite(nextRetryAt) && now >= nextRetryAt) {
          const claimedUntil = this.recoveryClaims.get(current.channelId) ?? 0
          if (now < claimedUntil) continue
          this.recoveryClaims.set(current.channelId, now + IM_FIRST_HEARTBEAT_DEADLINE_MS)
          onRecoveryDue?.({ ...current })
        }
        continue
      }
      if (current.status === 'unknown' || current.status === 'expired' || current.status === 'error' || current.status === 'stopped') continue
      const last = current.lastSuccessfulHeartbeatAt ? Date.parse(current.lastSuccessfulHeartbeatAt) : Date.parse(current.startedAt ?? current.updatedAt)
      if (!Number.isFinite(last)) continue
      const deadline = current.status === 'starting' ? IM_FIRST_HEARTBEAT_DEADLINE_MS : IM_STALE_AFTER_MS
      if (now - last <= deadline) continue
      const stale = this.markStale(current.channelId, {
        reasonCode: current.status === 'starting' ? 'first_poll_timeout' : 'poll_stale',
        message: '连接心跳已超时，正在重新连接。'
      })
      if (stale) onRecoveryDue?.(stale)
    }
  }

  selfCheck(input: {
    runId: string
    channelId: string
    credentialAvailable: boolean
    bridgeAvailable: boolean
    runtimeAvailable: boolean
    ledgerHealthy: boolean
    userDataFingerprint: string
  }): ImSelfCheckResultV1 {
    const health = this.states.get(input.channelId)
    const heartbeatFresh = Boolean(health && health.status === 'connected' && isFreshImHeartbeat(health))
    const checks = [
      { id: 'run-id', pass: Boolean(health && health.runId === input.runId), code: 'run_id_mismatch', summary: health?.runId === input.runId ? '当前连接实例与诊断实例一致。' : '当前连接实例已变化，请刷新后重试。' },
      { id: 'credential', pass: input.credentialAvailable, code: 'credential_unavailable', summary: input.credentialAvailable ? '连接凭据可用。' : '连接凭据不可用。' },
      { id: 'bridge', pass: input.bridgeAvailable, code: 'bridge_unavailable', summary: input.bridgeAvailable ? '通信桥可访问。' : '通信桥当前不可访问。' },
      { id: 'runtime', pass: input.runtimeAvailable, code: 'runtime_unavailable', summary: input.runtimeAvailable ? 'RailWise AI Runtime 可访问。' : 'RailWise AI Runtime 当前不可访问。' },
      { id: 'heartbeat', pass: heartbeatFresh, code: 'heartbeat_stale', summary: heartbeatFresh ? '当前连接具有新鲜心跳。' : '当前连接尚无新鲜心跳。' },
      { id: 'ledger', pass: input.ledgerHealthy, code: 'ledger_unhealthy', summary: input.ledgerHealthy ? '通信账本完整性检查通过。' : '通信账本完整性检查失败。' }
    ]
    return {
      schema: 'workwise.im-self-check',
      version: 1,
      overall: checks.every((check) => check.pass) ? 'PASS' : 'FAIL',
      checkedAt: nowIso(),
      runId: input.runId,
      checks
    }
  }

  diagnostics(appVersion: string, userDataPath: string): ImDiagnosticsV1 {
    const userDataFingerprint = createHash('sha256').update(userDataPath).digest('hex').slice(0, 12)
    return {
      schema: 'workwise.im-diagnostics',
      version: 1,
      generatedAt: nowIso(),
      appVersion,
      userDataFingerprint,
      channels: this.list().map((health) => ({
        channelId: health.channelId,
        provider: health.provider,
        accountFingerprint: createHash('sha256')
          .update(`${health.provider}\0${health.accountId}`)
          .digest('hex')
          .slice(0, 12),
        status: health.status,
        reasonCode: health.reasonCode,
        runId: health.runId,
        lastSuccessfulHeartbeatAt: health.lastSuccessfulHeartbeatAt,
        lastInboundAt: health.lastInboundAt,
        lastOutboundAt: health.lastOutboundAt,
        failureCount: health.failureCount,
        pendingMessages: health.pendingMessages,
        processingMessages: health.processingMessages,
        deliveryMessages: health.deliveryMessages
      }))
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private make(channelId: string, value: Omit<ImChannelHealthV1, 'schema' | 'version' | 'channelId' | 'pendingMessages' | 'processingMessages' | 'deliveryMessages'>): ImChannelHealthV1 {
    return {
      schema: 'workwise.im-health',
      version: 1,
      channelId,
      pendingMessages: this.states.get(channelId)?.pendingMessages ?? 0,
      processingMessages: this.states.get(channelId)?.processingMessages ?? 0,
      deliveryMessages: this.states.get(channelId)?.deliveryMessages ?? 0,
      ...value
    }
  }

  private commit(next: ImChannelHealthV1): ImChannelHealthV1 {
    const previous = this.states.get(next.channelId)
    if (
      previous && (
        previous.runId !== next.runId ||
        previous.status !== next.status ||
        previous.reasonCode !== next.reasonCode ||
        previous.nextRetryAt !== next.nextRetryAt
      )
    ) {
      this.recoveryClaims.delete(next.channelId)
    }
    if (next.status !== 'retrying') this.recoveryClaims.delete(next.channelId)
    this.states.set(next.channelId, next)
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => atomicWriteFile(healthPath(), `${JSON.stringify(Object.fromEntries(this.states), null, 2)}\n`))
    for (const listener of this.listeners) listener(next)
    return next
  }
}
