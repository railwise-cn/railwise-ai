// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createHash, webcrypto } from 'node:crypto'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyQualitySamplingWorkspace } from './SurveyQualitySamplingWorkspace'
import {
  validateSamplingInput, freezeSamplingPopulation, readSamplingPopulation, readSamplingRun, readSamplingUnits, readSamplingSamples,
  listSamplingPopulations, drawSamplingRun, verifySamplingRun, type SamplingBinding, type SamplingPopulation, type SamplingRun
} from '../../agent/survey-quality-sampling-client'
import { GBT24356_SAMPLING_SOURCE } from '../../../../../kun/src/engineering/survey-quality-sampling'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const hash = (char: string): string => char.repeat(64)
const binding: SamplingBinding = { projectId: 'project', projectRevision: 2, workspaceRoot: '/test' }
const definitionStatement = 'One completed survey section, with all source and result materials.\n保留原文。'
const units = Array.from({ length: 61 }, (_, index) => `unit-${String(index + 1).padStart(3, '0')}`)
const definitionHash = createHash('sha256').update(definitionStatement).digest('hex')
const populationHash = createHash('sha256').update(JSON.stringify(['survey-unit-product-frame-1', units])).digest('hex')
const input = { productType: 'Control survey', unitProductType: 'Section', definitionStatement, orderedUnitProductIds: units }
const population: SamplingPopulation = { schemaVersion: 1, id: 'population-1', projectId: 'project', projectRevision: 2, projectBindingHash: hash('a'),
  productType: input.productType, unitProductType: input.unitProductType, definitionEvidenceSha256: definitionHash, definitionSizeBytes: new TextEncoder().encode(definitionStatement).byteLength,
  populationHash, unitCount: units.length, createdAt: '2026-09-20T00:00:00.000Z', definitionStatement,
  definitionTrust: 'user-declared-not-professionally-verified', populationCompleteness: 'caller-declared-not-verified' }
const run: SamplingRun = { schemaVersion: 1, id: 'run-1', projectId: 'project', projectRevision: 2, projectBindingHash: hash('a'), populationId: population.id,
  populationHash, definitionEvidenceSha256: definitionHash, unitCount: units.length, stage: 'acceptance', inspectionMode: 'census', round: 1,
  algorithmVersion: 'quality-sampling-hmac-sha256-fy-1', source: { ...GBT24356_SAMPLING_SOURCE } as SamplingRun['source'], requestHash: hash('d'), planHash: hash('e'), runHash: hash('f'),
  sampleSize: units.length, batchCount: 1, batches: [{ batchIndex: 0, batchSize: units.length, nominalTableSampleSize: 9, sampleSize: units.length, census: true }],
  randomSource: 'not-applicable', createdAt: '2026-09-20T00:00:00.000Z', decision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
  populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' }
const populationSummary = (): Omit<SamplingPopulation, 'definitionStatement'> => {
  const { definitionStatement: ignored, ...summary } = population; void ignored; return summary
}
const verification = () => ({ schemaVersion: 1, projectId: binding.projectId, populationId: population.id, runId: run.id, planHash: run.planHash, runHash: run.runHash,
  checkedAt: run.createdAt, recordIntegrity: 'verified', recomputed: true, checkpointTrust: 'local-records-only', decision: 'not-evaluated', standardConformity: 'not-evaluated',
  humanSignatureVerification: 'not-evaluated', populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' })
const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
const runtimeRequest = vi.fn()
let host: HTMLDivElement, root: Root
async function render(overrides: Partial<Parameters<typeof SurveyQualitySamplingWorkspace>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(SurveyQualitySamplingWorkspace, { binding, runtimeReady: true, ...overrides })))
}
async function click(target: HTMLElement): Promise<void> { await act(async () => target.click()) }
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(item => item.textContent === text)!
function field<T extends HTMLElement>(text: string): T {
  return [...host.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === text)!.querySelector('input, textarea, select') as unknown as T
}
async function edit(text: string, value: string): Promise<void> {
  const target = field<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(text)
  await act(async () => {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function open(): Promise<void> { await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) }) }
async function fill(): Promise<void> {
  await edit('Product type', input.productType); await edit('Unit product type', input.unitProductType)
  await edit('Unit product definition statement', definitionStatement); await edit('Ordered unit product IDs (one per line)', units.join('\n'))
}
async function waitForPopulation(): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(button('Execute first-round selection')).toBeDefined()
  })
}
async function freeze(): Promise<void> {
  await fill(); await click(field('I have checked the unit definition and ordered population and confirm freezing this declaration.')); await click(button('Freeze unit product population'))
  await waitForPopulation()
}
async function choose(stage = 'acceptance', mode = 'census'): Promise<void> {
  await edit('Inspection stage', stage); await edit('Inspection mode', mode)
  await click(field('I confirm the frozen population, inspection stage and mode and will execute the single first round.'))
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  await i18n.changeLanguage('en')
  runtimeRequest.mockReset().mockImplementation(async (path: string, method = 'GET', payload?: string) => {
    if (path.endsWith('/sampling-populations') && method === 'POST') return response(population)
    if (path.includes('/sampling-populations?')) return response({ populations: [populationSummary()], unavailable: [], nextOffset: null })
    if (path.endsWith('/sampling-populations/population-1')) return response(population)
    if (path.endsWith('/sampling-runs') && method === 'POST') {
      const body = JSON.parse(payload!)
      return response({ ...run, stage: body.stage, inspectionMode: body.inspectionMode,
        ...(body.inspectionMode === 'table-1-simple-random' ? { sampleSize: 9, randomSource: 'runtime-generated-local-unwitnessed', batches: [{ ...run.batches[0], sampleSize: 9, census: false }] } : {}) })
    }
    if (path.includes('/sampling-runs?')) return response({ runs: [run], unavailable: [], nextOffset: null })
    if (path.endsWith('/sampling-runs/run-1')) return response(run)
    if (path.includes('/units?') || path.includes('/samples?')) {
      const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset'))
      const rows = units.slice(offset, offset + 50).map((unitProductId, index) => ({ index: offset + index, unitProductId }))
      return response({ projectId: binding.projectId, offset, total: units.length, nextOffset: offset + rows.length < units.length ? offset + rows.length : null,
        ...(path.includes('/units?') ? { populationId: population.id, populationHash: population.populationHash, units: rows } : { runId: run.id, planHash: run.planHash, samples: rows.map(row => ({ ...row, batchIndex: 0 })) }) })
    }
    if (path.endsWith('/verify')) return response(verification())
    throw new Error(`Unexpected path ${path}`)
  })
  Object.assign(window, { workwise: { runtimeRequest } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('quality sampling desktop workspace', () => {
  it('binds questions to the loaded run and paged sample identity without a runtime request', async () => {
    const focus = vi.fn()
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/test', projectId: 'project', projectRevision: 2, ready: true, focus }, children: createElement(SurveyQualitySamplingWorkspace, { binding, runtimeReady: true }) })))
    await open(); await freeze(); await choose(); await click(button('Execute first-round selection')); await click(button('Read selected samples')); await click(button('Next page'))
    const question = host.querySelector('li button[aria-label*="unit-051"]') as HTMLButtonElement
    expect(question).not.toBeNull(); runtimeRequest.mockClear(); await click(question)
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'project'])]?.evidenceContext?.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project', projectRevision: 2, kind: 'sampling-run', runId: run.id, runHash: run.runHash, planHash: run.planHash, sampleIndex: 50, unitId: units[50] })
    await click(button('Read sampling history'))
    expect(host.querySelector('button[aria-label*="unit-051"]')).toBeNull()
  })

  it('requires an explicit population declaration and separate stage/mode confirmation, with no supplied seed or inferred units', async () => {
    await render(); await open(); expect(runtimeRequest).not.toHaveBeenCalled()
    expect(button('Freeze unit product population').disabled).toBe(true)
    expect(field<HTMLInputElement>('Product type').value).toBe('')
    await freeze()
    expect(JSON.parse(runtimeRequest.mock.calls[0]![2])).toEqual({ ...input, expectedProjectRevision: 2, idempotencyKey: expect.any(String) })
    expect(host.textContent).toContain(definitionStatement)
    expect(button('Execute first-round selection').disabled).toBe(true)
    expect(field<HTMLSelectElement>('Inspection stage').value).toBe('')
    await choose('acceptance', 'table-1-simple-random')
    await click(button('Execute first-round selection'))
    expect(JSON.parse(runtimeRequest.mock.calls.at(-1)![2])).toEqual({ populationId: population.id, stage: 'acceptance', inspectionMode: 'table-1-simple-random', idempotencyKey: expect.any(String) })
    expect(host.textContent).toContain('9 unit products selected')
    expect(host.textContent).toContain('without an external witness')
    expect(host.textContent).toContain('it does not export sampling records')
    expect(host.textContent).toContain('Declared quality scoring calculates scores')
    expect(host.textContent).toContain('Declared inspection linkage assessment links retained materials and unit scores within its stated limits')
    expect(host.textContent).toContain('Stage completion and professional sign-off are not implemented')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('不代表质量批准或规范合格')
    expect(host.textContent).toContain('不提供抽样记录导出')
    expect(host.textContent).toContain('声明评分在“质量评分试算”中计算')
    expect(host.textContent).toContain('在“声明检查关联评估”中按限定范围关联')
    expect(host.textContent).toContain('阶段完成判定与专业签认尚未实施')
  })

  it.each(['process', 'final-office'])('restricts %s to an explicitly chosen census and resets acknowledgment when stage changes', async stage => {
    await render(); await open(); await freeze(); await choose('acceptance', 'table-1-simple-random')
    await edit('Inspection stage', stage)
    expect(field<HTMLSelectElement>('Inspection mode').value).toBe('')
    expect([...field<HTMLSelectElement>('Inspection mode').options].map(option => option.value)).toEqual(['', 'census'])
    expect(button('Execute first-round selection').disabled).toBe(true)
    await edit('Inspection mode', 'census')
    await click(field('I confirm the frozen population, inspection stage and mode and will execute the single first round.'))
    await click(button('Execute first-round selection'))
    expect(JSON.parse(runtimeRequest.mock.calls.at(-1)![2])).toMatchObject({ stage, inspectionMode: 'census' })
  })

  it('invalidates the freeze acknowledgment on edits and rejects duplicates without truncating input', async () => {
    await render(); await open(); await fill()
    const ack = field<HTMLInputElement>('I have checked the unit definition and ordered population and confirm freezing this declaration.')
    await click(ack); await edit('Ordered unit product IDs (one per line)', 'unit-1\nunit-1')
    expect(ack.checked).toBe(false)
    expect(button('Freeze unit product population').disabled).toBe(true)
    expect(field<HTMLTextAreaElement>('Ordered unit product IDs (one per line)').value).toBe('unit-1\nunit-1')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('pages ordered units and selected samples without rendering the full frame, and freshly verifies history reads', async () => {
    await render(); await open(); await click(button('Read population history'))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.startsWith('Verify and restore population'))!)
    await waitForPopulation()
    expect(runtimeRequest).toHaveBeenLastCalledWith('/v1/engineering/projects/project/sampling-populations/population-1', 'GET')
    await click(button('Read population units'))
    expect(host.textContent).toContain(units[49]); expect(host.textContent).not.toContain(units[50])
    await click(button('Next page'))
    expect(host.textContent).toContain(units[60]); expect(host.textContent).not.toContain(units[0])
    await click(button('Previous page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('limit=50&offset=0')
    await choose(); await click(button('Execute first-round selection')); await click(button('Read selected samples'))
    expect(host.textContent).toContain(units[49]); expect(host.textContent).not.toContain(units[50])
    await click(button('Next page')); expect(host.textContent).toContain(units[60])
    await click(button('Read sampling history'))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.startsWith('Verify and restore sampling run'))!)
    expect(runtimeRequest.mock.calls.at(-1)![0]).toBe('/v1/engineering/projects/project/sampling-runs/run-1')
    await click(button('Reverify local sampling record'))
    expect(runtimeRequest.mock.calls.at(-2)!.slice(0, 3)).toEqual(['/v1/engineering/projects/project/sampling-runs/run-1/verify', 'POST', '{}'])
    expect(host.textContent).toContain('Frozen local evidence and algorithm replay were checked')
  })

  it('shows unavailable history entries without restore buttons', async () => {
    await render(); await open()
    runtimeRequest.mockResolvedValueOnce(response({ populations: [], unavailable: [{ id: 'stale-pop', reason: 'stale' }, { id: 'damaged-pop', reason: 'integrity' }], nextOffset: null }))
    await click(button('Read population history'))
    expect(host.textContent).toContain('stale-pop'); expect(host.textContent).toContain('damaged-pop')
    expect([...host.querySelectorAll('button')].some(item => /stale-pop|damaged-pop/.test(item.textContent!))).toBe(false)
  })

  it('reads history through bounded pages counting unavailable entries without creating records', async () => {
    await render(); await open()
    runtimeRequest.mockResolvedValueOnce(response({ populations: Array.from({ length: 19 }, (_, index) => ({ ...populationSummary(), id: `history-${index}` })), unavailable: [{ id: 'stale-history', reason: 'stale' }], nextOffset: 20 }))
    await click(button('Read population history'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('limit=20&offset=0')
    runtimeRequest.mockResolvedValueOnce(response({ populations: [], unavailable: [], nextOffset: null }))
    await click(button('Next page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('limit=20&offset=20')
    await click(button('Previous page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('limit=20&offset=0')
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('retries ambiguous mutations with exactly the same body and prevents repeated clicks', async () => {
    await render(); await open(); await freeze(); await choose()
    runtimeRequest.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { button('Execute first-round selection').click(); button('Execute first-round selection').click() })
    expect(runtimeRequest).toHaveBeenCalledTimes(2)
    const original = runtimeRequest.mock.calls.at(-1)!
    expect(host.textContent).not.toContain('First-round selection record')
    await click(button('Retry the same request'))
    expect(runtimeRequest.mock.calls.at(-1)).toEqual(original)
    expect(host.textContent).toContain('First-round selection record')
  })

  it.each([{ runtimeReady: false }, { binding: { ...binding, projectRevision: 3 } }, { binding: { ...binding, projectId: 'other' } }, { binding: { ...binding, workspaceRoot: '/other' } }])('discards late responses and acknowledgments for an obsolete scope: %o', async overrides => {
    await render(); await open(); await fill(); await click(field('I have checked the unit definition and ordered population and confirm freezing this declaration.'))
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(button('Freeze unit product population'))
    await render(overrides); await act(async () => complete(response(population)))
    expect(host.textContent).not.toContain('population-1')
    expect(button('Freeze unit product population').disabled).toBe(true)
    expect(field<HTMLInputElement>('Product type').value).toBe('')
  })

  it('does not issue the follow-up reverify read after the scope changes', async () => {
    await render(); await open(); await click(button('Read sampling history'))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.startsWith('Verify and restore sampling run'))!)
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(button('Reverify local sampling record')); runtimeRequest.mockClear()
    await render({ runtimeReady: false }); await act(async () => complete(response(verification())))
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Runtime offline')
  })

  it('rejects multibyte and unit-count limits without silently trimming or dropping values', () => {
    expect(validateSamplingInput(binding, input)).toBe(true)
    for (const orderedUnitProductIds of [[''], [' x'], ['x '], ['x', 'x'], ['\ud800'], Array.from({ length: 10_001 }, (_, i) => `unit-${i}`)]) {
      expect(validateSamplingInput(binding, { ...input, orderedUnitProductIds })).toBe(false)
    }
    expect(validateSamplingInput(binding, { ...input, definitionStatement: '中'.repeat(22_000) })).toBe(false)
    expect(validateSamplingInput(binding, { ...input, orderedUnitProductIds: Array.from({ length: 10_000 }, (_, i) => `${i}-${'中'.repeat(100)}`) })).toBe(false)
  })

  it('rejects mixed historical identities, revisions, counts and changed definitions', async () => {
    for (const modified of [{ ...population, id: 'other' }, { ...population, projectRevision: 3 }, { ...population, definitionStatement: 'altered' }]) {
      runtimeRequest.mockResolvedValueOnce(response(modified))
      await expect(readSamplingPopulation(binding, population)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    runtimeRequest.mockResolvedValueOnce(response({ ...population, definitionStatement: definitionStatement.replace('One', 'Two') }))
    await expect(readSamplingPopulation(binding, populationSummary())).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValueOnce(response({ ...run, id: 'other' }))
    await expect(readSamplingRun(binding, run)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValueOnce(response({ ...run, stage: 'final-field' }))
    await expect(drawSamplingRun(binding, population, 'acceptance', 'census', 'request-identity')).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValueOnce(response({ populations: [populationSummary(), populationSummary()], unavailable: [], nextOffset: null }))
    await expect(listSamplingPopulations(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
  })

  it('rejects wrong population pages, missing units, wrong sample batch and mixed verification identities', async () => {
    const page = { projectId: 'project', populationId: population.id, populationHash: population.populationHash, offset: 0, total: units.length, nextOffset: 50, units: units.slice(0, 50).map((unitProductId, index) => ({ index, unitProductId })) }
    for (const modified of [{ ...page, populationHash: hash('d') }, { ...page, units: page.units.slice(1) }, { ...page, offset: 1 }, { ...page, nextOffset: 49 }]) {
      runtimeRequest.mockResolvedValueOnce(response(modified))
      await expect(readSamplingUnits(binding, population)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    runtimeRequest.mockResolvedValueOnce(response({ projectId: 'project', runId: run.id, planHash: run.planHash, offset: 0, total: units.length, nextOffset: 50, samples: page.units.map(item => ({ ...item, batchIndex: 1 })) }))
    await expect(readSamplingSamples(binding, run)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValueOnce(response({ ...verification(), runHash: hash('a') }))
    await expect(verifySamplingRun(binding, run)).rejects.toMatchObject({ reason: 'invalid-response' })
  })

  it('accepts reordered JSON keys while binding exact frozen input hashes', async () => {
    const reverse = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).reverse())
    runtimeRequest.mockResolvedValueOnce(response(reverse(population)))
    await expect(readSamplingPopulation(binding, population)).resolves.toMatchObject({ id: population.id })
    runtimeRequest.mockResolvedValueOnce(response(reverse({ ...run, source: reverse(run.source) })))
    await expect(readSamplingRun(binding, run)).resolves.toMatchObject({ id: run.id })
    for (const modified of [{ ...population, populationHash: hash('a') }, { ...population, definitionEvidenceSha256: hash('a') }]) {
      runtimeRequest.mockResolvedValueOnce(response(modified))
      await expect(freezeSamplingPopulation(binding, input, 'fixed-request-key')).rejects.toMatchObject({ reason: 'invalid-response' })
    }
  })

  it('localizes integrity failures without exposing raw paths or allowing a mutation retry', async () => {
    await render(); await open()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: JSON.stringify({ code: 'sampling_workspace_integrity', message: '/secret/path' }) })
    await click(button('Read population history'))
    expect(host.textContent).toContain('verification failed')
    expect(host.textContent).not.toContain('/secret/path')
    expect(button('Retry the same request')).toBeUndefined()
  })
})
