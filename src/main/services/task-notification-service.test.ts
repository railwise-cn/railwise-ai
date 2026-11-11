import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claimTaskNotification } from './task-notification-service'
it('claims concurrent notices once and retains claims across later reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-notification-'))
  try {
    const path = join(root, 'ledger.json')
    expect(await Promise.all([claimTaskNotification(path, 'attention:1'), claimTaskNotification(path, 'attention:1')])).toEqual([true, false])
    expect(await claimTaskNotification(path, 'attention:1')).toBe(false)
    expect(await claimTaskNotification(path, 'artifact:1')).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains notification claims when a reconnect replays the same attention after service reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-notification-replay-'))
  try {
    const path = join(root, 'ledger.json')
    expect(await claimTaskNotification(path, 'attention:synthetic:revision-1')).toBe(true)
    vi.resetModules()
    const reloaded = await import('./task-notification-service')
    expect(await reloaded.claimTaskNotification(path, 'attention:synthetic:revision-1')).toBe(false)
    expect(await reloaded.claimTaskNotification(path, 'artifact:synthetic:verified-hash')).toBe(true)
    expect(await claimTaskNotification(path, 'artifact:synthetic:verified-hash')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
