import { describe, expect, it } from 'vitest'
import {
  GUI_UPDATE_CHECK_INTERVAL_MS,
  nextGuiUpdateCheckDelay
} from './gui-update-schedule'

describe('nextGuiUpdateCheckDelay', () => {
  it('checks immediately when there is no previous check', () => {
    expect(nextGuiUpdateCheckDelay(null, 1_000)).toBe(0)
    expect(nextGuiUpdateCheckDelay(undefined, 1_000)).toBe(0)
    expect(nextGuiUpdateCheckDelay(0, 1_000)).toBe(0)
    expect(nextGuiUpdateCheckDelay(20_000, 1_000)).toBe(0)
  })

  it('waits only until the 15-minute check interval has elapsed', () => {
    const now = Date.UTC(2026, 4, 26, 12, 0, 0)
    const lastCheckedAt = now - 5 * 60_000
    expect(nextGuiUpdateCheckDelay(lastCheckedAt, now)).toBe(
      GUI_UPDATE_CHECK_INTERVAL_MS - 5 * 60_000
    )
  })

  it('checks at startup when the last check was earlier the same day', () => {
    const now = Date.UTC(2026, 4, 26, 12, 0, 0)
    const lastCheckedAt = now - 3_600_000
    expect(nextGuiUpdateCheckDelay(lastCheckedAt, now)).toBe(0)
  })
})
