// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringProjectSuggestions } from './EngineeringProjectSuggestions'

let container: HTMLDivElement
let root: Root
const request = vi.fn()
const refresh = vi.fn()
const suggestion = { id: 'suggestion-1', projectId: 'project-1', expectedRevision: 3, reason: 'Use the reviewed datum', before: { name: 'Old name' }, patch: { name: 'New name' }, status: 'pending' }
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, body: JSON.stringify(body) })
const render = async (busy = false) => {
  await act(async () => { root.render(createElement(EngineeringProjectSuggestions, { projectId: 'project-1', threadId: 'thread-1', connected: true, busy, refreshKey: 1, onRefresh: refresh })) })
}
beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  Object.assign(window, { workwise: { runtimeRequest: request } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('Project change confirmation card', () => {
  it('shows before, after and effects; only an explicit confirmation posts the decision', async () => {
    request.mockImplementation(async (_path: string, method?: string) => response(method === 'POST' ? { suggestion: { ...suggestion, status: 'applied' } } : { suggestions: [{ suggestion, token: 'ui-only-confirmation-token' }] }))
    await render()
    expect(request).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Old name')
    expect(container.textContent).toContain('New name')
    expect(container.textContent).toContain('does not transform imported coordinates')
    expect(container.textContent).not.toContain('ui-only-confirmation-token')
    const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === 'Confirm changes')!
    await act(async () => confirm.click())
    expect(request).toHaveBeenLastCalledWith('/v1/engineering/ai/project-suggestions/suggestion-1/decision', 'POST', JSON.stringify({ token: 'ui-only-confirmation-token', decision: 'apply' }))
    expect(container.textContent).toContain('Applied')
    expect(container.textContent).not.toContain('Confirm changes')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shows a stale error without claiming application or discarding the proposed values', async () => {
    request.mockImplementation(async (_path: string, method?: string) => method === 'POST' ? response({}, 409) : response({ suggestions: [{ suggestion, token: 'ui-only-confirmation-token' }] }))
    await render()
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Confirm changes')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Request a fresh suggestion')
    expect(container.textContent).toContain('Old name')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not render a suggestion for a different project', async () => {
    request.mockResolvedValue(response({ suggestions: [{ suggestion: { ...suggestion, projectId: 'other-project' }, token: 'token' }] }))
    await render()
    expect(container.querySelector('[data-testid="engineering-project-suggestion"]')).toBeNull()
  })
})
