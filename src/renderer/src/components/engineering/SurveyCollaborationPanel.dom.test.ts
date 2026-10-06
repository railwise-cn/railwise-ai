// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SurveyCollaborationPanel } from './SurveyCollaborationPanel'
import { createSurveyDraft, listSurveyDrafts, reviewSurveyDraft, setSurveyDraftSelection } from '../../agent/survey-collaboration-client'

vi.mock('../../agent/survey-collaboration-client', () => ({
  createSurveyDraft: vi.fn(), listSurveyDrafts: vi.fn(), reviewSurveyDraft: vi.fn(), setSurveyDraftSelection: vi.fn()
}))
vi.mock('../../store/chat-store', () => ({ useChatStore: { getState: () => ({ openFlow: vi.fn() }) } }))
vi.mock('../../write/write-workspace-store', () => ({ useWriteWorkspaceStore: { getState: () => ({}) } }))

const binding = { projectId: 'project-1', projectRevision: 2, workspaceRoot: '/survey' }
const latest = { id: 'manifest-latest', finalizedAt: '2026-10-05T08:00:00Z', outputs: [
  { path: '/reports/latest-control-report.pdf', mediaType: 'application/pdf' },
  { path: '/reports/latest-control-table.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
] }
const earlier = { id: 'manifest-earlier', finalizedAt: '2026-10-01T08:00:00Z', outputs: [{ path: '/reports/earlier-leveling-report.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] }
const draft = (id: string, manifestId: string, revision = 1) => ({
  schemaVersion: 1 as const, id, projectId: binding.projectId, projectRevision: binding.projectRevision,
  projectName: 'Control network', workspace: binding.workspaceRoot, manifestId, manifestHash: 'a'.repeat(64),
  contextHash: 'context', revision, contentHash: 'b'.repeat(64), notesPath: '/survey/notes.md',
  designPath: '/survey/design.json', designDocumentId: `design-${id}`, notesHash: 'c'.repeat(64),
  designHash: 'd'.repeat(64), createdAt: '2026-10-05T09:00:00Z', updatedAt: '2026-10-05T09:00:00Z',
  status: 'draft' as const, professionalSignature: 'unsigned' as const, flowId: `flow-${id}`, runId: `run-${id}`
})
let host: HTMLDivElement
let root: Root
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  vi.mocked(listSurveyDrafts).mockReset()
  vi.mocked(createSurveyDraft).mockReset()
  vi.mocked(reviewSurveyDraft).mockReset()
  vi.mocked(setSurveyDraftSelection).mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('Survey collaboration draft identity', () => {
  it('identifies the source deliverable and reviews only the selected historical draft', async () => {
    const currentDraft = draft('current', latest.id, 2)
    const historicalDraft = draft('historical', earlier.id, 3)
    vi.mocked(listSurveyDrafts).mockResolvedValue([currentDraft, historicalDraft])
    vi.mocked(reviewSurveyDraft).mockResolvedValue(historicalDraft)
    await act(async () => root.render(createElement(SurveyCollaborationPanel, { binding, manifestId: latest.id, manifests: [latest, earlier], enabled: true })))
    await settle()

    const selector = host.querySelector('select')!
    expect(selector.value).toBe(currentDraft.id)
    expect(selector.querySelector(`option[value="${currentDraft.id}"]`)?.textContent).toContain('latest-control-report.pdf')
    expect(selector.querySelector(`option[value="${currentDraft.id}"]`)?.textContent).toContain('One of 2 files')
    expect(selector.querySelector(`option[value="${currentDraft.id}"]`)?.textContent).toContain('Most recently generated review draft')
    expect(selector.querySelector(`option[value="${historicalDraft.id}"]`)?.textContent).toContain('earlier-leveling-report.docx')
    expect(selector.querySelector(`option[value="${historicalDraft.id}"]`)?.textContent).toContain('Earlier review draft')
    expect(selector.querySelector(`option[value="${historicalDraft.id}"]`)?.textContent).toContain('Oct 1, 2026')
    expect(selector.textContent).not.toContain('manifest-earlier')

    await act(async () => { selector.value = historicalDraft.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('Earlier review draft · earlier-leveling-report.docx · Oct 1, 2026')
    const flow = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Review and export'))!
    await act(async () => flow.click())
    await settle()
    expect(reviewSurveyDraft).toHaveBeenCalledWith(binding, historicalDraft)
    expect(setSurveyDraftSelection).toHaveBeenCalledWith({ kind: 'flow', flowId: historicalDraft.flowId, runId: historicalDraft.runId })
  })

  it('creates a new draft for the current deliverable when only older drafts exist', async () => {
    const historicalDraft = draft('historical', earlier.id)
    const currentDraft = draft('current', latest.id)
    vi.mocked(listSurveyDrafts).mockResolvedValue([historicalDraft])
    vi.mocked(createSurveyDraft).mockResolvedValue(currentDraft)
    vi.mocked(reviewSurveyDraft).mockResolvedValue(currentDraft)
    await act(async () => root.render(createElement(SurveyCollaborationPanel, { binding, manifestId: latest.id, manifests: [latest, earlier], enabled: true })))
    await settle()
    expect(host.querySelector('select')?.value).toBe('')
    const flow = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Review and export'))!
    await act(async () => flow.click())
    await settle()
    expect(createSurveyDraft).toHaveBeenCalledWith(binding, latest.id, expect.any(String))
    expect(reviewSurveyDraft).toHaveBeenCalledWith(binding, currentDraft)
  })

  it('does not present an earlier record as the current result while a newer preview is unarchived', async () => {
    const previousDraft = draft('previous', latest.id)
    vi.mocked(listSurveyDrafts).mockResolvedValue([previousDraft])
    await act(async () => root.render(createElement(SurveyCollaborationPanel, { binding, manifests: [latest, earlier], enabled: true })))
    await settle()

    const selector = host.querySelector('select')!
    expect(selector.value).toBe('')
    expect(selector.querySelector(`option[value="${previousDraft.id}"]`)?.textContent).toContain('Most recently generated review draft')
    expect(host.textContent).not.toContain('Current deliverable')
    const flow = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Review and export'))!
    expect(flow.disabled).toBe(true)
    expect(createSurveyDraft).not.toHaveBeenCalled()
  })
})
