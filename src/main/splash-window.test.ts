import { describe, expect, it, vi } from 'vitest'
import {
  buildSplashHtml,
  createSplashWindow,
  SPLASH_MIN_VISIBLE_MS,
  SPLASH_READY_TIMEOUT_MS,
  splashProgressLabel,
  splashReadyWaitRemainingMs,
  splashRemainingVisibleMs
} from './splash-window'

const { splashWindows } = vi.hoisted(() => ({ splashWindows: [] as Array<{ emit: (event: string) => void }> }))

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {
  private listeners = new Map<string, Array<() => void>>()
  webContents = { once: (event: string, listener: () => void) => this.addListener(`webContents:${event}`, listener),
    isDestroyed: () => false, executeJavaScript: async () => undefined }
  constructor() { splashWindows.push(this) }
  once(event: string, listener: () => void): void { this.addListener(event, listener) }
  on(event: string, listener: () => void): void { this.addListener(event, listener) }
  loadURL(): Promise<void> { return Promise.resolve() }
  show(): void {}
  close(): void { this.emit('closed') }
  isDestroyed(): boolean { return false }
  private addListener(event: string, listener: () => void): void {
    const values = this.listeners.get(event) ?? []
    values.push(listener)
    this.listeners.set(event, values)
  }
  emit(event: string): void { this.listeners.get(event)?.forEach(listener => listener()) }
} }))

const appearance = {
  schema: 'workwise.window-appearance' as const,
  version: 1 as const,
  material: 'solid' as const,
  transparencyEnabled: false,
  reason: 'gpu-disabled' as const
}

describe('splash window document', () => {
  it('shows the brand and full Chinese subtitle above quiet, accessible progress', () => {
    const html = buildSplashHtml(
      {
        appearance: {
          schema: 'workwise.window-appearance',
          version: 1,
          material: 'vibrancy',
          transparencyEnabled: true,
          reason: 'supported'
        },
        dark: false,
        locale: 'zh',
        logoDataUrl: 'data:image/png;base64,logo'
      },
      { progress: 0.42, label: '正在载入扩展' }
    )

    expect(html).toMatch(/<img class="logo"[^>]*>\s*<h1 class="brand">RailWise AI<\/h1>\s*<p class="subtitle" lang="zh-CN">基于本地优先架构的智能协同工作台<\/p>/)
    expect(html).not.toContain('class="version"')
    expect(html).toContain('overflow-wrap: anywhere')
    expect(html).toContain('role="progressbar" aria-labelledby="splash-status"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('正在载入扩展')
    expect(html).toContain('prefers-reduced-transparency: reduce')
    expect(html).toContain('forced-colors: active')
    expect(html).toContain('font-src data:')
    expect(html).toContain("font-family: 'RailWise UI'")
  })

  it('keeps the Chinese subtitle in the English dark splash and escapes phase labels', () => {
    const html = buildSplashHtml(
      {
        appearance: {
          schema: 'workwise.window-appearance',
          version: 1,
          material: 'solid',
          transparencyEnabled: false,
          reason: 'gpu-disabled'
        },
        dark: true,
        locale: 'en'
      },
      { progress: 3, label: '<ready>' }
    )

    expect(html).toContain('<html lang="en" data-theme="dark" data-material="solid">')
    expect(html).toContain('<p class="subtitle" lang="zh-CN">基于本地优先架构的智能协同工作台</p>')
    expect(html).not.toContain('class="version"')
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('&lt;ready&gt;')
    expect(splashProgressLabel('en', 'interface')).toBe('Opening workbench')
  })

  it('keeps a fast-starting splash visible long enough to be perceived', () => {
    expect(SPLASH_MIN_VISIBLE_MS).toBe(1_200)
    expect(SPLASH_READY_TIMEOUT_MS).toBe(5_000)
    expect(splashReadyWaitRemainingMs(1_000, 1_000)).toBe(5_000)
    expect(splashReadyWaitRemainingMs(1_000, 5_999)).toBe(1)
    expect(splashReadyWaitRemainingMs(1_000, 6_000)).toBe(0)
    expect(splashRemainingVisibleMs(1_000, 1_450)).toBe(750)
    expect(splashRemainingVisibleMs(1_000, 2_500)).toBe(0)
    expect(splashRemainingVisibleMs(0, 100)).toBe(0)
  })

  it('starts the minimum visible interval when the splash window is actually shown', () => {
    const controller = createSplashWindow({ appearance, dark: false, locale: 'en' })
    const browserWindow = splashWindows.at(-1)
    expect(controller.visibleAt).toBe(0)
    browserWindow?.emit('ready-to-show')
    expect(controller.visibleAt).toBeGreaterThan(0)
    expect(splashRemainingVisibleMs(controller.visibleAt, controller.visibleAt + 200)).toBe(1_000)
  })
})
