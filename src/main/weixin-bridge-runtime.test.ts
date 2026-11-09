import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImCredentialRefV1 } from '../shared/im-communication'
import {
  configureWeixinBridgeCredentialProvider,
  disconnectWeixinBridgeAccount,
  weixinBridgeRuntimeInternals
} from './weixin-bridge-runtime'

const { getElectronPath } = vi.hoisted(() => ({
  getElectronPath: vi.fn(() => '/tmp/workwise-test-user-data')
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: getElectronPath,
    getVersion: () => '0.2.0-test'
  }
}))

const requireFromTest = createRequire(import.meta.url)
const testRoots: string[] = []

afterEach(async () => {
  configureWeixinBridgeCredentialProvider(null)
  getElectronPath.mockReturnValue('/tmp/workwise-test-user-data')
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('weixin bridge runtime', () => {
  it('builds WeChat base_info from the bundled WeChat plugin package', () => {
    const pkg = requireFromTest('@tencent-weixin/openclaw-weixin/package.json') as {
      version: string
    }
    const baseInfo = weixinBridgeRuntimeInternals.buildBaseInfo()

    expect(baseInfo).toMatchObject({
      channel_version: pkg.version,
      bot_agent: 'RailWise AI Runtime/0.2.0-test'
    })
  })

  it('keeps OpenClaw-compatible account id normalization for existing WeChat state files', () => {
    const { normalizeAccountId } = weixinBridgeRuntimeInternals

    expect(normalizeAccountId('b0f5860fdecb@im.bot')).toBe('b0f5860fdecb-im-bot')
    expect(normalizeAccountId('ABC@IM.WECHAT')).toBe('abc-im-wechat')
    expect(normalizeAccountId('')).toBe('default')
    expect(normalizeAccountId('__proto__')).toBe('default')
  })

  it('keeps the persisted account when QR login reports an existing binding', () => {
    const session = weixinBridgeRuntimeInternals.buildBoundLoginResult({
      sessionKey: 'temporary-login-session',
      existingAccountId: 'f592a34c63a6-im-bot'
    })

    expect(session).toMatchObject({
      connected: true,
      alreadyConnected: true,
      accountId: 'f592a34c63a6-im-bot',
      sessionKey: 'temporary-login-session'
    })
  })

  it('migrates a plaintext WeChat account token only after secure-storage verification', async () => {
    const secrets = new Map<string, string>()
    const provider = {
      set: vi.fn(async (_namespace: string, key: string, secret: string) => {
        secrets.set(key, secret)
        return { id: `ref-${key}`, storage: 'keychain' as const, createdAt: '2026-08-14T00:00:00.000Z' }
      }),
      migrate: vi.fn(async (_namespace: string, key: string, secret: string) => {
        secrets.set(key, secret)
        return { id: `ref-${key}`, storage: 'keychain' as const, createdAt: '2026-08-14T00:00:00.000Z' }
      }),
      resolve: vi.fn(async (ref: { id: string }) => secrets.get(ref.id.replace(/^ref-/, ''))),
      remove: vi.fn(async () => undefined)
    }

    const migrated = await weixinBridgeRuntimeInternals.protectWeixinAccountData('account-1', {
      token: 'wechat-secret-token',
      baseUrl: 'https://weixin.example.test',
      userId: 'wx-user-1'
    }, provider)

    expect(provider.migrate).toHaveBeenCalledWith('weixin-account', 'account-1', 'wechat-secret-token', undefined)
    expect(migrated).toMatchObject({ token: 'wechat-secret-token', migrated: true })
    expect(migrated.data.credentialRef).toMatchObject({ id: 'ref-account-1', storage: 'keychain' })
    expect(migrated.data).not.toHaveProperty('token')
    expect(JSON.stringify(migrated.data)).not.toContain('wechat-secret-token')
  })

  it('keeps a plaintext WeChat account token when migration falls back to session storage', async () => {
    const input = {
      token: 'wechat-secret-token',
      baseUrl: 'https://weixin.example.test',
      userId: 'wx-user-1'
    }
    const sessionRef = {
      id: 'session-ref',
      storage: 'session' as const,
      createdAt: '2026-08-14T00:00:00.000Z'
    }
    const remove = vi.fn(async () => undefined)
    const provider = {
      set: vi.fn(),
      migrate: vi.fn(async () => sessionRef),
      resolve: vi.fn(async () => 'wechat-secret-token'),
      remove
    }

    await expect(
      weixinBridgeRuntimeInternals.protectWeixinAccountData('account-1', input, provider)
    ).rejects.toMatchObject({ code: 'credential_unavailable' })

    expect(input.token).toBe('wechat-secret-token')
    expect(remove).not.toHaveBeenCalled()
    expect(provider.resolve).not.toHaveBeenCalled()
  })

  it('does not reuse local tokens for an explicit QR reconnect', () => {
    const { buildWeixinQrRequest } = weixinBridgeRuntimeInternals

    expect(buildWeixinQrRequest([], false)).toEqual({ local_token_list: [] })
    expect(buildWeixinQrRequest(['stale-token'], true)).toEqual({ local_token_list: ['stale-token'] })
  })

  it('removes only the disconnected WeChat account credentials and bridge state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-weixin-disconnect-'))
    testRoots.push(root)
    getElectronPath.mockReturnValue(root)
    const stateDir = join(root, 'weixin-bridge', 'openclaw-weixin')
    const accountsDir = join(stateDir, 'accounts')
    await mkdir(accountsDir, { recursive: true })
    const accountRef = { id: 'account-ref', storage: 'keychain' as const, createdAt: '2026-08-15T00:00:00.000Z' }
    const contextRef = { id: 'context-ref', storage: 'keychain' as const, createdAt: '2026-08-15T00:00:01.000Z' }
    const otherRef = { id: 'other-ref', storage: 'keychain' as const, createdAt: '2026-08-15T00:00:02.000Z' }
    await writeFile(join(stateDir, 'accounts.json'), `${JSON.stringify(['account-one', 'account-two'])}\n`)
    await writeFile(join(accountsDir, 'account-one.json'), `${JSON.stringify({ credentialRef: accountRef })}\n`)
    await writeFile(join(accountsDir, 'account-one.sync.json'), '{"get_updates_buf":"cursor"}\n')
    await writeFile(join(accountsDir, 'account-one.context-tokens.json'), `${JSON.stringify({ user: { credentialRef: contextRef } })}\n`)
    await writeFile(join(accountsDir, 'account-two.json'), `${JSON.stringify({ credentialRef: otherRef })}\n`)
    await writeFile(join(stateDir, 'account-status.json'), `${JSON.stringify({
      'account-one': { status: 'connected', message: 'connected' },
      'account-two': { status: 'connected', message: 'connected' }
    })}\n`)
    const remove = vi.fn(async (_ref: ImCredentialRefV1 | undefined) => undefined)
    configureWeixinBridgeCredentialProvider({
      set: vi.fn(),
      migrate: vi.fn(),
      resolve: vi.fn(),
      remove
    })

    await disconnectWeixinBridgeAccount('account-one')

    expect(remove.mock.calls.map(([ref]) => ref?.id).sort()).toEqual(['account-ref', 'context-ref'])
    await expect(access(join(accountsDir, 'account-one.json'))).rejects.toThrow()
    await expect(access(join(accountsDir, 'account-one.sync.json'))).rejects.toThrow()
    await expect(access(join(accountsDir, 'account-one.context-tokens.json'))).rejects.toThrow()
    await expect(access(join(accountsDir, 'account-two.json'))).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(stateDir, 'accounts.json'), 'utf8'))).toEqual(['account-two'])
    expect(JSON.parse(await readFile(join(stateDir, 'account-status.json'), 'utf8'))).toEqual({
      'account-two': expect.objectContaining({ status: 'connected' })
    })
    expect(remove).not.toHaveBeenCalledWith(otherRef)
  })

  it('reuses only accounts whose local session has not expired or stopped', () => {
    const { canReuseWeixinAccountStatus } = weixinBridgeRuntimeInternals

    expect(canReuseWeixinAccountStatus('connected')).toBe(true)
    expect(canReuseWeixinAccountStatus('starting')).toBe(true)
    expect(canReuseWeixinAccountStatus(undefined)).toBe(true)
    expect(canReuseWeixinAccountStatus('expired')).toBe(false)
    expect(canReuseWeixinAccountStatus('stopped')).toBe(false)
  })

  it('restarts recoverable monitors without looping terminal failures in the same run', () => {
    const { canAutomaticallyStartWeixinMonitor, shouldRestartWeixinMonitor } = weixinBridgeRuntimeInternals

    expect(shouldRestartWeixinMonitor(true, true, 'stale')).toBe(true)
    expect(shouldRestartWeixinMonitor(true, false, 'stopped')).toBe(false)
    expect(shouldRestartWeixinMonitor(false, false, 'expired')).toBe(false)
    expect(shouldRestartWeixinMonitor(false, false, 'error', 'credential_missing')).toBe(false)
    expect(shouldRestartWeixinMonitor(false, false, 'error', 'credential_unavailable')).toBe(false)
    expect(canAutomaticallyStartWeixinMonitor('stale', 'poll_stale')).toBe(true)
    expect(canAutomaticallyStartWeixinMonitor('stopped', 'user_stopped')).toBe(false)
    expect(canAutomaticallyStartWeixinMonitor('expired', 'auth_expired')).toBe(false)
    expect(canAutomaticallyStartWeixinMonitor('error', 'credential_missing')).toBe(false)
    expect(canAutomaticallyStartWeixinMonitor('error', 'credential_unavailable')).toBe(false)
  })

  it('uses the new startup time instead of a stale persisted heartbeat during recovery', () => {
    const { weixinMonitorHeartbeatTime } = weixinBridgeRuntimeInternals

    expect(weixinMonitorHeartbeatTime({
      status: 'starting',
      message: 'starting',
      startedAt: '2026-08-15T03:52:40.000Z',
      updatedAt: '2026-08-15T03:52:40.000Z',
      lastSuccessfulPollAt: '2026-08-15T03:19:53.000Z'
    })).toBe(Date.parse('2026-08-15T03:52:40.000Z'))
  })

  it('aborts an in-flight long poll when the monitor watchdog requests a restart', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return reject(new Error('missing request signal'))
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const request = weixinBridgeRuntimeInternals.getUpdates({
      accountId: 'account-one',
      configured: true,
      token: 'secret-token',
      baseUrl: 'https://example.test/',
      cdnBaseUrl: 'https://cdn.example.test/'
    }, '', 60_000, controller.signal)

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    fetchMock.mockRestore()
  })

  it('waits for aborted WeChat monitors to finish before reconnect can start a replacement', async () => {
    const controller = new AbortController()
    const watchdog = setInterval(() => undefined, 60_000)
    let finishMonitor: (() => void) | undefined
    const monitorFinished = new Promise<void>((resolve) => {
      finishMonitor = resolve
    })
    const stopping = weixinBridgeRuntimeInternals.abortWeixinMonitors([{
      accountId: 'account-one',
      runId: 'run-one',
      startedAt: '2026-08-15T00:00:00.000Z',
      controller,
      promise: monitorFinished,
      watchdog
    }])

    expect(controller.signal.aborted).toBe(true)
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    finishMonitor?.()
    await stopping
    clearInterval(watchdog)
    expect(stopped).toBe(true)
  })

  it('cancels a WeChat retry backoff immediately when the monitor is aborted', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let completed = false
      const waiting = weixinBridgeRuntimeInternals
        .sleepUntilAbort(72_000, controller.signal)
        .then(() => { completed = true })

      await vi.advanceTimersByTimeAsync(0)
      expect(completed).toBe(false)

      controller.abort()
      await waiting

      expect(completed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('trusts only an active connected monitor as proof that a WeChat credential is loaded', () => {
    const { canTrustActiveWeixinCredential } = weixinBridgeRuntimeInternals

    expect(canTrustActiveWeixinCredential(true, 'connected')).toBe(true)
    expect(canTrustActiveWeixinCredential(true, 'starting')).toBe(false)
    expect(canTrustActiveWeixinCredential(true, 'retrying')).toBe(false)
    expect(canTrustActiveWeixinCredential(false, 'connected')).toBe(false)
  })

  it('recognizes Tencent session-expired responses from either error field', () => {
    const { isWeixinSessionExpiredResponse } = weixinBridgeRuntimeInternals

    expect(isWeixinSessionExpiredResponse({ ret: 0, errcode: -14 })).toBe(true)
    expect(isWeixinSessionExpiredResponse({ ret: -14 })).toBe(true)
    expect(isWeixinSessionExpiredResponse({ ret: 0, errcode: 0 })).toBe(false)
  })

  it('does not expose the removed OpenClaw adapter builders', () => {
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildGuiManagedOpenClawConfig')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildWeixinBridgeAdapterSource')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('parseNodeVersion')
  })

  it('extracts webhook generated files for WeChat media delivery, capped at three', () => {
    const { webhookGeneratedFiles } = weixinBridgeRuntimeInternals

    expect(webhookGeneratedFiles({
      ok: true,
      reply: 'done',
      files: [
        { path: '/ws/.deepseekgui-images/cat.png', fileName: 'cat.png' },
        { path: '/ws/out/report.pdf' },
        { unrelated: true },
        { path: '/ws/a.png' },
        { path: '/ws/b.png' }
      ]
    })).toEqual([
      { path: '/ws/.deepseekgui-images/cat.png', fileName: 'cat.png' },
      { path: '/ws/out/report.pdf', fileName: 'report.pdf' },
      { path: '/ws/a.png', fileName: 'a.png' }
    ])

    expect(webhookGeneratedFiles({ ok: true, reply: 'no files' })).toEqual([])
    expect(webhookGeneratedFiles({ files: 'not-an-array' })).toEqual([])
  })

  it('returns per-file media delivery failures instead of hiding them', async () => {
    const attemptedIds: string[] = []
    const attemptedRunIds: Array<string | undefined> = []
    const sendMedia = vi.fn(async ({ filePath, clientId, runId }: {
      filePath: string
      clientId: string
      runId?: string
    }) => {
      attemptedIds.push(clientId)
      attemptedRunIds.push(runId)
      if (filePath.endsWith('broken.pptx')) throw new Error('upload failed')
      return { messageId: 'media-ok' }
    })
    const result = await weixinBridgeRuntimeInternals.sendGeneratedFilesWeixin(
      {
        accountId: 'account-1',
        baseUrl: 'https://weixin.example.test',
        cdnBaseUrl: 'https://cdn.example.test',
        configured: true
      },
      'wx-user-1',
      [
        { path: '/tmp/good.pptx', fileName: 'good.pptx' },
        { path: '/tmp/broken.pptx', fileName: 'broken.pptx' }
      ],
      undefined,
      'run-1',
      'ww_delivery',
      async () => sendMedia as never
    )

    expect(result).toEqual({
      sent: [{ path: '/tmp/good.pptx', fileName: 'good.pptx' }],
      failed: [{
        file: { path: '/tmp/broken.pptx', fileName: 'broken.pptx' },
        message: 'upload failed'
      }]
    })
    expect(sendMedia).toHaveBeenCalledTimes(4)
    expect(attemptedIds[0]).toBe('ww_delivery-file-1')
    expect(new Set(attemptedIds.slice(1))).toEqual(new Set(['ww_delivery-file-2']))
    expect(new Set(attemptedRunIds)).toEqual(new Set(['run-1']))
  })

  it('stops generated-file retry backoff when the monitor signal aborts', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const sendMedia = vi.fn(async () => {
        throw new Error('temporary upload failure')
      })
      const pending = weixinBridgeRuntimeInternals.sendGeneratedFilesWeixin(
        {
          accountId: 'account-1',
          baseUrl: 'https://weixin.example.test',
          cdnBaseUrl: 'https://cdn.example.test',
          configured: true
        },
        'wx-user-1',
        [{ path: '/tmp/result.txt', fileName: 'result.txt' }],
        undefined,
        'run-1',
        'ww-delivery',
        async () => sendMedia as never,
        undefined,
        controller.signal
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(sendMedia).toHaveBeenCalledTimes(1)

      controller.abort()
      await pending
      expect(sendMedia).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks candidate WeChat attachment delivery outside the exact allowed chat', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousOutbound = process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
    const previousProvider = process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER
    const previousChatId = process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID
    process.env.WORKWISE_CANDIDATE = '1'
    process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = '0'
    process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER = 'weixin'
    process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID = 'wx-self-test'
    const loadMediaFile = vi.fn(async () => vi.fn(async () => ({ messageId: 'should-not-send' })))
    try {
      await expect(weixinBridgeRuntimeInternals.sendGeneratedFilesWeixin(
        {
          accountId: 'account-1',
          baseUrl: 'https://weixin.example.test',
          cdnBaseUrl: 'https://cdn.example.test',
          configured: true
        },
        'wx-user-1',
        [{ path: '/tmp/result.txt', fileName: 'result.txt' }],
        undefined,
        'run-1',
        'ww-delivery',
        loadMediaFile
      )).resolves.toEqual({
        sent: [],
        failed: [{
          file: { path: '/tmp/result.txt', fileName: 'result.txt' },
          message: 'Candidate IM outbound is disabled.'
        }]
      })
      expect(loadMediaFile).not.toHaveBeenCalled()
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousOutbound === undefined) delete process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = previousOutbound
      if (previousProvider === undefined) delete process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER
      else process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER = previousProvider
      if (previousChatId === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID
      else process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID = previousChatId
    }
  })

  it('sends generated files before the success text and suppresses success text on attachment failure', async () => {
    const order: string[] = []
    const files = [{ path: '/tmp/result.txt', fileName: 'result.txt' }]
    const sendFiles = vi.fn(async (): Promise<{
      sent: Array<{ path: string; fileName: string }>
      failed: Array<{ file: { path: string; fileName: string }; message: string }>
    }> => {
      order.push('file')
      return { sent: files, failed: [] }
    })
    const sendText = vi.fn(async () => {
      order.push('text')
      return { messageId: 'text-ok' }
    })

    await expect(weixinBridgeRuntimeInternals.deliverWeixinFilesBeforeSuccessText(
      files,
      sendFiles,
      sendText
    )).resolves.toEqual({ messageId: 'text-ok' })
    expect(order).toEqual(['file', 'text'])

    sendFiles.mockResolvedValueOnce({
      sent: [],
      failed: [{ file: files[0], message: 'upload rejected' }]
    })
    await expect(weixinBridgeRuntimeInternals.deliverWeixinFilesBeforeSuccessText(
      files,
      sendFiles,
      sendText
    )).rejects.toThrow('WeChat file delivery failed: upload rejected')
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('includes one stable run id in Tencent text and media payloads', () => {
    const body = weixinBridgeRuntimeInternals.buildWeixinOutboundMessageBody({
      to: 'wx-user-1',
      clientId: 'ww_delivery',
      item: { type: 4, file_item: { file_name: 'report.pptx' } },
      contextToken: 'context-1',
      runId: 'run-1'
    })

    expect(body).toMatchObject({
      msg: {
        to_user_id: 'wx-user-1',
        client_id: 'ww_delivery',
        context_token: 'context-1',
        run_id: 'run-1',
        item_list: [{ type: 4, file_item: { file_name: 'report.pptx' } }]
      }
    })
    expect(JSON.parse(JSON.stringify(
      weixinBridgeRuntimeInternals.buildWeixinOutboundMessageBody({
        to: 'wx-user-1',
        clientId: 'ww_delivery',
        item: { type: 1, text_item: { text: 'hello' } }
      })
    )).msg).not.toHaveProperty('run_id')
  })

  it('encodes the Tencent CDN AES key using the outbound file protocol contract', () => {
    const aesKeyHex = '00112233445566778899aabbccddeeff'
    const encoded = weixinBridgeRuntimeInternals.encodeWeixinCdnAesKey(aesKeyHex)

    expect(encoded).toBe(
      'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY='
    )
    const decodedHex = Buffer.from(encoded, 'base64').toString('ascii')
    expect(decodedHex).toBe(aesKeyHex)
    expect(Buffer.from(decodedHex, 'hex')).toEqual(Buffer.from(aesKeyHex, 'hex'))
    expect(() => weixinBridgeRuntimeInternals.encodeWeixinCdnAesKey('not-a-key')).toThrow(
      'Invalid WeChat CDN AES key'
    )
  })

  it('validates Tencent CDN upload metadata against the generated attachment', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workwise-weixin-cdn-'))
    testRoots.push(tempDir)
    const filePath = join(tempDir, 'cdn-roundtrip.txt')
    const expected = Buffer.from('workwise wechat attachment roundtrip', 'utf8')
    await writeFile(filePath, expected)

    await expect(weixinBridgeRuntimeInternals.validateUploadedWeixinMedia(
      filePath,
      {
        downloadEncryptedQueryParam: 'encrypted-query',
        aeskey: '00112233445566778899aabbccddeeff',
        fileSize: expected.byteLength,
        fileSizeCiphertext: 48
      }
    )).resolves.toBeUndefined()
  })

  it('rechecks delivery ownership after CDN upload and before the provider send', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workwise-weixin-lease-takeover-'))
    testRoots.push(tempDir)
    const filePath = join(tempDir, 'takeover.txt')
    const expected = Buffer.from('lease takeover during upload', 'utf8')
    await writeFile(filePath, expected)
    let owned = true
    const providerPost = vi.fn(async () => ({}))
    const uploadAttachment = vi.fn(async () => {
      owned = false
      return {
        downloadEncryptedQueryParam: 'encrypted-query',
        aeskey: '00112233445566778899aabbccddeeff',
        fileSize: expected.byteLength,
        fileSizeCiphertext: 48
      }
    })
    const sendMedia = weixinBridgeRuntimeInternals.createSendWeixinMediaFile(
      {
        uploadVideoToWeixin: vi.fn(),
        uploadFileToWeixin: vi.fn(),
        uploadFileAttachmentToWeixin: uploadAttachment
      },
      { getMimeFromFilename: () => 'text/plain' },
      providerPost
    )

    await expect(sendMedia({
      filePath,
      fileName: 'takeover.txt',
      to: 'wx-user-1',
      text: '',
      clientId: 'ww-takeover-file-1',
      opts: { baseUrl: 'https://weixin.example.test' },
      cdnBaseUrl: 'https://cdn.example.test',
      beforeProviderSend: () => {
        if (!owned) throw new Error('delivery lease was taken over')
      }
    })).rejects.toThrow('delivery lease was taken over')
    expect(uploadAttachment).toHaveBeenCalledOnce()
    expect(providerPost).not.toHaveBeenCalled()
  })

  it('fails closed after the last confirmed lease deadline when renewal returns a server error', async () => {
    vi.useFakeTimers()
    let now = Date.parse('2026-08-17T00:00:00.000Z')
    const renew = vi.fn(async () => {
      throw new Error('WorkWise delivery receipt failed with HTTP 500.')
    })
    const heartbeat = weixinBridgeRuntimeInternals.startWorkWiseDeliveryLeaseHeartbeat({
      deliveryId: 'delivery-1',
      outboundId: 'outbound-1',
      deliveryLeaseRunId: 'owner-1',
      deliveryLeaseUntil: '2026-08-17T00:00:10.000Z'
    }, { renew, now: () => now, intervalMs: 1 })
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(renew).toHaveBeenCalledOnce()
      now = Date.parse('2026-08-17T00:00:09.999Z')
      expect(() => heartbeat.assertOwned()).not.toThrow()
      now = Date.parse('2026-08-17T00:00:10.000Z')
      expect(() => heartbeat.assertOwned()).toThrow('RailWise AI delivery lease is no longer owned')
    } finally {
      heartbeat.stop()
      vi.useRealTimers()
    }
  })

  it('rejects Tencent CDN upload metadata whose source size no longer matches', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workwise-weixin-cdn-'))
    testRoots.push(tempDir)
    const filePath = join(tempDir, 'cdn-mismatch.txt')
    const expected = Buffer.from('expected attachment', 'utf8')
    await writeFile(filePath, expected)

    await expect(weixinBridgeRuntimeInternals.validateUploadedWeixinMedia(
      filePath,
      {
        downloadEncryptedQueryParam: 'encrypted-query',
        aeskey: '00112233445566778899aabbccddeeff',
        fileSize: expected.byteLength + 1,
        fileSizeCiphertext: 32
      }
    )).rejects.toThrow('source size changed during upload')
  })

  it('normalizes Tencent numeric message ids before posting to the WorkWise webhook', () => {
    const { buildWebhookMessage } = weixinBridgeRuntimeInternals

    expect(buildWebhookMessage({
      message_id: 7493584052974092000,
      from_user_id: 'wx-user'
    }, 'wx-account', 'hello')).toMatchObject({
      chatId: 'wx-user',
      messageId: '7493584052974092000',
      senderId: 'wx-user'
    })
  })

  it('derives a stable fallback id when Tencent omits the WeChat message id', () => {
    const first = {
      from_user_id: 'wx-user-1',
      create_time_ms: 1_787_000_000_123,
      message_type: 1,
      context_token: 'context-1',
      item_list: [{ type: 1, text_item: { text: '同一条消息' } }]
    }
    const repeated = JSON.parse(JSON.stringify(first))
    const next = { ...first, create_time_ms: first.create_time_ms + 1 }

    expect(weixinBridgeRuntimeInternals.weixinMessageId(first)).toMatch(/^wx-fallback-[0-9a-f]{32}$/)
    expect(weixinBridgeRuntimeInternals.weixinMessageId(repeated)).toBe(
      weixinBridgeRuntimeInternals.weixinMessageId(first)
    )
    expect(weixinBridgeRuntimeInternals.weixinMessageId(next)).not.toBe(
      weixinBridgeRuntimeInternals.weixinMessageId(first)
    )
  })

  it('retries transient WeChat delivery failures and returns the successful result', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockRejectedValueOnce(new Error('temporary gateway failure'))
      .mockResolvedValueOnce({ messageId: 'delivered' })

    await expect(
      weixinBridgeRuntimeInternals.retryWithDelays(operation, [0, 0, 0])
    ).resolves.toEqual({ messageId: 'delivered' })
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('aborts a WeChat retry backoff without starting another delivery attempt', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const operation = vi.fn().mockRejectedValue(new Error('temporary failure'))
      const pending = weixinBridgeRuntimeInternals.retryWithDelays(
        operation,
        [0, 72_000],
        controller.signal
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(operation).toHaveBeenCalledTimes(1)

      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(operation).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces the last WeChat delivery error after all retries fail', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('final failure'))

    await expect(
      weixinBridgeRuntimeInternals.retryWithDelays(operation, [0, 0])
    ).rejects.toThrow('final failure')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('reuses one stable outbound client id across WeChat send retries', async () => {
    const attemptedIds: string[] = []
    const operation = vi.fn(async (clientId: string) => {
      attemptedIds.push(clientId)
      if (attemptedIds.length < 3) throw new Error('temporary failure')
      return { messageId: 'delivered' }
    })
    await expect(
      weixinBridgeRuntimeInternals.retryWithStableClientId(undefined, operation, [0, 0, 0])
    ).resolves.toEqual({ messageId: 'delivered' })
    expect(new Set(attemptedIds).size).toBe(1)
    expect(attemptedIds[0]).toBeTruthy()
  })

  it('derives stable and distinct client ids for retried WeChat reply chunks', () => {
    const { weixinChunkClientId } = weixinBridgeRuntimeInternals

    expect(weixinChunkClientId('ww_delivery', 0, 1)).toBe('ww_delivery')
    expect(weixinChunkClientId('ww_delivery', 0, 3)).toBe('ww_delivery-1')
    expect(weixinChunkClientId('ww_delivery', 1, 3)).toBe('ww_delivery-2')
    expect(weixinChunkClientId('ww_delivery', 1, 3)).toBe('ww_delivery-2')
  })

  it('maps known Runtime failures to safe Chinese WeChat replies', () => {
    const { safeWeixinFailureReply } = weixinBridgeRuntimeInternals

    expect(safeWeixinFailureReply('web_access_exhausted')).toContain('在线搜索连续失败')
    expect(safeWeixinFailureReply('turn timeout')).toContain('处理超时')
    expect(safeWeixinFailureReply('WeChat file delivery failed: upload failed')).toContain('附件发送失败')
    expect(safeWeixinFailureReply('/private/user/key=secret')).not.toContain('secret')
  })

  it('preserves a generated reply even when the webhook also reports failure', () => {
    const { webhookReplyText } = weixinBridgeRuntimeInternals

    expect(webhookReplyText({
      ok: false,
      message: 'web_access_exhausted',
      reply: '已生成的降级答复'
    })).toBe('已生成的降级答复')
    expect(webhookReplyText({ ok: false, message: 'failed' })).toBe('')
  })

  it('splits long WeChat replies below the upstream text limit without breaking paragraphs', () => {
    const { splitWeixinText } = weixinBridgeRuntimeInternals
    const chunks = splitWeixinText(`第一段\n${'a'.repeat(12)}\n第二段`, 16)

    expect(chunks).toEqual(['第一段\n' + 'a'.repeat(12), '第二段'])
    expect(chunks.every((chunk) => chunk.length <= 16)).toBe(true)
  })

  it('uses a hard split when a single token exceeds the limit', () => {
    const { splitWeixinText } = weixinBridgeRuntimeInternals
    const chunks = splitWeixinText('0123456789', 4)

    expect(chunks).toEqual(['0123', '4567', '89'])
  })
})
