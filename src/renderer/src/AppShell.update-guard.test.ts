// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckedDocumentWriteResult } from '@shared/write-document'
import AppShell from './AppShell'
import { useChatStore } from './store/chat-store'
import { preflightAndInstallGuiUpdate } from './lib/gui-update-install-preflight'
import { useWriteWorkspaceStore } from './write/write-workspace-store'

const lifecycle = vi.hoisted(() => ({ workbenchMounted: 0, workbenchUnmounted: 0, attempt: null as Promise<unknown> | null }))
vi.mock('./components/Workbench', () => ({ Workbench: () => {
  useEffect(() => {
    lifecycle.workbenchMounted += 1
    return () => {
      lifecycle.workbenchUnmounted += 1
      const state = useWriteWorkspaceStore.getState()
      // The real Write view starts a best-effort save when routing away.
      void state.flushSave(state.workspaceRoot)
    }
  }, [])
  return createElement('div', { 'data-testid': 'workbench-route' }, 'Write workbench')
} }))
vi.mock('./components/SettingsView', () => ({ SettingsView: () => createElement('button', {
  'data-testid': 'settings-install', onClick: () => { lifecycle.attempt = preflightAndInstallGuiUpdate() }
}, 'Restart and update') }))
vi.mock('./components/InitialSetupDialog', () => ({ InitialSetupDialog: () => null }))

const workspaceRoot = '/tmp/app-shell-update-guard'
const path = `${workspaceRoot}/draft.md`
const revision = { fingerprint: 'baseline', size: 13, modifiedAt: 1 }
const originalBoot = useChatStore.getState().boot
let container: HTMLDivElement
let root: Root

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  lifecycle.workbenchMounted = 0; lifecycle.workbenchUnmounted = 0; lifecycle.attempt = null
  useChatStore.setState({ route: 'write', boot: vi.fn(async () => undefined), initialSetupOpen: false })
  useWriteWorkspaceStore.getState().resetWorkspace()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useWriteWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useWriteWorkspaceStore.getState().resetWorkspace()
  useChatStore.setState({ route: 'chat', boot: originalBoot })
  vi.restoreAllMocks()
})

describe('AppShell update protection across Settings lifecycle', () => {
  it.each(['save-fails', 'edit-during-save', 'conflict'] as const)('keeps Write protected after Workbench unmounts for Settings: %s', async (branch) => {
    const save = deferred<CheckedDocumentWriteResult>()
    Object.defineProperty(window, 'workwise', { configurable: true, value: {
      platform: 'darwin',
      getAppVersion: vi.fn(async () => '0.5.4'),
      preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [] })),
      installGuiUpdate: vi.fn(async () => ({ ok: true })),
      readWorkspaceFile: vi.fn(async () => ({ ok: true, path, content: 'Saved content', size: 13, truncated: false })),
      readDocumentSnapshot: vi.fn(async () => ({ path, content: 'Saved content', revision })),
      writeDocumentChecked: vi.fn(() => save.promise)
    } })
    useWriteWorkspaceStore.setState({ workspaceRoot })
    await useWriteWorkspaceStore.getState().openFile(workspaceRoot, path)
    await act(async () => root.render(createElement(AppShell)))
    expect(container.querySelector('[data-testid="workbench-route"]')).not.toBeNull()
    expect(lifecycle.workbenchMounted).toBe(1)
    useWriteWorkspaceStore.getState().setFileContent('Draft before Settings')
    if (branch === 'conflict') useWriteWorkspaceStore.setState({ documentConflict: {
      path, expectedRevision: revision, currentRevision: null, currentContent: 'External content', attemptedContent: 'Draft before Settings'
    } })

    await act(async () => useChatStore.setState({ route: 'settings' }))
    expect(lifecycle.workbenchUnmounted).toBe(1)
    expect(container.querySelector('[data-testid="workbench-route"]')).toBeNull()
    const install = container.querySelector<HTMLButtonElement>('[data-testid="settings-install"]')!
    expect(install).not.toBeNull()
    await act(async () => install.click())
    if (branch !== 'conflict') {
      expect(useWriteWorkspaceStore.getState().saveStatus).toBe('saving')
      expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
      if (branch === 'edit-during-save') useWriteWorkspaceStore.getState().setFileContent('New draft while Settings is saving')
      save.resolve(branch === 'save-fails'
        ? { ok: false, message: 'Synthetic save failure after Workbench unmounted' }
        : { ok: true, snapshot: { path, content: 'Draft before Settings', revision: { ...revision, fingerprint: 'saved-draft' } } })
    }
    await expect(lifecycle.attempt).resolves.toMatchObject({ ok: false })
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(branch === 'edit-during-save' ? 'New draft while Settings is saving' : 'Draft before Settings')
  })
})
