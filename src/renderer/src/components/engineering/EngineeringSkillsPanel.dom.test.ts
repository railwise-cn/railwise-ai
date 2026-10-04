// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringSkillsPanel } from './EngineeringSkillsPanel'

const request = vi.fn()
let root: Root
let container: HTMLDivElement

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, body: JSON.stringify(body) })

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  Object.assign(window, { workwise: { runtimeRequest: request } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('EngineeringSkillsPanel professional presentation', () => {
  it('shows task-level capabilities without exposing packages, tools, sources or license metadata', async () => {
    request.mockImplementation(async (path: string) => path.includes('/capabilities')
      ? response({ capabilities: [{ id: 'survey-adjustment', label: 'Control network adjustment', category: 'survey', skillIds: ['rail-any-station-control-network'], toolIds: ['survey_adjustment'], available: true }] })
      : response({ skills: [{ id: 'rail-any-station-control-network', name: 'Control network adjustment', sourceRepository: 'internal-repository', commit: 'abc123def456', license: 'bundled-license', packaged: true, status: 'available' }] }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.textContent).toContain('Control network adjustment')
    expect(container.textContent).toContain('Available')
    expect(container.textContent).not.toContain('rail-any-station-control-network')
    expect(container.textContent).not.toContain('survey_adjustment')
    expect(container.textContent).not.toContain('abc123def456')
    expect(container.textContent).not.toContain('bundled-license')
    expect(container.textContent).not.toContain('internal-repository')
    expect(container.textContent).not.toMatch(/license|skills and standards|skill sources|tools|operations count/i)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/engineering/capabilities'])
  })

  it('shows a professional unavailable message when capability data is not readable', async () => {
    request.mockImplementation(async (path: string) => path.includes('/capabilities')
      ? { ok: true, status: 200, body: '<!doctype html><html><body>service unavailable</body></html>' }
      : response({ skills: [] }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.textContent).toContain('capability information is temporarily unavailable')
    expect(container.textContent).not.toMatch(/skills catalog|技能目录|Unexpected token|not valid JSON|<!doctype html/i)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/engineering/capabilities'])
  })
})
