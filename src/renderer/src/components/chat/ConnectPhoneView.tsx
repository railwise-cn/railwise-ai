import brand from '@shared/product-brand.json'
import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  AtSign,
  Battery,
  CheckCircle2,
  ChevronLeft,
  CircleStop,
  Image as ImageIcon,
  Loader2,
  LogOut,
  Maximize2,
  Mic,
  MoreHorizontal,
  PlusCircle,
  QrCode,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smile,
  Wifi
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ClawImAgentProfileV1,
  ClawImChannelV1,
  ClawImPlatformCredentialV1,
  ClawImProvider,
  ClawImSettingsV1,
  ClawModel
} from '@shared/app-settings'
import { DEFAULT_PHONE_AGENT_NAME } from '@shared/app-settings'
import type {
  ClawImInstallPollResult,
  ClawImInstallQrResult,
  WeixinBridgeAccountStatusV1
} from '@shared/workwise-api'
import type {
  ImChannelHealthV1,
  ImDiagnosticsV1,
  ImSelfCheckResultV1
} from '@shared/im-communication'
import { confirmDialog } from '../../lib/confirm-dialog'
import {
  type ClawInstallQrState,
  type ClawInstallTarget,
  clawInstallTargetLabel,
  formatClawInstallError
} from './SidebarClawDialogHelpers'
import { ClawProviderLogo } from './SidebarClaw'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'

type AddClawPhoneChannel = (
  provider: ClawImProvider,
  agentProfile: ClawImAgentProfileV1,
  platformCredential: ClawImPlatformCredentialV1,
  options: {
    channelId?: string
    model: ClawModel
    enabled: boolean
    im: Partial<ClawImSettingsV1>
    preserveRoute?: boolean
  }
) => Promise<void>

type Props = {
  channels: ClawImChannelV1[]
  onAddProvider: AddClawPhoneChannel
  leftSidebarCollapsed: boolean
  onToggleSidebar: () => void
}

type FeishuInstallRequest = {
  provider: 'feishu'
  options: { isLark: boolean }
}

type WeixinInstallRequest = {
  provider: 'weixin'
  options?: { isLark?: boolean }
}

type ConnectPhoneInstallRequest = FeishuInstallRequest | WeixinInstallRequest

const CONNECT_PHONE_TARGETS: readonly ClawInstallTarget[] = ['feishu', 'lark', 'weixin']

const INITIAL_QR_STATE: ClawInstallQrState = {
  status: 'idle',
  url: '',
  deviceCode: '',
  userCode: '',
  timeLeft: 0,
  error: ''
}

const INSTALL_POLL_IPC_TIMEOUT_MS = 15_000

export async function withClawInstallPollTimeout<T>(
  operation: Promise<T>,
  timeoutMs = INSTALL_POLL_IPC_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('IM_INSTALL_POLL_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function useWeixinConnectionStatus(channel: ClawImChannelV1 | null): WeixinBridgeAccountStatusV1 | null {
  const [status, setStatus] = useState<WeixinBridgeAccountStatusV1 | null>(null)
  const accountId = channel?.platformCredential?.kind === 'weixin'
    ? channel.platformCredential.accountId
    : ''

  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      if (!accountId || typeof window.workwise?.getWeixinBridgeStatus !== 'function') {
        if (!disposed) setStatus(null)
        return
      }
      try {
        const entries = await window.workwise.getWeixinBridgeStatus(accountId)
        if (!disposed) setStatus(entries[0] ?? null)
      } catch {
        if (!disposed) setStatus(null)
      }
    }
    void load()
    const timer = accountId ? window.setInterval(() => void load(), 5_000) : null
    return () => {
      disposed = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [accountId])

  return status
}

function useImHealth(channel: ClawImChannelV1 | null): ImChannelHealthV1 | null {
  const [health, setHealth] = useState<ImChannelHealthV1 | null>(null)
  const channelId = channel?.id ?? ''
  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      if (!channelId || typeof window.workwise?.getImHealth !== 'function') {
        if (!disposed) setHealth(null)
        return
      }
      try {
        const entries = await window.workwise.getImHealth(channelId)
        if (!disposed) setHealth(entries[0] ?? null)
      } catch {
        if (!disposed) setHealth(null)
      }
    }
    void load()
    const timer = channelId ? window.setInterval(() => void load(), 5_000) : null
    const unsubscribe = typeof window.workwise?.onImHealthChanged === 'function'
      ? window.workwise.onImHealthChanged((next) => {
          if (next.channelId === channelId && !disposed) setHealth(next)
        })
      : undefined
    return () => {
      disposed = true
      if (timer !== null) window.clearInterval(timer)
      unsubscribe?.()
    }
  }, [channelId])
  return health
}

export function imHealthLabelKey(
  health: Pick<ImChannelHealthV1, 'status'> | null,
  channelEnabled: boolean
): string | null {
  if (!health) return channelEnabled ? null : 'clawImDisabledSidebar'
  const labels: Record<ImChannelHealthV1['status'], string> = {
    unknown: 'connectPhoneHealthUnknown',
    starting: 'connectPhoneHealthStarting',
    connected: 'connectPhoneHealthConnected',
    retrying: 'connectPhoneHealthRetrying',
    stale: 'connectPhoneHealthStale',
    expired: 'connectPhoneHealthExpired',
    error: 'connectPhoneHealthError',
    stopped: 'connectPhoneHealthStopped'
  }
  return labels[health.status]
}

export function imSelfCheckScopeKey(
  channelId: string,
  health: Pick<ImChannelHealthV1, 'status' | 'reasonCode'> | null
): string {
  return `${channelId}:${health?.status ?? 'unknown'}:${health?.reasonCode ?? ''}`
}

export function connectPhoneProviderForTarget(target: ClawInstallTarget): ClawImProvider {
  return target === 'weixin' ? 'weixin' : 'feishu'
}

export function hasEnabledClawPhoneChannel(
  channels: ClawImChannelV1[],
  provider?: ClawImProvider
): boolean {
  return channels.some((channel) =>
    (provider ? channel.provider === provider : true) && channel.enabled
  )
}

export function hasClawPhoneChannel(
  channels: ClawImChannelV1[],
  provider?: ClawImProvider
): boolean {
  return provider
    ? channels.some((channel) => channel.provider === provider)
    : channels.length > 0
}

export function canReauthorizePhoneChannel(
  provider: ClawImProvider,
  health: Pick<ImChannelHealthV1, 'status' | 'reasonCode'> | null,
  weixinStatus: Pick<WeixinBridgeAccountStatusV1, 'status' | 'reasonCode'> | null = null
): boolean {
  if (health?.status === 'expired') return true
  if (
    health?.reasonCode === 'credential_missing'
    || health?.reasonCode === 'auth_expired'
  ) return true
  return provider === 'weixin'
    && (weixinStatus?.status === 'expired' || weixinStatus?.reasonCode === 'auth_expired')
}

export function needsProtectedStorageReconnect(
  health: Pick<ImChannelHealthV1, 'reasonCode'> | null
): boolean {
  return health?.reasonCode === 'credential_unavailable'
}

export function connectPhoneInstallRequestOptions(
  target: ClawInstallTarget
): ConnectPhoneInstallRequest {
  if (target === 'weixin') {
    return { provider: 'weixin' }
  }
  return {
    provider: 'feishu',
    options: { isLark: target === 'lark' }
  }
}

export function createConnectPhoneAgentProfile(): ClawImAgentProfileV1 {
  return {
    name: DEFAULT_PHONE_AGENT_NAME,
    description: '',
    identity: '',
    personality: '',
    userContext: '',
    replyRules: ''
  }
}

export function createConnectPhoneChannelOptions(provider: ClawImProvider = 'feishu'): {
  model: ClawModel
  enabled: boolean
  im: Partial<ClawImSettingsV1>
} {
  return {
    model: 'auto',
    enabled: true,
    im: {
      enabled: true,
      provider
    }
  }
}

export function createConnectPhoneCredential(
  poll: Extract<ClawImInstallPollResult, { done: true }>,
  createdAt: string = new Date().toISOString()
): ClawImPlatformCredentialV1 {
  if (poll.kind === 'weixin') {
    return {
      kind: poll.kind,
      accountId: poll.accountId,
      sessionKey: poll.sessionKey,
      createdAt
    }
  }
  return {
    kind: poll.kind,
    appId: poll.appId,
    appSecret: poll.appSecret,
    domain: poll.domain,
    createdAt
  }
}

export function formatConnectPhoneUserCode(userCode: string, deviceCode: string): string {
  const source = userCode.trim() || deviceCode
  const compact = source.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)
  if (compact.length <= 4) return compact
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

export function ConnectPhoneView({
  channels,
  onAddProvider,
  leftSidebarCollapsed,
  onToggleSidebar
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState<ClawInstallTarget>('feishu')
  const [installQr, setInstallQr] = useState<ClawInstallQrState>(INITIAL_QR_STATE)
  const [saving, setSaving] = useState(false)
  const installPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const installCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const installPollFocusHandlerRef = useRef<(() => void) | null>(null)
  const installRequestInFlightRef = useRef(false)
  const installPollInFlightRef = useRef(false)
  const installPollAttemptRef = useRef<number | null>(null)
  const installAttemptRef = useRef(0)
  const targetProvider = connectPhoneProviderForTarget(target)
  const connectedChannel = channels.find((channel) => channel.provider === targetProvider) ?? null
  const imHealth = useImHealth(connectedChannel)
  const weixinStatus = useWeixinConnectionStatus(connectedChannel)
  const allowReauthorization = canReauthorizePhoneChannel(targetProvider, imHealth, weixinStatus)
  const credentialAccessUnavailable = needsProtectedStorageReconnect(imHealth)
  const hasExistingChannel = hasClawPhoneChannel(channels, targetProvider)

  const clearInstallTimers = useCallback((): void => {
    if (installPollTimerRef.current) {
      clearInterval(installPollTimerRef.current)
      installPollTimerRef.current = null
    }
    if (installCountdownTimerRef.current) {
      clearInterval(installCountdownTimerRef.current)
      installCountdownTimerRef.current = null
    }
    if (installPollFocusHandlerRef.current && typeof window !== 'undefined') {
      window.removeEventListener('focus', installPollFocusHandlerRef.current)
      installPollFocusHandlerRef.current = null
    }
  }, [])

  const cancelInstallAttempt = useCallback((): void => {
    installAttemptRef.current += 1
    installRequestInFlightRef.current = false
    installPollInFlightRef.current = false
    installPollAttemptRef.current = null
    clearInstallTimers()
  }, [clearInstallTimers])

  useEffect(() => {
    return cancelInstallAttempt
  }, [cancelInstallAttempt])

  useEffect(() => {
    cancelInstallAttempt()
    setSaving(false)
    setInstallQr(INITIAL_QR_STATE)
  }, [cancelInstallAttempt, target])

  useEffect(() => {
    if (!hasExistingChannel || allowReauthorization) return
    cancelInstallAttempt()
    setSaving(false)
    setInstallQr(INITIAL_QR_STATE)
  }, [allowReauthorization, cancelInstallAttempt, hasExistingChannel])

  const addConnectedChannel = async (
    poll: Extract<ClawImInstallPollResult, { done: true }>
  ): Promise<void> => {
    const provider = poll.kind
    const existing = channels.find((channel) => channel.provider === provider) ?? null
    if (existing && !allowReauthorization) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('connectPhoneProviderAlreadyConnected', {
          provider: provider === 'weixin' ? clawInstallTargetLabel(t, 'weixin') : 'Feishu / Lark'
        })
      })
      return
    }
    setSaving(true)
    try {
      await onAddProvider(
        provider,
        createConnectPhoneAgentProfile(),
        createConnectPhoneCredential(poll),
        {
          ...createConnectPhoneChannelOptions(provider),
          ...(existing ? { channelId: existing.id } : {})
        }
      )
    } catch (error) {
      setInstallQr((current) => ({
        ...current,
        status: 'error',
        error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
      }))
    } finally {
      setSaving(false)
    }
  }

  const startOfficialInstallQr = async (): Promise<void> => {
    if (hasExistingChannel && !allowReauthorization) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('connectPhoneProviderAlreadyConnected', {
          provider: targetProvider === 'weixin' ? clawInstallTargetLabel(t, 'weixin') : 'Feishu / Lark'
        })
      })
      return
    }
    if (
      saving ||
      installRequestInFlightRef.current ||
      installQr.status === 'loading' ||
      installQr.status === 'showing'
    ) {
      return
    }
    if (
      typeof window === 'undefined' ||
      typeof window.workwise?.startClawImInstallQr !== 'function'
    ) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('clawAddImOfficialQrUnavailable')
      })
      return
    }

    clearInstallTimers()
    const installAttempt = installAttemptRef.current + 1
    installAttemptRef.current = installAttempt
    installRequestInFlightRef.current = true
    setSaving(false)
    setInstallQr({ ...INITIAL_QR_STATE, status: 'loading' })
    const request = connectPhoneInstallRequestOptions(target)
    let result: ClawImInstallQrResult
    try {
      result = await window.workwise.startClawImInstallQr(request.provider, request.options)
    } catch (error) {
      if (installAttempt !== installAttemptRef.current) return
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
      })
      return
    } finally {
      if (installAttempt === installAttemptRef.current) {
        installRequestInFlightRef.current = false
      }
    }
    if (installAttempt !== installAttemptRef.current) return
    if (!result.ok) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: formatClawInstallError(result.message, t)
      })
      return
    }

    setInstallQr({
      status: 'showing',
      url: result.url,
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      timeLeft: result.expireIn,
      error: ''
    })
    installCountdownTimerRef.current = setInterval(() => {
      setInstallQr((current) => {
        if (current.status !== 'showing') return current
        if (current.timeLeft <= 1) {
          installAttemptRef.current += 1
          clearInstallTimers()
          return {
            ...current,
            status: 'error',
            timeLeft: 0,
            error: t('clawAddImOfficialQrExpired')
          }
        }
        return { ...current, timeLeft: current.timeLeft - 1 }
      })
    }, 1000)
    const waitForInstall = async (): Promise<void> => {
      if (
        installPollInFlightRef.current
        && installPollAttemptRef.current === installAttempt
      ) return
      installPollInFlightRef.current = true
      installPollAttemptRef.current = installAttempt
      try {
        if (
          typeof window === 'undefined' ||
          typeof window.workwise?.pollClawImInstall !== 'function'
        ) {
          throw new Error(t('clawAddImOfficialQrUnavailable'))
        }
        const poll = await withClawInstallPollTimeout(
          window.workwise.pollClawImInstall(request.provider, result.deviceCode)
        )
        if (installAttempt !== installAttemptRef.current) return
        if (poll.done) {
          clearInstallTimers()
          setInstallQr((current) => ({
            ...current,
            status: 'success',
            error: '',
            timeLeft: 0
          }))
          await addConnectedChannel(poll)
          return
        }
        if (poll.error) {
          if (poll.retryable) {
            setInstallQr((current) => current.status === 'showing'
              ? { ...current, error: formatClawInstallError(poll.error ?? '', t) }
              : current)
            return
          }
          installAttemptRef.current += 1
          clearInstallTimers()
          setInstallQr((current) => ({
            ...current,
            status: 'error',
            error: formatClawInstallError(poll.error ?? t('clawAddImOfficialQrFailed'), t)
          }))
          return
        }
        setInstallQr((current) => current.status === 'showing' && current.error
          ? { ...current, error: '' }
          : current)
      } catch (error) {
        if (installAttempt !== installAttemptRef.current) return
        installAttemptRef.current += 1
        clearInstallTimers()
        setInstallQr((current) => ({
          ...current,
          status: 'error',
          error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
        }))
      } finally {
        if (installPollAttemptRef.current === installAttempt) {
          installPollInFlightRef.current = false
          installPollAttemptRef.current = null
        }
      }
    }
    if (typeof window !== 'undefined') {
      const onFocus = (): void => {
        void waitForInstall()
      }
      installPollFocusHandlerRef.current = onFocus
      window.addEventListener('focus', onFocus)
    }
    // Poll once immediately. Returning from the phone app should not depend
    // on a background timer that Chromium may throttle while the QR is shown.
    void waitForInstall()
    if (request.provider !== 'weixin') {
      installPollTimerRef.current = setInterval(() => {
        void waitForInstall()
      }, Math.max(result.interval, 3) * 1000)
    }
  }

  const hasDisabledChannels = hasExistingChannel && !hasEnabledClawPhoneChannel(channels, targetProvider)
  const displayUserCode = targetProvider === 'weixin'
    ? ''
    : formatConnectPhoneUserCode(installQr.userCode, installQr.deviceCode)
  const installQrIsImage = installQr.url.startsWith('data:image/')

  return (
    <section className="ds-no-drag relative flex min-h-0 flex-1 overflow-hidden bg-transparent">
      {leftSidebarCollapsed ? (
        <div className="absolute left-4 top-4 z-20">
          <SidebarTitlebarToggleButton
            onClick={onToggleSidebar}
            title={t('sidebarExpand')}
            ariaLabel={t('sidebarExpand')}
          />
        </div>
      ) : null}

      <div className="grid min-h-0 w-full grid-cols-1 gap-8 px-5 py-4 lg:grid-cols-[minmax(520px,1fr)_minmax(430px,0.76fr)] lg:px-4">
        <div className="flex min-h-0 items-center justify-center pb-4 pt-2">
          <div className="w-full max-w-[560px] text-center">
            <h1 className="text-[28px] font-semibold tracking-normal text-ds-ink">
              {t('connectPhoneTitle')}
            </h1>
            <p className="mx-auto mt-2 max-w-[460px] text-[14px] leading-6 text-[#9299a3] dark:text-white/40">
              {t('connectPhoneSubtitle')}
            </p>
            {credentialAccessUnavailable ? (
              <div className="mx-auto mt-4 max-w-[460px] rounded-[10px] border border-amber-300/70 bg-amber-50 px-3 py-2 text-left text-[12.5px] leading-5 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100">
                <div className="font-semibold">{t('connectPhoneCredentialAccessRequired')}</div>
                <div className="mt-0.5">{t('connectPhoneCredentialAccessHint')}</div>
              </div>
            ) : allowReauthorization ? (
              <div className="mx-auto mt-4 max-w-[460px] rounded-[10px] border border-amber-300/70 bg-amber-50 px-3 py-2 text-left text-[12.5px] leading-5 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100">
                <div className="font-semibold">{t('connectPhoneReauthorizationRequired')}</div>
                <div className="mt-0.5">{t('connectPhoneReauthorizationHint')}</div>
              </div>
            ) : null}

            <div className="mt-7 inline-flex rounded-full bg-[#f0f1ef] p-1 shadow-inner dark:bg-white/[0.08]">
              {CONNECT_PHONE_TARGETS.map((item) => {
                const active = target === item
                const provider = connectPhoneProviderForTarget(item)
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTarget(item)}
                    className={`inline-flex h-8 min-w-[92px] items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-semibold transition ${
                      active
                        ? 'bg-white text-ds-ink shadow-sm dark:bg-white/[0.14] dark:text-white'
                        : 'text-[#727985] hover:text-ds-ink dark:hover:text-white'
                    }`}
                    aria-pressed={active}
                  >
                    <ClawProviderLogo provider={provider} className="h-4 w-4" />
                    {clawInstallTargetLabel(t, item)}
                  </button>
                )
              })}
            </div>

            <div className="mx-auto mt-9 flex h-[226px] w-[226px] flex-col items-center justify-center rounded-[14px] border border-[#ececea] bg-white p-3 shadow-[0_18px_38px_rgba(32,37,43,0.05)]">
              {installQr.status === 'idle' ? (
                <div className="grid justify-items-center gap-4">
                  <div className="flex h-20 w-20 items-center justify-center rounded-[18px] bg-[#f3f4f2] text-[#9aa2ad]">
                    <QrCode className="h-9 w-9" strokeWidth={1.7} />
                  </div>
                  <button
                    type="button"
                    onClick={() => void startOfficialInstallQr()}
                    disabled={hasExistingChannel && !allowReauthorization}
                    className="inline-flex min-h-[36px] items-center justify-center gap-2 rounded-xl bg-[#222323] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-55 dark:bg-white dark:text-black"
                  >
                    {allowReauthorization ? t('connectPhoneReauthorize') : t('connectPhoneGenerateQr')}
                  </button>
                </div>
              ) : null}

              {installQr.status === 'loading' ? (
                <div className="grid justify-items-center gap-2 text-ds-faint">
                  <Loader2 className="h-6 w-6 animate-spin" strokeWidth={2} />
                  <span className="text-[12px]">{t('connectPhoneQrLoading')}</span>
                </div>
              ) : null}

              {installQr.url && installQr.status !== 'loading' ? (
                installQrIsImage ? (
                  <img
                    src={installQr.url}
                    alt={t('connectPhoneGenerateQr')}
                    className="h-[204px] w-[204px] object-contain"
                  />
                ) : (
                  <QRCodeSVG value={installQr.url} size={204} marginSize={1} />
                )
              ) : null}

              {installQr.status === 'showing' ? (
                <div className="mt-3 text-center text-[12px] text-[#8d95a1]">
                  {t('clawAddImOfficialQrTimeLeft', { seconds: installQr.timeLeft })}
                </div>
              ) : null}

              {installQr.status === 'success' ? (
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-600 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  {saving ? t('connectPhoneBinding') : t('clawAddImOfficialQrSuccess')}
                </div>
              ) : null}

              {installQr.status === 'error' ? (
                <div className="mt-3 grid justify-items-center gap-2">
                  <div className="max-w-[220px] text-center text-[12px] leading-5 text-red-600 dark:text-red-300">
                    {installQr.error || t('clawAddImOfficialQrFailed')}
                  </div>
                  {!hasExistingChannel || allowReauthorization ? (
                    <button
                      type="button"
                      onClick={() => void startOfficialInstallQr()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                    >
                      <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                      {t('clawAddImOfficialQrRetry')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="mt-4 text-center text-[12.5px] leading-5 text-[#a1a7af]">
              <div className="inline-flex items-center justify-center gap-1.5 font-medium text-[#68707c] dark:text-white/55">
                <ClawProviderLogo provider={targetProvider} className="h-4 w-4" />
                {t(targetProvider === 'weixin' ? 'connectPhoneScanHintWeixin' : 'connectPhoneScanHint')}
              </div>
              <div className="mt-1">{t('connectPhoneAutoBindHint')}</div>
              {displayUserCode ? (
                <div className="mt-3 font-mono text-[13px] tracking-normal text-ds-ink">
                  {t('connectPhoneUserCode', { code: displayUserCode })}
                </div>
              ) : null}
              {hasDisabledChannels ? (
                <div className="mt-1">{t('connectPhoneDisabledConnectionHint')}</div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="hidden min-h-0 items-stretch justify-center lg:flex">
          <div className="flex h-full max-h-[860px] w-full items-center justify-center rounded-[24px] border border-white/70 bg-[#98cef0] px-8 py-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_22px_48px_rgba(71,117,151,0.12)]">
            <div className="relative aspect-[0.54] h-[min(80vh,720px)] min-h-[560px] rounded-[48px] border-[7px] border-[#151718] bg-[#151718] shadow-[0_26px_52px_rgba(26,38,50,0.22)]">
              <div className="absolute -left-[11px] top-[156px] h-10 w-[5px] rounded-l-full bg-[#25282c]" />
              <div className="absolute -left-[11px] top-[216px] h-12 w-[5px] rounded-l-full bg-[#25282c]" />
              <div className="absolute -right-[11px] top-[210px] h-20 w-[5px] rounded-r-full bg-[#25282c]" />
              <div className="absolute left-1/2 top-[13px] z-20 h-[30px] w-[92px] -translate-x-1/2 rounded-full bg-black" />
              <div className="absolute right-[74px] top-[20px] z-30 h-3 w-3 rounded-full bg-[#151a1f]" />
              <div className="flex h-full flex-col overflow-hidden rounded-[40px] bg-[#fffefa]">
                <div className="flex h-[54px] shrink-0 items-end justify-between px-6 pb-2 text-[#111827]">
                  <span className="text-[13px] font-semibold">9:41</span>
                  <span className="flex items-center gap-1.5">
                    <Wifi className="h-4 w-4" strokeWidth={2} />
                    <Battery className="h-4 w-4" strokeWidth={2} />
                  </span>
                </div>
                <div className="relative flex h-12 shrink-0 items-center justify-between border-b border-[#f0f1ef] px-4 text-[#111827]">
                  <ChevronLeft className="h-6 w-6" strokeWidth={1.8} />
                  <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-[14px] font-semibold">
                    <span>{brand.platform}</span>
                    <span className="rounded-[4px] bg-[#eee7ff] px-1.5 py-0.5 text-[10px] font-semibold text-[#8b5cf6]">AI</span>
                  </div>
                  <MoreHorizontal className="h-5 w-5" strokeWidth={2} />
                </div>
                <div className="min-h-0 flex-1 bg-[#fffefa] px-5 pt-6">
                  <div className="ml-auto flex max-w-[248px] items-start gap-2">
                    <div className="rounded-[8px] bg-[#d6ebfb] px-4 py-3 text-left text-[13px] font-medium leading-5 text-[#1f2937]">
                      {t('connectPhonePreviewUser')}
                    </div>
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f6d75d] text-[12px] font-bold text-[#695000]">
                      K
                    </div>
                  </div>
                  <div className="mt-5 flex max-w-[274px] items-start gap-2">
                    <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#dbeafe] bg-[#f1f7fd] text-[12px] font-bold text-[#2563eb]">
                      K
                    </span>
                    <div className="overflow-hidden rounded-[8px] border border-[#dfe6e9] bg-[#fffefa] text-left shadow-sm">
                      <div className="flex items-center gap-2 bg-[#d2f5db] px-3 py-2">
                        <span className="text-[12px] font-semibold text-[#15803d]">{brand.platform}</span>
                        <span className="rounded-[4px] bg-[#bff0cf] px-1.5 py-0.5 text-[10px] font-semibold text-[#15803d]">
                          {t('connectPhonePreviewDone')}
                        </span>
                      </div>
                      <div className="px-3 py-3 text-[13px] font-medium leading-5 text-[#3f4147]">
                        {t('connectPhonePreviewAssistant')}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="shrink-0 bg-[#f3f4f2] px-3 pb-3 pt-2">
                  <div className="mb-2 flex h-10 items-center gap-2 rounded-[7px] bg-[#fffefa] px-3 text-[13px] text-[#a3a3a3] shadow-sm">
                    <span className="flex-1">{t('connectPhonePreviewInput')}</span>
                    <Maximize2 className="h-4 w-4 text-[#777]" strokeWidth={1.8} />
                  </div>
                  <div className="flex h-8 items-center justify-between px-1 text-[#70757a]">
                    <Smile className="h-5 w-5" strokeWidth={1.8} />
                    <AtSign className="h-5 w-5" strokeWidth={1.8} />
                    <Mic className="h-5 w-5" strokeWidth={1.8} />
                    <ImageIcon className="h-5 w-5" strokeWidth={1.8} />
                    <span className="text-[15px] font-semibold">Aa</span>
                    <PlusCircle className="h-5 w-5" strokeWidth={1.8} />
                  </div>
                  <div className="mx-auto mt-2 h-1 w-24 rounded-full bg-black" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function ConnectPhoneSidebarPanel({
  channels,
  onAddProvider,
  onDisconnect,
  onOpenSettings
}: {
  channels: ClawImChannelV1[]
  onAddProvider: AddClawPhoneChannel
  onDisconnect: (channelId: string) => Promise<void>
  onOpenSettings: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [target, setTarget] = useState<ClawInstallTarget>('feishu')
  const [installQr, setInstallQr] = useState<ClawInstallQrState>(INITIAL_QR_STATE)
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState('')
  const installPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const installCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const installPollFocusHandlerRef = useRef<(() => void) | null>(null)
  const installRequestInFlightRef = useRef(false)
  const installPollInFlightRef = useRef(false)
  const installPollAttemptRef = useRef<number | null>(null)
  const installAttemptRef = useRef(0)
  const targetProvider = connectPhoneProviderForTarget(target)
  const connectedChannel = channels.find((channel) => channel.provider === targetProvider) ?? null
  const imHealth = useImHealth(connectedChannel)
  const weixinStatus = useWeixinConnectionStatus(connectedChannel)
  const allowReauthorization = canReauthorizePhoneChannel(targetProvider, imHealth, weixinStatus)
  const credentialAccessUnavailable = needsProtectedStorageReconnect(imHealth)
  const hasExistingChannel = Boolean(connectedChannel)
  const [imSelfCheck, setImSelfCheck] = useState<ImSelfCheckResultV1 | null>(null)
  const [imDiagnostics, setImDiagnostics] = useState<ImDiagnosticsV1['channels'][number] | null>(null)
  const [imDiagnosticsFingerprint, setImDiagnosticsFingerprint] = useState('')
  const [imAction, setImAction] = useState<'start' | 'reconnect' | 'stop' | 'self-check' | null>(null)
  const [imActionError, setImActionError] = useState('')
  const displayUserCode = targetProvider === 'weixin'
    ? ''
    : formatConnectPhoneUserCode(installQr.userCode, installQr.deviceCode)
  const installQrIsImage = installQr.url.startsWith('data:image/')
  const fallbackConnectionLabel = targetProvider === 'weixin'
    ? weixinStatus?.status === 'connected'
      ? t('connectPhoneWeixinConnected')
      : t('connectPhoneWeixinChecking')
    : t('clawManageImConnected')
  const healthLabelKey = connectedChannel
    ? imHealthLabelKey(imHealth, connectedChannel.enabled)
    : null
  const selfCheckScopeKey = imSelfCheckScopeKey(connectedChannel?.id ?? '', imHealth)

  useEffect(() => {
    setImSelfCheck(null)
    setImDiagnostics(null)
    setImDiagnosticsFingerprint('')
  }, [selfCheckScopeKey])

  const clearInstallTimers = useCallback((): void => {
    if (installPollTimerRef.current) {
      clearInterval(installPollTimerRef.current)
      installPollTimerRef.current = null
    }
    if (installCountdownTimerRef.current) {
      clearInterval(installCountdownTimerRef.current)
      installCountdownTimerRef.current = null
    }
    if (installPollFocusHandlerRef.current && typeof window !== 'undefined') {
      window.removeEventListener('focus', installPollFocusHandlerRef.current)
      installPollFocusHandlerRef.current = null
    }
  }, [])

  const cancelInstallAttempt = useCallback((): void => {
    installAttemptRef.current += 1
    installRequestInFlightRef.current = false
    installPollInFlightRef.current = false
    installPollAttemptRef.current = null
    clearInstallTimers()
  }, [clearInstallTimers])

  useEffect(() => {
    return cancelInstallAttempt
  }, [cancelInstallAttempt])

  useEffect(() => {
    cancelInstallAttempt()
    setSaving(false)
    setInstallQr(INITIAL_QR_STATE)
    setDisconnectError('')
    setImSelfCheck(null)
    setImDiagnostics(null)
    setImDiagnosticsFingerprint('')
    setImActionError('')
  }, [cancelInstallAttempt, target])

  useEffect(() => {
    if (!hasExistingChannel || allowReauthorization) return
    cancelInstallAttempt()
    setSaving(false)
    setInstallQr(INITIAL_QR_STATE)
  }, [allowReauthorization, cancelInstallAttempt, hasExistingChannel])

  const addConnectedChannel = async (
    poll: Extract<ClawImInstallPollResult, { done: true }>
  ): Promise<void> => {
    const provider = poll.kind
    const existing = channels.find((channel) => channel.provider === provider) ?? null
    if (existing && !allowReauthorization) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('connectPhoneProviderAlreadyConnected', {
          provider: provider === 'weixin' ? clawInstallTargetLabel(t, 'weixin') : 'Feishu / Lark'
        })
      })
      return
    }
    setSaving(true)
    try {
      await onAddProvider(
        provider,
        createConnectPhoneAgentProfile(),
        createConnectPhoneCredential(poll),
        {
          ...createConnectPhoneChannelOptions(provider),
          ...(existing ? { channelId: existing.id } : {}),
          preserveRoute: true
        }
      )
    } catch (error) {
      setInstallQr((current) => ({
        ...current,
        status: 'error',
        error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
      }))
    } finally {
      setSaving(false)
    }
  }

  const startOfficialInstallQr = async (): Promise<void> => {
    if (hasExistingChannel && !allowReauthorization) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('connectPhoneProviderAlreadyConnected', {
          provider: targetProvider === 'weixin' ? clawInstallTargetLabel(t, 'weixin') : 'Feishu / Lark'
        })
      })
      return
    }
    if (
      saving ||
      installRequestInFlightRef.current ||
      installQr.status === 'loading' ||
      installQr.status === 'showing'
    ) {
      return
    }
    if (
      typeof window === 'undefined' ||
      typeof window.workwise?.startClawImInstallQr !== 'function'
    ) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: t('clawAddImOfficialQrUnavailable')
      })
      return
    }

    clearInstallTimers()
    const installAttempt = installAttemptRef.current + 1
    installAttemptRef.current = installAttempt
    installRequestInFlightRef.current = true
    setSaving(false)
    setInstallQr({ ...INITIAL_QR_STATE, status: 'loading' })
    const request = connectPhoneInstallRequestOptions(target)
    let result: ClawImInstallQrResult
    try {
      result = await window.workwise.startClawImInstallQr(request.provider, request.options)
    } catch (error) {
      if (installAttempt !== installAttemptRef.current) return
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
      })
      return
    } finally {
      if (installAttempt === installAttemptRef.current) {
        installRequestInFlightRef.current = false
      }
    }
    if (installAttempt !== installAttemptRef.current) return
    if (!result.ok) {
      setInstallQr({
        ...INITIAL_QR_STATE,
        status: 'error',
        error: formatClawInstallError(result.message, t)
      })
      return
    }

    setInstallQr({
      status: 'showing',
      url: result.url,
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      timeLeft: result.expireIn,
      error: ''
    })
    installCountdownTimerRef.current = setInterval(() => {
      setInstallQr((current) => {
        if (current.status !== 'showing') return current
        if (current.timeLeft <= 1) {
          installAttemptRef.current += 1
          clearInstallTimers()
          return {
            ...current,
            status: 'error',
            timeLeft: 0,
            error: t('clawAddImOfficialQrExpired')
          }
        }
        return { ...current, timeLeft: current.timeLeft - 1 }
      })
    }, 1000)
    const waitForInstall = async (): Promise<void> => {
      if (
        installPollInFlightRef.current
        && installPollAttemptRef.current === installAttempt
      ) return
      installPollInFlightRef.current = true
      installPollAttemptRef.current = installAttempt
      try {
        if (
          typeof window === 'undefined' ||
          typeof window.workwise?.pollClawImInstall !== 'function'
        ) {
          throw new Error(t('clawAddImOfficialQrUnavailable'))
        }
        const poll = await withClawInstallPollTimeout(
          window.workwise.pollClawImInstall(request.provider, result.deviceCode)
        )
        if (installAttempt !== installAttemptRef.current) return
        if (poll.done) {
          clearInstallTimers()
          setInstallQr((current) => ({
            ...current,
            status: 'success',
            error: '',
            timeLeft: 0
          }))
          await addConnectedChannel(poll)
          return
        }
        if (poll.error) {
          if (poll.retryable) {
            setInstallQr((current) => current.status === 'showing'
              ? { ...current, error: formatClawInstallError(poll.error ?? '', t) }
              : current)
            return
          }
          installAttemptRef.current += 1
          clearInstallTimers()
          setInstallQr((current) => ({
            ...current,
            status: 'error',
            error: formatClawInstallError(poll.error ?? t('clawAddImOfficialQrFailed'), t)
          }))
          return
        }
        setInstallQr((current) => current.status === 'showing' && current.error
          ? { ...current, error: '' }
          : current)
      } catch (error) {
        if (installAttempt !== installAttemptRef.current) return
        installAttemptRef.current += 1
        clearInstallTimers()
        setInstallQr((current) => ({
          ...current,
          status: 'error',
          error: formatClawInstallError(error instanceof Error ? error.message : String(error), t)
        }))
      } finally {
        if (installPollAttemptRef.current === installAttempt) {
          installPollInFlightRef.current = false
          installPollAttemptRef.current = null
        }
      }
    }
    if (typeof window !== 'undefined') {
      const onFocus = (): void => {
        void waitForInstall()
      }
      installPollFocusHandlerRef.current = onFocus
      window.addEventListener('focus', onFocus)
    }
    // Poll once immediately. Returning from the phone app should not depend
    // on a background timer that Chromium may throttle while the QR is shown.
    void waitForInstall()
    if (request.provider !== 'weixin') {
      installPollTimerRef.current = setInterval(() => {
        void waitForInstall()
      }, Math.max(result.interval, 3) * 1000)
    }
  }

  const disconnectChannel = async (): Promise<void> => {
    if (!connectedChannel || disconnecting) return
    const confirmed = await confirmDialog(
      t('connectPhoneDisconnectConfirm', { name: connectedChannel.label })
    )
    if (!confirmed) return

    setDisconnectError('')
    setDisconnecting(true)
    try {
      await onDisconnect(connectedChannel.id)
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : String(error))
    } finally {
      setDisconnecting(false)
    }
  }

  const runImLifecycle = async (action: 'start' | 'reconnect' | 'stop'): Promise<void> => {
    if (!connectedChannel || imAction) return
    const invoke = action === 'start'
      ? window.workwise?.startIm
      : action === 'reconnect'
        ? window.workwise?.reconnectIm
        : window.workwise?.stopIm
    if (typeof invoke !== 'function') {
      setImActionError(t('connectPhoneLifecycleUnavailable'))
      return
    }
    setImSelfCheck(null)
    setImDiagnostics(null)
    setImDiagnosticsFingerprint('')
    setImAction(action)
    setImActionError('')
    try {
      const result = await invoke(connectedChannel.id)
      if (!result.ok) setImActionError(result.message)
    } catch (error) {
      setImActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setImAction(null)
    }
  }

  const runImSelfCheck = async (): Promise<void> => {
    if (!connectedChannel || imAction) return
    if (
      typeof window.workwise?.selfCheckIm !== 'function'
      || typeof window.workwise?.getImDiagnostics !== 'function'
    ) {
      setImActionError(t('connectPhoneSelfCheckUnavailable'))
      return
    }
    setImAction('self-check')
    setImActionError('')
    try {
      const [selfCheck, diagnostics] = await Promise.all([
        window.workwise.selfCheckIm(connectedChannel.id),
        window.workwise.getImDiagnostics()
      ])
      setImSelfCheck(selfCheck)
      setImDiagnostics(
        diagnostics.channels.find((entry) => entry.channelId === connectedChannel.id) ?? null
      )
      setImDiagnosticsFingerprint(diagnostics.userDataFingerprint)
    } catch (error) {
      setImActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setImAction(null)
    }
  }

  return (
    <div className="ds-no-drag flex min-h-0 flex-1 flex-col px-2 pt-2">
      <div className="px-1 pb-3">
        <div className="flex items-center gap-2 text-[12px] font-normal text-[#9aa5b5] dark:text-white/35">
          <ClawProviderLogo provider={targetProvider} className="h-4 w-4" />
          <span>{t('claw')}</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl border border-ds-border bg-ds-card p-1">
          {CONNECT_PHONE_TARGETS.map((item) => {
            const active = target === item
            const provider = connectPhoneProviderForTarget(item)
            return (
              <button
                key={item}
                type="button"
                onClick={() => setTarget(item)}
                className={`inline-flex min-h-[28px] items-center justify-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold transition ${
                  active
                    ? 'bg-accent/12 text-accent'
                    : 'text-ds-faint hover:bg-ds-hover hover:text-ds-ink'
                }`}
                aria-pressed={active}
              >
                <ClawProviderLogo provider={provider} className="h-3.5 w-3.5" />
                {clawInstallTargetLabel(t, item)}
              </button>
            )
          })}
        </div>
      </div>

      {connectedChannel && !allowReauthorization ? (
        <div className="mx-1 rounded-[12px] border border-ds-border bg-ds-card px-3 py-3 shadow-sm">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-emerald-500/12 text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold text-ds-ink">
                {connectedChannel.label}
              </span>
              <span className="mt-1 block truncate text-[12px] text-ds-faint">
                {healthLabelKey ? t(healthLabelKey) : fallbackConnectionLabel}
              </span>
            </span>
          </div>
          {imHealth ? (
            <div className="mt-3 border-t border-ds-border-muted pt-3 text-[11.5px] leading-5 text-ds-faint">
              <div className="break-words text-ds-muted">
                {credentialAccessUnavailable ? t('connectPhoneCredentialAccessHint') : imHealth.message}
              </div>
              <div className="mt-1">
                {t('connectPhoneHealthCounts', {
                  pending: imHealth.pendingMessages,
                  processing: imHealth.processingMessages,
                  delivery: imHealth.deliveryMessages
                })}
              </div>
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void runImLifecycle(imHealth?.status === 'stopped' ? 'start' : 'reconnect')}
              disabled={Boolean(imAction)}
              className="inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-main/55 px-2 py-1.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {imAction === 'start' || imAction === 'reconnect' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
              )}
              {imHealth?.status === 'stopped' ? t('connectPhoneStart') : t('connectPhoneReconnect')}
            </button>
            <button
              type="button"
              onClick={() => void runImLifecycle('stop')}
              disabled={Boolean(imAction) || imHealth?.status === 'stopped'}
              className="inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-main/55 px-2 py-1.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {imAction === 'stop' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <CircleStop className="h-3.5 w-3.5" strokeWidth={1.8} />
              )}
              {t('connectPhoneStop')}
            </button>
            <button
              type="button"
              onClick={() => void runImSelfCheck()}
              disabled={Boolean(imAction)}
              className="col-span-2 inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-main/55 px-2.5 py-1.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {imAction === 'self-check' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
              )}
              {imAction === 'self-check' ? t('connectPhoneSelfChecking') : t('connectPhoneSelfCheck')}
            </button>
          </div>
          {imSelfCheck ? (
            <div className={`mt-2 rounded-[8px] px-2.5 py-2 text-[11.5px] leading-5 ${
              imSelfCheck.overall === 'PASS'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
                : 'bg-amber-500/10 text-amber-800 dark:text-amber-100'
            }`}>
              <div className="font-semibold">
                {imSelfCheck.overall === 'PASS' ? t('connectPhoneSelfCheckPass') : t('connectPhoneSelfCheckFail')}
              </div>
              {imSelfCheck.checks.map((check) => (
                <div key={check.id}>{check.pass ? '✓' : '×'} {check.summary}</div>
              ))}
              {imDiagnostics ? (
                <div className="mt-1 border-t border-current/15 pt-1">
                  {t('connectPhoneDiagnosticsCounts', {
                    pending: imDiagnostics.pendingMessages,
                    processing: imDiagnostics.processingMessages,
                    delivery: imDiagnostics.deliveryMessages,
                    failures: imDiagnostics.failureCount
                  })}
                  {imDiagnosticsFingerprint ? (
                    <div className="break-all font-mono opacity-75">
                      {t('connectPhoneDiagnosticsFingerprint', { fingerprint: imDiagnosticsFingerprint })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-2 grid gap-2">
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex min-h-[30px] w-full items-center justify-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-main/55 px-2.5 py-1.5 text-[12.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <Settings className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t('clawSettings')}
            </button>
            <button
              type="button"
              onClick={() => void disconnectChannel()}
              disabled={disconnecting}
              className="inline-flex min-h-[30px] w-full items-center justify-center gap-1.5 rounded-[8px] border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12.5px] font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
            >
              {disconnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <LogOut className="h-3.5 w-3.5" strokeWidth={1.8} />
              )}
              {disconnecting ? t('connectPhoneDisconnecting') : t('connectPhoneDisconnect')}
            </button>
          </div>
          {disconnectError ? (
            <div className="mt-2 rounded-[8px] bg-red-500/10 px-2.5 py-2 text-[12px] leading-relaxed text-red-600 dark:text-red-300">
              {disconnectError}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mx-1 flex flex-col items-center rounded-[12px] border border-ds-border bg-ds-card px-3 py-4 shadow-sm">
          {allowReauthorization ? (
            <div className="mb-3 w-full rounded-[9px] border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100">
              <div className="font-semibold">{t('connectPhoneReauthorizationRequired')}</div>
              <div className="mt-0.5">{t('connectPhoneReauthorizationHint')}</div>
            </div>
          ) : null}
          <div className="flex h-[168px] w-full items-center justify-center rounded-[10px] border border-[#ececea] bg-white p-2">
            {installQr.status === 'idle' ? (
              <div className="grid justify-items-center gap-3">
                <div className="flex h-14 w-14 items-center justify-center rounded-[14px] bg-[#f3f4f2] text-[#9aa2ad]">
                  <QrCode className="h-7 w-7" strokeWidth={1.7} />
                </div>
                <button
                  type="button"
                  onClick={() => void startOfficialInstallQr()}
                  className="inline-flex min-h-[32px] items-center justify-center gap-1.5 rounded-[8px] bg-[#222323] px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-black dark:bg-white dark:text-black"
                >
                  {allowReauthorization ? t('connectPhoneReauthorize') : t('connectPhoneGenerateQr')}
                </button>
              </div>
            ) : null}

            {installQr.status === 'loading' ? (
              <div className="grid justify-items-center gap-2 text-ds-faint">
                <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
                <span className="text-[12px]">{t('connectPhoneQrLoading')}</span>
              </div>
            ) : null}

            {installQr.url && installQr.status !== 'loading' ? (
              installQrIsImage ? (
                <img
                  src={installQr.url}
                  alt={t('connectPhoneGenerateQr')}
                  className="h-[148px] w-[148px] object-contain"
                />
              ) : (
                <QRCodeSVG value={installQr.url} size={148} marginSize={1} />
              )
            ) : null}
          </div>

          {installQr.status === 'showing' ? (
            <>
              <div className="mt-3 text-center text-[12px] text-[#8d95a1]">
                {t('clawAddImOfficialQrTimeLeft', { seconds: installQr.timeLeft })}
              </div>
              {installQr.error ? (
                <div className="mt-2 max-w-[220px] text-center text-[12px] leading-5 text-amber-700 dark:text-amber-200">
                  {installQr.error}
                </div>
              ) : null}
            </>
          ) : null}

          {installQr.status === 'success' ? (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              {saving ? t('connectPhoneBinding') : t('clawAddImOfficialQrSuccess')}
            </div>
          ) : null}

          {installQr.status === 'error' ? (
            <div className="mt-3 grid justify-items-center gap-2">
              <div className="max-w-[220px] text-center text-[12px] leading-5 text-red-600 dark:text-red-300">
                {installQr.error || t('clawAddImOfficialQrFailed')}
              </div>
              {!hasExistingChannel || allowReauthorization ? (
                <button
                  type="button"
                  onClick={() => void startOfficialInstallQr()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                >
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {t('clawAddImOfficialQrRetry')}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 text-center text-[12px] leading-5 text-[#8d95a1]">
            <div className="inline-flex items-center justify-center gap-1.5 font-medium text-[#68707c] dark:text-white/55">
              <ClawProviderLogo provider={targetProvider} className="h-4 w-4" />
              {clawInstallTargetLabel(t, target)}
            </div>
            <div className="mt-1">{t('connectPhoneAutoBindHint')}</div>
            {displayUserCode ? (
              <div className="mt-2 font-mono text-[13px] tracking-normal text-ds-ink">
                {t('connectPhoneUserCode', { code: displayUserCode })}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
