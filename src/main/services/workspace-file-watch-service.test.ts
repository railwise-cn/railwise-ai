import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteFile, drainSerializedWrites } from './durable-file'
import { startWorkspaceFileWatch, type WorkspaceFileWatch } from './workspace-file-watch-service'

const roots: string[] = []
const watches: WorkspaceFileWatch[] = []

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-file-watch-'))
  roots.push(root)
  const path = join(root, 'draft.md')
  await writeFile(path, 'initial')
  return { root, path }
}

async function observe(path: string): Promise<Array<string>> {
  const snapshots: string[] = []
  watches.push(await startWorkspaceFileWatch({
    path,
    pollIntervalMs: 30,
    onChange: () => {
      void readFile(path, 'utf8').then(
        (content) => snapshots.push(content),
        (error: NodeJS.ErrnoException) => snapshots.push(`error:${error.code}`)
      )
    }
  }))
  return snapshots
}

async function saw(snapshots: string[], value: string): Promise<void> {
  await vi.waitFor(() => expect(snapshots).toContain(value), { timeout: 3_000, interval: 10 })
}

afterEach(async () => {
  for (const watcher of watches.splice(0)) watcher.close()
  await drainSerializedWrites()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace pathname watcher', () => {
  it('survives atomic saves, further external edits, deletion and recreation without reopening', async () => {
    const { path } = await fixture()
    const snapshots = await observe(path)

    await writeFile(path, 'changed') // Same byte length as "initial".
    await saw(snapshots, 'changed')
    await atomicWriteFile(path, 'saved atomically')
    await saw(snapshots, 'saved atomically')
    await writeFile(path, 'external edit after save')
    await saw(snapshots, 'external edit after save')
    await atomicWriteFile(path, 'external atomic replacement')
    await saw(snapshots, 'external atomic replacement')
    await writeFile(path, 'second external edit')
    await saw(snapshots, 'second external edit')
    await unlink(path)
    await saw(snapshots, 'error:ENOENT')
    await writeFile(path, 'recreated')
    await saw(snapshots, 'recreated')
    await writeFile(path, 'edited after recreation')
    await saw(snapshots, 'edited after recreation')
  })

  it('recovers the original pathname when its containing directory moves and is recreated', async () => {
    const { root } = await fixture()
    const parent = join(root, 'documents')
    await mkdir(parent)
    const path = join(parent, 'draft.md')
    await writeFile(path, 'before directory move')
    const snapshots = await observe(path)

    await rename(parent, join(root, 'moved-documents'))
    await saw(snapshots, 'error:ENOENT')
    await mkdir(parent)
    await writeFile(path, 'new original pathname')
    await saw(snapshots, 'new original pathname')
    await atomicWriteFile(path, 'replacement after directory recovery')
    await saw(snapshots, 'replacement after directory recovery')
    const deletionNotifications = snapshots.filter((value) => value === 'error:ENOENT').length
    await unlink(path)
    // Require a new deletion notification after recovery, not the earlier one.
    await vi.waitFor(() => expect(snapshots.filter((value) => value === 'error:ENOENT').length).toBeGreaterThan(deletionNotifications), { timeout: 3_000, interval: 10 })
  })

  it('disposes native and polling callbacks without removing another subscription for the same path', async () => {
    const { path } = await fixture()
    const closedChange = vi.fn()
    const activeChange = vi.fn()
    const closed = await startWorkspaceFileWatch({ path, pollIntervalMs: 30, onChange: closedChange })
    const active = await startWorkspaceFileWatch({ path, pollIntervalMs: 30, onChange: activeChange })
    watches.push(closed, active)
    closed.close()
    closed.close()
    await atomicWriteFile(path, 'remaining subscriber')
    await vi.waitFor(() => expect(activeChange).toHaveBeenCalled(), { timeout: 3_000, interval: 10 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(closedChange).not.toHaveBeenCalled()
    active.close()
    const calls = activeChange.mock.calls.length
    await writeFile(path, 'no subscriber')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(activeChange).toHaveBeenCalledTimes(calls)
  })
})
