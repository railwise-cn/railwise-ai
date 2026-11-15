// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { latestHtmlArtifact, useTaskArtifactPreview } from './use-task-artifact-preview'

let tasks: TaskRunV1[] = []
vi.mock('../store/task-live-store', () => ({ useTaskState: () => ({ tasks }) }))
let mounted: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => mounted?.unmount()); mounted = undefined; container?.remove(); tasks = []; Reflect.deleteProperty(window, 'workwise') })
async function mountPreview(thread: string) {
  container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  let value: ReturnType<typeof useTaskArtifactPreview>
  function Probe({ threadId }: { threadId: string }) { value = useTaskArtifactPreview(threadId, true); return null }
  async function render(threadId = thread) { await act(async () => mounted!.render(createElement(Probe, { threadId }))) }
  await render()
  return { current: () => value!, render }
}
function task(id: string, origin = 'chat', hash = 'hash'): TaskRunV1 {
  return { id, threadId: `internal-${id}`, originThreadId: origin, updatedAt: '2026-11-13T00:00:00Z', artifacts: [{ id: 'html', relativePath: '报告.html', sha256: hash, validation: 'valid', createdAt: 'now' }] } as TaskRunV1
}

describe('task-owned HTML auto preview', () => {
  it.each(['verified', 'draft'] as const)('binds the preview badge to the returned file SHA when a requested %s artifact changes before Main reads it', async status => {
    const report = task('one', 'chat', 'requested-A')
    report.acceptance = { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true }
    report.artifacts[0] = { ...report.artifacts[0]!, sourceEvidenceStatus: status, ...(status === 'verified' ? { sourceEvidenceReceiptId: 'proof-A' } : {}) }
    tasks = [report]
    let finish!: (value: unknown) => void
    const preview = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockImplementation(() => new Promise(() => undefined))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    const actualStatus = status === 'verified' ? 'draft' : 'verified'
    // Runtime/Main see B before its SSE projection reaches this renderer.
    tasks = [{ ...report, artifacts: [{ ...report.artifacts[0]!, sha256: 'selected-B', sourceEvidenceStatus: actualStatus,
      sourceEvidenceReceiptId: actualStatus === 'verified' ? 'proof-B' : undefined }] }]
    await act(async () => finish({ ok: true, url: 'http://127.0.0.1:1/selected-B', title: 'B', sha256: 'selected-B' }))
    expect(hook.current().url).toBe('http://127.0.0.1:1/selected-B')
    expect(hook.current().sourceEvidenceStatus).toBe(actualStatus)
  })

  it.each([undefined, 'unmatched-C'])('does not claim request-time source verification when Main supplies an unproven snapshot hash %s', async sha256 => {
    const report = task('one', 'chat', 'requested-A')
    report.acceptance = { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true }
    report.artifacts[0] = { ...report.artifacts[0]!, sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof-A' }
    tasks = [report]
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: vi.fn(async () => ({
      ok: true, url: 'http://127.0.0.1:1/unknown-snapshot', title: '报告', ...(sha256 ? { sha256 } : {})
    })) } })
    const hook = await mountPreview('chat')
    expect(hook.current().url).toBe('http://127.0.0.1:1/unknown-snapshot')
    expect(hook.current().sourceEvidenceStatus).toBe('draft')
  })

  it('allows a web draft preview and updates its source status for the same bytes without reopening the page', async () => {
    const report = task('one'); report.acceptance = { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true }
    report.artifacts[0]!.sourceEvidenceStatus = 'draft'
    tasks = [report]
    const preview = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:1/draft', title: '草稿', sha256: 'hash' }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    expect(hook.current().url).toBe('http://127.0.0.1:1/draft')
    expect(hook.current().sourceEvidenceStatus).toBe('draft')
    tasks = [{ ...report, artifacts: [{ ...report.artifacts[0]!, sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof' }] }]
    await hook.render()
    expect(hook.current().sourceEvidenceStatus).toBe('verified')
    expect(preview).toHaveBeenCalledTimes(1)
  })
  it('does not apply a newer verified file status to an older draft that is still displayed', async () => {
    const report = task('one'); report.acceptance = { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true }
    report.artifacts[0]!.sourceEvidenceStatus = 'draft'
    tasks = [report]
    let finish!: (value: unknown) => void
    const preview = vi.fn().mockResolvedValueOnce({ ok: true, url: 'http://127.0.0.1:1/old-draft', title: '草稿', sha256: 'hash' })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    tasks = [{ ...report, artifacts: [{ ...report.artifacts[0]!, sha256: 'new-verified-bytes', sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof-new' }] }]
    await hook.render()
    expect(hook.current().url).toBe('http://127.0.0.1:1/old-draft')
    expect(hook.current().sourceEvidenceStatus).toBe('draft')
    await act(async () => finish({ ok: true, url: 'http://127.0.0.1:1/new-verified', title: '已核验', sha256: 'new-verified-bytes' }))
    expect(hook.current().url).toBe('http://127.0.0.1:1/new-verified')
    expect(hook.current().sourceEvidenceStatus).toBe('verified')
  })
  it('selects only verified HTML belonging to the current origin conversation', () => {
    expect(latestHtmlArtifact([task('one'), task('other', 'other')], 'chat')?.taskId).toBe('one')
    expect(latestHtmlArtifact([task('other', 'other')], 'chat')).toBeNull()
    const invalid = task('bad'); invalid.artifacts[0]!.validation = 'invalid'
    expect(latestHtmlArtifact([invalid], 'chat')).toBeNull()
  })
  it('deduplicates event replay and opens a changed artifact once', async () => {
    tasks = [task('one')]
    const preview = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:1/one', title: '报告' }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    expect(hook.current().url).toBe('http://127.0.0.1:1/one')
    tasks = [task('one')]; await hook.render()
    expect(preview).toHaveBeenCalledTimes(1)
    tasks = [task('one', 'chat', 'changed')]; await hook.render()
    expect(preview).toHaveBeenCalledTimes(2)
  })
  it('revalidates the original conversation when returning to its existing HTML', async () => {
    tasks = [task('one')]
    const preview = vi.fn(async () => ({ ok: true, url: `http://127.0.0.1:1/session-${preview.mock.calls.length}`, title: '报告' }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    const firstUrl = hook.current().url
    const firstKey = hook.current().key
    await hook.render('other')
    expect(hook.current().url).toBeNull()
    await hook.render('chat')
    expect(preview).toHaveBeenCalledTimes(2)
    expect(hook.current().url).not.toBe(firstUrl)
    expect(hook.current().key).toBe(firstKey)
  })
  it('renews the resource snapshot when only a verified companion changes and ignores reordered replay', async () => {
    const report = task('one')
    report.artifacts.push({ ...report.artifacts[0]!, id: 'css', relativePath: 'assets/report.css', sha256: 'css-v1' })
    tasks = [report]
    const preview = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:1/report', title: '报告' }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    const firstKey = hook.current().key
    tasks = [{ ...report, artifacts: [...report.artifacts].reverse() }]
    await hook.render()
    expect(preview).toHaveBeenCalledTimes(1)
    tasks = [{ ...report, artifacts: report.artifacts.map(file => file.id === 'css' ? { ...file, sha256: 'css-v2' } : file) }]
    await hook.render()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(hook.current().key).not.toBe(firstKey)
    expect(preview).toHaveBeenLastCalledWith({ taskId: 'one', artifactId: 'html' })
    tasks = [{ ...report, artifacts: report.artifacts.filter(file => file.id !== 'css') }]
    await hook.render()
    expect(preview).toHaveBeenCalledTimes(3)
  })
  it('discards a late preview response after switching conversations', async () => {
    tasks = [task('one')]
    let finish!: (value: unknown) => void
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: vi.fn(() => new Promise(resolve => { finish = resolve })) } })
    const hook = await mountPreview('chat')
    await hook.render('other')
    await act(async () => finish({ ok: true, url: 'http://127.0.0.1:1/old', title: 'old' }))
    expect(hook.current().url).toBeNull()
  })
})
