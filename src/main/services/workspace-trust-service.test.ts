import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
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
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('WorkspaceTrustService', () => {
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
