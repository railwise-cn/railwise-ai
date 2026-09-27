// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SurveyStandardBasisRuleV1, SurveyStandardBasisCatalogV1, SurveyStandardBasisResolvedV1,
  SURVEY_STANDARD_BASIS_CATALOG_VERSION, RUNTIME_STANDARD_BASIS_PATH, runtimeStandardBasisPath
} from '@shared/survey-standard-basis'
import { readResultStandardBasis, scoringStandardBasisContext, standardBasisPdfPageUrl, type StandardBasisContext } from '../../agent/survey-standard-basis-client'
import { SurveyStandardBasis } from './SurveyStandardBasis'
import { scoreSurveyQualityV1 } from '../../../../../kun/src/engineering/survey-quality-scoring'
import { qualityScoringExample } from './survey-quality-scoring-examples'
import { QualityScoringResult } from './SurveyQualityScoringResult'
import { getSurveyStandardBasisCatalog, resolveSurveyStandardBasis } from '../../../../../kun/src/engineering/survey-standard-basis'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const localized = (zh: string, en: string) => ({ zh, en })
const locator = { clauses: ['6.2.4.1.1'], tables: [], printedPages: [6], pdfPages: [9], description: localized('合成测试条款说明', 'Synthetic test clause explanation') }
const rule = SurveyStandardBasisRuleV1.parse({
  standardCode: 'GB/T 24356-2023', standardVersion: '2023', ruleId: 'gbt24356-2023.scoring.accuracy', ruleVersion: '1',
  title: localized('数学精度依据', 'Accuracy basis'), summary: localized('只读测试目录', 'Read-only test catalog'),
  executor: { family: 'declared-scoring', operation: 'accuracy', algorithmVersion: 'gbt24356-declared-exact-quality-scoring-1', inputContract: 'SurveyQualityScoringInputV1', outputContract: 'SurveyQualityScoringOutputV1', implementationPath: 'kun/src/engineering/survey-quality-scoring.ts' },
  source: { kind: 'official-scanned-pdf', sha256: 'a'.repeat(64), officialUrl: 'https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf', publicationUrl: 'https://zrzy.guizhou.gov.cn/', metadataUrl: 'https://openstd.samr.gov.cn/', byteLength: 27976440, pageCount: 129,
    evidenceDocuments: [{ path: 'docs/test.md', sha256: 'b'.repeat(64) }], availability: 'public-url-and-retained-digest-no-runtime-fetch', redistribution: 'full-pdf-not-bundled-license-not-inferred' },
  locators: [locator], profiles: [{ profileId: 'planar-control-point', profileVersion: 'gbt24356-2023-control-declared-counts-1', label: localized('平面控制点', 'Planar control point'), unitProduct: 'point', locators: [{ ...locator, clauses: ['7.5.1'], tables: [43], printedPages: [58], pdfPages: [61] }] }],
  implementationChoices: [localized('声明数据试算', 'Declared-data trial')], exclusions: [localized('未核验人员签认', 'Human signatures unverified')],
  reviewIdentity: 'agent-reviewed-not-professional-signoff', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated', projectApplicability: 'not-evaluated', formalResultsModified: false
})
const entry = { rule, ruleDigest: hash(rule) }
const catalog = SurveyStandardBasisCatalogV1.parse({ schemaVersion: 1, catalogVersion: SURVEY_STANDARD_BASIS_CATALOG_VERSION, catalogDigest: hash([entry.ruleDigest]), rules: [entry], updatePolicy: 'exact-version-only-no-automatic-latest', historicalRecordsModified: false })
const context: StandardBasisContext = { schemaVersion: 1, family: rule.executor.family, operation: rule.executor.operation, standardCode: rule.standardCode,
  sourceSha256: rule.source.sha256, algorithmVersion: rule.executor.algorithmVersion, profileId: rule.profiles[0]!.profileId, profileVersion: rule.profiles[0]!.profileVersion }
const reference = { standardCode: rule.standardCode, standardVersion: rule.standardVersion, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion,
  sourceSha256: context.sourceSha256, algorithmVersion: context.algorithmVersion, profileId: context.profileId, profileVersion: context.profileVersion }
const resolved = SurveyStandardBasisResolvedV1.parse({ schemaVersion: 1, catalogVersion: SURVEY_STANDARD_BASIS_CATALOG_VERSION, status: 'resolved-basis-only', reference, entry, profile: rule.profiles[0], historicalRecordsModified: false })
const response = (value: unknown) => ({ ok: true, status: 200, body: JSON.stringify(value) })
const runtimeRequest = vi.fn(), openExternal = vi.fn()
let host: HTMLDivElement, root: Root
async function render(next: StandardBasisContext | null = context, runtimeReady = true): Promise<void> {
  await act(async () => root.render(createElement(SurveyStandardBasis, { context: next, runtimeReady })))
}
async function toggle(open = true): Promise<void> {
  await act(async () => {
    const details = host.querySelector('details')!
    details.open = open
    details.dispatchEvent(new Event('toggle'))
  })
}
async function loaded(): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('Accuracy basis')
  })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  await i18n.changeLanguage('en')
  runtimeRequest.mockReset().mockImplementation(async (path: string) => response(path === RUNTIME_STANDARD_BASIS_PATH ? catalog : resolved))
  openExternal.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { workwise: { runtimeRequest, openExternal } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('result standard basis client', () => {
  it('resolves all 16 built-in rule/profile bindings against the real runtime catalog contract', async () => {
    const builtIn = getSurveyStandardBasisCatalog()
    runtimeRequest.mockImplementation(async (path: string) => {
      if (path === RUNTIME_STANDARD_BASIS_PATH) return response(builtIn)
      const url = new URL(path, 'http://localhost'), parts = url.pathname.split('/')
      return response(resolveSurveyStandardBasis({ ...Object.fromEntries(url.searchParams), ruleId: parts.at(-2), ruleVersion: parts.at(-1) }))
    })
    let count = 0
    for (const { rule } of builtIn.rules) for (const profile of rule.profiles) {
      const value = await readResultStandardBasis({ schemaVersion: 1, family: rule.executor.family, operation: rule.executor.operation,
        standardCode: rule.standardCode, sourceSha256: rule.source.sha256, algorithmVersion: rule.executor.algorithmVersion,
        profileId: profile.profileId, profileVersion: profile.profileVersion })
      expect(value.entry.rule.ruleId).toBe(rule.ruleId)
      expect(value.profile).toEqual(profile)
      expect(value.entry.rule.humanSignatureVerification).toBe('not-evaluated')
      count++
    }
    expect(count).toBe(16)
    expect(runtimeRequest.mock.calls.every(call => call[1] === 'GET' && call.length === 2)).toBe(true)
  })
  it('reads exact retained identities without writes and preserves input bytes', async () => {
    const original = JSON.stringify(context)
    expect(await readResultStandardBasis(context)).toEqual(resolved)
    expect(runtimeRequest.mock.calls).toEqual([[RUNTIME_STANDARD_BASIS_PATH, 'GET'], [runtimeStandardBasisPath(reference), 'GET']])
    expect(JSON.stringify(context)).toBe(original)
  })
  it('rejects changed source, algorithm, profile, operation and unsupported historical schema without a detail fetch', async () => {
    for (const changed of [{ sourceSha256: 'c'.repeat(64) }, { algorithmVersion: 'old-algorithm' }, { profileId: 'height-control-section' }, { profileVersion: 'old-profile' }, { operation: 'unit' }, { schemaVersion: 2 }]) {
      runtimeRequest.mockClear()
      await expect(readResultStandardBasis({ ...context, ...changed })).rejects.toMatchObject({ reason: 'mismatch' })
      expect(runtimeRequest).toHaveBeenCalledTimes(1)
    }
  })
  it('associates all seven scoring operations and both profiles from actual saved-result contracts without changing them', () => {
    for (const operation of ['accuracy', 'deduction', 'unit', 'overview', 'sample', 'final-batch', 'acceptance-batch'] as const) {
      for (const profile of ['planar-control-point', 'height-control-section'] as const) {
        const result = scoreSurveyQualityV1(qualityScoringExample(operation, profile))
        const before = JSON.stringify(result)
        expect(scoringStandardBasisContext(result)).toMatchObject({ operation, profileId: profile, sourceSha256: result.source.sha256, algorithmVersion: result.algorithmVersion })
        expect(JSON.stringify(result)).toBe(before)
      }
    }
    expect(scoringStandardBasisContext(scoreSurveyQualityV1({}))).toBeNull()
  })
  it('rejects catalog tampering and ambiguous matches', async () => {
    for (const bad of [
      { ...catalog, catalogDigest: '0'.repeat(64) },
      { ...catalog, rules: [{ ...entry, ruleDigest: '0'.repeat(64) }] },
      { ...catalog, rules: [entry, entry], catalogDigest: hash([entry.ruleDigest, entry.ruleDigest]) }
    ]) {
      runtimeRequest.mockResolvedValue(response(bad))
      await expect(readResultStandardBasis(context)).rejects.toBeInstanceOf(Error)
    }
  })
  it('rejects detail substitution, profile substitution and unsafe official URLs', async () => {
    for (const bad of [
      { ...resolved, reference: { ...reference, ruleVersion: '2' } },
      { ...resolved, profile: { ...resolved.profile, profileId: 'height-control-section' } },
      { ...resolved, entry: { ...entry, ruleDigest: '0'.repeat(64) } }
    ]) {
      runtimeRequest.mockImplementation(async (path: string) => response(path === RUNTIME_STANDARD_BASIS_PATH ? catalog : bad))
      await expect(readResultStandardBasis(context)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    for (const officialUrl of ['javascript:alert(1)', 'https://evil.example/file.pdf', `${rule.source.officialUrl}?redirect=1`, `${rule.source.officialUrl}#page=1`]) {
      const changed = structuredClone(resolved); changed.entry.rule.source.officialUrl = officialUrl
      expect(() => standardBasisPdfPageUrl(changed, 9)).toThrow()
    }
    expect(() => standardBasisPdfPageUrl(resolved, 1)).toThrow()
  })
  it('keeps unavailable and mismatched server versions explicit', async () => {
    for (const [status, reason] of [[404, 'unavailable'], [409, 'mismatch'], [503, 'unavailable'], [500, 'request-failed']] as const) {
      runtimeRequest.mockResolvedValue({ ok: false, status, body: '{}' })
      await expect(readResultStandardBasis(context)).rejects.toMatchObject({ reason })
    }
  })
})

describe('accessible bilingual result standard basis', () => {
  it('prepares a precise stored-record clause question without fetching or sending', async () => {
    const focus = vi.fn(), parent = { kind: 'scoring' as const, recordId: 'selected-score', recordHash: 'c'.repeat(64) }
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/test', projectId: 'project', projectRevision: 2, ready: true, focus }, children: createElement(SurveyStandardBasis, { context, parent }) })))
    await toggle(); await loaded(); runtimeRequest.mockClear()
    await act(async () => (host.querySelector('button[aria-label*="6.2.4.1.1"]') as HTMLButtonElement).click())
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'project'])]?.evidenceContext?.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project', projectRevision: 2, kind: 'standard-basis', reference, ruleDigest: entry.ruleDigest, parent, selector: { path: ['entry', 'rule', 'locators', 0], identityPaths: [{ path: ['clauses', 0], equals: locator.clauses[0] }] } })
    await toggle(false); expect(host.querySelector('button[aria-label*="6.2.4.1.1"]')).toBeNull()
  })

  it.each([
    ['planar-control-point', [61, 62, 63, 60]],
    ['height-control-section', [64, 65, 66, 64]]
  ] as const)('opens actual catalog table pages before the clause introduction for %s', async (profile, expected) => {
    const actual = getSurveyStandardBasisCatalog()
    const result = scoreSurveyQualityV1(qualityScoringExample('accuracy', profile))
    const before = JSON.stringify(result)
    const actualContext = scoringStandardBasisContext(result)!
    runtimeRequest.mockImplementation(async (path: string) => {
      if (path === RUNTIME_STANDARD_BASIS_PATH) return response(actual)
      const url = new URL(path, 'http://localhost')
      return response(resolveSurveyStandardBasis({ ...Object.fromEntries(url.searchParams), ruleId: 'gbt24356-2023.scoring.accuracy', ruleVersion: '1' }))
    })
    await render(actualContext); await toggle()
    await vi.waitFor(() => expect(host.querySelectorAll('a')).toHaveLength(5))
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a')]
    expect(links.map(link => Number(new URL(link.href).hash.slice(6)))).toEqual([9, ...expected])
    for (const link of links.slice(1)) await act(async () => link.click())
    expect(openExternal.mock.calls.map(([url]) => Number(new URL(url).hash.slice(6)))).toEqual(expected)
    expect(JSON.stringify(result)).toBe(before)
  })
  it('exposes basis from a scoring result without fetching or mutating its decision', async () => {
    const result = scoreSurveyQualityV1(qualityScoringExample('accuracy', 'planar-control-point'))
    const before = JSON.stringify(result)
    await act(async () => root.render(createElement(QualityScoringResult, { result })))
    expect([...host.querySelectorAll('summary')].some(summary => summary.textContent === 'View standard basis')).toBe(true)
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).toBe(before)
  })
  it('loads only when expanded and opens the exact official PDF page through the desktop API', async () => {
    await render(); expect(runtimeRequest).not.toHaveBeenCalled()
    await toggle(); await loaded()
    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Standard basis for this result')
    expect(host.textContent).toContain('standards conformity and human signatures remain unevaluated')
    const link = host.querySelector<HTMLAnchorElement>('a')!
    expect(link.textContent).toContain('Printed page 6 · PDF page 9')
    expect(link.href).toBe(`${rule.source.officialUrl}#page=9`)
    await act(async () => link.click())
    expect(openExternal).toHaveBeenCalledWith(`${rule.source.officialUrl}#page=9`)
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('数学精度依据'); expect(host.textContent).toContain('合成测试条款说明')
    expect(host.textContent).toContain('印刷第 6 页 · PDF 第 9 页'); expect(host.textContent).toContain('人员签认仍为未评估')
    expect(runtimeRequest).toHaveBeenCalledTimes(2)
  })
  it('does not query incomplete identities or offline runtime', async () => {
    await render(null); await toggle(); expect(host.textContent).toContain('no complete source identity')
    expect(runtimeRequest).not.toHaveBeenCalled()
    await render(context, false); expect(host.textContent).toContain('runtime is unavailable')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })
  it('shows mismatch without links or a silent latest fallback', async () => {
    await render({ ...context, algorithmVersion: 'legacy' }); await toggle()
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('No unique exact catalog match'))
    expect(host.querySelector('a')).toBeNull(); expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })
  it('discards late responses when switching results and closing the view', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    runtimeRequest.mockImplementation(async (path: string) => path === RUNTIME_STANDARD_BASIS_PATH ? pending.promise : response(resolved))
    await render(); await toggle()
    await render({ ...context, algorithmVersion: 'legacy' }); await toggle(false)
    await act(async () => pending.resolve(response(catalog)))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(host.textContent).not.toContain('Accuracy basis'); expect(host.querySelector('a')).toBeNull()
  })
  it('offers retry for transport failures and reports browser-opening failure', async () => {
    runtimeRequest.mockRejectedValueOnce(new Error('offline'))
    await render(); await toggle()
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); await loaded()
    expect(document.activeElement).toBe(host.querySelector('h6'))
    openExternal.mockRejectedValueOnce(new Error('browser unavailable'))
    await act(async () => host.querySelector<HTMLAnchorElement>('a')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('official PDF could not be opened')
  })
})
