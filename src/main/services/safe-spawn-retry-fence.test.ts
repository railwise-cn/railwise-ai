import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { safeSpawn } from './safe-spawn'

const calls = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: calls.spawn }))
afterEach(() => { calls.spawn.mockReset() })

it('rechecks admission before the bounded EPERM retry and keeps the callback out of OS options', async () => {
  let observeSpawn!: () => void
  const firstSpawn = new Promise<void>(resolve => { observeSpawn = resolve })
  calls.spawn.mockImplementation(() => {
    const child = new EventEmitter()
    observeSpawn()
    queueMicrotask(() => child.emit('error', Object.assign(new Error('Synthetic transient denial'), { code: 'EPERM' })))
    return child
  })
  let allowed = true
  const beforeSpawn = vi.fn(() => { if (!allowed) throw new Error('runtime_shutdown_in_progress') })
  const starting = safeSpawn(process.execPath, ['-e', 'process.exit(0)'], { beforeSpawn })
  const rejected = expect(starting).rejects.toMatchObject({ code: 'spawn_denied', cause: { message: 'runtime_shutdown_in_progress' } })
  await firstSpawn
  expect(calls.spawn.mock.calls[0][2]).not.toHaveProperty('beforeSpawn')
  allowed = false
  await rejected
  expect(beforeSpawn).toHaveBeenCalledTimes(2)
  expect(calls.spawn).toHaveBeenCalledOnce()
})
