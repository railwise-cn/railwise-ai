// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { EngineeringDrawer } from './EngineeringDrawer'
import i18n from '../../i18n'

it('opens a named native dialog, handles Escape and restores its trigger focus', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  const trigger = document.createElement('button')
  document.body.append(trigger, host)
  const root = createRoot(host)
  const render = (open: boolean): void => root.render(createElement(EngineeringDrawer, {
    open, title: 'Advanced task settings', onClose: () => render(false), children: createElement('input', { 'aria-label': 'Unit' })
  }))
  try {
    await act(async () => render(false))
    trigger.focus()
    await act(async () => render(true))
    const dialog = host.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(host.querySelector(`#${dialog.getAttribute('aria-labelledby')?.replaceAll(':', '\\:')}`)?.textContent).toBe('Advanced task settings')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(i18n.t('engineeringCloseDetails'))
    await act(async () => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
    // Closing must not destroy conversation inputs or any draft state.
    expect(host.querySelector('input')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove(); trigger.remove()
  }
})

it('returns focus to a stable fallback when the opening trigger unmounts', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  const openingTrigger = document.createElement('button')
  const stableTrigger = document.createElement('button')
  document.body.append(openingTrigger, stableTrigger, host)
  const root = createRoot(host)
  const render = (open: boolean): void => root.render(createElement(EngineeringDrawer, {
    open, title: 'Task assistant', onClose: () => render(false),
    fallbackFocusRef: { current: stableTrigger }, children: createElement('textarea')
  }))
  try {
    await act(async () => render(false))
    openingTrigger.focus()
    await act(async () => render(true))
    openingTrigger.remove()
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(host.querySelector('dialog')!.open).toBe(false)
    expect(document.activeElement).toBe(stableTrigger)
  } finally {
    await act(async () => root.unmount())
    host.remove(); openingTrigger.remove(); stableTrigger.remove()
  }
})
