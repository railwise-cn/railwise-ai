import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { materializeCatalogPackage, PluginManagementService } from './plugin-management-service'
import { PackageInstallationService } from './package-installation-service'
import { discoverInstalledPluginSkillRoots } from './skill-service'
import { managedDependency } from './managed-dependency-download'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const item = () => structuredClone(getOfficialMarketplaceCatalog().find(value => value.id === 'browser-skill')!)
describe('fixed BrowserSkill source archive', () => {
  it('uses the company immutable source first and rejects wrong bytes before materialization without git fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-source-rejected-')); roots.push(root)
    const fetcher = vi.fn(async (_input: string | URL | Request) => new Response('wrong archive'))
    vi.stubGlobal('fetch', fetcher)
    await expect(materializeCatalogPackage(item(), join(root, 'prepared'))).rejects.toThrow(/size|SHA-256/)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(managedDependency('browser-skill-source').sha256)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(access(join(root, 'prepared', 'SKILL.md'))).rejects.toThrow()
  })
  it.runIf(process.env.RAILWISE_BROWSER_SOURCE_ACCEPTANCE === '1')('cold installs all fixed upstream Skill references through production prepare and commit', async () => {
    const root = await mkdtemp(join(process.env.RAILWISE_BROWSER_ACCEPTANCE_ROOT || tmpdir(), 'browser-source-live-'))
    const bytes = await readFile(process.env.RAILWISE_BROWSER_SOURCE_ARCHIVE!)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
    const service = new PluginManagementService({ rootDirectory: join(root, 'imports'), installationService: new PackageInstallationService({ rootDirectory: join(root, 'installed') }) })
    const prepared = await service.prepareCatalogPackage(item())
    const installed = await service.installPrepared({ preparedId: prepared.id, reviewSha256: prepared.reviewSha256, expectedCurrentVersion: null, scope: 'user', permissions: [], idempotencyKey: 'browser-source-live' })
    const content = await readFile(join(installed.artifact.location, 'SKILL.md'), 'utf8')
    expect(content).toContain('browser-skill')
    for (const match of content.matchAll(/\]\((references\/[^)]+)\)/g)) await expect(access(join(installed.artifact.location, match[1]))).resolves.toBeUndefined()
    await expect(readFile(join(installed.artifact.location, 'LICENSE'), 'utf8')).resolves.toContain('MIT License')
    expect(await discoverInstalledPluginSkillRoots([installed])).toEqual([installed.artifact.location])
  }, 60000)
})
