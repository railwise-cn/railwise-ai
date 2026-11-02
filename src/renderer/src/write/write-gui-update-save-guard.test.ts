import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckedDocumentWriteResult } from '@shared/write-document'
import { preflightAndInstallGuiUpdate } from '../lib/gui-update-install-preflight'
import { registerWriteGuiUpdateSaveGuard } from './write-gui-update-save-guard'
import { useWriteWorkspaceStore } from './write-workspace-store'

const workspaceRoot = '/tmp/updater-drafts'
const path = `${workspaceRoot}/draft.md`
let unregister: () => void = () => undefined

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}

async function setup(overrides: Partial<Window['workwise']> = {}): Promise<void> {
  const target = new EventTarget()
  Object.assign(target, { workwise: {
    getAppVersion: vi.fn(async () => '0.5.4'),
    preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [] })),
    installGuiUpdate: vi.fn(async () => ({ ok: false, currentVersion: '0.5.4', message: 'Synthetic installer failure' })),
    readWorkspaceFile: vi.fn(async () => ({ ok: true, path, content: 'Saved content', size: 13, truncated: false })),
    readDocumentSnapshot: vi.fn(async () => ({ path, content: 'Saved content', revision: { fingerprint: 'baseline', size: 13, modifiedAt: 1 } })),
    ...overrides
  } })
  vi.stubGlobal('window', target)
  useWriteWorkspaceStore.setState({ workspaceRoot })
  await useWriteWorkspaceStore.getState().openFile(workspaceRoot, path)
  unregister = registerWriteGuiUpdateSaveGuard()
}

beforeEach(() => useWriteWorkspaceStore.getState().resetWorkspace())
afterEach(() => {
  unregister()
  useWriteWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useWriteWorkspaceStore.getState().resetWorkspace()
  vi.unstubAllGlobals()
})

describe('Write updater save and handoff guard', () => {
  it('does not continue to installer preflight when an edit arrives during saving', async () => {
    const write = deferred<CheckedDocumentWriteResult>()
    await setup({ writeDocumentChecked: vi.fn(() => write.promise) })
    useWriteWorkspaceStore.getState().setFileContent('First draft')
    const installing = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.writeDocumentChecked).toHaveBeenCalledOnce())
    useWriteWorkspaceStore.getState().setFileContent('New draft during save')
    write.resolve({ ok: true, snapshot: { path, content: 'First draft', revision: { fingerprint: 'first', size: 11, modifiedAt: 2 } } })
    expect(await installing).toMatchObject({ ok: false })
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'New draft during save', saveStatus: 'dirty', guiUpdateInstallPending: false })
  })

  it('rejects new edits made while updater preflight is pending', async () => {
    const preflight = deferred<Awaited<ReturnType<Window['workwise']['preflightGuiUpdateInstall']>>>()
    await setup({ preflightGuiUpdateInstall: vi.fn(() => preflight.promise) })
    const installing = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.preflightGuiUpdateInstall).toHaveBeenCalledOnce())
    useWriteWorkspaceStore.getState().setFileContent('Draft entered during preflight')
    preflight.resolve({ ok: true, activeWork: [] })
    expect(await installing).toMatchObject({ ok: false })
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'Draft entered during preflight', saveStatus: 'dirty', guiUpdateInstallPending: false })
  })

  it('retains the persistent guard when leaving Write starts a save during preflight', async () => {
    const preflight = deferred<Awaited<ReturnType<Window['workwise']['preflightGuiUpdateInstall']>>>()
    const write = deferred<CheckedDocumentWriteResult>()
    await setup({ preflightGuiUpdateInstall: vi.fn(() => preflight.promise), writeDocumentChecked: vi.fn(() => write.promise) })
    const installing = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.preflightGuiUpdateInstall).toHaveBeenCalledOnce())
    useWriteWorkspaceStore.getState().setFileContent('Draft entered just before leaving Write')
    // WriteWorkspaceView's unmount cleanup starts this save. Its updater guard
    // is owned by AppShell, so routing away cannot unregister it.
    const savingOnLeave = useWriteWorkspaceStore.getState().flushSave(workspaceRoot)
    expect(useWriteWorkspaceStore.getState().saveStatus).toBe('saving')
    preflight.resolve({ ok: true, activeWork: [] })
    expect(await installing).toMatchObject({ ok: false })
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    write.resolve({ ok: false, message: 'Synthetic save failure after route switch' })
    expect(await savingOnLeave).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'Draft entered just before leaving Write', saveStatus: 'error' })
  })

  it('does not skip an inactive Write conflict or use a previously captured workspace root', async () => {
    await setup()
    const originalFlush = useWriteWorkspaceStore.getState().flushSave
    const flushSave = vi.fn((root: string) => originalFlush(root))
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/tmp/another-write-workspace',
      flushSave,
      documentConflict: { path, expectedRevision: null, currentRevision: null, currentContent: 'External', attemptedContent: 'Saved content' }
    })
    try {
      expect(await preflightAndInstallGuiUpdate()).toMatchObject({ ok: false })
      expect(flushSave).toHaveBeenCalledWith('/tmp/another-write-workspace')
      expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
      expect(useWriteWorkspaceStore.getState().documentConflict).not.toBeNull()
    } finally { useWriteWorkspaceStore.setState({ flushSave: originalFlush }) }
  })

  it('blocks editor input and dirty mutations during installer handoff and unlocks on failure', async () => {
    const installer = deferred<Awaited<ReturnType<Window['workwise']['installGuiUpdate']>>>()
    await setup({ installGuiUpdate: vi.fn(() => installer.promise) })
    const installing = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.installGuiUpdate).toHaveBeenCalledOnce())
    expect(useWriteWorkspaceStore.getState().guiUpdateInstallPending).toBe(true)
    useWriteWorkspaceStore.getState().setFileContent('Must not become a hidden unsaved draft')
    const input = new Event('beforeinput', { cancelable: true })
    expect(window.dispatchEvent(input)).toBe(false)
    expect(input.defaultPrevented).toBe(true)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'Saved content', saveStatus: 'saved' })
    installer.resolve({ ok: false, currentVersion: '0.5.4', message: 'Synthetic failure' })
    expect(await installing).toMatchObject({ ok: false })
    expect(useWriteWorkspaceStore.getState().guiUpdateInstallPending).toBe(false)
    const afterFailure = new Event('beforeinput', { cancelable: true })
    expect(window.dispatchEvent(afterFailure)).toBe(true)
    useWriteWorkspaceStore.getState().setFileContent('Editing works again')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('Editing works again')
  })

  it('retains the read-only handoff after quitAndInstall succeeds', async () => {
    await setup({ installGuiUpdate: vi.fn(async () => ({ ok: true as const })) })
    expect(await preflightAndInstallGuiUpdate()).toEqual({ ok: true })
    expect(useWriteWorkspaceStore.getState().guiUpdateInstallPending).toBe(true)
    useWriteWorkspaceStore.getState().setFileContent('Must remain blocked until exit')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('Saved content')
  })
})
