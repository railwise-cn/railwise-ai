import { describe, expect, it, vi } from 'vitest'
import {
  buildSplashHtml,
  SPLASH_MIN_VISIBLE_MS,
  splashProgressLabel,
  splashRemainingVisibleMs
} from './splash-window'

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }))

describe('splash window document', () => {
  it('shows the product, version, real progress, and accessibility fallbacks', () => {
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
        version: '0.3.5',
        locale: 'zh'
      },
      { progress: 0.42, label: '正在载入扩展' }
    )

    expect(html).toContain('<div class="brand">RailWise AI</div>')
    expect(html).toContain('<div class="version">0.3.5</div>')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('正在载入扩展')
    expect(html).toContain('prefers-reduced-transparency: reduce')
    expect(html).toContain('forced-colors: active')
  })

  it('clamps initial progress and localizes phase labels', () => {
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
        version: '<unsafe>',
        locale: 'en'
      },
      { progress: 3, label: '<ready>' }
    )

    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('&lt;unsafe&gt;')
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
