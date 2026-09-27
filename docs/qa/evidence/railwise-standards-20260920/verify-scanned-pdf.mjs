#!/usr/bin/env node
// Local source/renderer contract probe; never registers a production or normative predicate.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const hash = value => createHash('sha256').update(value).digest('hex')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const kernelPath = resolve(root, 'kun/src/engineering/survey-standard-registry.ts')
const schemaPath = resolve(root, 'kun/src/contracts/survey-standard-quality.ts')
const kernelUrl = pathToFileURL(kernelPath).href
const schemaUrl = pathToFileURL(schemaPath).href
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--pdf', '--transcription', '--expected-pdf-sha256', '--pdf-page', '--printed-page', '--clause', '--region', '--dpi'].includes(key)
    || options.has(key) || !process.argv[i + 1]) throw new Error('Invalid explicit arguments')
  options.set(key, process.argv[i + 1])
}
const required = key => { const value = options.get(key); if (!value) throw new Error('Missing explicit argument'); return value }
const integer = (value, min = 1) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min) throw new Error('Invalid integer'); return n }

async function main() {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return next(context.parentURL === kernelUrl && specifier === '../contracts/survey-standard-quality.js' ? schemaUrl : specifier, context)
  } })
  let kernel, schema
  try { kernel = await import(kernelUrl); schema = await import(schemaUrl) } finally { hooks.deregister() }
  const { SurveyStandardRegistry, surveyStandardRuleDigest } = kernel
  const { SurveyStandardRuleV1, SURVEY_SCANNED_PDF_LIMITS: limits } = schema
  const pdfPath = required('--pdf')
  const transcriptPath = required('--transcription')
  const expected = required('--expected-pdf-sha256')
  const retainedSources = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'sources.json'), 'utf8'))
  const officialSource = retainedSources.sources.find(source => source.id === 'guizhou-full-text')
  assert.equal(expected, officialSource.sha256)
  const pdfPage = integer(required('--pdf-page'))
  const dpi = integer(required('--dpi'))
  const [x, y, width, height] = required('--region').split(',').map((n, i) => integer(n, i < 2 ? 0 : 1))
  assert.equal(required('--region').split(',').length, 4)
  assert.match(expected, /^[0-9a-f]{64}$/)
  assert.ok(statSync(pdfPath).size > 0 && statSync(pdfPath).size <= limits.maxPdfBytes)
  assert.ok(statSync(transcriptPath).size > 0 && statSync(transcriptPath).size <= 65536)
  const pdf = readFileSync(pdfPath)
  const transcriptBytes = readFileSync(transcriptPath)
  const transcription = new TextDecoder('utf-8', { fatal: true }).decode(transcriptBytes)
  assert.equal(hash(Buffer.from(transcription, 'utf8')), hash(transcriptBytes))
  assert.equal(hash(pdf), expected)
  const temporary = mkdtempSync(join(tmpdir(), 'railwise-scan-contract-'))
  let renderCalls = 0
  try {
    const retainedPdf = join(temporary, 'source.pdf')
    writeFileSync(retainedPdf, pdf, { mode: 0o600 })
    function command(executable, args, maxBuffer = 65536) {
      const result = spawnSync(executable, args, { encoding: null, timeout: 30000, maxBuffer,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
      if (result.error || result.status !== 0) throw new Error('Local rendering tool failed')
      return result
    }
    const versionRun = command('pdftoppm', ['-v'])
    const version = Buffer.concat([versionRun.stdout, versionRun.stderr]).toString('utf8').match(/pdftoppm version ([\d.]+)/)?.[1]
    assert.ok(version)
    const recipe = { renderer: 'poppler-pdftoppm-rgb8', version, dpi }

    function renderPdfPage(source, request) {
      assert.equal(hash(source), expected)
      assert.equal(request.rendering.renderer, recipe.renderer)
      assert.equal(request.rendering.version, version)
      const requestedDpi = integer(request.rendering.dpi)
      assert.ok(requestedDpi <= 1200)
      const page = integer(request.pdfPage)
      const pixelBudget = integer(request.limits.maxPagePixels)
      const byteBudget = integer(request.limits.maxRgbBytes)
      assert.ok(pixelBudget <= limits.maxPagePixels && byteBudget <= limits.maxRgbBytes)
      const info = command('pdfinfo', ['-f', String(page), '-l', String(page), retainedPdf]).stdout.toString('utf8')
      const pageCount = integer(info.match(/^Pages:\s+(\d+)$/m)?.[1])
      assert.ok(page <= pageCount)
      const dimensions = info.match(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/m)
      const rotation = Number(info.match(/^Page\s+\d+ rot:\s+(\d+)/m)?.[1])
      assert.ok(dimensions && [0, 90, 180, 270].includes(rotation))
      const pointWidth = Number(dimensions[1]); const pointHeight = Number(dimensions[2])
      assert.ok(Number.isFinite(pointWidth) && pointWidth > 0 && Number.isFinite(pointHeight) && pointHeight > 0)
      // pdfinfo prints rounded point sizes: reserve two pixels per edge before raster allocation.
      const estimateW = Math.ceil(pointWidth * requestedDpi / 72) + 2
      const estimateH = Math.ceil(pointHeight * requestedDpi / 72) + 2
      assert.ok(Number.isSafeInteger(estimateW * estimateH) && estimateW * estimateH <= pixelBudget)
      assert.ok(estimateW * estimateH * 3 <= byteBudget)
      renderCalls++
      const ppm = command('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-r', String(requestedDpi), retainedPdf], byteBudget + 1024).stdout
      const header = ppm.subarray(0, 128).toString('ascii').match(/^P6\s+(\d+)\s+(\d+)\s+255\r?\n/)
      assert.ok(header)
      const widthPixels = integer(header[1]); const heightPixels = integer(header[2])
      assert.ok(widthPixels * heightPixels <= pixelBudget && widthPixels * heightPixels * 3 <= byteBudget)
      const rgb = ppm.subarray(Buffer.byteLength(header[0], 'ascii'))
      assert.equal(rgb.byteLength, widthPixels * heightPixels * 3)
      return { pageCount, widthPixels, heightPixels, rgb }
    }

    const image = renderPdfPage(pdf, { pdfPage, rendering: recipe, limits })
    assert.ok(x + width <= image.widthPixels && y + height <= image.heightPixels)
    const regionHash = createHash('sha256')
    for (let row = y; row < y + height; row++) {
      const offset = (row * image.widthPixels + x) * 3
      regionHash.update(image.rgb.subarray(offset, offset + width * 3))
    }
    const region = { x, y, width, height, sha256: regionHash.digest('hex') }
    const transcriptionSha256 = hash(transcriptBytes)
    const reviewEvidence = Buffer.from(JSON.stringify({ kind: 'agent-contract-probe', reviewer: { id: 'source-review-agent', kind: 'agent' },
      pdfSha256: expected, pdfPage, pageImageSha256: hash(image.rgb), region, transcriptionSha256,
      verificationScope: 'byte-integrity-and-source-bindings-only', professionalSignatureVerified: false }))
    const at = '2026-09-20T00:00:00Z' // Probe record date, not an asserted professional signing time.
    const r = SurveyStandardRuleV1.parse({ schemaVersion: 1, standardCode: 'TEST-ONLY-SOURCE-BINDING', standardVersion: '1',
      ruleId: 'non-normative-zero-marker', ruleVersion: '1', locator: { clause: required('--clause') },
      source: { kind: 'scanned-pdf', url: officialSource.url,
        retrievedAt: at, sha256: expected, scan: { pdfPage, ...(options.has('--printed-page') ? { printedPage: options.get('--printed-page') } : {}),
          rendering: recipe, pageImage: { widthPixels: image.widthPixels, heightPixels: image.heightPixels, sha256: hash(image.rgb) }, region,
          transcription: { text: transcription, sha256: transcriptionSha256, method: 'agent', recordedAt: at,
            recordedBy: { id: 'source-review-agent', kind: 'agent' } },
          review: { outcome: 'confirmed', reviewedAt: at, reviewedBy: { id: 'source-review-agent', kind: 'agent' },
            transcriptionSha256, evidenceSha256: hash(reviewEvidence) } } },
      scope: { taskTypes: ['contract-probe'], grades: ['test-only'], jurisdictions: ['not-applicable'] },
      assertion: { metric: 'synthetic-zero-marker', unit: 'test-only', operator: 'lte', threshold: 0 } })
    const context = { taskType: 'contract-probe', grade: 'test-only', jurisdiction: 'not-applicable', at,
      metric: 'synthetic-zero-marker', unit: 'test-only', value: 0 }
    // These allowlists exist only inside this synthetic probe and do not establish independent human approval.
    const trust = { fullTextSha256: new Set([expected]), reviewedRuleDigests: new Set([surveyStandardRuleDigest(r)]),
      readSource: digest => digest === expected ? pdf : digest === hash(reviewEvidence) ? reviewEvidence : undefined, renderPdfPage }
    const evaluate = (rule, configuration = trust) => new SurveyStandardRegistry([rule], configuration).evaluate(rule, context)
    const positive = evaluate(r)
    assert.equal(positive.outcome, 'passed')
    assert.equal(positive.standardConformity, 'not-evaluated')
    const results = {}
    results.noTrustedSource = evaluate(r, { ...trust, fullTextSha256: new Set() }).reason
    assert.equal(results.noTrustedSource, 'source-not-independently-trusted')
    results.noReviewedDigest = evaluate(r, { ...trust, reviewedRuleDigests: new Set() }).reason
    assert.equal(results.noReviewedDigest, 'exact-rule-not-reviewed')
    const changedPage = structuredClone(r); changedPage.source.scan.pdfPage++
    results.changedPage = evaluate(changedPage).reason
    assert.equal(results.changedPage, 'exact-rule-not-reviewed')
    const changedText = structuredClone(r); changedText.source.scan.transcription.text += 'x'
    results.changedTranscription = evaluate(changedText).reason
    assert.equal(results.changedTranscription, 'exact-rule-not-reviewed')
    results.changedTextWithRecomputedProbeDigest = evaluate(changedText, { ...trust,
      reviewedRuleDigests: new Set([surveyStandardRuleDigest(changedText)]) }).reason
    assert.equal(results.changedTextWithRecomputedProbeDigest, 'scan-transcription-hash-mismatch')
    const changedRegion = structuredClone(r); changedRegion.source.scan.region.sha256 = '0'.repeat(64)
    results.changedRegionWithRecomputedProbeDigest = evaluate(changedRegion, { ...trust,
      reviewedRuleDigests: new Set([surveyStandardRuleDigest(changedRegion)]) }).reason
    assert.equal(results.changedRegionWithRecomputedProbeDigest, 'scan-region-hash-mismatch')
    const beforeOversizedRender = renderCalls
    assert.throws(() => renderPdfPage(pdf, { pdfPage, rendering: { ...recipe, dpi: 1200 }, limits }))
    assert.equal(renderCalls, beforeOversizedRender)
    results.oversizedRaster = 'rejected-before-pdftoppm'
    assert.equal(hash(readFileSync(pdfPath)), expected)
    console.log(JSON.stringify({ schemaVersion: 1, verificationScope: 'real-PDF-renderer-byte-and-binding-contract-only',
      source: { sha256: expected, byteLength: pdf.byteLength, pageCount: image.pageCount, pdfPage,
        printedPage: options.get('--printed-page') ?? null, clause: required('--clause') },
      rendering: recipe, pageImage: r.source.scan.pageImage, region, transcriptionSha256,
      transcriptionByteLength: transcriptBytes.byteLength, reviewEvidenceSha256: hash(reviewEvidence), reviewerKind: 'agent',
      positiveContractCheck: positive.outcome, standardConformity: positive.standardConformity,
      humanSignatureVerification: 'not-evaluated', syntheticTrustOnly: true, productionRuleRegistered: false,
      negativeChecks: results, inputUnchanged: true, renderCalls, limits,
      hashes: { scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), kernelSha256: hash(readFileSync(kernelPath)),
        schemaSha256: hash(readFileSync(schemaPath)) } }, null, 2))
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

main().catch(() => { console.error(JSON.stringify({ status: 'failed', reason: 'Explicit inputs, local tools, bounded rendering or source-binding checks failed; no source text emitted.' })); process.exitCode = 1 })
