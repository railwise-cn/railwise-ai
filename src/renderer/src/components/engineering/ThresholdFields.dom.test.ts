// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { parseThresholds, ThresholdFields } from './ThresholdFields'

let container: HTMLDivElement
let root: Root
let savedText = ''
const translate = (key: string): string => i18n.t(key)

function Form({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  savedText = value
  return createElement(ThresholdFields, { value, unit: 'mm', onChange: setValue })
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => { await act(async () => root.unmount()); container.remove() })

async function render(initial: string): Promise<void> { await act(async () => root.render(createElement(Form, { initial }))) }
async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('professional monitoring limit fields', () => {
  it('shows professional item labels and preserves the legacy default, settlement, custom and signed values', async () => {
    await render('default = 8\nsettlement = 10\n隧道收敛 = -2.5')
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('default')
    expect(container.textContent).not.toContain('settlement')
    expect(container.querySelectorAll('select')).toHaveLength(3)
    const custom = container.querySelector<HTMLInputElement>('input[aria-label="监测项名称 3"]')!
    expect(custom.value).toBe('隧道收敛')
    await change(container.querySelector<HTMLInputElement>('input[aria-label="限值（mm） 1"]')!, '9')
    expect(parseThresholds(savedText, translate)).toEqual({ default: 9, settlement: 10, 隧道收敛: -2.5 })
  })

  it('adds an incomplete row without silently converting an empty value to zero and removes it explicitly', async () => {
    await render('')
    expect(parseThresholds(savedText, translate)).toEqual({})
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(i18n.t('engineeringThresholdAdd')))!.click())
    expect(() => parseThresholds(savedText, translate)).toThrow()
    await change(container.querySelector<HTMLInputElement>('input')!, '0')
    expect(parseThresholds(savedText, translate)).toEqual({ default: 0 })
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label]')!.click())
    expect(parseThresholds(savedText, translate)).toEqual({})
  })

  it('keeps a custom item name and decimal limit during row editing', async () => {
    await render('custom-code = 4')
    const name = container.querySelector<HTMLInputElement>('input[aria-label="监测项名称 1"]')!
    await change(name, '拱顶 沉降')
    await change(container.querySelector<HTMLInputElement>('input[aria-label="限值（mm） 1"]')!, '2.75')
    expect(parseThresholds(savedText, translate)).toEqual({ '拱顶 沉降': 2.75 })
  })

  it.each(['default = ', 'default = NaN', 'default = Infinity', 'default = wrong', ' = 8'])('rejects an incomplete or invalid limit %s', value => {
    expect(() => parseThresholds(value, translate)).toThrow()
  })

  it('preserves finite negative limits and blank-table semantics from the existing contract', () => {
    expect(parseThresholds('custom = -0.125\ndefault=0\n', translate)).toEqual({ custom: -0.125, default: 0 })
    expect(parseThresholds('\n \n', translate)).toEqual({})
  })

  it('refuses duplicate item names instead of silently replacing the first limit', () => {
    for (const value of ['default = 8\ndefault = 10', '隧道收敛 = 2\n 隧道收敛 = 4', 'settlement = 8\nsettlement = 8']) {
      expect(() => parseThresholds(value, translate)).toThrow(i18n.t('engineeringThresholdDuplicate'))
    }
    expect(Object.hasOwn(parseThresholds('__proto__ = 3\nconstructor = 2', translate), '__proto__')).toBe(true)
    expect(JSON.stringify(parseThresholds('__proto__ = 3\nconstructor = 2', translate))).toBe('{"__proto__":3,"constructor":2}')
  })
})
