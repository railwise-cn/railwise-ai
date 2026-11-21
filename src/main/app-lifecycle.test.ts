import { describe, expect, it } from 'vitest'
import {
  shouldCloseMainWindowToTray,
  shouldShowStartupErrorDialog,
  shouldStopServicesWhenAllWindowsClose
} from './app-lifecycle'

describe('app lifecycle', () => {
  it('keeps background communication services running on macOS', () => {
    expect(shouldStopServicesWhenAllWindowsClose('darwin')).toBe(false)
  })

  it('quits an isolated macOS candidate when its last window closes', () => {
    expect(shouldStopServicesWhenAllWindowsClose('darwin', true)).toBe(true)
  })

  it.each(['win32', 'linux'] as const)('stops services before quitting on %s', (platform) => {
    expect(shouldStopServicesWhenAllWindowsClose(platform)).toBe(true)
  })

  it('keeps the normal app close-to-tray preference', () => {
    expect(shouldCloseMainWindowToTray(true)).toBe(true)
    expect(shouldCloseMainWindowToTray(false)).toBe(false)
  })

  it('always closes an isolated candidate window instead of hiding it to the tray', () => {
    expect(shouldCloseMainWindowToTray(true, true)).toBe(false)
  })

  it('closes the main window for a native update even with close-to-tray enabled', () => {
    expect(shouldCloseMainWindowToTray(true, false, true)).toBe(false)
  })

  it('does not show a blocking startup dialog in headless candidate mode', () => {
    expect(shouldShowStartupErrorDialog(true)).toBe(false)
    expect(shouldShowStartupErrorDialog(false)).toBe(true)
  })
})
