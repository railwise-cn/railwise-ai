import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SurveyStandardRegistry, surveyStandardRuleDigest, type SurveyStandardTrust } from './survey-standard-registry.js'
import { SurveyStandardRuleV1, SURVEY_SCANNED_PDF_LIMITS, type SurveyRuleContextV1 } from '../contracts/survey-standard-quality.js'

// Deliberately fictional rule. No number in this fixture is a normative survey limit.
const bytes = Buffer.from('Synthetic test standard: absolute sample value <= 7 test-units.')
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex')
function rule(): SurveyStandardRuleV1 {
  return { schemaVersion: 1, standardCode: 'TEST-ONLY', standardVersion: '2026', ruleId: 'sample-limit', ruleVersion: '1',
    locator: { clause: 'fixture-1', table: 'fixture-table' },
    source: { url: 'https://example.test/test-only', retrievedAt: '2026-09-19T00:00:00Z', kind: 'full-text',
      sha256: hash(bytes), excerpt: { byteOffset: 0, byteLength: bytes.length, sha256: hash(bytes) } },
    scope: { taskTypes: ['test-network'], grades: ['test-grade'], jurisdictions: ['test-region'] },
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: '2027-01-01T00:00:00Z',
    assertion: { metric: 'test-error', unit: 'test-units', operator: 'abs-lte', threshold: 7 } }
}
function context(): SurveyRuleContextV1 {
  return { taskType: 'test-network', grade: 'test-grade', jurisdiction: 'test-region', at: '2026-09-19T00:00:00Z',
    metric: 'test-error', unit: 'test-units', value: -7 }
}
function trust(rules: SurveyStandardRuleV1[] = [rule()]): SurveyStandardTrust {
  return { fullTextSha256: new Set([hash(bytes)]), reviewedRuleDigests: new Set(rules.map(surveyStandardRuleDigest)), readSource: () => bytes }
}

describe('versioned standard rule registry', () => {
  it('preserves legacy source fields and the previously reviewed rule digest exactly', () => {
    expect(SurveyStandardRuleV1.parse(rule())).toEqual(rule())
    expect(surveyStandardRuleDigest(rule())).toBe('2ed1de856274a9db50f8113d6cdf6661fcd3e184e9f8b260f38f1ff86211f2d7')
    const metadata = rule(); metadata.source.kind = 'official-metadata'; delete metadata.source.sha256
    delete metadata.source.excerpt; delete metadata.locator
    expect(SurveyStandardRuleV1.parse(metadata)).toEqual(metadata)
  })

  it('evaluates a reviewed predicate at the equality boundary without claiming overall conformity', () => {
    const registry = new SurveyStandardRegistry([rule()], trust())
    expect(registry.evaluate(rule(), context())).toMatchObject({ outcome: 'passed', standardConformity: 'not-evaluated' })
    expect(registry.evaluate(rule(), { ...context(), value: -7.001 }).outcome).toBe('failed')
  })

  it.each(['lte', 'gte'] as const)('evaluates the %s operator', operator => {
    const r = rule(); r.assertion!.operator = operator
    const registry = new SurveyStandardRegistry([r], trust([r]))
    expect(registry.evaluate(r, { ...context(), value: 7 }).outcome).toBe('passed')
    expect(registry.evaluate(r, { ...context(), value: operator === 'lte' ? 8 : 6 }).outcome).toBe('failed')
  })

  it('never substitutes standard or rule versions', () => {
    const registry = new SurveyStandardRegistry([rule()], trust())
    expect(registry.evaluate({ ...rule(), standardVersion: '2025' }, context()).reason).toBe('exact-rule-version-unavailable')
    expect(registry.evaluate({ ...rule(), ruleVersion: '2' }, context()).reason).toBe('exact-rule-version-unavailable')
  })

  it('isolates incompatible standard editions and rejects duplicate exact versions', () => {
    const other = rule(); other.standardVersion = '2025'; other.assertion!.threshold = 3
    const registry = new SurveyStandardRegistry([rule(), other], trust([rule(), other]))
    expect(registry.evaluate(rule(), context()).outcome).toBe('passed')
    expect(registry.evaluate(other, context()).outcome).toBe('failed')
    expect(() => new SurveyStandardRegistry([rule(), rule()], trust())).toThrow('Duplicate')
  })

  it('cannot promote official metadata to an executable rule even if it contains a threshold', () => {
    const r = rule(); r.source.kind = 'official-metadata'; delete r.locator
    let reads = 0
    const registry = new SurveyStandardRegistry([r], { ...trust([r]), readSource: () => { reads++; return bytes } })
    expect(registry.evaluate(r, context()).reason).toBe('metadata-only')
    expect(reads).toBe(0)
  })

  it('requires scope, exact units, metric and a half-open effective period', () => {
    const registry = new SurveyStandardRegistry([rule()], trust())
    for (const update of [{ grade: 'other' }, { jurisdiction: 'other' }, { taskType: 'other' },
      { at: '2025-12-31T23:59:59Z' }, { at: '2027-01-01T08:00:00+08:00' }]) {
      expect(registry.evaluate(rule(), { ...context(), ...update }).outcome).toBe('not-evaluated')
    }
    expect(registry.evaluate(rule(), { ...context(), at: '2026-01-01T00:00:00Z' }).outcome).toBe('passed')
    expect(registry.evaluate(rule(), { ...context(), unit: 'mm' }).reason).toBe('metric-or-unit-mismatch')
    expect(registry.evaluate(rule(), { ...context(), metric: 'other' }).reason).toBe('metric-or-unit-mismatch')
  })

  it('fails closed when source, full-text approval or exact rule approval is absent', () => {
    expect(new SurveyStandardRegistry([rule()], { ...trust(), fullTextSha256: new Set() })
      .evaluate(rule(), context()).reason).toBe('source-not-independently-trusted')
    expect(new SurveyStandardRegistry([rule()], { ...trust(), reviewedRuleDigests: new Set() })
      .evaluate(rule(), context()).reason).toBe('exact-rule-not-reviewed')
    for (const readSource of [() => undefined, () => { throw new Error('PRIVATE path') }]) {
      const result = new SurveyStandardRegistry([rule()], { ...trust(), readSource }).evaluate(rule(), context())
      expect(result.reason).toBe('source-unavailable')
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    }
    const r = rule(); delete r.source.excerpt
    expect(new SurveyStandardRegistry([r], trust([r])).evaluate(r, context()).reason).toBe('source-or-clause-evidence-missing')
    const noLocator = rule(); delete noLocator.locator
    expect(new SurveyStandardRegistry([noLocator], trust([noLocator])).evaluate(noLocator, context()).reason).toBe('source-or-clause-evidence-missing')
  })

  it('verifies the full bytes and bounded clause byte range independently', () => {
    expect(new SurveyStandardRegistry([rule()], { ...trust(), readSource: () => Buffer.from('tampered') })
      .evaluate(rule(), context()).reason).toBe('source-hash-mismatch')
    const r = rule(); r.source.excerpt!.byteOffset = bytes.length
    expect(new SurveyStandardRegistry([r], trust([r])).evaluate(r, context()).reason).toBe('clause-evidence-out-of-range')
    r.source.excerpt!.byteOffset = 0; r.source.excerpt!.sha256 = '1'.repeat(64)
    expect(new SurveyStandardRegistry([r], trust([r])).evaluate(r, context()).reason).toBe('clause-hash-mismatch')
  })

  it('refuses conflicting applicable rules without choosing a preferred threshold', () => {
    const other = rule(); other.ruleId = 'second-rule'; other.assertion!.threshold = 9
    const registry = new SurveyStandardRegistry([rule(), other], trust([rule(), other]))
    expect(registry.evaluate(rule(), context()).reason).toBe('conflicting-applicable-rules')
    expect(registry.evaluate(other, context()).reason).toBe('conflicting-applicable-rules')
  })

  it('does not let callers mutate a registration or trust set after construction', () => {
    const r = rule(); const t = trust([r]); const registry = new SurveyStandardRegistry([r], t)
    r.assertion!.threshold = 0
    ;(t.reviewedRuleDigests as Set<string>).clear()
    expect(registry.evaluate(rule(), context()).outcome).toBe('passed')
  })

  it('invalidates review when the exact rule changes and rejects invalid numeric inputs', () => {
    const r = rule(); r.assertion!.threshold = 8
    expect(new SurveyStandardRegistry([r], trust()).evaluate(r, context()).reason).toBe('exact-rule-not-reviewed')
    expect(() => new SurveyStandardRegistry([rule()], trust()).evaluate(rule(), { ...context(), value: NaN })).toThrow()
  })
})

// Synthetic bytes and injected raster only: these fixtures do not establish real PDF or human review evidence.
const pdfBytes = Buffer.from('%PDF-TEST-ONLY source fixture; not a real standard')
const rgb = Uint8Array.from({ length: 18 }, (_, index) => index + 1)
const reviewBytes = Buffer.from('TEST-ONLY agent cross-check record')
function scannedRule() {
  const source: Extract<SurveyStandardRuleV1['source'], { kind: 'scanned-pdf' }> = {
    url: 'https://example.test/test-only.pdf', retrievedAt: '2026-09-20T00:00:00Z', kind: 'scanned-pdf', sha256: hash(pdfBytes),
    scan: { pdfPage: 2, printedPage: 'I', rendering: { renderer: 'test-only-renderer', version: '1', dpi: 144 },
      pageImage: { sha256: hash(rgb), widthPixels: 3, heightPixels: 2 },
      region: { x: 1, y: 0, width: 2, height: 2, sha256: hash(Buffer.concat([rgb.subarray(3, 9), rgb.subarray(12, 18)])) },
      transcription: { text: bytes.toString('utf8'), sha256: hash(bytes), method: 'agent',
        recordedAt: '2026-09-20T00:00:00Z', recordedBy: { id: 'test-agent-1', kind: 'agent' } },
      review: { outcome: 'confirmed', transcriptionSha256: hash(bytes), evidenceSha256: hash(reviewBytes),
        reviewedAt: '2026-09-20T01:00:00Z', reviewedBy: { id: 'test-agent-2', kind: 'agent' } } }
  }
  return { ...rule(), source }
}
function scanTrust(r: SurveyStandardRuleV1 = scannedRule()): SurveyStandardTrust {
  const retained = new Map([[hash(pdfBytes), pdfBytes], [hash(reviewBytes), reviewBytes]])
  return { fullTextSha256: new Set([hash(pdfBytes)]), reviewedRuleDigests: new Set([surveyStandardRuleDigest(r)]),
    readSource: digest => retained.get(digest),
    renderPdfPage: () => ({ pageCount: 4, widthPixels: 3, heightPixels: 2, rgb }) }
}

describe('scanned PDF standard evidence', () => {
  it('binds the exact source/page/render recipe and hashes RGB rows across a non-contiguous region', () => {
    const r = scannedRule()
    const renderPdfPage = vi.fn(scanTrust().renderPdfPage!)
    const registry = new SurveyStandardRegistry([r], { ...scanTrust(), renderPdfPage })
    expect(registry.evaluate(r, context())).toMatchObject({ outcome: 'passed', standardConformity: 'not-evaluated' })
    expect(renderPdfPage).toHaveBeenCalledWith(Uint8Array.from(pdfBytes), { pdfPage: 2, rendering: r.source.scan.rendering,
      limits: { maxPagePixels: SURVEY_SCANNED_PDF_LIMITS.maxPagePixels, maxRgbBytes: SURVEY_SCANNED_PDF_LIMITS.maxRgbBytes } })
    expect(registry.evaluate(r, { ...context(), value: 8 }).outcome).toBe('failed')
  })

  it('allows full-page evidence and unnumbered pages without adding defaults', () => {
    const r = scannedRule(); delete r.source.scan.region; delete r.source.scan.printedPage
    expect(SurveyStandardRuleV1.parse(r)).toEqual(r)
    expect(new SurveyStandardRegistry([r], scanTrust(r)).evaluate(r, context()).outcome).toBe('passed')
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])('rejects invalid PDF page %s', pdfPage => {
    const r = scannedRule(); r.source.scan.pdfPage = pdfPage
    expect(SurveyStandardRuleV1.safeParse(r).success).toBe(false)
  })

  it('rejects missing PDF evidence, mixed byte/scan modes, and scan evidence attached to metadata', () => {
    const r = scannedRule()
    for (const source of [
      { ...r.source, sha256: undefined }, { ...r.source, scan: undefined },
      { ...r.source, excerpt: rule().source.excerpt }, { ...rule().source, scan: r.source.scan },
      { ...r.source, kind: 'official-metadata' }
    ]) expect(SurveyStandardRuleV1.safeParse({ ...r, source }).success).toBe(false)
  })

  it.each([
    { x: -1, y: 0, width: 1, height: 1 }, { x: 3, y: 0, width: 1, height: 1 },
    { x: 0, y: 2, width: 1, height: 1 }, { x: 1, y: 0, width: 3, height: 1 },
    { x: 0, y: 1, width: 1, height: 2 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 }
  ])('rejects invalid pixel region %j', region => {
    const r = scannedRule(); r.source.scan.region = { ...region, sha256: hash(rgb) }
    expect(SurveyStandardRuleV1.safeParse(r).success).toBe(false)
  })

  it('rejects empty transcriptions, invalid raster dimensions, and reviews predating transcription', () => {
    const r = scannedRule()
    for (const text of ['', ' \n\t', 'x'.repeat(65537)]) {
      expect(SurveyStandardRuleV1.safeParse({ ...r, source: { ...r.source, scan: { ...r.source.scan,
        transcription: { ...r.source.scan.transcription, text } } } }).success).toBe(false)
    }
    for (const widthPixels of [0, 1.5, 32769]) {
      expect(SurveyStandardRuleV1.safeParse({ ...r, source: { ...r.source, scan: { ...r.source.scan,
        pageImage: { ...r.source.scan.pageImage, widthPixels } } } }).success).toBe(false)
    }
    r.source.scan.review!.reviewedAt = '2026-09-19T23:59:59Z'
    expect(SurveyStandardRuleV1.safeParse(r).success).toBe(false)
  })

  it('retains transcription bytes exactly and refuses mismatched text or review binding', () => {
    const r = scannedRule(); r.source.scan.transcription.text += ' '
    expect(SurveyStandardRuleV1.parse(r).source.scan?.transcription.text.endsWith(' ')).toBe(true)
    expect(new SurveyStandardRegistry([r], scanTrust(r)).evaluate(r, context()).reason).toBe('scan-transcription-hash-mismatch')
    const wrongBinding = scannedRule(); wrongBinding.source.scan.review!.transcriptionSha256 = '0'.repeat(64)
    expect(new SurveyStandardRegistry([wrongBinding], scanTrust(wrongBinding)).evaluate(wrongBinding, context()).reason)
      .toBe('scan-review-transcription-mismatch')
  })

  it('does not promote recorded reviewer metadata into independent source or rule trust', () => {
    const r = scannedRule(); r.source.scan.review!.reviewedBy = { id: 'unverified-human-name', kind: 'human' }
    const renderPdfPage = vi.fn(scanTrust(r).renderPdfPage!)
    expect(new SurveyStandardRegistry([r], { ...scanTrust(r), fullTextSha256: new Set(), renderPdfPage })
      .evaluate(r, context()).reason).toBe('source-not-independently-trusted')
    expect(new SurveyStandardRegistry([r], { ...scanTrust(r), reviewedRuleDigests: new Set(), renderPdfPage })
      .evaluate(r, context()).reason).toBe('exact-rule-not-reviewed')
    expect(renderPdfPage).not.toHaveBeenCalled()
  })

  it('requires a confirmed transcription review and actual retained review bytes', () => {
    const r = scannedRule(); delete r.source.scan.review
    expect(new SurveyStandardRegistry([r], scanTrust(r)).evaluate(r, context()).reason).toBe('scan-transcription-review-incomplete')
    const pending = scannedRule(); pending.source.scan.review!.outcome = 'needs-correction'
    expect(new SurveyStandardRegistry([pending], scanTrust(pending)).evaluate(pending, context()).reason).toBe('scan-transcription-review-incomplete')
    for (const evidence of [undefined, Buffer.from('tampered')]) {
      const s = scannedRule()
      expect(new SurveyStandardRegistry([s], { ...scanTrust(), readSource: digest => digest === hash(pdfBytes) ? pdfBytes : evidence })
        .evaluate(s, context()).reason).toBe(evidence ? 'scan-review-evidence-hash-mismatch' : 'scan-review-evidence-unavailable')
    }
  })

  it('checks PDF bytes before attempting to render or read review evidence', () => {
    const r = scannedRule(); const renderPdfPage = vi.fn(scanTrust().renderPdfPage!)
    const readSource = vi.fn(() => Buffer.from('changed PDF'))
    expect(new SurveyStandardRegistry([r], { ...scanTrust(), readSource, renderPdfPage }).evaluate(r, context()).reason)
      .toBe('source-hash-mismatch')
    expect(readSource).toHaveBeenCalledTimes(1)
    expect(renderPdfPage).not.toHaveBeenCalled()
  })

  it('fails closed without a renderer or page and sanitizes renderer/review-reader exceptions', () => {
    const r = scannedRule()
    expect(new SurveyStandardRegistry([r], { ...scanTrust(), renderPdfPage: undefined }).evaluate(r, context()).reason)
      .toBe('scan-renderer-unavailable')
    for (const renderPdfPage of [() => undefined, () => { throw new Error('PRIVATE PDF path') }]) {
      const result = new SurveyStandardRegistry([r], { ...scanTrust(), renderPdfPage }).evaluate(r, context())
      expect(result.reason).toBe('scan-page-unavailable')
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    }
    const result = new SurveyStandardRegistry([r], { ...scanTrust(), readSource: digest => {
      if (digest === hash(pdfBytes)) return pdfBytes
      throw new Error('PRIVATE review path')
    } }).evaluate(r, context())
    expect(result.reason).toBe('scan-review-evidence-unavailable')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it('checks returned page count, dimensions, RGB length, and page pixels', () => {
    const r = scannedRule()
    const rendered = scanTrust().renderPdfPage!(pdfBytes, { pdfPage: 2, rendering: r.source.scan.rendering,
      limits: SURVEY_SCANNED_PDF_LIMITS })!
    for (const [patch, reason] of [
      [{ pageCount: 1 }, 'scan-page-out-of-range'], [{ pageCount: 0 }, 'scan-render-output-invalid'],
      [{ pageCount: 2.5 }, 'scan-render-output-invalid'], [{ widthPixels: 2 }, 'scan-render-output-invalid'],
      [{ heightPixels: 3 }, 'scan-render-output-invalid'], [{ rgb: rgb.subarray(1) }, 'scan-render-output-invalid'],
      [{ rgb: Uint8Array.from(rgb, value => value + 1) }, 'scan-page-hash-mismatch']
    ] as const) {
      expect(new SurveyStandardRegistry([r], { ...scanTrust(), renderPdfPage: () => ({ ...rendered, ...patch }) })
        .evaluate(r, context()).reason).toBe(reason)
    }
  })

  it('rejects a wrong region hash even when the full-page hash is correct', () => {
    const r = scannedRule(); r.source.scan.region!.sha256 = hash(rgb)
    expect(new SurveyStandardRegistry([r], scanTrust(r)).evaluate(r, context()).reason).toBe('scan-region-hash-mismatch')
  })

  it('invalidates the prior exact review on page, crop, text, render recipe or reviewer changes', () => {
    for (const modify of [
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.pdfPage++ },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.printedPage = 'II' },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.region!.x = 0 },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.transcription.text += 'changed' },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.rendering.dpi = 72 },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.rendering.version = '2' },
      (r: ReturnType<typeof scannedRule>) => { r.source.scan.review!.reviewedBy.id = 'other-reviewer' }
    ]) {
      const r = scannedRule(); modify(r)
      expect(new SurveyStandardRegistry([r], scanTrust()).evaluate(r, context()).reason).toBe('exact-rule-not-reviewed')
    }
  })

  it('protects registered source metadata from caller or renderer mutation', () => {
    const r = scannedRule()
    const renderPdfPage: SurveyStandardTrust['renderPdfPage'] = (_pdf, request) => {
      request.rendering.version = 'changed-by-renderer'
      return { pageCount: 4, widthPixels: 3, heightPixels: 2, rgb }
    }
    const registry = new SurveyStandardRegistry([r], { ...scanTrust(), renderPdfPage })
    r.source.scan.transcription.text = 'changed-by-caller'
    expect(registry.evaluate(r, context()).outcome).toBe('passed')
    expect(registry.evaluate(r, context()).outcome).toBe('passed')
  })

  it('bounds total pixels before constructing a registry or invoking a renderer', () => {
    const r = scannedRule(); delete r.source.scan.region
    r.source.scan.pageImage = { sha256: hash(rgb), widthPixels: 4000, heightPixels: 4000 }
    expect(SurveyStandardRuleV1.safeParse(r).success).toBe(true)
    const trusted = scanTrust(r); const renderPdfPage = vi.fn(trusted.renderPdfPage!)
    for (const size of [[4001, 4000], [32768, 32768]]) {
      r.source.scan.pageImage.widthPixels = size[0]; r.source.scan.pageImage.heightPixels = size[1]
      expect(() => new SurveyStandardRegistry([r], { ...trusted, renderPdfPage })).toThrow()
    }
    expect(renderPdfPage).not.toHaveBeenCalled()
  })

  it.each(['pdf', 'review'] as const)('rejects oversized %s bytes before copying or rendering', kind => {
    const oversized = new Uint8Array(0)
    Object.defineProperty(oversized, 'byteLength', {
      value: (kind === 'pdf' ? SURVEY_SCANNED_PDF_LIMITS.maxPdfBytes : SURVEY_SCANNED_PDF_LIMITS.maxReviewBytes) + 1
    })
    const iterate = vi.fn(() => { throw new Error('must not copy oversized input') })
    Object.defineProperty(oversized, Symbol.iterator, { value: iterate })
    const r = scannedRule(); const trusted = scanTrust()
    const renderPdfPage = vi.fn(trusted.renderPdfPage!)
    const readSource = (digest: string) => digest === hash(kind === 'pdf' ? pdfBytes : reviewBytes) ? oversized : trusted.readSource(digest)
    expect(new SurveyStandardRegistry([r], { ...trusted, readSource, renderPdfPage }).evaluate(r, context()).reason)
      .toBe(kind === 'pdf' ? 'scan-source-size-limit-exceeded' : 'scan-review-size-limit-exceeded')
    expect(iterate).not.toHaveBeenCalled()
    expect(renderPdfPage).not.toHaveBeenCalled()
  })

  it.each(['pdf', 'review'] as const)('rejects empty or invalid declared %s byte lengths before copying', kind => {
    for (const byteLength of [0, -1, 1.5, NaN]) {
      const invalid = new Uint8Array(0); Object.defineProperty(invalid, 'byteLength', { value: byteLength })
      const iterate = vi.fn(() => { throw new Error('must not copy invalid input') })
      Object.defineProperty(invalid, Symbol.iterator, { value: iterate })
      const r = scannedRule(); const trusted = scanTrust()
      const readSource = (digest: string) => digest === hash(kind === 'pdf' ? pdfBytes : reviewBytes) ? invalid : trusted.readSource(digest)
      expect(new SurveyStandardRegistry([r], { ...trusted, readSource }).evaluate(r, context()).reason)
        .toBe(kind === 'pdf' ? 'scan-source-size-invalid' : 'scan-review-size-invalid')
      expect(iterate).not.toHaveBeenCalled()
    }
  })
})
