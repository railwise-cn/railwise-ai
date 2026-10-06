import { describe, expect, it } from 'vitest'
import { professionalCitationDisplay, professionalCitationLocator, professionalCitationSource } from './engineering-citation-text'

describe('professional citation presentation', () => {
  it('preserves survey filenames and engineering locations', () => {
    expect(professionalCitationDisplay('COSA.in2', 'attachment', '第 2-5 行')).toBe('COSA.in2 · 第 2-5 行')
    expect(professionalCitationSource('GB 50026-2020', 'standard')).toBe('GB 50026-2020')
    expect(professionalCitationLocator('第 6.3.2 条')).toBe('第 6.3.2 条')
  })

  it('hides implementation paths, hashes and internal records', () => {
    expect(professionalCitationSource('/Users/test/.workwise/deliverables/run-abc/manifest.json', 'attachment')).toBe('测量资料')
    expect(professionalCitationSource('sourceSha256: 7f3a1f2b', 'attachment')).toBe('测量资料')
    expect(professionalCitationLocator('contextHash=abc123')).toBeUndefined()
    expect(professionalCitationLocator('.workwise/deliverables/run/report.pdf')).toBeUndefined()
    expect(professionalCitationDisplay('internal-parser-fixture', 'other', 'selector=unknownPoints[0]')).toBe('引用来源')
  })

  it('uses the same professional fallback in English', () => {
    expect(professionalCitationSource('/private/tmp/manifest.json', 'attachment', true)).toBe('Survey attachment')
    expect(professionalCitationDisplay('inputHash=deadbeef', 'other', 'path=/tmp/a', true)).toBe('Referenced source')
  })
})
