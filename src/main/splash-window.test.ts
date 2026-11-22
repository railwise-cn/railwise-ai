import { describe, expect, it, vi } from 'vitest'
import {
  buildSplashHtml,
  SPLASH_MIN_VISIBLE_MS,
  splashProgressLabel,
  splashRemainingVisibleMs
} from './splash-window'

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }))

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
    expect(splashRemainingVisibleMs(1_000, 1_450)).toBe(750)
    expect(splashRemainingVisibleMs(1_000, 2_500)).toBe(0)
    expect(splashRemainingVisibleMs(0, 100)).toBe(0)
  })
})
