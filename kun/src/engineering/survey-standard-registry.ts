import { createHash } from 'node:crypto'
import {
  SurveyRuleContextV1, SurveyStandardRuleRefV1, SurveyStandardRuleV1, SURVEY_SCANNED_PDF_LIMITS,
  type SurveyRuleContextV1 as Context, type SurveyStandardRuleRefV1 as RuleRef,
  type SurveyStandardRuleV1 as Rule, type SurveyScannedPdfEvidenceV1 as Scan
} from '../contracts/survey-standard-quality.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function surveyStandardRuleDigest(input: Rule): string {
  return createHash('sha256').update(canonical(SurveyStandardRuleV1.parse(input))).digest('hex')
}

function key(rule: RuleRef): string {
  return JSON.stringify([rule.standardCode, rule.standardVersion, rule.ruleId, rule.ruleVersion])
}

function applicable(rule: Rule, context: Context): boolean {
  const at = Date.parse(context.at)
  return rule.scope.taskTypes.includes(context.taskType) && rule.scope.grades.includes(context.grade)
    && rule.scope.jurisdictions.includes(context.jurisdiction)
    && (!rule.effectiveFrom || at >= Date.parse(rule.effectiveFrom))
    && (!rule.effectiveUntil || at < Date.parse(rule.effectiveUntil))
}

export type SurveyStandardRuleEvaluation = {
  rule: RuleRef
  outcome: 'passed' | 'failed' | 'not-evaluated'
  reason: string
  ruleDigest?: string
  /** Evaluating one predicate cannot establish compliance with an entire standard. */
  standardConformity: 'not-evaluated'
}

export type SurveyStandardTrust = {
  /** Supplied by a trusted, independent source/license verification boundary. */
  fullTextSha256: ReadonlySet<string>
  /** Digests of exact rules reviewed against their full-text clauses, not source URLs. */
  reviewedRuleDigests: ReadonlySet<string>
  /** Retained full text and review evidence; never an arbitrary caller-supplied file path. */
  readSource: (sha256: string) => Uint8Array | undefined
  /** Trusted renderer must inspect page dimensions and enforce these budgets before raster allocation. */
  renderPdfPage?: (pdf: Uint8Array, request: { pdfPage: number; rendering: Scan['rendering'];
    limits: Pick<typeof SURVEY_SCANNED_PDF_LIMITS, 'maxPagePixels' | 'maxRgbBytes'> }) => {
    pageCount: number; widthPixels: number; heightPixels: number; rgb: Uint8Array
  } | undefined
}

/** No built-in thresholds, auto-upgrade, network requests, or wildcard scope matching. */
export class SurveyStandardRegistry {
  private readonly rules: Map<string, Rule>
  private readonly fullTextSha256: Set<string>
  private readonly reviewedRuleDigests: Set<string>
  private readonly readSource: SurveyStandardTrust['readSource']
  private readonly renderPdfPage: SurveyStandardTrust['renderPdfPage']

  constructor(inputs: readonly Rule[], trust: SurveyStandardTrust) {
    this.rules = new Map()
    for (const input of inputs) {
      const rule = SurveyStandardRuleV1.parse(input)
      if (this.rules.has(key(rule))) throw new Error('Duplicate exact standard rule version')
      this.rules.set(key(rule), rule)
    }
    this.fullTextSha256 = new Set(trust.fullTextSha256)
    this.reviewedRuleDigests = new Set(trust.reviewedRuleDigests)
    this.readSource = trust.readSource
    this.renderPdfPage = trust.renderPdfPage
  }

  evaluate(reference: RuleRef, input: Context): SurveyStandardRuleEvaluation {
    const ref = SurveyStandardRuleRefV1.parse({ standardCode: reference.standardCode,
      standardVersion: reference.standardVersion, ruleId: reference.ruleId, ruleVersion: reference.ruleVersion })
    const context = SurveyRuleContextV1.parse(input)
    const rule = this.rules.get(key(ref))
    const result = (outcome: SurveyStandardRuleEvaluation['outcome'], reason: string): SurveyStandardRuleEvaluation => ({
      rule: ref, outcome, reason, standardConformity: 'not-evaluated',
      ...(rule ? { ruleDigest: surveyStandardRuleDigest(rule) } : {})
    })
    if (!rule) return result('not-evaluated', 'exact-rule-version-unavailable')
    if (!applicable(rule, context)) return result('not-evaluated', 'outside-rule-scope-or-effective-period')
    if (!rule.assertion || rule.source.kind === 'official-metadata') return result('not-evaluated', 'metadata-only')
    const assertion = rule.assertion
    if (assertion.metric !== context.metric || assertion.unit !== context.unit) return result('not-evaluated', 'metric-or-unit-mismatch')
    const hash = rule.source.sha256
    if (!hash || !rule.locator || (rule.source.kind === 'full-text' && !rule.source.excerpt)) {
      return result('not-evaluated', 'source-or-clause-evidence-missing')
    }
    if (!this.fullTextSha256.has(hash)) return result('not-evaluated', 'source-not-independently-trusted')
    if (!this.reviewedRuleDigests.has(surveyStandardRuleDigest(rule))) return result('not-evaluated', 'exact-rule-not-reviewed')
    let bytes: Uint8Array | undefined
    try {
      const source = this.readSource(hash)
      if (source && rule.source.kind === 'scanned-pdf') {
        if (!(source instanceof Uint8Array) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1) {
          return result('not-evaluated', 'scan-source-size-invalid')
        }
        if (source.byteLength > SURVEY_SCANNED_PDF_LIMITS.maxPdfBytes) return result('not-evaluated', 'scan-source-size-limit-exceeded')
      }
      if (source) bytes = Uint8Array.from(source)
    } catch { return result('not-evaluated', 'source-unavailable') }
    if (!bytes) return result('not-evaluated', 'source-unavailable')
    if (createHash('sha256').update(bytes).digest('hex') !== hash) return result('not-evaluated', 'source-hash-mismatch')
    if (rule.source.kind === 'scanned-pdf') {
      const failure = this.verifyScan(bytes, rule.source.scan)
      if (failure) return result('not-evaluated', failure)
    } else {
      const excerpt = rule.source.excerpt!
      if (excerpt.byteOffset > bytes.byteLength || excerpt.byteLength > bytes.byteLength - excerpt.byteOffset) {
        return result('not-evaluated', 'clause-evidence-out-of-range')
      }
      if (createHash('sha256').update(bytes.subarray(excerpt.byteOffset, excerpt.byteOffset + excerpt.byteLength)).digest('hex') !== excerpt.sha256) {
        return result('not-evaluated', 'clause-hash-mismatch')
      }
    }
    // Never silently pick a looser/stricter candidate when overlapping registrations disagree.
    const conflict = [...this.rules.values()].some(other => other !== rule
      && other.standardCode === rule.standardCode && other.standardVersion === rule.standardVersion
      && applicable(other, context) && other.assertion?.metric === assertion.metric
      && (other.assertion.unit !== assertion.unit || other.assertion.operator !== assertion.operator
        || other.assertion.threshold !== assertion.threshold))
    if (conflict) return result('not-evaluated', 'conflicting-applicable-rules')
    const observed = assertion.operator === 'abs-lte' ? Math.abs(context.value) : context.value
    const passed = assertion.operator === 'gte' ? observed >= assertion.threshold : observed <= assertion.threshold
    return result(passed ? 'passed' : 'failed', 'exact-reviewed-predicate-evaluated')
  }

  private verifyScan(pdf: Uint8Array, scan: Scan): string | undefined {
    if (createHash('sha256').update(scan.transcription.text, 'utf8').digest('hex') !== scan.transcription.sha256) {
      return 'scan-transcription-hash-mismatch'
    }
    if (!scan.review || scan.review.outcome !== 'confirmed') return 'scan-transcription-review-incomplete'
    if (scan.review.transcriptionSha256 !== scan.transcription.sha256) return 'scan-review-transcription-mismatch'
    let evidence: Uint8Array | undefined
    try {
      const value = this.readSource(scan.review.evidenceSha256)
      if (value) {
        if (!(value instanceof Uint8Array) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1) {
          return 'scan-review-size-invalid'
        }
        if (value.byteLength > SURVEY_SCANNED_PDF_LIMITS.maxReviewBytes) return 'scan-review-size-limit-exceeded'
      }
      if (value) evidence = Uint8Array.from(value)
    } catch { return 'scan-review-evidence-unavailable' }
    if (!evidence) return 'scan-review-evidence-unavailable'
    if (createHash('sha256').update(evidence).digest('hex') !== scan.review.evidenceSha256) return 'scan-review-evidence-hash-mismatch'
    if (!this.renderPdfPage) return 'scan-renderer-unavailable'
    let rendered: ReturnType<NonNullable<SurveyStandardTrust['renderPdfPage']>>
    try {
      rendered = this.renderPdfPage(pdf, { pdfPage: scan.pdfPage, rendering: { ...scan.rendering }, limits: {
        maxPagePixels: SURVEY_SCANNED_PDF_LIMITS.maxPagePixels, maxRgbBytes: SURVEY_SCANNED_PDF_LIMITS.maxRgbBytes
      } })
      if (!rendered) return 'scan-page-unavailable'
      if (!Number.isSafeInteger(rendered.pageCount) || rendered.pageCount < 1) return 'scan-render-output-invalid'
      if (scan.pdfPage > rendered.pageCount) return 'scan-page-out-of-range'
      if (rendered.widthPixels !== scan.pageImage.widthPixels || rendered.heightPixels !== scan.pageImage.heightPixels
        || !(rendered.rgb instanceof Uint8Array)
        || rendered.rgb.byteLength > SURVEY_SCANNED_PDF_LIMITS.maxRgbBytes
        || rendered.rgb.byteLength !== rendered.widthPixels * rendered.heightPixels * 3) return 'scan-render-output-invalid'
      rendered = { ...rendered, rgb: Uint8Array.from(rendered.rgb) }
    } catch { return 'scan-page-unavailable' }
    if (createHash('sha256').update(rendered.rgb).digest('hex') !== scan.pageImage.sha256) return 'scan-page-hash-mismatch'
    if (scan.region) {
      const regionHash = createHash('sha256')
      for (let y = scan.region.y; y < scan.region.y + scan.region.height; y++) {
        const offset = (y * rendered.widthPixels + scan.region.x) * 3
        regionHash.update(rendered.rgb.subarray(offset, offset + scan.region.width * 3))
      }
      if (regionHash.digest('hex') !== scan.region.sha256) return 'scan-region-hash-mismatch'
    }
    return undefined
  }
}
