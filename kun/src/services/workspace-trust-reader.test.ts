import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWorkspaceTrustReader } from './workspace-trust-reader.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'railwise-trust-reader-')))
  directories.push(directory)
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const manifest = join(directory, 'workspace-trust.json')
  const set = async (level: string, revision: number) => writeFile(manifest, JSON.stringify({ schema: 'workwise.workspace-trust', version: 1, workspaces: [{ canonicalRoot: workspace, level, revision }] }))
  return { directory, workspace, manifest, set, reader: new FileWorkspaceTrustReader(manifest) }
}

describe('persistent workspace trust at runtime', () => {
  it('does not infer full access for an unregistered workspace', async () => {
    const f = await fixture()
    expect(await f.reader.get(f.workspace)).toMatchObject({ level: 'read-only', revision: 0 })
  })

  it('rechecks the real manifest and observes revocation without runtime restart', async () => {
    const f = await fixture()
    await f.set('full-access', 1)
    expect(await f.reader.get(f.workspace)).toMatchObject({ level: 'full-access', revision: 1 })
    await f.set('read-only', 2)
    expect(await f.reader.get(f.workspace)).toMatchObject({ level: 'read-only', revision: 2 })
  })

  it('matches canonical roots rather than trusting a symlink alias', async () => {
    const f = await fixture()
    const alias = join(f.directory, 'alias')
    await symlink(f.workspace, alias, 'dir')
    await f.set('workspace-write', 3)
    expect(await f.reader.get(alias)).toEqual({ canonicalRoot: f.workspace, level: 'workspace-write', revision: 3 })
  })

  it('fails closed on corrupt or duplicate trust records', async () => {
    const f = await fixture()
    await writeFile(f.manifest, '{broken')
    await expect(f.reader.get(f.workspace)).rejects.toMatchObject({ code: 'workspace_trust_unavailable' })
    const entry = { canonicalRoot: f.workspace, level: 'full-access', revision: 1 }
    await writeFile(f.manifest, JSON.stringify({ schema: 'workwise.workspace-trust', version: 1, workspaces: [entry, entry] }))
    await expect(f.reader.get(f.workspace)).rejects.toMatchObject({ code: 'workspace_trust_unavailable' })
  })
})
