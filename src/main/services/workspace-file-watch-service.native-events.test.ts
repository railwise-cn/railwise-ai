import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  listener: null as null | ((event: string, filename: string | Buffer | null) => void),
  close: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watch: vi.fn((_path, _options, listener) => {
    native.listener = listener
    return { close: native.close, on: vi.fn() }
  })
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

import { startWorkspaceFileWatch, type WorkspaceFileWatch } from './workspace-file-watch-service'

let root: string
let path: string
let watcher: WorkspaceFileWatch
const statCalls = vi.mocked(stat)

// Complete real filesystem probes without asserting against a timed quiet
// window: native macOS events can include target invalidations from setup.
async function settleProbes(): Promise<void> {
  await Promise.all(statCalls.mock.results.filter((result) => result.type === 'return').map((result) => result.value))
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'workwise-watch-native-'))
  path = join(root, 'draft.md')
  await writeFile(path, 'initial')
})
afterEach(async () => {
  watcher?.close()
  await rm(root, { recursive: true, force: true })
})

describe('native workspace-watch advisory event contract', () => {
  it('filters known sibling and atomic temporary names without invalidating the target', async () => {
    const onChange = vi.fn()
    watcher = await startWorkspaceFileWatch({ path, onChange })
    await settleProbes()
    for (const filename of ['other.md', '.draft.md.unrelated.tmp', Buffer.from('another.md')]) {
      native.listener!('rename', filename)
      native.listener!('change', filename)
    }
    await settleProbes()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('checks the actual target before invalidating an unnamed directory event', async () => {
    const onChange = vi.fn()
    watcher = await startWorkspaceFileWatch({ path, onChange })
    await settleProbes()
    const probes = statCalls.mock.calls.length
    native.listener!('change', null)
    await settleProbes()
    expect(statCalls.mock.calls.length).toBeGreaterThan(probes)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('retains duplicate exact-target invalidations even when file metadata is unchanged', async () => {
    const onChange = vi.fn()
    watcher = await startWorkspaceFileWatch({ path, onChange })
    await settleProbes()
    const before = await stat(path)
    // An unchanged file also models the metadata observed on a coarse filesystem
    // after a same-size edit. Only the native event says a re-read is necessary.
    native.listener!('change', 'draft.md')
    native.listener!('rename', Buffer.from('draft.md'))
    await settleProbes()
    const after = await stat(path)
    expect([after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.size, before.mtimeMs, before.ctimeMs])
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
