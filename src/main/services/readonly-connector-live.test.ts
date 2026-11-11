import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { ManagedUvRuntimeService } from './managed-uv-runtime-service'
import { materializePypiPackage } from './pypi-package-materializer'

// Explicit package-download acceptance. Uses an isolated root and no account.
describe('upstream Zotero installation acceptance', () => {
  it.runIf(process.env.RAILWISE_ZOTERO_INSTALL_ACCEPTANCE === '1')('materializes the exact upstream wheel and a hash-locked core dependency environment', async () => {
    const root = process.env.RAILWISE_CONNECTOR_ACCEPTANCE_ROOT
    if (!root) throw new Error('An isolated acceptance root is required.')
    await mkdir(root, { recursive: true })
    const item = getOfficialMarketplaceCatalog().find(item => item.id === 'zotero-mcp')!
    const target = join(root, 'zotero-0.17.0')
    await materializePypiPackage(item, target, { runtime: new ManagedUvRuntimeService({ rootDirectory: join(root, 'uv-runtime') }) })
    const manifest = JSON.parse(await readFile(join(target, 'workwise-python-runtime.json'), 'utf8'))
    const lock = await readFile(join(target, 'requirements.lock'), 'utf8')
    expect(manifest.packageVersion).toBe('0.17.0')
    expect(manifest.entrypoints).toContain('zotero-mcp')
    expect(lock).not.toMatch(/^(?:chromadb|sentence-transformers|pymupdf|torch)==/m)
    await writeFile(join(root, 'zotero-install-evidence.json'), JSON.stringify({ package: manifest.packageName, version: manifest.packageVersion, wheel: manifest.wheel, lockSha256: manifest.lockSha256, coreOnly: true, accountAccess: false }, null, 2))
  }, 15 * 60_000)
})
