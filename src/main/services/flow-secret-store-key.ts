import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { isCandidateCredentialAccessAllowed } from '../candidate-runtime'
import { atomicWriteFile, readRecoveredFile, runSerialized } from './durable-file'
import {
  decryptStringWithCredentialHelper,
  encryptStringWithCredentialHelper
} from './im-credential-helper'

type SafeStorageAdapter = {
  isEncryptionAvailable(): boolean | Promise<boolean>
  encryptString(value: string): Buffer | Promise<Buffer>
  decryptString(value: Buffer): string | Promise<string>
}

function defaultAdapter(): SafeStorageAdapter {
  if (process.platform === 'darwin') {
    return {
      // Even the availability check can wait for Keychain. The disposable
      // helper contains all macOS protected-storage work and has a watchdog.
      isEncryptionAvailable: isCandidateCredentialAccessAllowed,
      encryptString: encryptStringWithCredentialHelper,
      decryptString: decryptStringWithCredentialHelper
    }
  }
  return {
    isEncryptionAvailable: () => isCandidateCredentialAccessAllowed() && safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptStringAsync(value),
    decryptString: async (value) => (await safeStorage.decryptStringAsync(value)).result
  }
}

export async function loadOrCreateFlowSecretStoreKey(options: {
  root?: string
  safeStorageAdapter?: SafeStorageAdapter
} = {}): Promise<string | null> {
  const adapter = options.safeStorageAdapter ?? defaultAdapter()
  try {
    if (!await adapter.isEncryptionAvailable()) return null
  } catch {
    return null
  }
  const root = options.root ?? join(app.getPath('userData'), 'credentials', 'flow')
  const path = join(root, 'master-key.json')
  return runSerialized(`flow-secret-store-key:${path}`, async () => {
    let stored: string | undefined
    try {
      stored = await readRecoveredFile(path)
    } catch (error) {
      // Only a missing record permits creating a key. Read/access failures
      // must never rotate the key protecting existing Flow credentials.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (stored !== undefined) {
      const parsed = JSON.parse(stored) as { version?: number; encrypted?: string } | null
      if (parsed?.version !== 1 || typeof parsed.encrypted !== 'string' || !parsed.encrypted) {
        throw new Error('Invalid Flow secret-store key record')
      }
      let decrypted: string
      try {
        decrypted = await adapter.decryptString(Buffer.from(parsed.encrypted, 'base64'))
      } catch {
        // Keep the original record untouched. The runtime can start with its
        // unavailable secret store, and a later restart can retry access.
        return null
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(decrypted)) throw new Error('Invalid Flow secret-store key')
      return decrypted
    }
    const key = randomBytes(32).toString('base64url')
    let encrypted: string
    try {
      encrypted = (await adapter.encryptString(key)).toString('base64')
    } catch {
      return null
    }
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicWriteFile(path, `${JSON.stringify({ version: 1, encrypted })}\n`)
    return key
  })
}
