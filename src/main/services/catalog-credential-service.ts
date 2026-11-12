import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { safeStorage } from 'electron'
import type { CatalogCredentialStatusV1 } from '../../shared/marketplace'
import { atomicWriteFile, readRecoveredFile, runSerialized } from './durable-file'
import { isCandidateCredentialAccessAllowed } from '../candidate-runtime'
import { decryptStringWithCredentialHelper, encryptStringWithCredentialHelper } from './im-credential-helper'

const MAX_SECRET_KEY_BYTES = 512
const MAX_TOKEN_BYTES = 64 * 1024

type ResolvedCatalogCredential = { hash: string; value: string }
const processResolvedCatalogCredentials = new Map<string, ResolvedCatalogCredential>()

export type CatalogCredentialEncryption = {
  available(): boolean | Promise<boolean>
  encrypt(value: string, interactive?: boolean): Buffer | Promise<Buffer>
  decrypt(value: Buffer, interactive?: boolean): string | Promise<string>
  storage: NonNullable<CatalogCredentialStatusV1['storage']>
}

function defaultEncryption(): CatalogCredentialEncryption {
  if (!isCandidateCredentialAccessAllowed()) {
    return {
      available: () => false,
      encrypt: () => { throw new Error('Candidate protected storage access is disabled.') },
      decrypt: () => { throw new Error('Candidate protected storage access is disabled.') },
      storage: 'keychain'
    }
  }
  if (process.platform === 'darwin') {
    return {
      available: () => true,
      encrypt: (value, interactive = false) => encryptStringWithCredentialHelper(value, { interactive }),
      decrypt: (value, interactive = false) => decryptStringWithCredentialHelper(value, { interactive }),
      storage: 'keychain'
    }
  }
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
    storage: process.platform === 'win32' ? 'dpapi' : 'safe-storage'
  }
}

function normalizedSecretKey(value: string): string {
  const key = value.trim()
  if (!key || key.includes('\0') || Buffer.byteLength(key) > MAX_SECRET_KEY_BYTES) {
    throw new Error('Catalog credential key is invalid.')
  }
  return key
}

function normalizedToken(value: string): string {
  const token = value.trim()
  if (!token || token.includes('\0') || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new Error('Catalog credential token is invalid or exceeds 64 KiB.')
  }
  return token
}

function credentialId(secretKey: string): string {
  return `catalog_${createHash('sha256').update(secretKey).digest('hex')}`
}

export class CatalogCredentialService {
  private readonly root: string
  private readonly encryption: CatalogCredentialEncryption
  private readonly resolvedCredentials: Map<string, ResolvedCatalogCredential>
  private readonly retryScope = new AsyncLocalStorage<string>()
  private readonly session = new Map<string, string>()

  constructor(options: {
    root?: string
    encryption?: CatalogCredentialEncryption
  } = {}) {
    this.root = resolve(options.root ?? join(homedir(), '.workwise', 'credentials', 'catalog'))
    this.encryption = options.encryption ?? defaultEncryption()
    this.resolvedCredentials = options.encryption ? new Map() : processResolvedCatalogCredentials
  }

  async set(secretKey: string, accessToken: string): Promise<NonNullable<CatalogCredentialStatusV1['storage']>> {
    const key = normalizedSecretKey(secretKey)
    const token = normalizedToken(accessToken)
    const id = credentialId(key)
    const path = join(this.root, `${id}.json`)
    return runSerialized(`catalog-credential:${path}`, async () => {
      if (!await this.encryption.available()) {
        await rm(path, { force: true }).catch(() => undefined)
        this.resolvedCredentials.delete(path)
        this.session.set(id, token)
        return 'session'
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const encrypted = await this.encryption.encrypt(token, true)
      await atomicWriteFile(path, `${JSON.stringify({ schema: 'workwise.catalog-credential', version: 1, encrypted: encrypted.toString('base64') })}\n`)
      this.session.delete(id)
      this.resolvedCredentials.set(path, { hash: createHash('sha256').update(encrypted).digest('hex'), value: token })
      return this.encryption.storage
    })
  }

  async resolve(secretKey: string): Promise<string | undefined> {
    const id = credentialId(normalizedSecretKey(secretKey))
    const path = join(this.root, `${id}.json`)
    return runSerialized(`catalog-credential:${path}`, async () => {
      const session = this.session.get(id)
      if (session) return session
      try {
        if (!await this.encryption.available()) {
          this.resolvedCredentials.delete(path)
          return undefined
        }
        const value = JSON.parse(await readRecoveredFile(path)) as { schema?: unknown; version?: unknown; encrypted?: unknown }
        if (value.schema !== 'workwise.catalog-credential' || value.version !== 1 || typeof value.encrypted !== 'string') {
          this.resolvedCredentials.delete(path)
          return undefined
        }
        const encrypted = Buffer.from(value.encrypted, 'base64')
        const hash = createHash('sha256').update(encrypted).digest('hex')
        const cached = this.resolvedCredentials.get(path)
        if (cached?.hash === hash) return cached.value
        this.resolvedCredentials.delete(path)
        const token = normalizedToken(await this.encryption.decrypt(encrypted, this.retryScope.getStore() === id))
        const current = JSON.parse(await readRecoveredFile(path)) as { encrypted: string }
        if (!Buffer.from(current.encrypted, 'base64').equals(encrypted)) throw new Error('Credential changed while being read.')
        this.resolvedCredentials.set(path, { hash, value: token })
        return token
      } catch (error) {
        this.resolvedCredentials.delete(path)
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        const code = (error as { code?: unknown }).code
        throw Object.assign(new Error('无法读取已保存的市场凭据。请处理系统凭据访问提示后重试；原凭据仍保留。'), {
          code: typeof code === 'string' && code.startsWith('credential_helper_') ? code : 'credential_unavailable'
        })
      }
    })
  }

  async status(sourceId: string, secretKey: string): Promise<CatalogCredentialStatusV1> {
    const id = credentialId(normalizedSecretKey(secretKey))
    if (this.session.has(id)) return { sourceId, configured: true, storage: 'session' }
    if (!await this.encryption.available()) return { sourceId, configured: false }
    try {
      const token = await this.resolve(secretKey)
      return token
        ? { sourceId, configured: true, storage: this.encryption.storage }
        : { sourceId, configured: false }
    } catch (error) {
      return {
        sourceId, configured: false, storage: this.encryption.storage,
        errorCode: String((error as { code?: unknown }).code ?? 'credential_unavailable'),
        message: '已保存的市场凭据暂时无法读取。请处理系统凭据访问提示后刷新此来源；原凭据仍保留。'
      }
    }
  }

  withProtectedStorageRetry<T>(secretKey: string, operation: () => Promise<T>): Promise<T> {
    const id = credentialId(normalizedSecretKey(secretKey))
    return this.retryScope.run(id, operation)
  }

  async remove(secretKey: string): Promise<void> {
    const id = credentialId(normalizedSecretKey(secretKey))
    const path = join(this.root, `${id}.json`)
    await runSerialized(`catalog-credential:${path}`, async () => {
      this.session.delete(id)
      this.resolvedCredentials.delete(path)
      await rm(path, { force: true }).catch(() => undefined)
    })
  }

}
