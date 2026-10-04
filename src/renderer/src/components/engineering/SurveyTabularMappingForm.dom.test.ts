// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SurveyTabularMappingForm, type SurveyTabularMapping, type SurveyTabularProbe } from './SurveyTabularMappingForm'

const probe: SurveyTabularProbe = { formatId: 'delimited-text', sourceSha256: 'a'.repeat(64), delimiter: ',', requiresMapping: true, tables: [{ id: 'csv', name: 'CSV', visibility: 'visible', importable: true, columns: ['编号', '起点', '终点', '高差', '长度'], previewRows: [['obs1', 'BM01', 'P01', '200', '0.1']], rowCount: 1, headerRow: 1 }] }
let container: HTMLDivElement
let root: Root
let confirm: ReturnType<typeof vi.fn<(mapping: SurveyTabularMapping) => void>>
const memory = new Map<string, string>()

beforeEach(async () => {
  await i18n.changeLanguage('zh'); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key), clear: () => memory.clear() })
  memory.clear(); confirm = vi.fn(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(extra: Record<string, unknown> = {}): Promise<void> { await act(async () => root.render(createElement(SurveyTabularMappingForm, { fileName: 'level.csv', probe, disabled: false, onConfirm: confirm, onCancel: vi.fn(), ...extra }))) }
function labelControl<T extends HTMLElement>(text: string): T { const translated = ({ '坐标系统': 'surveyCoordinateSystem', '高程基准': 'surveyHeightDatum', '网型': 'surveyNetworkType', '分隔符': 'surveyMappingDelimiter', '已知点': 'surveyKnownPoints', '线性观测与精度单位': 'surveyTabularLinearUnit', '方案名称': 'surveyTabularProfileName' } as Record<string, string>)[text]; const expected = translated ? i18n.t(translated, { ns: 'common' }) : text; const label = Array.from(container.querySelectorAll('label')).find(item => item.textContent?.startsWith(expected)); if (!label) throw new Error(`missing ${expected}`); return label.querySelector('input,textarea,select') as T }
async function change(text: string, value: string): Promise<void> { const control = labelControl<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(text); await act(async () => { const setter = Object.getOwnPropertyDescriptor(control.tagName === 'SELECT' ? HTMLSelectElement.prototype : control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!; setter.call(control, value); control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }) }
async function validLeveling(): Promise<void> { await change('起点 / 测站', '1'); await change('终点 / 目标', '2'); await change('观测值', '3'); await change('坐标系统', 'LOCAL'); await change('高程基准', 'PROJECT-DATUM'); await change('已知点', 'BM01, 100'); }
function submit(): HTMLButtonElement { return container.querySelector('button[type="submit"]')! }

describe('survey table confirmation', () => {
  it('starts without semantic guesses and requires roles, datum and valid controls', async () => {
    await render()
    expect(submit().disabled).toBe(true)
    expect(labelControl<HTMLSelectElement>('起点 / 测站').value).toBe('-1')
    await validLeveling()
    expect(submit().disabled).toBe(false)
    await change('终点 / 目标', '1')
    expect(submit().disabled).toBe(true)
    await change('终点 / 目标', '2'); await change('已知点', 'BM01, missing')
    expect(submit().disabled).toBe(true)
  })
  it('emits source-bound choices and canonical-metre controls only after explicit confirmation', async () => {
    await render(); await validLeveling(); await change('线性观测与精度单位', 'mm'); await change('测段长度单位', 'km')
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => submit().click())
    const mapping = confirm.mock.calls[0][0] as SurveyTabularMapping
    expect(mapping).toMatchObject({ sourceSha256: probe.sourceSha256, tableId: 'csv', confirmed: true, linearUnit: 'mm', routeLengthUnit: 'km', knownPoints: [{ id: 'BM01', height: 100 }], bindings: [{ field: 'from', columnIndex: 1 }, { field: 'to', columnIndex: 2 }, { field: 'value', columnIndex: 3 }] })
  })
  it('reuses an explicitly saved mapping as pending prefill without reusing source confirmation', async () => {
    await render(); await validLeveling()
    await act(async () => labelControl<HTMLInputElement>('保存本次映射').click()); await act(async () => submit().click())
    expect(memory.size).toBe(1)
    await act(async () => root.unmount()); root = createRoot(container); confirm.mockClear()
    await render({ probe: { ...probe, sourceSha256: 'b'.repeat(64) } })
    expect(container.textContent).toContain('本次资料仍需重新确认')
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => submit().click())
    expect(confirm.mock.calls[0][0].sourceSha256).toBe('b'.repeat(64))
  })
  it('retains multiple named profiles for the same table headers and applies a selected profile', async () => {
    await render(); await validLeveling(); await change('方案名称', '毫米测量'); await change('线性观测与精度单位', 'mm'); await act(async () => labelControl<HTMLInputElement>('保存本次映射').click()); await act(async () => submit().click())
    await change('方案名称', '米制测量'); await change('线性观测与精度单位', 'm'); await act(async () => submit().click())
    await act(async () => root.unmount()); root = createRoot(container); confirm.mockClear(); await render()
    const profile = Array.from(container.querySelectorAll('select')).find(select => Array.from(select.querySelectorAll('option')).some(option => option.textContent === '毫米测量')) as HTMLSelectElement | undefined
    expect(profile).toBeDefined(); expect(profile!.querySelectorAll('option')).toHaveLength(3)
    const profileOptions = profile!.querySelectorAll('option')
    await act(async () => { profile!.value = profileOptions.item(1)!.getAttribute('value') ?? ''; profile!.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(labelControl<HTMLSelectElement>('线性观测与精度单位').value).toBe('mm')
  })
  it('limits supported observation types and parses X/Y controls independently of observation units', async () => {
    await render(); await change('网型', 'plane-control')
    expect(Array.from(labelControl<HTMLSelectElement>('观测类型').options).map(option => option.value)).toEqual(['distance', 'direction'])
    await change('起点 / 测站', '1'); await change('终点 / 目标', '2'); await change('观测值', '3'); await change('坐标系统', 'LOCAL'); await change('高程基准', 'PROJECT'); await change('已知点', 'A, 1000, 2000\nB, 1100, 2100')
    await change('待定点近似坐标', 'P01, 1020, 2030'); await act(async () => submit().click())
    expect(confirm.mock.calls[0][0]).toMatchObject({ networkType: 'plane-control', knownPoints: [{ id: 'A', x: 1000, y: 2000 }, { id: 'B', x: 1100, y: 2100 }], unknownPoints: [{ id: 'P01', x: 1020, y: 2030 }] })
  })
  it('re-probes delimiter changes so bindings cannot target columns from a different split', async () => {
    const delimiter = vi.fn(); await render({ onDelimiterChange: delimiter }); await change('分隔符', ';')
    expect(delimiter).toHaveBeenCalledWith(';')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('offers only visible worksheets and names hidden sheets that were excluded', async () => {
    await render({ probe: { ...probe, formatId: 'xlsx', tables: [
      { ...probe.tables[0]!, id: 'xl/worksheets/visible.xml', name: '观测记录', visibility: 'visible', importable: true },
      { ...probe.tables[0]!, id: 'xl/worksheets/hidden.xml', name: '隐藏测站', visibility: 'hidden', importable: false },
      { ...probe.tables[0]!, id: 'xl/worksheets/very-hidden.xml', name: '内部计算', visibility: 'veryHidden', importable: false }
    ] } })
    const tableOptions = Array.from(labelControl<HTMLSelectElement>('工作表').options).map(option => option.textContent)
    expect(tableOptions).toEqual(['观测记录 · 1 行'])
    expect(container.textContent).toContain('隐藏测站 (隐藏)')
    expect(container.textContent).toContain('内部计算 (深度隐藏)')
  })
  it('keeps visible cover or notes sheets out of the mapping selector', async () => {
    await render({ probe: { ...probe, formatId: 'xlsx', tables: [
      { ...probe.tables[0]!, id: 'xl/worksheets/visible.xml', name: '观测记录', importable: true },
      { ...probe.tables[0]!, id: 'xl/worksheets/notes.xml', name: '说明', importable: false, columns: [], previewRows: [], rowCount: 0 }
    ] } })
    const tableOptions = Array.from(labelControl<HTMLSelectElement>('工作表').options).map(option => option.textContent)
    expect(tableOptions).toEqual(['观测记录 · 1 行'])
    expect(container.textContent).toContain('说明')
    expect(container.textContent).toContain('已从映射选项中排除')
  })
})
