import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ClawImChannelV1, ScheduledTaskV1 } from '../shared/app-settings'
import { ImCredentialService } from './services/im-credential-service'
import { applySettingsApplicationTransaction } from './settings-application-transaction'
import { JsonSettingsStore } from './settings-store'

function feishuChannel(
  credentialRef: ClawImChannelV1['credentialRef'],
  appSecret?: string,
  identity: { channelId?: string; appId?: string } = {}
): ClawImChannelV1 {
  const now = '2026-08-21T00:00:00.000Z'
  return {
    id: identity.channelId ?? 'channel-1',
    provider: 'feishu',
    label: 'Feishu',
    enabled: true,
    model: 'auto',
    threadId: '',
    workspaceRoot: '',
    agentProfile: {
      name: 'Agent',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    platformCredential: {
      kind: 'feishu',
      appId: identity.appId ?? 'app-1',
      ...(appSecret === undefined ? {} : { appSecret }),
      domain: 'feishu',
      createdAt: now
    },
    ...(credentialRef ? { credentialRef } : {}),
    conversations: [],
    createdAt: now,
    updatedAt: now
  }
}

describe('applySettingsApplicationTransaction', () => {
  it('normalizes saved schedule models when switching providers and protects channel credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-provider-switch-'))
    const userData = join(root, 'user-data')
    const store = new JsonSettingsStore(userData, {
      workwiseHome: join(root, 'home', '.workwise')
    })
    const service = new ImCredentialService({
      root: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from(value, 'utf8'),
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const scheduledTask = (id: string, model: string): ScheduledTaskV1 => ({
      id,
      title: id,
      enabled: true,
      prompt: 'Run task',
      workspaceRoot: '/tmp/workspace',
      model,
      reasoningEffort: 'medium',
      mode: 'agent',
      schedule: { kind: 'manual' as const, everyMinutes: 60, timeOfDay: '09:00', atTime: '' },
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      lastRunAt: '',
      nextRunAt: '',
      lastStatus: 'idle' as const,
      lastMessage: '',
      lastThreadId: ''
    })
    await store.patch({
      agents: { kun: { providerId: 'custom-provider' } },
      schedule: {
        model: 'deepseek-v4-pro',
        tasks: [scheduledTask('retired', 'deepseek-v4-flash'), scheduledTask('custom', 'custom-model')]
      }
    })

    const saved = await applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: {
        agents: { kun: { providerId: '' } },
        claw: { channels: [feishuChannel(undefined, 'provider-switch-secret')] }
      }
    })

    expect(saved.schedule.model).toBe('deepseek-flash')
    expect(saved.schedule.tasks.map((task) => task.model)).toEqual(['deepseek-flash', 'custom-model'])
    const channel = saved.claw.channels[0]!
    expect(channel.platformCredential).not.toHaveProperty('appSecret')
    await expect(service.resolve(channel.credentialRef!)).resolves.toBe('provider-switch-secret')
    const persistedSettings = await readFile(join(userData, 'workwise-settings.json'), 'utf8')
    expect(persistedSettings).not.toContain('provider-switch-secret')
  })

  it('keeps the committed replacement when old credential cleanup reports an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-cleanup-failure-'))
    const store = new JsonSettingsStore(join(root, 'user-data'), {
      workwiseHome: join(root, 'home', '.workwise')
    })
    const service = new ImCredentialService({
      root: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from(value, 'utf8'),
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const originalRef = await service.set('feishu', 'app-1', 'old-secret')
    await store.patch({ claw: { channels: [feishuChannel(originalRef)] } })
    vi.spyOn(service, 'remove').mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: { claw: { channels: [feishuChannel(originalRef, 'new-secret')] } }
    })).rejects.toThrow('cleanup failed')

    const saved = await store.load()
    const replacementRef = saved.claw.channels[0]?.credentialRef
    expect(replacementRef?.id).not.toBe(originalRef.id)
    await expect(service.resolve(replacementRef!)).resolves.toBe('new-secret')
  })

  it('keeps the existing credential and removes the replacement when settings persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-write-failure-'))
    const credentialRoot = join(root, 'credentials')
    const store = new JsonSettingsStore(join(root, 'user-data'), {
      workwiseHome: join(root, 'home', '.workwise')
    })
    const service = new ImCredentialService({
      root: credentialRoot,
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from(value, 'utf8'),
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const originalRef = await service.set('feishu', 'app-1', 'old-secret')
    await store.patch({ claw: { channels: [feishuChannel(originalRef)] } })
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'))

    await expect(applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: { claw: { channels: [feishuChannel(originalRef, 'new-secret')] } }
    })).rejects.toThrow('disk full')

    const saved = await store.load()
    expect(saved.claw.channels[0]?.credentialRef?.id).toBe(originalRef.id)
    await expect(service.resolve(originalRef)).resolves.toBe('old-secret')
    expect(await readdir(credentialRoot)).toEqual([`${originalRef.id}.json`])
  })

  it('waits for every channel protection attempt before rolling back a failed batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-partial-protection-'))
    const credentialRoot = join(root, 'credentials')
    let releaseSlowEncryption!: () => void
    const slowEncryption = new Promise<void>((resolve) => { releaseSlowEncryption = resolve })
    let signalSlowEncryptionStarted!: () => void
    const slowEncryptionStarted = new Promise<void>((resolve) => { signalSlowEncryptionStarted = resolve })
    const service = new ImCredentialService({
      root: credentialRoot,
      encryption: {
        available: () => true,
        encrypt: async (value) => {
          if (value === 'slow-secret') {
            signalSlowEncryptionStarted()
            await slowEncryption
          }
          return Buffer.from(value, 'utf8')
        },
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const store = new JsonSettingsStore(join(root, 'user-data'), {
      workwiseHome: join(root, 'home', '.workwise')
    })
    const transaction = applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: {
        claw: {
          channels: [
            feishuChannel(undefined, 'slow-secret', { channelId: 'slow', appId: 'slow-app' }),
            feishuChannel(undefined, 'x'.repeat(128 * 1024 + 1), { channelId: 'invalid', appId: 'invalid-app' })
          ]
        }
      }
    })
    const outcome = transaction.then(() => 'resolved' as const, () => 'rejected' as const)

    await slowEncryptionStarted
    const beforeRelease = await Promise.race([
      outcome,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25))
    ])
    releaseSlowEncryption()
    await expect(transaction).rejects.toThrow('IM credential is empty or exceeds 128 KiB.')

    expect(beforeRelease).toBe('pending')
    expect((await store.load()).claw.channels).toHaveLength(0)
    await expect(readdir(credentialRoot)).resolves.toEqual([])
  })

  it('rejects a stale revision before mutating an existing credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-stale-credential-'))
    const store = new JsonSettingsStore(join(root, 'user-data'), {
      workwiseHome: join(root, 'home', '.workwise')
    })
    const service = new ImCredentialService({
      root: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from(value, 'utf8'),
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const originalRef = await service.set('feishu', 'app-1', 'old-secret')
    const original = await store.patch({ claw: { channels: [feishuChannel(originalRef)] } })
    await store.patch({ theme: 'dark' }, original.revision)

    await expect(applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: { claw: { channels: [feishuChannel(originalRef, 'stale-secret')] } },
      expectedRevision: original.revision
    })).rejects.toMatchObject({ code: 'stale_request' })

    await expect(service.resolve(originalRef)).resolves.toBe('old-secret')
  })

  it('does not let an older cleanup delete a credential retained by a later commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-settings-transaction-'))
    const store = new JsonSettingsStore(join(root, 'user-data'), {
      workwiseHome: join(root, 'home', '.workwise')
    })
    let signalNewCredentialProtected!: () => void
    const newCredentialProtected = new Promise<void>((resolve) => {
      signalNewCredentialProtected = resolve
    })
    const service = new ImCredentialService({
      root: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => {
          if (value === 'new-secret') signalNewCredentialProtected()
          return Buffer.from(value, 'utf8')
        },
        decrypt: (value) => value.toString('utf8'),
        storage: 'safe-storage'
      }
    })
    const originalRef = await service.set('feishu', 'app-1', 'old-secret')
    await store.patch({ claw: { channels: [feishuChannel(originalRef)] } })

    let cleanupStarted!: () => void
    const cleanupStart = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const originalRemove = service.remove.bind(service)
    const remove = vi.spyOn(service, 'remove')
    remove.mockImplementationOnce(async (ref) => {
      cleanupStarted()
      await cleanupGate
      await originalRemove(ref)
    })

    const removeOldChannel = applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: { claw: { channels: [] } }
    })
    await cleanupStart

    const restoreSameAccount = applySettingsApplicationTransaction({
      store,
      credentialService: service,
      partial: { claw: { channels: [feishuChannel(originalRef, 'new-secret')] } }
    })
    const beforeCleanupRelease = await Promise.race([
      newCredentialProtected.then(() => 'protected' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 25))
    ])
    expect(beforeCleanupRelease).toBe('blocked')
    expect((await store.load()).claw.channels).toHaveLength(0)

    releaseCleanup()
    await Promise.all([removeOldChannel, restoreSameAccount])

    const saved = await store.load()
    const retainedRef = saved.claw.channels[0]?.credentialRef
    expect(retainedRef?.id).not.toBe(originalRef.id)
    await expect(service.resolve(originalRef)).resolves.toBeUndefined()
    await expect(service.resolve(retainedRef!)).resolves.toBe('new-secret')
  })
})
