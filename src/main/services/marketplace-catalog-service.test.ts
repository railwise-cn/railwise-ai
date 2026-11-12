import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CatalogSnapshotV1,
  CatalogSourceV1,
  MarketplacePackageV1
} from '../../shared/marketplace'
import {
  getMarketplaceCatalogSources,
  getOfficialMarketplaceCatalog
} from './official-marketplace-catalog'
import { MarketplaceCatalogService } from './marketplace-catalog-service'
import { CatalogCredentialService } from './catalog-credential-service'

const roots: string[] = []
const MAX_JSON_BYTES = 10 * 1024 * 1024
const NOW = '2026-08-08T08:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function tempRoot(prefix = 'workwise-marketplace-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function localSource(
  id: string,
  location: string,
  type: 'local' | 'project' = 'local'
): CatalogSourceV1 {
  return {
    schemaVersion: 1,
    id,
    name: `${id} catalog`,
    type,
    scope: type === 'project' ? 'workspace' : 'user',
    location,
    trust: 'unverified',
    searchable: true,
    auth: { type: 'none' },
    sync: {
      mode: 'manual',
      state: 'idle',
      mirroredByDefault: false,
      installedByDefault: false
    }
  } as CatalogSourceV1
}

function httpsSource(id: string, location = `https://${id}.catalog.test/v1.json`): Extract<CatalogSourceV1, { type: 'https' }> {
  return {
    schemaVersion: 1,
    id,
    name: `${id} catalog`,
    type: 'https',
    scope: 'team',
    location,
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
}

function catalogPackage(sourceId: string, id = 'example-package'): MarketplacePackageV1 {
  const source = {
    id: `${id}-source`,
    catalogSourceId: sourceId,
    kind: 'local' as const,
    location: `/catalog/${id}`
  }
  return {
    schemaVersion: 1,
    id,
    name: id,
    summary: `${id} summary`,
    tier: 'advanced',
    version: '1.0.0',
    publisher: { id: 'test-publisher', name: 'Test Publisher', verified: false },
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

function snapshot(
  sourceId: string,
  revision = 'revision-1',
  packages: MarketplacePackageV1[] = [catalogPackage(sourceId)]
): CatalogSnapshotV1 {
  return { schemaVersion: 1, sourceId, revision, packages }
}

async function writeSnapshot(path: string, value: CatalogSnapshotV1): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

function jsonResponse(value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) }
  })
}

describe('MarketplaceCatalogService', () => {
  it('seeds official source definitions and the built-in trusted snapshot once', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })

    const sources = await service.listSources()
    const builtIn = await service.getSnapshot('workwise-official')
    const merged = await service.listPackages()

    expect(sources.map((source) => source.id)).toEqual(
      getMarketplaceCatalogSources().map((source) => source.id)
    )
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length)
    expect(builtIn?.packages).toEqual(getOfficialMarketplaceCatalog())
    expect(merged.packages[0]?.sourceId).toBe('workwise-official')
    expect(merged.packages.map((entry) => entry.package)).toEqual(getOfficialMarketplaceCatalog())
  })

  it('persists configured sources and trusted snapshots across service instances', async () => {
    const rootDirectory = await tempRoot()
    const catalogPath = join(rootDirectory, 'team.json')
    await writeSnapshot(catalogPath, snapshot('team-local'))
    const first = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await first.upsertSource(localSource('team-local', catalogPath))
    await expect(first.syncSource('team-local')).resolves.toMatchObject({ status: 'synced' })

    const second = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })

    expect((await second.listSources()).filter((source) => source.id === 'team-local')).toHaveLength(1)
    expect(await second.getSnapshot('team-local')).toEqual(snapshot('team-local'))
  })

  it('resolves project catalog paths from the configured workspace root', async () => {
    const rootDirectory = await tempRoot()
    const workspaceRoot = await tempRoot('workwise-project-')
    const catalogPath = join(workspaceRoot, 'catalog.json')
    await writeSnapshot(catalogPath, snapshot('project-catalog'))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      workspaceRoot,
      now: () => new Date(NOW)
    })
    await service.upsertSource(localSource('project-catalog', 'catalog.json', 'project'))

    const result = await service.syncSource('project-catalog')

    expect(result).toMatchObject({ status: 'synced', stale: false })
    expect(result.snapshot?.revision).toBe('revision-1')
  })

  it('resolves project catalog paths from the current workspace provider', async () => {
    const rootDirectory = await tempRoot()
    const workspaceRoot = await tempRoot('workwise-project-provider-')
    await writeSnapshot(join(workspaceRoot, 'catalog.json'), snapshot('project-provider'))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      resolveWorkspaceRoot: async () => workspaceRoot,
      now: () => new Date(NOW)
    })
    await service.upsertSource(localSource('project-provider', 'catalog.json', 'project'))

    await expect(service.syncSource('project-provider')).resolves.toMatchObject({
      status: 'synced',
      snapshot: { sourceId: 'project-provider' }
    })
  })

  it('sends the saved ETag and keeps the snapshot unchanged for HTTP 304', async () => {
    const rootDirectory = await tempRoot()
    let currentTime = NOW
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse(snapshot('remote'), {
          etag: '"remote-r1"',
          'last-modified': 'Sat, 08 Aug 2026 08:00:00 GMT',
          'x-workwise-catalog-commit': 'a'.repeat(40)
        })
      }
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"remote-r1"')
      return new Response(null, { status: 304 })
    })
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(currentTime)
    })
    await service.upsertSource(httpsSource('remote'))
    await service.syncSource('remote')
    currentTime = '2026-08-08T09:00:00.000Z'

    const result = await service.syncSource('remote')
    const source = (await service.listSources()).find((entry) => entry.id === 'remote')

    expect(result).toMatchObject({ status: 'unchanged', stale: false })
    expect(result.snapshot?.revision).toBe('revision-1')
    expect(source?.sync).toMatchObject({
      state: 'synced',
      lastSyncedAt: currentTime,
      etag: '"remote-r1"',
      lastModified: 'Sat, 08 Aug 2026 08:00:00 GMT',
      commit: 'a'.repeat(40)
    })
  })

  it.each(['credential_helper_timeout', 'credential_helper_access_denied'])('isolates %s to its protected source while retaining bundled and cached catalogs', async (code) => {
    const rootDirectory = await tempRoot()
    let denied = false
    const credentials = new CatalogCredentialService({ root: join(rootDirectory, 'credentials'), encryption: {
      available: () => true, encrypt: async value => Buffer.from(value), storage: 'keychain',
      decrypt: async value => {
        if (denied) throw Object.assign(new Error('synthetic protected-storage failure'), { code })
        return value.toString()
      }
    } })
    await credentials.set('catalog.protected.token', 'synthetic-token')
    const fetch = vi.fn(async () => jsonResponse(snapshot('protected-cache')))
    const options = { rootDirectory, fetch, resolveSecret: async (key: string) => (await credentials.resolve(key)) ?? null }
    const service = new MarketplaceCatalogService(options)
    await service.upsertSource({ ...httpsSource('protected-cache'), auth: { type: 'token', secretKey: 'catalog.protected.token' } })
    expect(await service.syncSource('protected-cache')).toMatchObject({ status: 'synced' })
    const before = await service.listPackages()
    expect(before.packages.some(entry => entry.sourceId === 'workwise-official')).toBe(true)
    denied = true
    expect(await service.syncSource('protected-cache')).toMatchObject({ sourceId: 'protected-cache', status: 'failed', stale: true, error: expect.stringContaining('原凭据仍保留'), snapshot: { sourceId: 'protected-cache' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await service.listPackages()).toEqual(before)
    const reopened = new MarketplaceCatalogService(options)
    expect(await reopened.listPackages()).toEqual(before)
    const sources = await reopened.listSources()
    expect(sources.find(source => source.id === 'protected-cache')?.sync.state).toBe('error')
    expect(sources.find(source => source.id === 'workwise-official')?.sync.state).not.toBe('error')
    denied = false
    expect(await reopened.syncSource('protected-cache')).toMatchObject({ status: 'synced' })
    expect(await credentials.resolve('catalog.protected.token')).toBe('synthetic-token')
  })

  it('returns an explicit stale offline result while retaining a trusted HTTPS cache', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('remote-cache'), { etag: '"cached"' }))
      .mockRejectedValueOnce(new Error('network unavailable')) as unknown as typeof fetch
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('remote-cache'))
    await service.syncSource('remote-cache')

    const result = await service.syncSource('remote-cache')
    const listed = await service.listPackages()

    expect(result).toMatchObject({ status: 'offline', stale: true, error: 'network unavailable' })
    expect(result.snapshot?.revision).toBe('revision-1')
    expect(listed.packages.some((entry) => entry.sourceId === 'remote-cache')).toBe(true)
    expect((await service.listSources()).find((source) => source.id === 'remote-cache')?.sync)
      .toMatchObject({ state: 'error', error: 'network unavailable', etag: '"cached"' })
  })

  it('rejects malformed and oversized local files without trusting a snapshot', async () => {
    const rootDirectory = await tempRoot()
    const malformedPath = join(rootDirectory, 'malformed.json')
    const oversizedPath = join(rootDirectory, 'oversized.json')
    await writeFile(malformedPath, '{not json')
    await writeFile(oversizedPath, Buffer.alloc(MAX_JSON_BYTES + 1, 0x20))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('malformed', malformedPath))
    await service.upsertSource(localSource('oversized', oversizedPath))

    const malformed = await service.syncSource('malformed')
    const oversized = await service.syncSource('oversized')

    expect(malformed).toMatchObject({ status: 'failed', stale: false })
    expect(malformed.error).toMatch(/JSON/i)
    expect(oversized).toMatchObject({ status: 'failed', stale: false })
    expect(oversized.error).toMatch(/10 MiB/i)
    await expect(service.getSnapshot('malformed')).resolves.toBeNull()
    await expect(service.getSnapshot('oversized')).resolves.toBeNull()
  })

  it('rejects symlinks and directories as local catalog files', async () => {
    const rootDirectory = await tempRoot()
    const targetPath = join(rootDirectory, 'target.json')
    const symlinkPath = join(rootDirectory, 'link.json')
    await writeSnapshot(targetPath, snapshot('symlinked'))
    await symlink(targetPath, symlinkPath)
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('symlinked', symlinkPath))
    await service.upsertSource(localSource('directory', rootDirectory))

    await expect(service.syncSource('symlinked')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/symbolic link/i)
    })
    await expect(service.syncSource('directory')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/regular file/i)
    })
  })

  it('rejects snapshot and package provenance mismatches and duplicate package IDs', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const cases: Array<[string, CatalogSnapshotV1, RegExp]> = [
      ['wrong-envelope', snapshot('another-source'), /sourceId/i],
      ['wrong-primary', snapshot('wrong-primary', 'r1', [catalogPackage('another-source')]), /catalogSourceId/i],
      ['wrong-additional', (() => {
        const item = catalogPackage('wrong-additional')
        item.sources.push({ ...item.source, id: 'other', catalogSourceId: 'another-source' })
        return snapshot('wrong-additional', 'r1', [item])
      })(), /catalogSourceId/i],
      ['duplicate-packages', snapshot('duplicate-packages', 'r1', [
        catalogPackage('duplicate-packages', 'same-id'),
        catalogPackage('duplicate-packages', 'same-id')
      ]), /duplicate package ID/i]
    ]

    for (const [id, value, error] of cases) {
      const path = join(rootDirectory, `${id}.json`)
      await writeSnapshot(path, value)
      await service.upsertSource(localSource(id, path))
      const result = await service.syncSource(id)
      expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(error) })
      await expect(service.getSnapshot(id)).resolves.toBeNull()
    }
  })

  it('rejects snapshots with more than 5,000 packages', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'too-many.json')
    const packages = Array.from({ length: 5_001 }, (_, index) =>
      catalogPackage('too-many', `package-${index}`)
    )
    await writeSnapshot(path, snapshot('too-many', 'r1', packages))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('too-many', path))

    const result = await service.syncSource('too-many')

    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/5,000 packages/i) })
  })

  it('serializes concurrent syncs for the same source', async () => {
    const rootDirectory = await tempRoot()
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    const fetchMock = vi.fn(async () => {
      const call = fetchMock.mock.calls.length
      if (call === 1) await firstCanFinish
      return jsonResponse(snapshot('serialized', `revision-${call}`))
    })
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('serialized'))

    const first = service.syncSource('serialized')
    const second = service.syncSource('serialized')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFirst()
    const results = await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results.map((result) => result.snapshot?.revision)).toEqual(['revision-1', 'revision-2'])
    expect((await service.getSnapshot('serialized'))?.revision).toBe('revision-2')
  })

  it('removes user sources, packages, and cache but refuses built-in removal', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'removable.json')
    await writeSnapshot(path, snapshot('removable'))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('removable', path))
    await service.syncSource('removable')

    await service.removeSource('removable')

    expect((await service.listSources()).some((source) => source.id === 'removable')).toBe(false)
    await expect(service.getSnapshot('removable')).resolves.toBeNull()
    expect((await service.listPackages()).packages.some((entry) => entry.sourceId === 'removable')).toBe(false)
    await expect(service.removeSource('workwise-official')).rejects.toThrow(/system|built-in/i)
  })

  it('returns deep clones from every public read and sync method', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'clone.json')
    await writeSnapshot(path, snapshot('clone-source'))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('clone-source', path))
    const syncResult = await service.syncSource('clone-source')
    const sources = await service.listSources()
    const cached = await service.getSnapshot('clone-source')
    const merged = await service.listPackages()

    sources.find((source) => source.id === 'clone-source')!.name = 'mutated source'
    syncResult.snapshot!.packages[0]!.name = 'mutated sync result'
    cached!.packages[0]!.name = 'mutated snapshot'
    merged.packages.find((entry) => entry.sourceId === 'clone-source')!.package.name = 'mutated merged'

    expect((await service.listSources()).find((source) => source.id === 'clone-source')?.name)
      .toBe('clone-source catalog')
    expect((await service.getSnapshot('clone-source'))?.packages[0]?.name).toBe('example-package')
    expect((await service.listPackages()).packages.find((entry) => entry.sourceId === 'clone-source')?.package.name)
      .toBe('example-package')
  })

  it('reports deterministic namespaced conflicts without overwriting packages', async () => {
    const rootDirectory = await tempRoot()
    const firstPath = join(rootDirectory, 'first.json')
    const secondPath = join(rootDirectory, 'second.json')
    await writeSnapshot(firstPath, snapshot('first', 'r1', [catalogPackage('first', 'duplicate')]))
    await writeSnapshot(secondPath, snapshot('second', 'r1', [catalogPackage('second', 'duplicate')]))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('first', firstPath))
    await service.upsertSource(localSource('second', secondPath))
    await service.syncSource('first')
    await service.syncSource('second')

    const result = await service.listPackages()
    const duplicates = result.packages.filter((entry) => entry.package.id === 'duplicate')

    expect(result.packages[0]?.sourceId).toBe('workwise-official')
    expect(duplicates.map((entry) => entry.sourceId)).toEqual(['first', 'second'])
    expect(duplicates.map((entry) => entry.key)).toEqual(['first:duplicate', 'second:duplicate'])
    expect(duplicates.every((entry) => entry.conflicted)).toBe(true)
    expect(result.conflicts).toContainEqual({
      packageId: 'duplicate',
      sourceIds: ['first', 'second'],
      keys: ['first:duplicate', 'second:duplicate']
    })
  })

  it('never replaces a good snapshot with malformed HTTPS data', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('guarded', 'trusted-r1'), { etag: '"trusted"' }))
      .mockResolvedValueOnce(jsonResponse(snapshot('wrong-source', 'untrusted-r2'), { etag: '"bad"' })) as unknown as typeof fetch
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('guarded'))
    await service.syncSource('guarded')

    const result = await service.syncSource('guarded')

    expect(result).toMatchObject({ status: 'failed', stale: true })
    expect(result.snapshot?.revision).toBe('trusted-r1')
    expect((await service.getSnapshot('guarded'))?.revision).toBe('trusted-r1')
    expect((await service.listSources()).find((source) => source.id === 'guarded')?.sync)
      .toMatchObject({ state: 'error', etag: '"trusted"' })
  })

  it('enforces HTTPS URLs and rejects URL credentials, with opt-in loopback HTTP', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })

    await expect(service.upsertSource(httpsSource('credentials', 'https://user:password@example.test/catalog.json')))
      .rejects.toThrow(/credentials/i)
    await expect(service.upsertSource(httpsSource('insecure', 'http://example.test/catalog.json')))
      .rejects.toThrow(/HTTPS/i)

    const loopback = new MarketplaceCatalogService({
      rootDirectory: await tempRoot(),
      allowLoopbackHttp: true,
      fetch: (async () => jsonResponse(snapshot('loopback'))) as typeof fetch,
      now: () => new Date(NOW)
    })
    await loopback.upsertSource(httpsSource('loopback', 'http://127.0.0.1:8787/catalog.json'))
    await expect(loopback.syncSource('loopback')).resolves.toMatchObject({ status: 'synced' })
  })

  it('persists token references but strips supplied plaintext secrets', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const source = httpsSource('secret-safe') as CatalogSourceV1 & {
      auth: { type: 'token'; secretKey: string; token: string }
    }
    source.auth = {
      type: 'token',
      secretKey: 'marketplace.secret-safe.token',
      token: 'plaintext-super-secret'
    }

    await service.upsertSource(source)

    const persisted = await readFile(join(rootDirectory, 'sources.json'), 'utf8')
    expect(persisted).toContain('marketplace.secret-safe.token')
    expect(persisted).not.toContain('plaintext-super-secret')
    expect((await service.listSources()).find((entry) => entry.id === 'secret-safe')?.auth)
      .toEqual({ type: 'token', secretKey: 'marketplace.secret-safe.token' })
  })

  it('rejects packages missing required runtime schema fields', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'invalid-package.json')
    const invalid = catalogPackage('invalid-package') as unknown as Record<string, unknown>
    delete invalid.name
    await writeSnapshot(
      path,
      snapshot('invalid-package', 'r1', [invalid as unknown as MarketplacePackageV1])
    )
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('invalid-package', path))

    await expect(service.syncSource('invalid-package')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/name/i)
    })
    await expect(service.getSnapshot('invalid-package')).resolves.toBeNull()
  })

  it('validates bundled runtimes, disabled hooks, signatures, and configuration fields', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'plugin-fields.json')
    const item = catalogPackage('plugin-fields')
    item.components = [{
      id: 'example-skill',
      name: 'Example Skill',
      type: 'skill',
      sourceId: item.source.id,
      runtime: { kind: 'bundled', entrypoint: 'skills/example' },
      skillNames: ['example']
    }]
    item.permissions = [{
      id: 'hook-process',
      kind: 'process',
      access: 'execute',
      default: 'review',
      reviewRequired: true,
      description: 'Run an explicitly reviewed hook.'
    }]
    item.hooks = [{
      id: 'post-tool-use',
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      command: './scripts/check.sh',
      enabledByDefault: false,
      execution: 'disabled-pending-review',
      permissionIds: ['hook-process']
    }]
    item.signature = { status: 'unsigned' }
    item.configuration = [{
      key: 'ROOT',
      type: 'directory',
      title: 'Root directory',
      required: true,
      sensitive: false,
      multiple: false,
      defaultValue: '/tmp/example'
    }]
    await writeSnapshot(path, snapshot('plugin-fields', 'r1', [item]))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('plugin-fields', path))

    await expect(service.syncSource('plugin-fields')).resolves.toMatchObject({ status: 'synced' })

    const unsafe = structuredClone(item)
    unsafe.components[0]!.runtime = { kind: 'bundled', entrypoint: '../outside' }
    unsafe.hooks![0]!.enabledByDefault = true as false
    await writeSnapshot(path, snapshot('plugin-fields', 'r2', [unsafe]))
    await expect(service.syncSource('plugin-fields')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/path traversal|disabled/i),
      stale: true
    })

    const selfVerifiedPublisher = structuredClone(item)
    selfVerifiedPublisher.publisher.verified = true
    await writeSnapshot(path, snapshot('plugin-fields', 'r3', [selfVerifiedPublisher]))
    await expect(service.syncSource('plugin-fields')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/cannot claim verified/i),
      stale: true
    })

    const selfVerifiedArtifact = structuredClone(item)
    selfVerifiedArtifact.signature = {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: 'self-reported-key'
    }
    await writeSnapshot(path, snapshot('plugin-fields', 'r4', [selfVerifiedArtifact]))
    await expect(service.syncSource('plugin-fields')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/verified after download/i),
      stale: true
    })
  })

  it('rejects project paths that escape through an intermediate symbolic link', async () => {
    if (process.platform === 'win32') return
    const rootDirectory = await tempRoot()
    const workspaceRoot = await tempRoot('workwise-project-root-')
    const outsideRoot = await tempRoot('workwise-project-outside-')
    await mkdir(join(workspaceRoot, 'catalogs'))
    await writeSnapshot(join(outsideRoot, 'catalog.json'), snapshot('linked-project'))
    await symlink(outsideRoot, join(workspaceRoot, 'catalogs', 'linked'), 'dir')
    const service = new MarketplaceCatalogService({
      rootDirectory,
      workspaceRoot,
      now: () => new Date(NOW)
    })
    await service.upsertSource(
      localSource('linked-project', 'catalogs/linked/catalog.json', 'project')
    )

    await expect(service.syncSource('linked-project')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/workspace|escape/i)
    })
  })

  it('rejects a project catalog whose directory is swapped after realpath resolution', async () => {
    if (process.platform === 'win32') return
    const rootDirectory = await tempRoot()
    const workspaceRoot = await tempRoot('workwise-project-swap-')
    const outsideRoot = await tempRoot('workwise-project-replacement-')
    const catalogs = join(workspaceRoot, 'catalogs')
    const live = join(catalogs, 'live')
    const saved = join(catalogs, 'saved')
    const replacement = join(outsideRoot, 'replacement')
    await mkdir(live, { recursive: true })
    await mkdir(replacement, { recursive: true })
    await writeSnapshot(join(live, 'catalog.json'), snapshot('path-swap', 'trusted-r1'))
    await writeSnapshot(join(replacement, 'catalog.json'), snapshot('path-swap', 'substituted-r2'))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      workspaceRoot,
      now: () => new Date(NOW),
      fileSourceReadHook: async (phase) => {
        if (phase === 'resolved') {
          await rename(live, saved)
          await rename(replacement, live)
        } else {
          await rename(live, replacement)
          await rename(saved, live)
        }
      }
    })
    await service.upsertSource(localSource('path-swap', 'catalogs/live/catalog.json', 'project'))

    await expect(service.syncSource('path-swap')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/changed|safe/i)
    })
    await expect(service.getSnapshot('path-swap')).resolves.toBeNull()
  })

  it('stops reading an unbounded chunked HTTPS response at 10 MiB', async () => {
    const rootDirectory = await tempRoot()
    let cancelled = false
    const fetchMock = vi.fn(async () => {
      let emitted = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          emitted += 1
          controller.enqueue(new Uint8Array(1024 * 1024))
          if (emitted === 12) controller.close()
        },
        cancel() {
          cancelled = true
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('bounded'))

    await expect(service.syncSource('bounded')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/10 MiB/i)
    })
    expect(cancelled).toBe(true)
  })

  it('validates and deduplicates persisted sources while protecting reserved defaults', async () => {
    const duplicateRoot = await tempRoot()
    const duplicate = localSource('duplicate-source', join(duplicateRoot, 'catalog.json'))
    await writeFile(join(duplicateRoot, 'sources.json'), JSON.stringify({
      schema: 'workwise.marketplace-sources',
      version: 1,
      sources: [duplicate, duplicate]
    }))
    await expect(new MarketplaceCatalogService({ rootDirectory: duplicateRoot }).listSources())
      .rejects.toThrow(/duplicate/i)

    const insecureRoot = await tempRoot()
    await writeFile(join(insecureRoot, 'sources.json'), JSON.stringify({
      schema: 'workwise.marketplace-sources',
      version: 1,
      sources: [httpsSource('persisted-http', 'http://example.test/catalog.json')]
    }))
    await expect(new MarketplaceCatalogService({ rootDirectory: insecureRoot }).listSources())
      .rejects.toThrow(/HTTPS/i)

    const reservedRoot = await tempRoot()
    await writeFile(join(reservedRoot, 'sources.json'), JSON.stringify({
      schema: 'workwise.marketplace-sources',
      version: 1,
      sources: [localSource('workwise-official', join(reservedRoot, 'shadow.json'))]
    }))
    const reserved = await new MarketplaceCatalogService({ rootDirectory: reservedRoot }).listSources()
    expect(reserved.find((source) => source.id === 'workwise-official')).toMatchObject({
      type: 'built-in',
      scope: 'system'
    })
  })

  it('clears obsolete validators after a successful unversioned HTTPS refresh', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('validator-reset', 'r1'), {
        etag: '"r1"',
        'last-modified': 'Sat, 08 Aug 2026 08:00:00 GMT',
        'x-workwise-catalog-commit': 'a'.repeat(40)
      }))
      .mockResolvedValueOnce(jsonResponse(snapshot('validator-reset', 'r2')))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('validator-reset'))
    await service.syncSource('validator-reset')
    await service.syncSource('validator-reset')

    const source = (await service.listSources()).find((entry) => entry.id === 'validator-reset')
    expect(source?.sync.etag).toBeUndefined()
    expect(source?.sync.lastModified).toBeUndefined()
    expect(source?.sync.commit).toBeUndefined()
  })

  it('rolls back a candidate snapshot when source metadata persistence fails', async () => {
    const rootDirectory = await tempRoot()
    let failNextSourceWrite = false
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('transactional', 'trusted-r1')))
      .mockResolvedValueOnce(jsonResponse(snapshot('transactional', 'candidate-r2')))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW),
      beforePersistSources: async (sources) => {
        const state = sources.find((source) => source.id === 'transactional')?.sync.state
        if (!failNextSourceWrite || state !== 'synced') return
        failNextSourceWrite = false
        throw new Error('simulated source persistence failure')
      }
    })
    await service.upsertSource(httpsSource('transactional'))
    await service.syncSource('transactional')
    failNextSourceWrite = true

    const result = await service.syncSource('transactional')

    expect(result).toMatchObject({ status: 'failed', stale: true })
    expect(result.snapshot?.revision).toBe('trusted-r1')
    expect((await service.getSnapshot('transactional'))?.revision).toBe('trusted-r1')
    const reloaded = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    expect((await reloaded.getSnapshot('transactional'))?.revision).toBe('trusted-r1')
  })

  it('merges manifest mutations from multiple live service instances', async () => {
    const rootDirectory = await tempRoot()
    const first = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const second = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await Promise.all([first.listSources(), second.listSources()])

    await first.upsertSource(localSource('first-live', join(rootDirectory, 'first.json')))
    await second.upsertSource(localSource('second-live', join(rootDirectory, 'second.json')))

    const reloaded = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const ids = (await reloaded.listSources()).map((source) => source.id)
    expect(ids).toContain('first-live')
    expect(ids).toContain('second-live')
  })

  it('rejects unknown source authentication discriminators instead of downgrading them', async () => {
    const rootDirectory = await tempRoot()
    const source = httpsSource('unknown-auth') as unknown as Record<string, unknown>
    source.auth = { type: 'unexpected', token: 'must-not-survive' }
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })

    await expect(service.upsertSource(source as unknown as CatalogSourceV1))
      .rejects.toThrow(/auth type/i)

    const local = localSource('unknown-local-auth', join(rootDirectory, 'local.json')) as unknown as
      Record<string, unknown>
    local.auth = { type: 'unexpected' }
    await expect(service.upsertSource(local as unknown as CatalogSourceV1))
      .rejects.toThrow(/auth type/i)
  })

  it('serializes removal behind an active source sync and leaves no restored cache', async () => {
    const rootDirectory = await tempRoot()
    let releaseFetch!: () => void
    const fetchCanFinish = new Promise<void>((resolve) => { releaseFetch = resolve })
    const fetchMock = vi.fn(async () => {
      await fetchCanFinish
      return jsonResponse(snapshot('remove-during-sync'))
    })
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('remove-during-sync'))

    const syncing = service.syncSource('remove-during-sync')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const removing = service.removeSource('remove-during-sync')
    releaseFetch()
    await syncing
    await removing

    await expect(service.getSnapshot('remove-during-sync')).resolves.toBeNull()
    expect((await service.listSources()).some((source) => source.id === 'remove-during-sync')).toBe(false)
  })

  it('rejects user-created privileged catalog sources', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const attempts = [
      { ...localSource('fake-built-in', '/tmp/catalog.json'), type: 'built-in', scope: 'system' },
      { ...localSource('fake-system', '/tmp/catalog.json'), scope: 'system' },
      { ...localSource('fake-official', '/tmp/catalog.json'), trust: 'official' },
      { ...localSource('fake-system-trust', '/tmp/catalog.json'), trust: 'system' },
      { ...localSource('fake-verified', '/tmp/catalog.json'), trust: 'verified' }
    ]

    for (const source of attempts) {
      await expect(service.upsertSource(source as CatalogSourceV1)).rejects.toThrow(/reserved|privileged/i)
    }
  })

  it('uses manifest-addressed immutable snapshots and ignores orphaned or corrupted candidates', async () => {
    const rootDirectory = await tempRoot()
    const catalogPath = join(rootDirectory, 'immutable.json')
    await writeSnapshot(catalogPath, snapshot('immutable', 'trusted-r1'))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('immutable', catalogPath))
    await service.syncSource('immutable')

    const manifest = JSON.parse(await readFile(join(rootDirectory, 'sources.json'), 'utf8')) as {
      snapshots: Record<string, { file: string; revision: string; sha256: string }>
    }
    const pointer = manifest.snapshots.immutable
    expect(pointer.file).toMatch(new RegExp(`${pointer.sha256}\\.json$`))
    expect(pointer.revision).toBe('trusted-r1')
    const snapshotDirectory = join(rootDirectory, 'snapshots')
    await writeFile(join(snapshotDirectory, 'orphan.json'), JSON.stringify(snapshot('immutable', 'orphan-r2')))

    const ignoresOrphan = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    expect((await ignoresOrphan.getSnapshot('immutable'))?.revision).toBe('trusted-r1')

    await writeFile(join(snapshotDirectory, pointer.file), JSON.stringify(snapshot('immutable', 'tampered-r3')))
    const rejectsTampering = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await expect(rejectsTampering.getSnapshot('immutable')).resolves.toBeNull()
  })

  it('refreshes sources, snapshots, and package lists across active service instances', async () => {
    const rootDirectory = await tempRoot()
    const catalogPath = join(rootDirectory, 'live.json')
    await writeSnapshot(catalogPath, snapshot('live-refresh', 'live-r1'))
    const writer = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const reader = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await Promise.all([writer.listSources(), reader.listSources()])

    await writer.upsertSource(localSource('live-refresh', catalogPath))
    await writer.syncSource('live-refresh')

    expect((await reader.listSources()).some((source) => source.id === 'live-refresh')).toBe(true)
    expect((await reader.getSnapshot('live-refresh'))?.revision).toBe('live-r1')
    expect((await reader.listPackages()).packages.some((entry) => entry.sourceId === 'live-refresh')).toBe(true)
  })

  it('invalidates a trusted snapshot and owned validators when source identity changes', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn(async () => jsonResponse(snapshot('identity-change', 'trusted-r1'), {
      etag: '"trusted"',
      'last-modified': 'Sat, 08 Aug 2026 08:00:00 GMT',
      'x-workwise-catalog-commit': 'a'.repeat(40)
    }))
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('identity-change'))
    await service.syncSource('identity-change')

    const moved = httpsSource('identity-change', 'https://new.catalog.test/v1.json')
    moved.sync = {
      ...moved.sync,
      etag: '"attacker-controlled"',
      commit: 'b'.repeat(40),
      lastSyncedAt: NOW
    }
    await service.upsertSource(moved)

    const updated = (await service.listSources()).find((source) => source.id === 'identity-change')
    expect(updated?.sync.etag).toBeUndefined()
    expect(updated?.sync.lastModified).toBeUndefined()
    expect(updated?.sync.commit).toBeUndefined()
    expect(updated?.sync.lastSyncedAt).toBeUndefined()
    await expect(service.getSnapshot('identity-change')).resolves.toBeNull()
  })

  it('requires component runtimes to match their declared package source', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'runtime-mismatch.json')
    const item = catalogPackage('runtime-mismatch')
    const source = {
      id: 'runtime-source',
      catalogSourceId: 'runtime-mismatch',
      kind: 'npm' as const,
      location: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      packageName: 'example',
      version: '1.0.0',
      resolvedRef: 'example@1.0.0',
      digest: { algorithm: 'sha512-sri' as const, value: 'sha512-source' }
    }
    item.source = source
    item.sources = [source]
    item.components = [{
      id: 'runtime-component',
      name: 'Runtime component',
      sourceId: source.id,
      type: 'mcp',
      runtime: {
        kind: 'npm',
        packageName: 'different-package',
        version: '9.9.9',
        executable: 'example',
        args: [],
        install: {
          strategy: 'managed-download',
          verify: 'sri-before-activation',
          digestSource: 'component-source'
        }
      }
    }]
    await writeSnapshot(path, snapshot('runtime-mismatch', 'r1', [item]))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('runtime-mismatch', path))

    await expect(service.syncSource('runtime-mismatch')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/runtime.*source|packageName|version/i)
    })
  })

  it('injects resolved tokens only into request headers and never persists them', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer runtime-secret')
      return jsonResponse(snapshot('authenticated'))
    })
    const resolveSecret = vi.fn(async (key: string) => {
      expect(key).toBe('marketplace.authenticated.token')
      return 'runtime-secret'
    })
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock as unknown as typeof fetch,
      resolveSecret,
      now: () => new Date(NOW)
    })
    const source = httpsSource('authenticated')
    source.auth = { type: 'token', secretKey: 'marketplace.authenticated.token' }
    await service.upsertSource(source)

    await expect(service.syncSource('authenticated')).resolves.toMatchObject({ status: 'synced' })
    const persisted = await readFile(join(rootDirectory, 'sources.json'), 'utf8')
    expect(persisted).not.toContain('runtime-secret')
    expect(resolveSecret).toHaveBeenCalledTimes(1)
  })

  it('times out stalled HTTPS fetches and response bodies', async () => {
    const fetchRoot = await tempRoot()
    const stalledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const fetchService = new MarketplaceCatalogService({
      rootDirectory: fetchRoot,
      fetch: stalledFetch,
      fetchTimeoutMs: 1_000,
      now: () => new Date(NOW)
    })
    await fetchService.upsertSource(httpsSource('stalled-fetch'))

    const fetchResult = await fetchService.syncSource('stalled-fetch')
    expect(fetchResult).toMatchObject({ status: 'failed', error: expect.stringMatching(/timed out/i) })

    const bodyRoot = await tempRoot()
    let bodyCancelled = false
    const stalledBody = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { bodyCancelled = true }
    }), { status: 200 }))
    const bodyService = new MarketplaceCatalogService({
      rootDirectory: bodyRoot,
      fetch: stalledBody as unknown as typeof fetch,
      fetchTimeoutMs: 1_000,
      now: () => new Date(NOW)
    })
    await bodyService.upsertSource(httpsSource('stalled-body'))

    const bodyResult = await bodyService.syncSource('stalled-body')
    expect(bodyResult).toMatchObject({ status: 'failed', error: expect.stringMatching(/timed out/i) })
    expect(bodyCancelled).toBe(true)
  }, 15_000)

  it('clears request timeout timers after an immediate fetch or credential failure', async () => {
    const networkRoot = await tempRoot()
    const networkService = new MarketplaceCatalogService({
      rootDirectory: networkRoot,
      fetch: vi.fn().mockRejectedValue(new Error('immediate failure')) as unknown as typeof fetch,
      fetchTimeoutMs: 1_000,
      now: () => new Date(NOW)
    })
    await networkService.upsertSource(httpsSource('timer-network'))
    vi.useFakeTimers()
    try {
      await networkService.syncSource('timer-network')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }

    const credentialRoot = await tempRoot()
    const credentialService = new MarketplaceCatalogService({
      rootDirectory: credentialRoot,
      fetchTimeoutMs: 1_000,
      now: () => new Date(NOW)
    })
    const credentialSource = httpsSource('timer-credential')
    credentialSource.auth = { type: 'token', secretKey: 'missing-secret' }
    await credentialService.upsertSource(credentialSource)
    vi.useFakeTimers()
    try {
      await credentialService.syncSource('timer-credential')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a stalled credential resolver without permanently occupying the source lock', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetchTimeoutMs: 1_000,
      resolveSecret: () => new Promise(() => undefined),
      now: () => new Date(NOW)
    })
    const source = httpsSource('stalled-secret')
    source.auth = { type: 'token', secretKey: 'stalled-secret' }
    await service.upsertSource(source)

    const result = await Promise.race([
      service.syncSource('stalled-secret'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_500))
    ])

    expect(result).not.toBe('hung')
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/timed out/i) })
  }, 3_000)

  it('uses stale cache only for retryable HTTP responses and cancels rejected bodies', async () => {
    const rootDirectory = await tempRoot()
    let cancelled401 = false
    let cancelled503 = false
    const rejected = (status: number, cancelled: () => void): Response => new Response(
      new ReadableStream<Uint8Array>({ cancel: cancelled }),
      { status }
    )
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('http-status', 'trusted-r1')))
      .mockResolvedValueOnce(rejected(401, () => { cancelled401 = true }))
      .mockResolvedValueOnce(rejected(503, () => { cancelled503 = true })) as unknown as typeof fetch
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('http-status'))
    await service.syncSource('http-status')

    await expect(service.syncSource('http-status')).resolves.toMatchObject({ status: 'failed', stale: true })
    await expect(service.syncSource('http-status')).resolves.toMatchObject({ status: 'offline', stale: true })
    expect(cancelled401).toBe(true)
    expect(cancelled503).toBe(true)
  })

  it('validates generated timestamps, publisher URLs, permission resources, and OAuth scopes', async () => {
    const rootDirectory = await tempRoot()
    const cases: Array<[string, (value: CatalogSnapshotV1) => void, RegExp]> = [
      ['generated-at', (value) => { value.generatedAt = 'not-a-date' }, /generatedAt/i],
      ['publisher-url', (value) => { value.packages[0]!.publisher.url = 'javascript:alert(1)' }, /publisher.*URL/i],
      ['permission-resource', (value) => {
        value.packages[0]!.permissions = [{
          id: 'network',
          kind: 'network',
          access: 'connect',
          default: 'review',
          reviewRequired: true,
          description: 'Network access',
          resources: ['']
        }]
      }, /permission resources/i],
      ['oauth-scope', (value) => {
        value.packages[0]!.auth = {
          type: 'oauth', provider: 'example', discovery: 'ready', scopes: ['']
        }
      }, /OAuth scopes/i]
    ]
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })

    for (const [id, mutate, error] of cases) {
      const path = join(rootDirectory, `${id}.json`)
      const value = snapshot(id)
      mutate(value)
      await writeSnapshot(path, value)
      await service.upsertSource(localSource(id, path))
      await expect(service.syncSource(id)).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringMatching(error)
      })
    }
  })

  it('strictly strips unknown top-level and sync credential fields', async () => {
    const rootDirectory = await tempRoot()
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    const source = httpsSource('strict-sanitize') as unknown as Record<string, unknown>
    source.token = 'top-level-secret'
    ;(source.sync as Record<string, unknown>).authorization = 'nested-secret'

    await service.upsertSource(source as unknown as CatalogSourceV1)

    const persisted = await readFile(join(rootDirectory, 'sources.json'), 'utf8')
    expect(persisted).not.toContain('top-level-secret')
    expect(persisted).not.toContain('nested-secret')
  })

  it('updates response validators returned with HTTP 304', async () => {
    const rootDirectory = await tempRoot()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot('validator-304'), {
        etag: '"r1"',
        'last-modified': 'Sat, 08 Aug 2026 08:00:00 GMT'
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: {
          etag: '"r2"',
          'last-modified': 'Sat, 08 Aug 2026 09:00:00 GMT'
        }
      })) as unknown as typeof fetch
    const service = new MarketplaceCatalogService({
      rootDirectory,
      fetch: fetchMock,
      now: () => new Date(NOW)
    })
    await service.upsertSource(httpsSource('validator-304'))
    await service.syncSource('validator-304')
    await service.syncSource('validator-304')

    expect((await service.listSources()).find((source) => source.id === 'validator-304')?.sync)
      .toMatchObject({
        etag: '"r2"',
        lastModified: 'Sat, 08 Aug 2026 09:00:00 GMT'
      })
  })

  it('restores in-memory state when source upsert or removal persistence fails', async () => {
    const rootDirectory = await tempRoot()
    let fail = false
    const service = new MarketplaceCatalogService({
      rootDirectory,
      now: () => new Date(NOW),
      beforePersistSources: async () => {
        if (fail) throw new Error('simulated manifest failure')
      }
    })
    const source = localSource('rollback-source', join(rootDirectory, 'rollback.json'))
    await service.listSources()
    fail = true
    await expect(service.upsertSource(source)).rejects.toThrow(/manifest failure/i)
    expect((await service.listSources()).some((entry) => entry.id === 'rollback-source')).toBe(false)

    fail = false
    await service.upsertSource(source)
    fail = true
    await expect(service.removeSource('rollback-source')).rejects.toThrow(/manifest failure/i)
    expect((await service.listSources()).some((entry) => entry.id === 'rollback-source')).toBe(true)
  })

  it('removes only the manifest-addressed snapshot when deleting a source', async () => {
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'cleanup.json')
    await writeSnapshot(path, snapshot('cleanup'))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('cleanup', path))
    await service.syncSource('cleanup')
    const before = await readdir(join(rootDirectory, 'snapshots'))

    await service.removeSource('cleanup')

    const after = await readdir(join(rootDirectory, 'snapshots'))
    expect(after.length).toBe(before.length - 1)
  })

  it('treats post-commit snapshot cleanup failure as non-fatal garbage collection', async () => {
    if (process.platform === 'win32') return
    const rootDirectory = await tempRoot()
    const path = join(rootDirectory, 'cleanup-failure.json')
    const snapshotDirectory = join(rootDirectory, 'snapshots')
    await writeSnapshot(path, snapshot('cleanup-failure'))
    const service = new MarketplaceCatalogService({ rootDirectory, now: () => new Date(NOW) })
    await service.upsertSource(localSource('cleanup-failure', path))
    await service.syncSource('cleanup-failure')
    await chmod(snapshotDirectory, 0o500)

    try {
      await expect(service.removeSource('cleanup-failure')).resolves.toBeUndefined()
    } finally {
      await chmod(snapshotDirectory, 0o700)
    }
    expect((await service.listSources()).some((source) => source.id === 'cleanup-failure')).toBe(false)
  })
})
