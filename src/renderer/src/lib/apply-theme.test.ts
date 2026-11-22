import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDocumentLocale, applyUiFontScale } from './apply-theme'

describe('applyDocumentLocale', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes a BCP-47 tag onto <html lang> for each supported locale', () => {
    const attributes = new Map<string, string>()
    vi.stubGlobal('document', {
      documentElement: {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value)
        }
      }
    })

    applyDocumentLocale('en')
    expect(attributes.get('lang')).toBe('en')

    applyDocumentLocale('zh')
    expect(attributes.get('lang')).toBe('zh-CN')
  })

  it('does not touch the attribute when the locale already matches', () => {
    let writes = 0
    vi.stubGlobal('document', {
      documentElement: {
        getAttribute: () => 'en',
        setAttribute: () => {
          writes += 1
        }
      }
    })

    applyDocumentLocale('en')
    expect(writes).toBe(0)
  })
})

describe('applyUiFontScale', () => {
  it('binds the saved scale to the application body', () => {
    const baseShellStyles = readFileSync(new URL('../styles/base-shell.css', import.meta.url), 'utf8')
    expect(baseShellStyles).toMatch(/\nbody\s*\{[^}]*zoom:\s*var\(--ds-ui-scale\)/)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['small', '0.9'],
    ['medium', '1'],
    ['large', '1.1']
  ] as const)('maps %s to a meaningful UI scale', (scale, expected) => {
    const setProperty = vi.fn()
    vi.stubGlobal('document', {
      documentElement: { style: { setProperty } }
    })

    applyUiFontScale(scale)

    expect(setProperty).toHaveBeenCalledWith('--ds-ui-scale', expected)
  })
})
