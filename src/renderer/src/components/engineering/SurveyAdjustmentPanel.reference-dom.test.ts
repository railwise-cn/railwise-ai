// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyAdjustmentPanel } from './SurveyAdjustmentPanel'
import i18n from '../../i18n'

let container: HTMLDivElement
let root: Root
let savedNetwork: typeof planeNetwork | null
let earlierNetworks: typeof planeNetwork[]
let importedBodies: Record<string, unknown>[]
let validationAddsRevision: boolean

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

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
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

async function chooseFiles(files: File[]): Promise<void> {
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: files })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await vi.waitFor(() => expect(importedBodies).toHaveLength(files.length))
  await settle()
}

async function chooseMappedFile(file: File): Promise<void> {
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
}

async function changeFormControl(label: string, value: string): Promise<void> {
  const wrapper = Array.from(container.querySelectorAll('form label')).find(item => item.textContent?.startsWith(label))
  expect(wrapper, `Expected form control ${label}`).toBeDefined()
  const control = wrapper!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')!
  await act(async () => {
    const prototype = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

async function confirmMapping(): Promise<void> {
  await act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(importedBodies).toHaveLength(1))
  await settle()
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  savedNetwork = structuredClone(planeNetwork)
  earlierNetworks = []
  importedBodies = []
  validationAddsRevision = false
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
        if (path === '/v1/engineering/survey/networks?projectId=project-reference' && method === 'GET') return response({ networks: savedNetwork ? [savedNetwork, ...earlierNetworks] : earlierNetworks })
        if (path === '/v1/engineering/adjustments?projectId=project-reference' && method === 'GET') return response({ adjustments: [] })
        if (path === '/v1/engineering/survey/tabular/probe' && method === 'POST') {
          const input = JSON.parse(body!) as { name: string }
          const xlsx = input.name.endsWith('.xlsx')
          return response({ probe: {
            formatId: xlsx ? 'xlsx' : 'delimited-text', sourceSha256: 'b'.repeat(64),
            tables: [{ id: xlsx ? 'xl/worksheets/observations.xml' : 'csv', name: 'Observations', visibility: 'visible', importable: true, columns: ['from', 'to', 'value'], previewRows: [['BM', 'P', '0.2']], rowCount: 1, headerRow: 1 }], requiresMapping: true
          } })
        }
        if (path === '/v1/engineering/survey/networks/import' && method === 'POST') {
          const request = JSON.parse(body!) as Record<string, unknown>
          importedBodies.push(request)
          const references = request.referenceDeclaration as { coordinateSystem?: string; verticalDatum?: string } | undefined
          const mapping = request.tabularMapping as { coordinateSystem?: string; verticalDatum?: string; sourceSha256?: string } | undefined
          if (savedNetwork) earlierNetworks.unshift(savedNetwork)
          savedNetwork = {
            ...structuredClone(planeNetwork), id: `network-import-${importedBodies.length}`,
            networkType: mapping ? request.networkType as string : planeNetwork.networkType,
            coordinateSystem: mapping?.coordinateSystem ?? planeNetwork.coordinateSystem,
            verticalDatum: mapping?.verticalDatum ?? planeNetwork.verticalDatum,
            ...references,
            sourceFile: {
              ...structuredClone(planeNetwork.sourceFile), name: request.name as string,
              sha256: mapping?.sourceSha256 ?? `${importedBodies.length}`.repeat(64),
              detection: { ...planeNetwork.sourceFile.detection, format: (request.name as string).split('.').at(-1) ?? 'gsi' }
            }
          }
          return response({ network: savedNetwork })
        }
        if (/^\/v1\/engineering\/survey\/networks\/[^/]+\/validate$/.test(path) && method === 'POST') {
          if (validationAddsRevision && savedNetwork) savedNetwork = { ...savedNetwork, revision: savedNetwork.revision + 1 }
          return response({ network: savedNetwork })
        }
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
    expect(container.textContent).toContain('填写基准后重新导入原文件')
  })

  it('focuses the remaining undeclared reference after one of two required fields is filled', async () => {
    savedNetwork = { ...planeNetwork, observations: [{ id: 'obs-1', type: 'zenith', from: 'A', to: 'P', value: 1, unit: 'rad' }] }
    await render()
    await changeInput(coordinateInput(), '工程独立坐标系')
    const coordinateIssue = Array.from(container.querySelectorAll('li')).find(item => item.textContent?.includes('平面坐标基准尚未声明'))!
    await act(async () => coordinateIssue.querySelector<HTMLButtonElement>('button')!.click())
    expect(document.activeElement).toBe(heightInput())
  })

  it('retains a pending survey file so confirming the reference repairs the imported network without another file picker', async () => {
    savedNetwork = null
    const file = new File(['instrument survey bytes'], 'survey.gsi')
    const removePendingFile = vi.fn()
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-reference', revision: 1 }, runtimeReady: true, compact: true,
      preferredSection: 'network', pendingFiles: [file], onRemovePendingFile: removePendingFile
    })))
    await vi.waitFor(() => expect(importedBodies).toHaveLength(1))
    await settle()
    expect(removePendingFile).toHaveBeenCalledWith(file)
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(true)
    expect(container.textContent).toContain('使用本次上传的原文件重新导入')

    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    expect(container.textContent).toContain('本次上传的原文件会用于重新导入')
    expect(container.textContent).not.toContain('填写基准后重新导入原文件')
    expect(document.activeElement).toBe(coordinateInput())

    await changeInput(coordinateInput(), '工程独立坐标系')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    await vi.waitFor(() => expect(importedBodies).toHaveLength(2))
    await settle()
    expect(importedBodies[1]).toMatchObject({ name: 'survey.gsi', referenceDeclaration: { coordinateSystem: '工程独立坐标系' } })
    expect(importedBodies[1]!.dataBase64).toBe(importedBodies[0]!.dataBase64)
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(false)
  })

  it('requires the original file again after the selected network changes outside this import', async () => {
    savedNetwork = null
    await render()
    await chooseFile()
    expect(container.textContent).toContain('使用本次上传的原文件重新导入')

    savedNetwork = { ...savedNetwork!, revision: 3 }
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-reference', revision: 1 }, runtimeReady: true,
      compact: true, preferredSection: 'network', refreshToken: 1
    })))
    await settle()
    await settle()
    expect(container.textContent).not.toContain('使用本次上传的原文件重新导入')

    await changeInput(coordinateInput(), '工程独立坐标系')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    expect(importedBodies).toHaveLength(1)
    expect(container.textContent).toContain('重新选择原文件导入')
  })

  it('keeps a file available after an observed validation revision change', async () => {
    savedNetwork = null
    await render(undefined, false)
    await chooseFile()
    validationAddsRevision = true
    await act(async () => button(i18n.t('engineeringTabQuality')).click())
    await vi.waitFor(() => expect((savedNetwork as typeof planeNetwork | null)?.revision).toBe(3))
    await settle()
    expect(container.textContent).toContain('本次上传的原文件可用于补充基准声明')

    await changeInput(coordinateInput(), '工程独立坐标系')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    await vi.waitFor(() => expect(importedBodies).toHaveLength(2))
    expect(importedBodies[1]).toMatchObject({
      name: 'survey.gsi', dataBase64: importedBodies[0]!.dataBase64,
      referenceDeclaration: { coordinateSystem: '工程独立坐标系' }
    })
    expect(earlierNetworks.map(item => item.id)).toContain('network-import-1')
  })

  it('preserves the confirmed IN1 mapping and original import choices while repairing the reference', async () => {
    savedNetwork = null
    await render()
    await changeInput(container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${i18n.t('surveyKnownPointsInput')}"]`)!, 'BM,100')
    await chooseMappedFile(new File(['BM,100\nP,100.2'], 'level.in1'))
    await changeFormControl(i18n.t('surveyMappingKnownCount'), '2')
    await confirmMapping()
    const original = importedBodies[0]!
    expect(original).toMatchObject({ name: 'level.in1', networkType: 'leveling', knownPoints: [{ id: 'BM', height: 100 }], cosaIn1Mapping: { knownPointRecordCount: 2 } })

    const type = container.querySelector<HTMLSelectElement>(`select[aria-label="${i18n.t('surveyNetworkType')}"]`)!
    await act(async () => { type.value = 'traverse'; type.dispatchEvent(new Event('change', { bubbles: true })) })
    await changeInput(container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${i18n.t('surveyKnownPointsInput')}"]`)!, 'OTHER,999')
    await changeInput(coordinateInput(), '工程独立坐标系')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    await vi.waitFor(() => expect(importedBodies).toHaveLength(2))
    expect(importedBodies[1]).toMatchObject({
      name: original.name, networkType: original.networkType, knownPoints: original.knownPoints,
      cosaIn1Mapping: original.cosaIn1Mapping, dataBase64: original.dataBase64,
      referenceDeclaration: { coordinateSystem: '工程独立坐标系' }
    })
  })

  it.each(['csv', 'xlsx'])('uses the confirmed %s table reference without asking for a second declaration', async (extension) => {
    savedNetwork = null
    await render()
    await chooseMappedFile(new File(['from,to,value\nBM,P,0.2'], `observations.${extension}`))
    await changeFormControl(i18n.t('surveyTabularField.from'), '0')
    await changeFormControl(i18n.t('surveyTabularField.to'), '1')
    await changeFormControl(i18n.t('surveyTabularField.value'), '2')
    await changeFormControl(i18n.t('surveyCoordinateSystem'), 'LOCAL')
    await changeFormControl(i18n.t('surveyHeightDatum'), 'PROJECT')
    await changeFormControl(i18n.t('surveyKnownPoints'), 'BM,100')
    await confirmMapping()
    const original = importedBodies[0]!
    expect(original).toMatchObject({ name: `observations.${extension}`, tabularMapping: {
      confirmed: true, sourceSha256: 'b'.repeat(64), coordinateSystem: 'LOCAL', verticalDatum: 'PROJECT'
    } })
    expect(savedNetwork).toMatchObject({ coordinateSystem: 'LOCAL', verticalDatum: 'PROJECT' })
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(false)
    expect(importedBodies).toHaveLength(1)
    expect(Array.from(container.querySelectorAll('button')).some(item => item.textContent?.trim() === i18n.t('surveyReferenceDeclarationRepair'))).toBe(false)
    expect(container.textContent).not.toContain('平面坐标基准尚未声明')
  })

  it('retains each file from a batch for reference repair and keeps the earlier records', async () => {
    savedNetwork = null
    await render(undefined, false)
    await chooseFiles([
      new File(['first survey bytes'], 'first.gsi'),
      new File(['second survey bytes'], 'second.gsi')
    ])
    const originalFirst = importedBodies[0]!
    const originalSecond = importedBodies[1]!
    const selector = container.querySelector<HTMLSelectElement>('#survey-existing-network')!
    expect(selector.value).toBe('network-import-1')
    expect(Array.from(selector.options).map(option => option.value)).toEqual(['', 'network-import-1', 'network-import-2'])

    await act(async () => { selector.value = 'network-import-2'; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('本次上传的原文件可用于补充基准声明')
    await changeInput(coordinateInput(), '工程独立坐标系')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    await vi.waitFor(() => expect(importedBodies).toHaveLength(3))
    expect(importedBodies[2]).toMatchObject({
      name: originalSecond.name, dataBase64: originalSecond.dataBase64,
      referenceDeclaration: { coordinateSystem: '工程独立坐标系' }
    })
    expect((savedNetwork as typeof planeNetwork | null)?.id).toBe('network-import-3')
    expect((savedNetwork as typeof planeNetwork | null)?.coordinateSystem).toBe('工程独立坐标系')
    expect(earlierNetworks.map(item => item.id)).toEqual(['network-import-2', 'network-import-1'])
    expect(button(i18n.t('surveyRunAdjustment')).disabled).toBe(false)

    const updatedSelector = container.querySelector<HTMLSelectElement>('#survey-existing-network')!
    await act(async () => { updatedSelector.value = 'network-import-1'; updatedSelector.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('本次上传的原文件可用于补充基准声明')
    await act(async () => button(i18n.t('surveyReferenceDeclarationRepair')).click())
    await vi.waitFor(() => expect(importedBodies).toHaveLength(4))
    expect(importedBodies[3]).toMatchObject({
      name: originalFirst.name, dataBase64: originalFirst.dataBase64,
      referenceDeclaration: { coordinateSystem: '工程独立坐标系' }
    })
    expect((savedNetwork as typeof planeNetwork | null)?.id).toBe('network-import-4')
    expect(earlierNetworks.map(item => item.id)).toEqual(['network-import-3', 'network-import-2', 'network-import-1'])
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
