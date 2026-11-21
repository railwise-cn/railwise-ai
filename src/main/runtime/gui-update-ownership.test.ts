import { describe, expect, it, vi } from 'vitest'
import { readGuiUpdateRuntimeOwnership, RuntimeStartBlockedForShutdownError } from './gui-update-ownership'

describe('Runtime ownership before GUI update', () => {
  it('checks an idle service by its loopback port without starting a Runtime', async () => {
    const portAvailable = vi.fn().mockResolvedValue(true)
    await expect(readGuiUpdateRuntimeOwnership({
      pendingStarts: [], isOwnedChildRunning: () => false, isConfiguredPortAvailable: portAvailable
    })).resolves.toBe('idle')
    expect(portAvailable).toHaveBeenCalledOnce()
  })

  it('waits for an admitted startup to become owned before proceeding', async () => {
    let owned = false
    let finishStart!: () => void
    const start = new Promise<void>(resolve => { finishStart = resolve })
    const portAvailable = vi.fn()
    const result = readGuiUpdateRuntimeOwnership({
      pendingStarts: [start], isOwnedChildRunning: () => owned, isConfiguredPortAvailable: portAvailable
    })
    await Promise.resolve()
    expect(portAvailable).not.toHaveBeenCalled()
    owned = true
    finishStart()
    await expect(result).resolves.toBe('owned')
    expect(portAvailable).not.toHaveBeenCalled()
  })

  it('does not treat an occupied unowned Runtime port as idle', async () => {
    await expect(readGuiUpdateRuntimeOwnership({
      pendingStarts: [Promise.reject(new RuntimeStartBlockedForShutdownError())],
      isOwnedChildRunning: () => false,
      isConfiguredPortAvailable: async () => false
    })).rejects.toThrow('无法确认当前任务服务由本应用启动')
  })

  it('recognizes the admission fence when the spawn wrapper rejected before spawning', async () => {
    await expect(readGuiUpdateRuntimeOwnership({
      pendingStarts: [Promise.reject(new Error('Spawn denied', { cause: new RuntimeStartBlockedForShutdownError() }))],
      isOwnedChildRunning: () => false,
      isConfiguredPortAvailable: async () => true
    })).resolves.toBe('idle')
  })

  it('requires rechecking after an unconfirmed owned startup failure', async () => {
    const portAvailable = vi.fn()
    await expect(readGuiUpdateRuntimeOwnership({
      pendingStarts: [Promise.reject(new Error('child exited before readiness'))],
      isOwnedChildRunning: () => false,
      isConfiguredPortAvailable: portAvailable
    })).rejects.toThrow('未能确认就绪')
    expect(portAvailable).not.toHaveBeenCalled()
  })

  it('rechecks ownership when a normal Runtime start races the UI preflight', async () => {
    let owned = false
    await expect(readGuiUpdateRuntimeOwnership({
      pendingStarts: [],
      isOwnedChildRunning: () => owned,
      isConfiguredPortAvailable: async () => { owned = true; return false }
    })).resolves.toBe('owned')
  })
})
