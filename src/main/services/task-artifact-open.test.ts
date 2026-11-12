import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openVerifiedTaskArtifact } from './task-artifact-open'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-artifact-open-')); roots.push(temporary)
  const root = await realpath(temporary), path = join(root, 'result.md'), content = '# Verified result\n'
  await writeFile(path, content)
  const proof = { taskId: 'task', artifactId: 'artifact', absolutePath: path, authorizedRoot: root, executionGrantId: 'grant', turnId: 'turn', operationId: 'operation', sha256: createHash('sha256').update(content).digest('hex') }
  const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify(proof) }))
  const openPath = vi.fn(async () => '')
  return { path, proof, runtimeRequest, openPath }
}
describe('typed verified artifact opening', () => {
  it('opens only the file recovered from the task proof', async () => {
    const f = await fixture()
    expect(await openVerifiedTaskArtifact({ taskId: 'task', artifactId: 'artifact' }, f)).toEqual({ ok: true })
    expect(f.runtimeRequest).toHaveBeenCalledWith('/v1/tasks/task/artifacts/artifact/proof', 'GET')
    expect(f.openPath).toHaveBeenCalledWith(f.path)
  })
  it('rejects changed content, mismatched identity and paths outside the grant', async () => {
    const f = await fixture()
    await writeFile(f.path, '# Changed after delivery\n')
    expect(await openVerifiedTaskArtifact({ taskId: 'task', artifactId: 'artifact' }, f)).toMatchObject({ ok: false })
    expect(await openVerifiedTaskArtifact({ taskId: 'other', artifactId: 'artifact' }, f)).toMatchObject({ ok: false })
    f.proof.authorizedRoot = join(f.proof.authorizedRoot, 'missing')
    expect(await openVerifiedTaskArtifact({ taskId: 'task', artifactId: 'artifact' }, f)).toMatchObject({ ok: false })
    expect(f.openPath).not.toHaveBeenCalled()
  })
})
