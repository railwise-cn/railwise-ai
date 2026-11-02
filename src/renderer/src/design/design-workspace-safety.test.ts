import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preflightAndInstallGuiUpdate } from '../lib/gui-update-install-preflight'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { isDesignWorkspaceReadyForUpdate, registerDesignGuiUpdateSaveGuard, registerDesignSaveSession, trackDesignSave } from './design-workspace-safety'

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value: T) => resolve(value) }
}
let unregister: () => void
let releaseSession: () => void
beforeEach(() => {
  const target = new EventTarget()
  Object.assign(target, { workwise: {
    getAppVersion: vi.fn(async () => '0.5.4'),
    preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [] })),
    installGuiUpdate: vi.fn(async () => ({ ok: false, currentVersion: '0.5.4' }))
  } })
  vi.stubGlobal('window', target)
  useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
  useDesignWorkspaceStore.getState().createNewDocument()
  useDesignWorkspaceStore.getState().markSaved(useDesignWorkspaceStore.getState().document!)
  unregister = registerDesignGuiUpdateSaveGuard()
  releaseSession = () => undefined
})
afterEach(() => {
  unregister(); releaseSession()
  useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
  vi.unstubAllGlobals()
})

describe('persistent Design updater guard', () => {
  it.each(['dirty', 'save-error', 'native-dirty'] as const)('refuses an off-route %s document without a mounted saver', async (branch) => {
    if (branch === 'dirty') useDesignWorkspaceStore.getState().addDefaultElement('text')
    if (branch === 'save-error') useDesignWorkspaceStore.getState().markSaveError('Synthetic failed write')
    if (branch === 'native-dirty') useDesignWorkspaceStore.setState({ nativeDirty: true })
    expect(await preflightAndInstallGuiUpdate()).toMatchObject({ ok: false })
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
  })

  it('waits for pending native/canvas persistence even with equal metadata revisions', async () => {
    const saved = deferred<boolean>()
    const pending = trackDesignSave(() => saved.promise)
    releaseSession = registerDesignSaveSession({ flush: () => pending, isNativeDirty: () => false })
    expect(isDesignWorkspaceReadyForUpdate()).toBe(false)
    const updating = preflightAndInstallGuiUpdate()
    await Promise.resolve(); await Promise.resolve()
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    saved.resolve(true)
    await updating
    expect(window.workwise.preflightGuiUpdateInstall).toHaveBeenCalledOnce()
  })

  it('checks again for edits made during updater preflight', async () => {
    const preflight = deferred<Awaited<ReturnType<Window['workwise']['preflightGuiUpdateInstall']>>>()
    vi.mocked(window.workwise.preflightGuiUpdateInstall).mockImplementation(() => preflight.promise)
    const updating = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.preflightGuiUpdateInstall).toHaveBeenCalledOnce())
    useDesignWorkspaceStore.getState().addDefaultElement('text')
    preflight.resolve({ ok: true, activeWork: [] })
    expect(await updating).toMatchObject({ ok: false })
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(useDesignWorkspaceStore.getState().document!.pages[0].elements).toHaveLength(1)
  })

  it('blocks late canvas/AI mutations during handoff and unlocks when installation fails', async () => {
    const install = deferred<Awaited<ReturnType<Window['workwise']['installGuiUpdate']>>>()
    vi.mocked(window.workwise.installGuiUpdate).mockImplementation(() => install.promise)
    const before = useDesignWorkspaceStore.getState().document!
    const updating = preflightAndInstallGuiUpdate()
    await vi.waitFor(() => expect(window.workwise.installGuiUpdate).toHaveBeenCalledOnce())
    expect(useDesignWorkspaceStore.getState().guiUpdateInstallPending).toBe(true)
    useDesignWorkspaceStore.getState().addDefaultElement('text')
    useDesignWorkspaceStore.getState().createNewDocument()
    const ack = useDesignWorkspaceStore.getState().applyCanvasCommand({
      schema: 'workwise.design.command', version: 1, idempotencyKey: 'late-ai-command',
      workspaceRoot: '/tmp/design', documentId: before.id, pageId: before.pages[0].id,
      expectedRevision: before.revision, operations: []
    }, '/tmp/design')
    expect(ack.ok).toBe(false)
    expect(useDesignWorkspaceStore.getState().document).toBe(before)
    install.resolve({ ok: false, currentVersion: '0.5.4', message: 'Synthetic installer failure' })
    await updating
    expect(useDesignWorkspaceStore.getState().guiUpdateInstallPending).toBe(false)
    useDesignWorkspaceStore.getState().addDefaultElement('text')
    expect(useDesignWorkspaceStore.getState().document!.pages[0].elements).toHaveLength(1)
  })
})
