import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogCredentialService } from './catalog-credential-service'

vi.mock('./im-credential-helper', () => ({
  encryptStringWithCredentialHelper: vi.fn(async (value: string) => Buffer.from(value)),
  decryptStringWithCredentialHelper: vi.fn(async (value: Buffer, _interactive?: boolean) => value.toString()),
  requestInteractiveCredentialHelperAccess: vi.fn()
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

let root = ''

beforeEach(async () => {
  const helper = await import('./im-credential-helper')
  vi.mocked(helper.encryptStringWithCredentialHelper).mockReset().mockImplementation(async value => Buffer.from(value))
  vi.mocked(helper.decryptStringWithCredentialHelper).mockReset().mockImplementation(async value => value.toString())
  vi.mocked(helper.requestInteractiveCredentialHelperAccess).mockReset()
  root = await mkdtemp(join(tmpdir(), 'workwise-catalog-credentials-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('CatalogCredentialService', () => {
  it('uses session storage for a candidate without touching protected storage', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousAccess = process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
    process.env.WORKWISE_CANDIDATE = '1'
    delete process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
    try {
      const service = new CatalogCredentialService({ root })
      await expect(service.set('catalog.candidate.token', 'candidate-token')).resolves.toBe('session')
      await expect(service.resolve('catalog.candidate.token')).resolves.toBe('candidate-token')
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousAccess === undefined) delete process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
      else process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS = previousAccess
    }
  })

  it('stores persistent tokens only as safe-storage ciphertext', async () => {
    const key = 0x47
    const service = new CatalogCredentialService({
      root,
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ key)),
        decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ key)).toString('utf8'),
        storage: 'keychain'
      }
    })

    await expect(service.set('catalog.private.token', 'private-token-value')).resolves.toBe('keychain')
    await expect(service.resolve('catalog.private.token')).resolves.toBe('private-token-value')
    await expect(service.status('private', 'catalog.private.token')).resolves.toEqual({
      sourceId: 'private',
      configured: true,
      storage: 'keychain'
    })
    const files = await readdir(root)
    expect(files).toHaveLength(1)
    expect(await readFile(join(root, files[0]!), 'utf8')).not.toContain('private-token-value')

    await service.remove('catalog.private.token')
    await expect(service.resolve('catalog.private.token')).resolves.toBeUndefined()
  })

  it('falls back to process-memory session storage when encryption is unavailable', async () => {
    const service = new CatalogCredentialService({
      root,
      encryption: {
        available: () => false,
        encrypt: () => Buffer.alloc(0),
        decrypt: () => '',
        storage: 'safe-storage'
      }
    })
    await expect(service.set('catalog.session.token', 'session-token')).resolves.toBe('session')
    await expect(service.resolve('catalog.session.token')).resolves.toBe('session-token')
    await expect(service.status('session', 'catalog.session.token')).resolves.toMatchObject({
      configured: true,
      storage: 'session'
    })
  })

  it('removes stale persistent ciphertext when a token is replaced in session storage', async () => {
    const encryption = {
      available: () => true,
      encrypt: (value: string) => Buffer.from(value),
      decrypt: (value: Buffer) => value.toString('utf8'),
      storage: 'keychain' as const
    }
    const persistent = new CatalogCredentialService({ root, encryption })
    await persistent.set('catalog.rotated.token', 'old-token')
    expect(await readdir(root)).toHaveLength(1)

    const session = new CatalogCredentialService({
      root,
      encryption: { ...encryption, available: () => false }
    })
    await expect(session.set('catalog.rotated.token', 'new-token')).resolves.toBe('session')
    await expect(session.resolve('catalog.rotated.token')).resolves.toBe('new-token')
    expect(await readdir(root)).toHaveLength(0)
  })

  it('rejects empty and oversized secrets', async () => {
    const service = new CatalogCredentialService({ root })
    await expect(service.set('catalog.token', '')).rejects.toThrow(/invalid/i)
    await expect(service.set('catalog.token', 'x'.repeat(64 * 1024 + 1))).rejects.toThrow(/64 KiB/i)
  })
})

describe('catalog protected-storage startup isolation', () => {
  it('uses the production helper without blocking the event loop, preserves ciphertext on timeout, and reads the same record on retry', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const helper = await import('./im-credential-helper')
    const { safeStorage } = await import('electron')
    const syncAvailability = vi.spyOn(safeStorage, 'isEncryptionAvailable')
    const syncDecrypt = vi.spyOn(safeStorage, 'decryptString')
    try {
      const writer = new CatalogCredentialService({ root, encryption: { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString(), storage: 'keychain' } })
      await writer.set('catalog.synthetic.token', 'synthetic-original-token')
      const file = join(root, (await readdir(root))[0]!)
      const originalCiphertext = await readFile(file)
      let rejectDecrypt!: (error: Error) => void
      vi.mocked(helper.decryptStringWithCredentialHelper).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDecrypt = reject }))
      const reopened = new CatalogCredentialService({ root })
      const pending = reopened.resolve('catalog.synthetic.token')
      const rejected = expect(pending).rejects.toMatchObject({ code: 'credential_helper_timeout', message: expect.stringContaining('重试') })
      await vi.waitFor(() => expect(rejectDecrypt).toBeTypeOf('function'))
      await new Promise<void>(resolve => setImmediate(resolve))
      rejectDecrypt(Object.assign(new Error('synthetic helper timeout'), { code: 'credential_helper_timeout' }))
      await rejected
      expect(await readFile(file)).toEqual(originalCiphertext)
      await expect(reopened.resolve('catalog.synthetic.token')).resolves.toBe('synthetic-original-token')
      expect(syncAvailability).not.toHaveBeenCalled()
      expect(syncDecrypt).not.toHaveBeenCalled()
    } finally { platform.mockRestore(); syncAvailability.mockRestore(); syncDecrypt.mockRestore() }
  })

  it('preserves the old token when a protected-storage replacement is denied', async () => {
    const encrypt = vi.fn(async (value: string) => Buffer.from(value))
    const service = new CatalogCredentialService({ root, encryption: {
      available: () => true, encrypt, decrypt: async value => value.toString(), storage: 'keychain'
    } })
    await service.set('catalog.synthetic.token', 'synthetic-original-token')
    const file = join(root, (await readdir(root))[0]!)
    const originalCiphertext = await readFile(file)
    encrypt.mockRejectedValueOnce(Object.assign(new Error('synthetic denied'), { code: 'credential_helper_access_denied' }))
    await expect(service.set('catalog.synthetic.token', 'synthetic-replacement')).rejects.toMatchObject({ code: 'credential_helper_access_denied' })
    expect(await readFile(file)).toEqual(originalCiphertext)
    await expect(service.resolve('catalog.synthetic.token')).resolves.toBe('synthetic-original-token')
  })
})


it('keeps a failed status local and retries the saved token only after an explicit source retry', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const helper = await import('./im-credential-helper')
  try {
    const writer = new CatalogCredentialService({ root, encryption: { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString(), storage: 'keychain' } })
    await writer.set('catalog.retry.token', 'synthetic-saved-token')
    const service = new CatalogCredentialService({ root })
    const file = join(root, (await readdir(root))[0]!)
    const ciphertext = await readFile(file)
    vi.mocked(helper.requestInteractiveCredentialHelperAccess).mockClear()
    vi.mocked(helper.decryptStringWithCredentialHelper).mockRejectedValueOnce(Object.assign(new Error('synthetic denied'), { code: 'credential_helper_access_denied' }))
    await expect(service.status('private', 'catalog.retry.token')).resolves.toMatchObject({ sourceId: 'private', configured: false, storage: 'keychain', errorCode: 'credential_helper_access_denied', message: expect.stringContaining('刷新此来源') })
    expect(helper.requestInteractiveCredentialHelperAccess).not.toHaveBeenCalled()
    await service.withProtectedStorageRetry('catalog.retry.token', () => service.resolve('catalog.retry.token'))
    expect(helper.requestInteractiveCredentialHelperAccess).not.toHaveBeenCalled()
    expect(vi.mocked(helper.decryptStringWithCredentialHelper).mock.calls.at(-1)?.[1]).toEqual({ interactive: true })
    await expect(service.resolve('catalog.retry.token')).resolves.toBe('synthetic-saved-token')
    await expect(service.status('private', 'catalog.retry.token')).resolves.toMatchObject({ sourceId: 'private', configured: true })
    expect(helper.requestInteractiveCredentialHelperAccess).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(ciphertext)
    const reads = vi.mocked(helper.decryptStringWithCredentialHelper).mock.calls.length
    await service.withProtectedStorageRetry('catalog.missing.token', () => service.resolve('catalog.missing.token'))
    expect(helper.requestInteractiveCredentialHelperAccess).not.toHaveBeenCalled()
    expect(helper.decryptStringWithCredentialHelper).toHaveBeenCalledTimes(reads)
  } finally { platform.mockRestore() }
})

describe('catalog successful protected-credential reuse', () => {
  const encryption = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString(), storage: 'keychain' as const }

  it('shares the same file cache across default service instances and reports persistent storage after set and status', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const helper = await import('./im-credential-helper')
    try {
      const service = new CatalogCredentialService({ root })
      await service.set('catalog.cached', 'synthetic-key')
      expect(await new CatalogCredentialService({ root }).status('cached', 'catalog.cached')).toEqual({ sourceId: 'cached', configured: true, storage: 'keychain' })
      expect(helper.decryptStringWithCredentialHelper).not.toHaveBeenCalled()
      expect(helper.encryptStringWithCredentialHelper).toHaveBeenCalledExactlyOnceWith('synthetic-key', { interactive: true })
      await service.withProtectedStorageRetry('catalog.cached', () => service.resolve('catalog.cached'))
      expect(helper.decryptStringWithCredentialHelper).not.toHaveBeenCalled()
      expect(helper.requestInteractiveCredentialHelperAccess).not.toHaveBeenCalled()
      const decrypt = vi.fn(async (value: Buffer, _interactive?: boolean) => value.toString())
      await new CatalogCredentialService({ root, encryption: { ...encryption, decrypt } }).resolve('catalog.cached')
      await new CatalogCredentialService({ root, encryption: { ...encryption, decrypt } }).resolve('catalog.cached')
      expect(decrypt).toHaveBeenCalledTimes(2)
    } finally { platform.mockRestore() }
  })

  it('decrypts a cold token once for concurrent resolve and status, invalidates changed or deleted files, and keeps a failed replacement intact', async () => {
    const writer = new CatalogCredentialService({ root, encryption })
    await writer.set('catalog.cold', 'synthetic-old')
    const decrypt = vi.fn(async (value: Buffer, _interactive?: boolean) => value.toString())
    const encrypt = vi.fn(async (value: string) => Buffer.from(value))
    const service = new CatalogCredentialService({ root, encryption: { ...encryption, encrypt, decrypt } })
    const file = join(root, (await readdir(root))[0]!)
    const old = await readFile(file)
    await Promise.all([service.resolve('catalog.cold'), service.resolve('catalog.cold'), service.status('cold', 'catalog.cold')])
    expect(decrypt).toHaveBeenCalledTimes(1)
    await writeFile(file, JSON.stringify({ schema: 'workwise.catalog-credential', version: 1, encrypted: Buffer.from('synthetic-external').toString('base64') }))
    await expect(service.resolve('catalog.cold')).resolves.toBe('synthetic-external')
    expect(decrypt).toHaveBeenCalledTimes(2)
    await rm(file)
    await expect(service.resolve('catalog.cold')).resolves.toBeUndefined()
    await writeFile(file, old)
    await expect(service.resolve('catalog.cold')).resolves.toBe('synthetic-old')
    expect(decrypt).toHaveBeenCalledTimes(3)
    encrypt.mockRejectedValueOnce(new Error('synthetic denied replacement'))
    await expect(service.set('catalog.cold', 'replacement')).rejects.toThrow('synthetic denied replacement')
    await expect(service.resolve('catalog.cold')).resolves.toBe('synthetic-old')
    expect(decrypt).toHaveBeenCalledTimes(3)
    expect(await readFile(file)).toEqual(old)
    await service.remove('catalog.cold')
    await writeFile(file, old)
    await service.resolve('catalog.cold')
    expect(decrypt).toHaveBeenCalledTimes(4)
  })

  it('confines explicit retries to the selected key and clears their scope after success or failure', async () => {
    const writer = new CatalogCredentialService({ root, encryption })
    for (const key of ['a', 'b', 'c']) await writer.set(key, `synthetic-${key}`)
    const decrypt = vi.fn(async (value: Buffer, _interactive?: boolean) => value.toString())
    const service = new CatalogCredentialService({ root, encryption: { ...encryption, decrypt } })
    await service.withProtectedStorageRetry('a', async () => {
      await service.resolve('b')
      await service.resolve('a')
    })
    expect(decrypt.mock.calls.map(call => call[1])).toEqual([false, true])
    await expect(service.withProtectedStorageRetry('c', async () => { throw new Error('synthetic sync failure') })).rejects.toThrow('synthetic sync failure')
    await service.resolve('c')
    expect(decrypt.mock.calls.at(-1)?.[1]).toBe(false)
    const count = decrypt.mock.calls.length
    await service.withProtectedStorageRetry('a', () => service.resolve('a'))
    expect(decrypt).toHaveBeenCalledTimes(count)
  })
})
