// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Buffer as NodeBuffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SurveyAdvancedTrialsWorkspaceService } from '../../../../kun/src/engineering/survey-advanced-trials-workspace.ts'
import { SurveyAdvancedModelWorkspace } from '../../../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx'
import { VceTrialResult } from '../../../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx'
import { runSurveyVceTrial } from '../../../../kun/src/engineering/survey-vce-trial.ts'
import { SurveyVceTrialOutputV1 } from '../../../../kun/src/contracts/survey-vce-trial.ts'
import { SURVEY_ADVANCED_TRIAL_LIMITS as LIMITS } from '../../../../src/shared/survey-advanced-trials.ts'
import i18n from '../../../../src/renderer/src/i18n.ts'
import { maximalWModel, maximalVceModel, hundredStepVceModel } from './extreme-models'

vi.mock('../../../../src/renderer/src/agent/runtime-client.ts', () => ({ rendererRuntimeClient: { runtimeRequest: vi.fn() } }))
import { rendererRuntimeClient } from '../../../../src/renderer/src/agent/runtime-client.ts'
const request = vi.mocked(rendererRuntimeClient.runtimeRequest)
let root: Root, host: HTMLDivElement
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  await i18n.changeLanguage('en')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { vi.unstubAllGlobals(); await act(async () => root.unmount()); host.remove(); request.mockReset() })
function realRecord(kind: 'generalized-w' | 'vce', basis = 'Synthetic model for UI boundary checks only.') {
  const rootDir = mkdtempSync(join(tmpdir(), 'advanced-gui-review-'))
  const project = { id: 'review-project', revision: 1, workspace: join(rootDir, 'workspace') }
  const service = new SurveyAdvancedTrialsWorkspaceService({ rootDir, getProject: id => id === project.id ? project : null })
  try {
    const model = kind === 'vce' ? maximalVceModel() : maximalWModel()
    const summary = service.createTrial(project.id, Buffer.from(JSON.stringify({ kind, acknowledged: true, expectedProjectRevision: 1,
      idempotencyKey: 'extreme-review-model', declarationJson: JSON.stringify(model), modelBasisStatement: basis })))
    return { record: service.getTrial(project.id, summary.id), summary,
      binding: { projectId: project.id, projectRevision: 1, workspaceRoot: project.workspace } }
  } finally { service.close(); rmSync(rootDir, { recursive: true, force: true }) }
}
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function edit(node: HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function settle(check: () => void) {
  let last: unknown
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    try { check(); return } catch (error) { last = error }
  }
  throw last
}

it.each(['generalized-w', 'vce'] as const)('restores and renders maximum-dimension %s in English without Buffer', async kind => {
  const fixture = realRecord(kind)
  const detailBody = JSON.stringify(fixture.record)
  request.mockImplementation(async path => ({ ok: true, status: 200, body: path.includes('?')
    ? JSON.stringify({ trials: [fixture.summary], unavailable: [], nextOffset: null }) : detailBody }))
  vi.stubGlobal('Buffer', undefined)
  await act(async () => root.render(createElement(SurveyAdvancedModelWorkspace, { binding: fixture.binding, runtimeReady: true })))
  await click(button(i18n.t('advancedHistory')))
  await settle(() => expect(host.textContent).toContain(fixture.summary.id))
  await click([...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(i18n.t('advancedRestore')) )!)
  await settle(() => expect(host.textContent).toContain(i18n.t('advancedSavedRecord')))
  expect(host.querySelector('[role=alert]')).toBeNull()
  expect(host.textContent).toContain('Model assumptions and source authenticity are unverified')
  expect(host.textContent).not.toMatch(/[㐀-鿿]/)
  expect(host.textContent).not.toMatch(/\bNaN\b|\bInfinity\b|\bundefined\b/)
  expect(host.textContent).toContain(fixture.record.declaration.parameterIds.at(-1))
  if (fixture.record.kind === 'generalized-w') {
    expect(fixture.record.result.modelStatus).toBe('resolved')
    expect(host.querySelectorAll('table')).toHaveLength(4)
    expect(host.textContent).toContain(fixture.record.declaration.biasDirections.at(-1)!.id)
    expect(host.querySelectorAll('table').item(3).querySelectorAll('tbody td')).toHaveLength(64 * 64)
  } else {
    expect(fixture.record.result.outcome).toBe('converged')
    expect(host.textContent).toContain(fixture.record.declaration.observations.at(-1)!.id)
    expect(host.textContent).toContain('Numerical convergence is a stopping state for this model only')
  }
})

it('renders the complete genuine 100-step VCE exhaustion trace without suggesting convergence', async () => {
  const result = SurveyVceTrialOutputV1.parse(runSurveyVceTrial(hundredStepVceModel()))
  expect(result.outcome).toBe('iteration-limit'); expect(result.iterations).toHaveLength(100)
  vi.stubGlobal('Buffer', undefined)
  await act(async () => root.render(createElement(VceTrialResult, { result })))
  expect(host.querySelectorAll('details')).toHaveLength(100)
  expect(host.querySelectorAll('details[open]')).toHaveLength(1)
  expect(host.querySelector('details:last-child')!.hasAttribute('open')).toBe(true)
  expect(host.textContent).toContain(i18n.t('advancedIterationLimit'))
  expect(host.textContent).not.toContain(i18n.t('advancedAcceptedVariances', { unit: result.squaredUnit }))
})

it('accepts exact declaration/basis byte maxima and rejects overflow without truncating the user input', async () => {
  const binding = { projectId: 'review-project', projectRevision: 1, workspaceRoot: '/synthetic-review' }
  await act(async () => root.render(createElement(SurveyAdvancedModelWorkspace, { binding, runtimeReady: true })))
  await edit(host.querySelector('select')!, 'generalized-w')
  const [basis, declaration] = [...host.querySelectorAll('textarea')]
  const source = JSON.stringify(maximalWModel()).padEnd(LIMITS.declarationBytes, ' ')
  await edit(basis!, 'x'.repeat(LIMITS.basisBytes)); await edit(declaration!, source)
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(false)
  await edit(basis!, 'x'.repeat(LIMITS.basisBytes - 1) + '界')
  expect(basis!.value).toHaveLength(LIMITS.basisBytes)
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true)
  await edit(basis!, 'Synthetic basis'); await edit(declaration!, source + ' ')
  expect(declaration!.value).toBe(source + ' ')
  expect(button(i18n.t('advancedSave')).disabled).toBe(true)
  expect(request).not.toHaveBeenCalled()
})


it('exports a freshly checked Unicode record without Buffer and suppresses a late export after project change', async () => {
  const fixture = realRecord('vce', '  原始依据 😀\n仅为独立审查合成模型。')
  const detailBody = JSON.stringify(fixture.record)
  const save = vi.fn().mockResolvedValue({ ok: true, path: '/synthetic-review/trial.json' })
  Object.assign(window, { workwise: { saveWorkspaceFileAs: save } })
  request.mockImplementation(async path => ({ ok: true, status: 200, body: path.includes('?')
    ? JSON.stringify({ trials: [fixture.summary], unavailable: [], nextOffset: null }) : detailBody }))
  vi.stubGlobal('Buffer', undefined)
  await act(async () => root.render(createElement(SurveyAdvancedModelWorkspace, { binding: fixture.binding, runtimeReady: true })))
  await click(button(i18n.t('advancedHistory')))
  await settle(() => expect(host.textContent).toContain(fixture.summary.id))
  await click([...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(i18n.t('advancedRestore')))!)
  await settle(() => expect(host.textContent).toContain(i18n.t('advancedSavedRecord')))
  await click(button(i18n.t('advancedExport')))
  await settle(() => expect(host.textContent).toContain('/synthetic-review/trial.json'))
  expect(request.mock.calls.at(-1)![0]).toMatch(/\/export$/)
  expect(save).toHaveBeenCalledOnce()
  const saved = save.mock.calls[0]![0]
  expect(saved.workspaceRoot).toBe(fixture.binding.workspaceRoot)
  expect(NodeBuffer.from(saved.dataBase64, 'base64').toString('utf8')).toBe(detailBody + '\n')
  expect(JSON.parse(NodeBuffer.from(saved.dataBase64, 'base64').toString()).modelBasisStatement).toContain('😀')
  let release!: (value: { ok: boolean; status: number; body: string }) => void
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await click(button(i18n.t('advancedExport')))
  await act(async () => root.render(createElement(SurveyAdvancedModelWorkspace, { binding: { ...fixture.binding, projectId: 'other-project' }, runtimeReady: true })))
  await act(async () => { release({ ok: true, status: 200, body: detailBody }); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(save).toHaveBeenCalledOnce()
  expect(host.textContent).not.toContain('/synthetic-review/trial.json')
  expect(host.textContent).not.toContain(fixture.summary.id)
})
