import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogSourceV1, MarketplacePackageV1 } from '../../shared/marketplace'
import { MarketplaceCatalogService } from './marketplace-catalog-service'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { materializeCatalogPackage } from './plugin-management-service'

const roots: string[] = []
const originalEnvironment = { ...process.env }

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key]
  }
  Object.assign(process.env, originalEnvironment)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-marketplace-integration-'))
  roots.push(root)
  return root
}

async function fakeTool(directory: string, name: string, source: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await symlink(process.execPath, join(directory, 'node')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const path = join(directory, name)
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`)
  await chmod(path, 0o755)
}

function officialPackage(id: string): MarketplacePackageV1 {
  const item = getOfficialMarketplaceCatalog().find((candidate) => candidate.id === id)
  if (!item) throw new Error(`Missing official marketplace fixture: ${id}`)
  return item
}

function catalogPackage(sourceId: string): MarketplacePackageV1 {
  const source = {
    id: 'fixture-source',
    catalogSourceId: sourceId,
    kind: 'local' as const,
    location: '/fixture'
  }
  return {
    schemaVersion: 1,
    id: 'fixture-package',
    name: 'Fixture package',
    summary: 'Generic Git catalog fixture.',
    tier: 'advanced',
    version: '1.0.0',
    publisher: { id: 'fixture', name: 'Fixture', verified: false },
    license: 'MIT',
    source,
    sources: [source],
    components: [],
    permissions: [],
    auth: { type: 'none' },
    licenseEvidence: [],
    dependencies: [],
    updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false },
    compatibility: {
      workwise: '>=0.3.5',
      platforms: ['darwin', 'win32', 'linux'],
      architectures: ['arm64', 'x64']
    },
    availability: { status: 'available' },
    installation: { mode: 'external', installedByDefault: false, reinstallable: false }
  }
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('marketplace command integration', () => {
  it('materializes an npm package through an env-based launcher on a minimal PATH', async () => {
    const root = await tempRoot()
    const tools = join(root, 'tools')
    const target = join(root, 'npm-package')
    const item = officialPackage('context7-mcp')
    if (item.source.kind !== 'npm') throw new Error('Expected an npm fixture.')
    process.env.PATH = tools
    process.env.WORKWISE_TEST_PACKAGE_NAME = item.source.packageName
    process.env.WORKWISE_TEST_INTEGRITY = item.source.digest.value
    await fakeTool(tools, 'npm', String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'view') {
  process.stdout.write(JSON.stringify(process.env.WORKWISE_TEST_INTEGRITY))
  process.exit(0)
}
if (args[0] === 'install') {
  const packageRoot = path.join(process.cwd(), 'node_modules', ...process.env.WORKWISE_TEST_PACKAGE_NAME.split('/'))
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: process.env.WORKWISE_TEST_PACKAGE_NAME }))
  fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'MIT fixture')
  process.exit(0)
}
throw new Error('Unexpected npm arguments: ' + args.join(' '))`)

    await materializeCatalogPackage(item, target)

    await expect(access(join(target, 'LICENSE'))).resolves.toBeUndefined()
    await expect(access(join(target, 'node_modules', ...item.source.packageName.split('/'), 'package.json')))
      .resolves.toBeUndefined()
  })

  it('materializes a pinned GitHub Skill through git on a minimal PATH', async () => {
    const root = await tempRoot()
    const tools = join(root, 'tools')
    const target = join(root, 'github-package')
    const item = officialPackage('antv-chart-skill')
    if (item.source.kind !== 'github' || !item.source.subpath) {
      throw new Error('Expected a GitHub subpath fixture.')
    }
    process.env.PATH = tools
    process.env.WORKWISE_TEST_COMMIT = item.source.resolvedRef
    process.env.WORKWISE_TEST_SUBPATH = item.source.subpath
    await fakeTool(tools, 'git', String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === 'clone') {
  const target = args[args.length - 1]
  const payload = path.join(target, ...process.env.WORKWISE_TEST_SUBPATH.split('/'))
  fs.mkdirSync(path.join(target, '.git'), { recursive: true })
  fs.mkdirSync(payload, { recursive: true })
  fs.writeFileSync(path.join(target, 'LICENSE'), 'MIT fixture')
  fs.writeFileSync(path.join(payload, 'SKILL.md'), '# Chart visualization fixture\n')
  process.exit(0)
}
if (args[0] === 'rev-parse') process.stdout.write(process.env.WORKWISE_TEST_COMMIT + '\n')
process.exit(0)`)

    await materializeCatalogPackage(item, target)

    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Chart visualization')
    expect(await readFile(join(target, 'LICENSE'), 'utf8')).toBe('MIT fixture')
    await expect(access(join(target, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('synchronizes a generic Git catalog through the default command runner', async () => {
    const root = await tempRoot()
    const tools = join(root, 'tools')
    const catalogPath = join(root, 'marketplace.json')
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const sourceId = 'generic-git-fixture'
    const source: CatalogSourceV1 = {
      schemaVersion: 1,
      id: sourceId,
      name: 'Generic Git fixture',
      type: 'git',
      scope: 'user',
      location: 'https://catalog.example.test/repository.git',
      defaultBranch: 'main',
      trust: 'unverified',
      searchable: true,
      auth: { type: 'none' },
      sync: {
        mode: 'manual',
        state: 'idle',
        mirroredByDefault: false,
        installedByDefault: false
      }
    }
    await writeFile(catalogPath, JSON.stringify({
      schemaVersion: 1,
      sourceId,
      revision: commit,
      packages: [catalogPackage(sourceId)]
    }))
    process.env.PATH = tools
    process.env.WORKWISE_TEST_CATALOG = catalogPath
    process.env.WORKWISE_TEST_COMMIT = commit
    await fakeTool(tools, 'git', String.raw`
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('rev-parse')) process.stdout.write(process.env.WORKWISE_TEST_COMMIT + '\n')
if (args.includes('show')) process.stdout.write(fs.readFileSync(process.env.WORKWISE_TEST_CATALOG, 'utf8'))
process.exit(0)`)

    const service = new MarketplaceCatalogService({ rootDirectory: join(root, 'state') })
    await service.upsertSource(source)
    const result = await service.syncSource(sourceId)

    expect(result.status).toBe('synced')
    expect(result.snapshot?.revision).toBe(commit)
    expect((await service.getSnapshot(sourceId))?.packages.map((item) => item.id))
      .toEqual(['fixture-package'])
  })
})

const describeWindows = process.platform === 'win32' ? describe : describe.skip

describeWindows('Windows marketplace npm installation', () => {
  async function windowsNpmFixture(matchesIntegrity = true) {
    const root = await tempRoot()
    const tools = join(root, '工具路径 with spaces')
    const npmBin = join(tools, 'node_modules', 'npm', 'bin')
    const target = join(root, '安装目录 with spaces')
    const cmdMarker = join(root, 'npm-cmd-started.txt')
    const invocationLog = join(root, 'npm-invocations.jsonl')
    const item = officialPackage('context7-mcp')
    if (item.source.kind !== 'npm') throw new Error('Expected an npm fixture.')
    const packageName = item.source.packageName
    const spec = `${packageName}@${item.source.version}`
    process.env.PATH = [tools, dirname(process.execPath)].join(delimiter)
    process.env.WORKWISE_TEST_PACKAGE_NAME = packageName
    process.env.WORKWISE_TEST_INTEGRITY = matchesIntegrity
      ? item.source.digest.value
      : `sha512-${Buffer.alloc(64).toString('base64')}`
    process.env.WORKWISE_TEST_NPM_CMD_MARKER = cmdMarker
    process.env.WORKWISE_TEST_NPM_INVOCATIONS = invocationLog

    await mkdir(npmBin, { recursive: true })
    await writeFile(join(tools, 'npm.cmd'), '@echo off\r\necho unexpected>"%WORKWISE_TEST_NPM_CMD_MARKER%"\r\nexit /b 27\r\n')
    await writeFile(join(npmBin, 'npm-cli.js'), String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const packageName = process.env.WORKWISE_TEST_PACKAGE_NAME
fs.appendFileSync(process.env.WORKWISE_TEST_NPM_INVOCATIONS, JSON.stringify({ args, cwd: process.cwd() }) + '\n')
if (args[0] === 'view') {
  process.stdout.write(JSON.stringify(process.env.WORKWISE_TEST_INTEGRITY))
} else if (args[0] === 'install') {
  const packageRoot = path.join(process.cwd(), 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }))
  fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'MIT fixture')
} else {
  throw new Error('Unexpected npm command: ' + args[0])
}
`)

    return {
      item, target, packageName, spec, cmdMarker,
      async readInvocations(): Promise<Array<{ args: string[]; cwd: string }>> {
        return (await readFile(invocationLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      }
    }
  }

  it('checks the pinned npm integrity and installs without launching the .cmd wrapper', async () => {
    const fixture = await windowsNpmFixture()

    await materializeCatalogPackage(fixture.item, fixture.target)

    expect(await fixture.readInvocations()).toEqual([
      { args: ['view', fixture.spec, 'dist.integrity', '--json'], cwd: expect.any(String) },
      {
        args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--package-lock=true', fixture.spec],
        cwd: fixture.target
      }
    ])
    expect(await readFile(join(fixture.target, 'LICENSE'), 'utf8')).toBe('MIT fixture')
    expect(JSON.parse(await readFile(join(fixture.target, 'node_modules', ...fixture.packageName.split('/'), 'package.json'), 'utf8')))
      .toEqual({ name: fixture.packageName })
    await expect(access(fixture.cmdMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops before installation when the Windows npm integrity mismatches', async () => {
    const fixture = await windowsNpmFixture(false)

    await expect(materializeCatalogPackage(fixture.item, fixture.target))
      .rejects.toThrow('npm registry integrity does not match the trusted catalog snapshot.')

    expect(await fixture.readInvocations()).toEqual([
      { args: ['view', fixture.spec, 'dist.integrity', '--json'], cwd: expect.any(String) }
    ])
    await expect(access(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(fixture.cmdMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
