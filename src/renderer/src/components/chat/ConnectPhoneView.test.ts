import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClawImChannelV1 } from '@shared/app-settings'
import i18n from '../../i18n'
import {
  ConnectPhoneSidebarPanel,
  ConnectPhoneView,
  canReauthorizePhoneChannel,
  connectPhoneInstallRequestOptions,
  connectPhoneProviderForTarget,
  createConnectPhoneAgentProfile,
  createConnectPhoneChannelOptions,
  createConnectPhoneCredential,
  formatConnectPhoneUserCode,
  hasClawPhoneChannel,
  hasEnabledClawPhoneChannel,
  imHealthLabelKey,
  imSelfCheckScopeKey,
  needsProtectedStorageReconnect,
  withClawInstallPollTimeout
} from './ConnectPhoneView'

function channel(enabled: boolean, provider: ClawImChannelV1['provider'] = 'feishu'): ClawImChannelV1 {
  return {
    id: `${provider}-${enabled ? 'enabled' : 'disabled'}`,
    provider,
    label: enabled ? 'Enabled' : 'Disabled',
    enabled,
    model: 'auto',
    threadId: '',
    workspaceRoot: '',
    agentProfile: {
      name: 'WorkWise',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    conversations: [],
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z'
  }
}

describe('ConnectPhoneView', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the dedicated phone connection page before a channel is enabled', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectPhoneView, {
        channels: [],
        onAddProvider: async () => undefined,
        leftSidebarCollapsed: false,
        onToggleSidebar: () => undefined
      })
    )

    expect(html).toContain('Use your phone to connect RailWise AI')
    expect(html).toContain('Generate authorization QR')
    expect(html).not.toContain('RailWise AI Runtime usage')
  })

  it('resolves every common connection label instead of exposing translation keys', async () => {
    const keys = [
      'clawImConnectionEnabled',
      'clawImEnabled',
      'clawImDisabled',
      'clawWorkspaceOverride',
      'showSecret',
      'hideSecret'
    ]

    for (const language of ['en', 'zh']) {
      await i18n.changeLanguage(language)
      for (const key of keys) {
        expect(i18n.t(key, { ns: 'common' })).not.toBe(key)
      }
    }
  })

  it('maps scan targets to the matching install API provider', () => {
    expect(connectPhoneProviderForTarget('feishu')).toBe('feishu')
    expect(connectPhoneProviderForTarget('lark')).toBe('feishu')
    expect(connectPhoneProviderForTarget('weixin')).toBe('weixin')
    expect(connectPhoneInstallRequestOptions('feishu')).toEqual({
      provider: 'feishu',
      options: { isLark: false }
    })
    expect(connectPhoneInstallRequestOptions('lark')).toEqual({
      provider: 'feishu',
      options: { isLark: true }
    })
    expect(connectPhoneInstallRequestOptions('weixin')).toEqual({
      provider: 'weixin'
    })
  })

  it('formats the official user code instead of the opaque device code', () => {
    expect(formatConnectPhoneUserCode('YWAZ-ZZ8P', 'v1:opaque-device-code')).toBe('YWAZ-ZZ8P')
    expect(formatConnectPhoneUserCode('', 'abcd1234-rest-of-token')).toBe('ABCD-1234')
  })

  it('bounds a renderer-side authorization poll that never settles', async () => {
    const pending = withClawInstallPollTimeout(new Promise<never>(() => undefined), 10)
    await expect(pending).rejects.toThrow('IM_INSTALL_POLL_TIMEOUT')
  })

  it('builds the default RailWise AI channel payload after a successful scan', () => {
    expect(createConnectPhoneAgentProfile()).toEqual({
      name: 'RailWise AI',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    })
    expect(createConnectPhoneChannelOptions()).toEqual({
      model: 'auto',
      enabled: true,
      im: {
        enabled: true,
        provider: 'feishu'
      }
    })
    expect(createConnectPhoneChannelOptions('weixin')).toEqual({
      model: 'auto',
      enabled: true,
      im: {
        enabled: true,
        provider: 'weixin'
      }
    })
    expect(
      createConnectPhoneCredential(
        {
          done: true,
          kind: 'feishu',
          appId: 'cli_a',
          appSecret: 'secret',
          domain: 'lark'
        },
        '2026-06-03T01:02:03.000Z'
      )
    ).toEqual({
      kind: 'feishu',
      appId: 'cli_a',
      appSecret: 'secret',
      domain: 'lark',
      createdAt: '2026-06-03T01:02:03.000Z'
    })
    expect(
      createConnectPhoneCredential(
        {
          done: true,
          kind: 'weixin',
          accountId: 'wx_account',
          sessionKey: 'session-key'
        },
        '2026-06-03T01:02:03.000Z'
      )
    ).toEqual({
      kind: 'weixin',
      accountId: 'wx_account',
      sessionKey: 'session-key',
      createdAt: '2026-06-03T01:02:03.000Z'
    })
  })

  it('treats only enabled channels for the selected provider as connected phone channels', () => {
    expect(hasEnabledClawPhoneChannel([])).toBe(false)
    expect(hasEnabledClawPhoneChannel([channel(false)])).toBe(false)
    expect(hasEnabledClawPhoneChannel([channel(false), channel(true)])).toBe(true)
    expect(hasEnabledClawPhoneChannel([channel(true, 'weixin')], 'feishu')).toBe(false)
    expect(hasEnabledClawPhoneChannel([channel(true, 'weixin')], 'weixin')).toBe(true)
  })

  it('reserves only the selected provider slot once a channel exists', () => {
    expect(hasClawPhoneChannel([])).toBe(false)
    expect(hasClawPhoneChannel([channel(false)])).toBe(true)
    expect(hasClawPhoneChannel([channel(true)])).toBe(true)
    expect(hasClawPhoneChannel([channel(true, 'feishu')], 'weixin')).toBe(false)
    expect(hasClawPhoneChannel([channel(true, 'weixin')], 'weixin')).toBe(true)
  })

  it('keeps a connected WeChat account distinguishable for runtime status checks', () => {
    const existing = channel(true, 'weixin')
    existing.platformCredential = {
      kind: 'weixin',
      accountId: 'wx_account',
      sessionKey: 'wx_session',
      createdAt: '2026-08-13T00:00:00.000Z'
    }

    expect(existing.platformCredential.accountId).toBe('wx_account')
    expect(hasClawPhoneChannel([existing], 'weixin')).toBe(true)
  })

  it('keeps protected-storage recovery separate from replacing expired credentials', () => {
    expect(canReauthorizePhoneChannel('weixin', {
      status: 'error',
      reasonCode: 'credential_unavailable'
    })).toBe(false)
    expect(needsProtectedStorageReconnect({ reasonCode: 'credential_unavailable' })).toBe(true)
    expect(needsProtectedStorageReconnect({ reasonCode: 'credential_missing' })).toBe(false)
    expect(canReauthorizePhoneChannel('feishu', {
      status: 'error',
      reasonCode: 'credential_missing'
    })).toBe(true)
    expect(canReauthorizePhoneChannel('feishu', {
      status: 'expired',
      reasonCode: 'auth_expired'
    })).toBe(true)
    expect(canReauthorizePhoneChannel('weixin', null, {
      status: 'expired',
      reasonCode: 'auth_expired'
    })).toBe(true)
    expect(canReauthorizePhoneChannel('feishu', {
      status: 'error',
      reasonCode: 'network'
    })).toBe(false)
  })

  it('uses authoritative health instead of a stale disabled channel snapshot', () => {
    expect(imHealthLabelKey({ status: 'connected' }, false)).toBe('connectPhoneHealthConnected')
    expect(imHealthLabelKey({ status: 'starting' }, false)).toBe('connectPhoneHealthStarting')
    expect(imHealthLabelKey({ status: 'stopped' }, true)).toBe('connectPhoneHealthStopped')
    expect(imHealthLabelKey(null, false)).toBe('clawImDisabledSidebar')
    expect(imHealthLabelKey(null, true)).toBeNull()
  })

  it('invalidates a self-check result when its channel health scope changes', () => {
    const connected = imSelfCheckScopeKey('channel-1', {
      status: 'connected',
      reasonCode: 'none'
    })
    expect(imSelfCheckScopeKey('channel-1', {
      status: 'stopped',
      reasonCode: 'user_stopped'
    })).not.toBe(connected)
    expect(imSelfCheckScopeKey('channel-2', {
      status: 'connected',
      reasonCode: 'none'
    })).not.toBe(connected)
  })

  it('shows settings and disconnect actions for an existing phone connection', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectPhoneSidebarPanel, {
        channels: [channel(true)],
        onAddProvider: async () => undefined,
        onDisconnect: async () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('Phone connection settings')
    expect(html).toContain('Disconnect phone')
    expect(html).toContain('Reconnect')
    expect(html).toContain('Pause connection')
    expect(html).toContain('Run connection self-check')
  })
})
