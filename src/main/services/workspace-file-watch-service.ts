import { watch, watchFile, unwatchFile, type FSWatcher, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

export type WorkspaceFileWatch = { close: () => void }

type Options = {
  path: string
  // Advisory invalidation, not a one-per-edit content notification. Native
  // watchers may repeat or deliver an older target event; consumers re-read.
  onChange: () => void
  onError?: (error: Error) => void
  pollIntervalMs?: number
}

function fileState(info: Stats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

async function readFileState(path: string): Promise<string> {
  try { return fileState(await stat(path)) }
  catch (error) { return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}` }
}

/** Watch the pathname, rather than the inode replaced by an atomic save. */
export async function startWorkspaceFileWatch(options: Options): Promise<WorkspaceFileWatch> {
  const parent = dirname(options.path)
  const name = basename(options.path)
  let closed = false
  let directoryWatcher: FSWatcher | null = null
  let parentIdentity = ''
  let state = await readFileState(options.path)
  let probeGeneration = 0
  let armGeneration = 0

  const closeDirectory = (): void => {
    const watcher = directoryWatcher
    directoryWatcher = null
    parentIdentity = ''
    watcher?.close()
  }

  const probe = async (): Promise<void> => {
    const generation = ++probeGeneration
    const next = await readFileState(options.path)
    if (closed || generation !== probeGeneration || next === state) return
    state = next
    options.onChange()
  }

  const armDirectory = async (): Promise<void> => {
    const generation = ++armGeneration
    try {
      const info = await stat(parent)
      if (closed || generation !== armGeneration) return
      const identity = `${info.dev}:${info.ino}`
      if (directoryWatcher && identity === parentIdentity) return
      closeDirectory()
      const watcher = watch(parent, { persistent: false }, (_event, filename) => {
        if (closed || directoryWatcher !== watcher) return
        if (filename === null) {
          // Some platforms omit the name. Verify this target before notifying;
          // unrelated directory activity must not broadcast document changes.
          void probe()
        } else if (filename.toString() === name) {
          // Never suppress target events solely by metadata: coarse timestamp
          // filesystems can report identical stats for different file contents.
          // Duplicate/late invalidations are safe; the caller re-reads the path.
          options.onChange()
          void probe()
        }
      })
      directoryWatcher = watcher
      parentIdentity = identity
      watcher.on('error', (error) => {
        if (closed || directoryWatcher !== watcher) return
        closeDirectory()
        options.onError?.(error)
        void probe()
      })
    } catch (error) {
      if (closed || generation !== armGeneration) return
      closeDirectory()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  // This subscription is scoped to one pathname. It also detects a missing or
  // replaced parent, where a native directory watcher remains on the old inode.
  const onStatChange = (): void => {
    if (closed) return
    void probe()
    void armDirectory()
  }
  watchFile(options.path, { persistent: false, interval: options.pollIntervalMs ?? 1_000 }, onStatChange)
  await armDirectory()
  // Cover changes between the initial read and registering both watchers.
  void probe()

  return {
    close: () => {
      if (closed) return
      closed = true
      probeGeneration += 1
      armGeneration += 1
      unwatchFile(options.path, onStatChange)
      closeDirectory()
    }
  }
}
