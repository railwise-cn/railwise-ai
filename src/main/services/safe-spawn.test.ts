import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { safeSpawn, SafeSpawnError } from './safe-spawn'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('safeSpawn', () => {
  it('starts only after the process emits spawn', async () => {
    const child = await safeSpawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    expect(child.pid).toBeTypeOf('number')
  })

  it('falls back from an unavailable cwd without creating it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workwise-safe-spawn-'))
    temporaryPaths.push(workspace)
    const missing = join(workspace, 'missing')
    const child = await safeSpawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: missing,
      workspaceRoot: workspace
    })
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    await expect(import('node:fs/promises').then(({ stat }) => stat(missing))).rejects.toThrow()
  })

  it('returns a diagnosable error for a missing executable', async () => {
    await expect(safeSpawn('workwise-command-that-does-not-exist', []))
      .rejects.toMatchObject({ code: 'executable_unavailable' } satisfies Partial<SafeSpawnError>)
  })

  it('checks the admission fence after asynchronous path preparation and before spawning', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workwise-spawn-fence-'))
    temporaryPaths.push(workspace)
    const marker = join(workspace, 'spawned.txt')
    let allowed = true
    const starting = safeSpawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker], {
      workspaceRoot: workspace,
      beforeSpawn: () => { if (!allowed) throw new Error('runtime_shutdown_in_progress') }
    })
    allowed = false
    await expect(starting).rejects.toMatchObject({ cause: { message: 'runtime_shutdown_in_progress' } })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
