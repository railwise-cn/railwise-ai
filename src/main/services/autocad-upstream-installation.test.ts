import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOCAD_UPSTREAM, isApprovedAutocadUpstreamSkill, isCatalogInstallable } from '../../shared/engineering-marketplace'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { PackageInstallationService } from './package-installation-service'
import { materializeCatalogPackage, PluginManagementService } from './plugin-management-service'
import { discoverInstalledPluginSkillRoots } from './skill-service'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function packageById(id: string): MarketplacePackageV1 {
  return structuredClone(getOfficialMarketplaceCatalog().find(item => item.id === id)!)
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'railwise-autocad-upstream-'))
  roots.push(root)
  return root
}

describe('fixed upstream AutoCAD Skill installation', () => {
  it.each(AUTOCAD_UPSTREAM.ids)('allows only the reviewed source and Skill component for %s', id => {
    const item = packageById(id)
    expect(isApprovedAutocadUpstreamSkill(item)).toBe(true)
    const mutations: Array<(candidate: MarketplacePackageV1) => void> = [
      candidate => { candidate.id = 'unreviewed-skill' },
      candidate => { candidate.version = 'latest' },
      candidate => { candidate.license = 'MIT' },
      candidate => { candidate.installation = { mode: 'direct-mirror', installedByDefault: false, reinstallable: true } },
      candidate => { candidate.source.location = 'https://example.test/source' },
      candidate => { if (candidate.source.kind === 'github') candidate.source.owner = 'other-publisher' },
      candidate => { if (candidate.source.kind === 'github') candidate.source.resolvedRef = '0'.repeat(40) },
      candidate => { if (candidate.source.kind === 'github') candidate.source.subpath = '../scripts' },
      candidate => { if (candidate.source.kind === 'github') candidate.source.digest = { algorithm: 'sha256', value: '0'.repeat(64) } },
      candidate => { candidate.sources[0]!.location = 'https://example.test/secondary' },
      candidate => { candidate.components[0]!.type = 'mcp' },
      candidate => { candidate.components[0]!.runtime = { kind: 'bundled', entrypoint: 'scripts/run.py' } }
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(item)
      mutate(changed)
      expect(isApprovedAutocadUpstreamSkill(changed)).toBe(false)
    }
    expect(isCatalogInstallable({ ...item, id: 'other-unknown-license' })).toBe(false)
  })

  it('rejects an altered upstream archive before extraction and performs no git fallback', async () => {
    const root = await temporaryRoot()
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response('altered archive', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(materializeCatalogPackage(packageById('autocad-image-redraw'), join(root, 'prepared')))
      .rejects.toThrow(/SHA-256 does not match/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://codeload.github.com/${AUTOCAD_UPSTREAM.owner}/${AUTOCAD_UPSTREAM.repository}/zip/${AUTOCAD_UPSTREAM.commit}`)
    await expect(access(join(root, 'prepared'))).rejects.toThrow()
  })

  it.each(AUTOCAD_UPSTREAM.ids)('installs %s through review with unknown license and denied execution', async id => {
    const root = await temporaryRoot()
    const item = packageById(id)
    const service = new PluginManagementService({
      rootDirectory: join(root, 'imports'),
      installationService: new PackageInstallationService({ rootDirectory: join(root, 'installed') }),
      catalogMaterializer: async (_item, target) => {
        await mkdir(join(target, 'scripts'), { recursive: true })
        await writeFile(join(target, 'SKILL.md'), `---\nname: ${id}\ndescription: Test Skill\n---\nUse scripts/example.py.\n`)
        await writeFile(join(target, 'scripts/example.py'), 'raise RuntimeError("must never execute during installation")\n')
      }
    })
    const prepared = await service.prepareCatalogPackage(item)
    expect(prepared.package.license).toBeNull()
    expect(prepared.warnings.join(' ')).toContain('运行 Python/CAD 脚本需要相应依赖和任务权限')
    expect(prepared.compatibility.workwiseCompatible).toBe(true)
    const request = {
      preparedId: prepared.id, reviewSha256: prepared.reviewSha256, expectedCurrentVersion: null,
      scope: 'user' as const, idempotencyKey: `install-${id}`,
      permissions: item.permissions.map(permission => ({ permissionId: permission.id, decision: 'denied' as const }))
    }
    await expect(service.installPrepared({ ...request, reviewSha256: '0'.repeat(64) })).rejects.toThrow(/review changed/)
    const installed = await service.installPrepared(request)
    await expect(readFile(join(installed.artifact.location, 'scripts/example.py'), 'utf8')).resolves.toContain('must never execute')
    await expect(access(join(installed.artifact.location, 'LICENSE'))).rejects.toThrow()
    expect(installed.permissions.every(permission => permission.decision === 'denied')).toBe(true)
    expect(JSON.parse(await readFile(join(installed.artifact.location, 'workwise.catalog.json'), 'utf8')).license).toBeNull()
    await expect(discoverInstalledPluginSkillRoots([installed])).resolves.toEqual([installed.artifact.location])
    await expect(service.diagnoseUpdates([item])).resolves.toMatchObject([{ packageId: id, state: 'current' }])
  })
})

describe('upstream AutoCAD Skill live acceptance', () => {
  it.runIf(process.env.RAILWISE_AUTOCAD_INSTALL_ACCEPTANCE === '1')('cold installs both exact Skills without executing any bundled script', async () => {
    const root = process.env.RAILWISE_CONNECTOR_ACCEPTANCE_ROOT
    if (!root) throw new Error('An isolated acceptance root is required.')
    await mkdir(root, { recursive: true })
    const service = new PluginManagementService({
      rootDirectory: join(root, 'imports'),
      installationService: new PackageInstallationService({ rootDirectory: join(root, 'installed') })
    })
    const evidence: unknown[] = []
    for (const id of AUTOCAD_UPSTREAM.ids) {
      const item = packageById(id)
      const prepared = await service.prepareCatalogPackage(item)
      const installed = await service.installPrepared({
        preparedId: prepared.id, reviewSha256: prepared.reviewSha256, expectedCurrentVersion: null,
        scope: 'user', idempotencyKey: `live-${id}`,
        permissions: item.permissions.map(permission => ({ permissionId: permission.id, decision: 'denied' }))
      })
      const skill = await readFile(join(installed.artifact.location, 'SKILL.md'), 'utf8')
      const paths = [...new Set([...skill.matchAll(/(?:scripts|references)[/\\]([a-zA-Z0-9_.-]+)/g)]
        .map(match => match[0].replaceAll('\\', '/')))]
      for (const path of paths) await access(join(installed.artifact.location, path))
      await expect(discoverInstalledPluginSkillRoots([installed])).resolves.toEqual([installed.artifact.location])
      expect(paths.length).toBeGreaterThan(0)
      evidence.push({ packageId: id, commit: item.version, archiveSha256: AUTOCAD_UPSTREAM.sha256,
        contentSha256: installed.artifact.sha256, reviewSha256: installed.reviewSha256,
        location: installed.artifact.location, referencedFiles: paths, license: null,
        permissions: installed.permissions, executedScripts: 0, companyMirrorUsed: false })
    }
    await writeFile(join(root, 'autocad-install-evidence.json'), JSON.stringify(evidence, null, 2))
  }, 5 * 60_000)
})
