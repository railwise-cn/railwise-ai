import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOrCreateFlowSecretStoreKey } from './flow-secret-store-key'

const protectedStorage = vi.hoisted(() => ({
  available: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  helperEncrypt: vi.fn(),
  helperDecrypt: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
  safeStorage: {
    isEncryptionAvailable: protectedStorage.available,
    encryptString: protectedStorage.encrypt,
    decryptString: protectedStorage.decrypt
  }
}))
vi.mock('./im-credential-helper', () => ({
  encryptStringWithCredentialHelper: protectedStorage.helperEncrypt,
  decryptStringWithCredentialHelper: protectedStorage.helperDecrypt
}))

const adapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^protected:/, '')
}

describe('Flow system safe-storage key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists only the platform-encrypted master key and returns the same key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const first = await loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter }); const second = await loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(second).toBe(first)
    const stored = await readFile(join(root, 'master-key.json'), 'utf8'); expect(stored).not.toContain(first!); expect(stored).toContain('encrypted')
  })
  it('fails closed when platform encryption is unavailable', async () => {
    await expect(loadOrCreateFlowSecretStoreKey({ root: '/unused', safeStorageAdapter: { ...adapter, isEncryptionAvailable: () => false } })).resolves.toBeNull()
  })

  it('does not rotate an existing key when protected storage access fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const record = JSON.stringify({ version: 1, encrypted: 'existing-encrypted-record' }) + '\n'
    await writeFile(join(root, 'master-key.json'), record, 'utf8')
    const failingAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: async () => { throw new Error('Keychain unavailable') },
      decryptString: async () => { throw new Error('Keychain unavailable') }
    }
    await expect(loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: failingAdapter })).resolves.toBeNull()
    await expect(readFile(join(root, 'master-key.json'), 'utf8')).resolves.toBe(record)
  })

  it('does not create a replacement key when protected storage cannot encrypt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const failingAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: async () => { throw new Error('Keychain unavailable') },
      decryptString: async () => { throw new Error('Keychain unavailable') }
    }
    await expect(loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: failingAdapter })).resolves.toBeNull()
    await expect(readFile(join(root, 'master-key.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'darwin')('uses the bounded async helper without querying Keychain on the main process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const existing = await loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })
    protectedStorage.helperDecrypt.mockImplementation(() => new Promise((resolve) => {
      // An asynchronous protected-storage wait must leave the event loop free.
      setTimeout(() => resolve(existing), 0)
    }))
    await expect(loadOrCreateFlowSecretStoreKey({ root })).resolves.toBe(existing)
    expect(protectedStorage.helperDecrypt).toHaveBeenCalledOnce()
    expect(protectedStorage.available).not.toHaveBeenCalled()
    expect(protectedStorage.decrypt).not.toHaveBeenCalled()
    expect(protectedStorage.encrypt).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'darwin')('recovers the same key after helper timeout without replacing the encrypted record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const existing = await loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })
    const before = await readFile(join(root, 'master-key.json'), 'utf8')
    protectedStorage.helperDecrypt.mockRejectedValueOnce(Object.assign(new Error('Protected storage timeout'), {
      code: 'credential_helper_timeout'
    })).mockResolvedValueOnce(existing)
    await expect(loadOrCreateFlowSecretStoreKey({ root })).resolves.toBeNull()
    await expect(readFile(join(root, 'master-key.json'), 'utf8')).resolves.toBe(before)
    await expect(loadOrCreateFlowSecretStoreKey({ root })).resolves.toBe(existing)
    expect(protectedStorage.helperEncrypt).not.toHaveBeenCalled()
  })

  it('keeps malformed records for recovery instead of silently rotating the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    await writeFile(join(root, 'master-key.json'), '{invalid', 'utf8')
    await expect(loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })).rejects.toThrow(SyntaxError)
    await expect(readFile(join(root, 'master-key.json'), 'utf8')).resolves.toBe('{invalid')
  })

  it('serializes concurrent first use so both callers receive the persisted key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-key-'))
    const [first, second] = await Promise.all([
      loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter }),
      loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })
    ])
    expect(first).toBe(second)
    await expect(loadOrCreateFlowSecretStoreKey({ root, safeStorageAdapter: adapter })).resolves.toBe(first)
  })
})
