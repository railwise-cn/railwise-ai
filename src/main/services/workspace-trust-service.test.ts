import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkspaceTrustManifestPath, FileWorkspaceTrustReader } from '../../../kun/src/services/workspace-trust-reader'
import {
  effectiveTrustLevel,
  trustLevelFromLegacySandbox,
  WorkspaceTrustService
} from './workspace-trust-service'

const roots: string[] = []

async function temp(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'workwise-trust-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('WorkspaceTrustService', () => {
  it('shares the isolated candidate manifest with KUN and only initializes the newly created default', async () => {
    const base = await temp()
    const home = join(base, 'home')
    const managed = join(home, '.workwise')
    const root = join(managed, 'default_workspace')
    vi.stubEnv('WORKWISE_CANDIDATE', '1')
    vi.stubEnv('WORKWISE_CANDIDATE_ROOT', base)
    vi.stubEnv('WORKWISE_CANDIDATE_HOME', home)
    expect(defaultWorkspaceTrustManifestPath()).toBe(join(managed, 'workspace-trust.json'))
    const service = new WorkspaceTrustService()
    await Promise.all([service.initializeDefaultWorkspace(managed, root), service.initializeDefaultWorkspace(managed, root)])
    await expect(new FileWorkspaceTrustReader().get(root)).resolves.toEqual({ canonicalRoot: await realpath(root), level: 'workspace-write', revision: 1 })
    await expect(service.get(root)).resolves.toMatchObject({ source: 'workwise-created', revision: 1 })
    const before = await readFile(join(managed, 'workspace-trust.json'), 'utf8')
    const external = join(base, 'external')
    await service.initializeDefaultWorkspace(managed, external)
    await expect(readFile(join(managed, 'workspace-trust.json'), 'utf8')).resolves.toBe(before)
  })

  it('preserves a saved restrictive rule even when it wins creation of the missing directory', async () => {
    const base = await temp()
    const managed = join(base, '.workwise')
    await mkdir(managed)
    const canonicalRoot = join(await realpath(managed), 'default_workspace')
    const manifest = join(managed, 'workspace-trust.json')
    const original = JSON.stringify({ schema: 'workwise.workspace-trust', version: 1, revision: 6,
      workspaces: [{ canonicalRoot: `${canonicalRoot}/`, level: 'read-only', source: 'user', revision: 3 }], mutationResults: {} })
    await writeFile(manifest, original)
    await new WorkspaceTrustService(manifest).initializeDefaultWorkspace(managed, join(managed, 'default_workspace'))
    await expect(readFile(manifest, 'utf8')).resolves.toBe(original)
    await expect(new FileWorkspaceTrustReader(manifest).get(canonicalRoot)).resolves.toMatchObject({ level: 'read-only', revision: 3 })
  })

  it('does not create a trusted default through a linked managed home and rejects candidate escapes', async () => {
    const base = await temp()
    const outside = await temp()
    const managed = join(base, '.workwise')
    await symlink(outside, managed, process.platform === 'win32' ? 'junction' : 'dir')
    await new WorkspaceTrustService(join(managed, 'workspace-trust.json')).initializeDefaultWorkspace(managed, join(managed, 'default_workspace'))
    await expect(readFile(join(outside, 'workspace-trust.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => defaultWorkspaceTrustManifestPath({ WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: base,
      WORKWISE_CANDIDATE_HOME: outside })).toThrow(/isolated/)
    const linkedHome = join(base, 'linked-home')
    await symlink(outside, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => defaultWorkspaceTrustManifestPath({ WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: base,
      WORKWISE_CANDIDATE_HOME: linkedHome })).toThrow(/isolated/)
  })

  it('uses source-sensitive defaults', async () => {
    const base = await temp()
    const external = join(base, 'external')
    const created = join(base, 'created')
    await mkdir(external)
    await mkdir(created)
    const service = new WorkspaceTrustService(join(base, 'trust.json'))

    await expect(service.get(external)).resolves.toMatchObject({ level: 'read-only', source: 'external' })
    await expect(service.get(created, { createdByWorkWise: true })).resolves.toMatchObject({
      level: 'workspace-write',
      source: 'workwise-created'
    })
  })

  it('requires confirmation for elevation and persists by canonical root', async () => {
    const base = await temp()
    const workspace = join(base, 'workspace')
    const linked = join(base, 'linked')
    await mkdir(workspace)
    await symlink(workspace, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const service = new WorkspaceTrustService(join(base, 'trust.json'))

    await expect(service.set({
      workspaceRoot: linked,
      level: 'trusted',
      expectedRevision: 0,
      confirmed: false
    })).rejects.toMatchObject({ code: 'approval_required' })

    const saved = await service.set({
      workspaceRoot: linked,
      level: 'trusted',
      expectedRevision: 0,
      confirmed: true,
      idempotencyKey: 'trust-linked'
    })
    await expect(service.get(workspace)).resolves.toEqual(saved)
    await expect(new WorkspaceTrustService(join(base, 'trust.json')).set({
      workspaceRoot: workspace,
      level: 'trusted',
      expectedRevision: 0,
      confirmed: true,
      idempotencyKey: 'trust-linked'
    })).resolves.toEqual(saved)
  })

  it('rejects same-key changes and serializes concurrent trust revisions', async () => {
    const base = await temp()
    const workspace = join(base, 'workspace')
    await mkdir(workspace)
    const service = new WorkspaceTrustService(join(base, 'trust.json'))
    await service.set({ workspaceRoot: workspace, level: 'workspace-write', expectedRevision: 0, confirmed: true, idempotencyKey: 'grant' })
    await expect(service.set({ workspaceRoot: workspace, level: 'full-access', expectedRevision: 0, confirmed: true, idempotencyKey: 'grant' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const results = await Promise.allSettled([
      service.set({ workspaceRoot: workspace, level: 'trusted', expectedRevision: 1, confirmed: true, idempotencyKey: 'a' }),
      service.set({ workspaceRoot: workspace, level: 'full-access', expectedRevision: 1, confirmed: true, idempotencyKey: 'b' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('never lets an Agent exceed workspace trust', () => {
    expect(effectiveTrustLevel('workspace-write', 'full-access')).toBe('workspace-write')
    expect(effectiveTrustLevel('trusted', 'read-only')).toBe('read-only')
    expect(trustLevelFromLegacySandbox('danger-full-access')).toBe('full-access')
    expect(trustLevelFromLegacySandbox('external-sandbox')).toBe('read-only')
  })
})
