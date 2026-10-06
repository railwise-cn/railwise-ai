// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyAdjustmentPanel } from './SurveyAdjustmentPanel'
import i18n from '../../i18n'

let container: HTMLDivElement
let root: Root
let savedNetwork: typeof planeNetwork | null
let importedBodies: Record<string, unknown>[]

const planeNetwork = {
  id: 'network-reference-check', revision: 2, networkType: 'plane-control',
  coordinateSystem: '待确认', verticalDatum: '待确认', unit: 'm',
  knownPoints: [{ id: 'A', known: true, x: 0, y: 0 }],
  unknownPoints: [{ id: 'P', known: false, x: 10, y: 10 }],
  observations: [{ id: 'obs-1', type: 'distance', from: 'A', to: 'P', value: 14.14, unit: 'm' }],
  qualityStatus: 'validated', findings: [],
  sourceEligibility: { eligible: true, findings: [] },
  rawSourceIntegrity: { status: 'verified', ledgerEntryCount: 2, errors: [] },
  sourceFile: {
    name: 'survey.gsi', size: 10, sha256: 'a'.repeat(64), originalPreserved: true,
    detection: { format: 'leica-gsi8', vendor: 'Leica', confidence: 1, extensionConflict: false, matchedSignatures: [] },
    disposition: 'adjustment-ready', parserId: 'survey-parser', parserVersion: '1',
    linearUnitCanonical: 'm', angularUnitCanonical: 'rad', recordCount: 1,
    diagnostics: [], rawRecordAnchors: []
  }
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function response(body: unknown): { ok: true; status: 200; body: string } {
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

async function render(project: { id: string; revision: number; coordinateSystem?: string; verticalDatum?: string; heightDatum?: string; taskContext?: { coordinateSystem?: string; verticalDatum?: string } } = { id: 'project-reference', revision: 1 }, compact = true): Promise<void> {
  await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project, runtimeReady: true, compact, preferredSection: 'network' })))
  await settle()
  await settle()
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  expect(match, `Expected button ${text}`).toBeDefined()
  return match!
}

function coordinateInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="平面坐标系"]')
  expect(input, 'Coordinate reference input must be accessible by its professional label').not.toBeNull()
  return input!
}

function heightInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="高程基准"]')
  expect(input, 'Height reference input must be accessible by its professional label').not.toBeNull()
  return input!
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function chooseFile(): Promise<void> {
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['instrument survey bytes'], 'survey.gsi')] })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  for (let attempt = 0; attempt < 10 && !importedBodies.length; attempt += 1) await settle()
  expect(importedBodies).toHaveLength(1)
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  savedNetwork = structuredClone(planeNetwork)
  importedBodies = []
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
        if (path === '/v1/engineering/survey/networks?projectId=project-reference' && method === 'GET') return response({ networks: savedNetwork ? [savedNetwork] : [] })
        if (path === '/v1/engineering/adjustments?projectId=project-reference' && method === 'GET') return response({ adjustments: [] })
        if (path === '/v1/engineering/survey/networks/import' && method === 'POST') {
          const request = JSON.parse(body!) as Record<string, unknown>
          importedBodies.push(request)
          const references = request.referenceDeclaration as { coordinateSystem?: string; verticalDatum?: string } | undefined
          savedNetwork = { ...structuredClone(planeNetwork), ...references }
          return response({ network: savedNetwork })
        }
        if (path === '/v1/engineering/survey/networks/network-reference-check/validate' && method === 'POST') return response({ network: savedNetwork })
        throw new Error(`Unexpected request ${method} ${path}`)
      })
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
})

describe('Survey professional reference declaration', () => {
  it('blocks new calculation when an old validated plane network has no coordinate declaration, while allowing file checks', async () => {
    await render()
    expect(container.textContent).toContain('平面坐标基准尚未声明')
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(true)
    expect(button(i18n.t('surveyCheckFiles')).disabled).toBe(false)
    expect(container.textContent).not.toContain('高程基准尚未声明')
  })

  it('does not require an unused height datum for a declared plane-only network', async () => {
    savedNetwork = { ...planeNetwork, coordinateSystem: '工程独立坐标系' }
    await render()
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(false)
    expect(container.textContent).not.toContain('高程基准尚未声明')
  })

  it('repairs a missing height declaration by focusing the height input rather than the known-point input', async () => {
    savedNetwork = { ...planeNetwork, networkType: 'leveling', observations: [{ id: 'obs-1', type: 'height-difference', from: 'A', to: 'P', value: 0.1, unit: 'm' }] }
    await render()
    expect(container.textContent).toContain('高程基准尚未声明')
    const issue = Array.from(container.querySelectorAll('li')).find(item => item.textContent?.includes('高程基准尚未声明'))!
    const repair = issue.querySelector<HTMLButtonElement>('button')!
    expect(repair).not.toBeNull()
    await act(async () => repair.click())
    expect(document.activeElement).toBe(heightInput())
    expect(document.activeElement).not.toBe(container.querySelector('textarea'))
    expect(container.textContent).toContain('确认基准后重新选择原文件导入，原记录保留')
  })

  it('prefills declared project references and sends trimmed non-empty declarations with the original import', async () => {
    savedNetwork = null
    await render({ id: 'project-reference', revision: 3, coordinateSystem: ' 工程独立坐标系 ', heightDatum: ' 1985 国家高程基准 ' })
    expect(coordinateInput().value).toBe(' 工程独立坐标系 ')
    expect(heightInput().value).toBe(' 1985 国家高程基准 ')
    await chooseFile()
    expect(importedBodies[0]).toMatchObject({ projectId: 'project-reference', expectedRevision: 3, name: 'survey.gsi', referenceDeclaration: { coordinateSystem: '工程独立坐标系', verticalDatum: '1985 国家高程基准' } })
    expect(importedBodies[0]!.dataBase64).toBe(btoa('instrument survey bytes'))
  })

  it('does not send blank reference fields or turn typed values into a declaration on the old network', async () => {
    await render()
    await changeInput(coordinateInput(), '工程独立坐标系')
    await changeInput(heightInput(), '   ')
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(true)
    await chooseFile()
    expect(importedBodies[0]!.referenceDeclaration).toEqual({ coordinateSystem: '工程独立坐标系' })
  })

  it('omits the declaration object when both fields are empty and exposes the same inputs in the advanced workflow', async () => {
    savedNetwork = null
    await render(undefined, false)
    expect(coordinateInput().value).toBe('')
    expect(heightInput().value).toBe('')
    await chooseFile()
    expect(importedBodies[0]).not.toHaveProperty('referenceDeclaration')
  })

  it('provides the same reference repair action in the advanced workflow', async () => {
    await render(undefined, false)
    const repair = button(i18n.t('surveyReferenceDeclarationRepair'))
    await act(async () => repair.click())
    expect(document.activeElement).toBe(coordinateInput())
  })

  it('keeps the reference declaration workflow professional in English', async () => {
    await i18n.changeLanguage('en')
    await render()
    expect(container.textContent).toContain('The coordinate reference has not been declared.')
    expect(container.textContent).not.toContain('平面坐标基准尚未声明')
    expect(container.querySelector('input[aria-label="Coordinate system"]')).not.toBeNull()
    expect(button(i18n.t('surveyReferenceDeclarationRepair')).disabled).toBe(false)
  })

  it('prefills the references declared in the current project task context without guessing placeholders', async () => {
    await render({ id: 'project-reference', revision: 1, coordinateSystem: '待确认', taskContext: { coordinateSystem: 'CGCS2000', verticalDatum: '1985 国家高程基准' } })
    expect(coordinateInput().value).toBe('CGCS2000')
    expect(heightInput().value).toBe('1985 国家高程基准')
  })
})
