import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from '../design/design-workspace-store'
import { registerDesignSaveSession, trackDesignSave } from '../design/design-workspace-safety'
import i18n from '../i18n'
import { protectDesignNavigation } from './design-navigation-safety'
import type { ChatState, ChatStoreSet } from './chat-store-types'

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value: T) => resolve(value) }
}
let unregister: () => void = () => undefined
let state: ChatState
let set: ChatStoreSet

beforeEach(() => {
  useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
  useDesignWorkspaceStore.getState().createNewDocument()
  state = { route: 'design', workspaceRoot: '/tmp/design-navigation', blocks: [], busy: false } as unknown as ChatState
  set = protectDesignNavigation((partial) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
  }, () => state)
})
afterEach(() => {
  unregister()
  useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
})

describe('Design navigation save fence', () => {
  it('applies runtime updates immediately and never replays them with delayed navigation', async () => {
    const saved = deferred<boolean>()
    unregister = registerDesignSaveSession({ flush: () => trackDesignSave(() => saved.promise), isNativeDirty: () => false })
    const original = useDesignWorkspaceStore.getState().document!
    set({ route: 'settings', settingsReturnRoute: 'design', busy: true, liveAssistant: 'earlier SSE' })
    expect(state).toMatchObject({ route: 'design', busy: true, liveAssistant: 'earlier SSE' })
    set({ busy: false, liveAssistant: 'newer SSE' })
    useDesignWorkspaceStore.getState().markSaved(original)
    saved.resolve(true)
    await vi.waitFor(() => expect(state.route).toBe('settings'))
    expect(state).toMatchObject({ busy: false, liveAssistant: 'newer SSE', settingsReturnRoute: 'design' })
  })

  it('commits only the latest navigation request after saving', async () => {
    const saved = deferred<boolean>()
    unregister = registerDesignSaveSession({ flush: () => saved.promise, isNativeDirty: () => false })
    set({ route: 'settings' })
    set({ route: 'plugins', pluginHostRoute: 'chat' })
    useDesignWorkspaceStore.getState().markSaved(useDesignWorkspaceStore.getState().document!)
    saved.resolve(true)
    await vi.waitFor(() => expect(state.route).toBe('plugins'))
    expect(state.settingsSection).toBeUndefined()
  })

  it('invalidates a delayed departure when the latest navigation stays in Design', async () => {
    const saved = deferred<boolean>()
    unregister = registerDesignSaveSession({ flush: () => saved.promise, isNativeDirty: () => false })
    set({ route: 'settings' })
    set({ route: 'design' })
    useDesignWorkspaceStore.getState().markSaved(useDesignWorkspaceStore.getState().document!)
    saved.resolve(true)
    await Promise.resolve(); await Promise.resolve()
    expect(state.route).toBe('design')
  })

  it.each(['save-fails', 'newer-draft'] as const)('preserves the original view and workspace when %s', async (branch) => {
    const saved = deferred<boolean>()
    const original = useDesignWorkspaceStore.getState().document!
    unregister = registerDesignSaveSession({ flush: () => saved.promise, isNativeDirty: () => false })
    set({ workspaceRoot: '/tmp/other-design-workspace', workspaceLabel: 'Other', liveAssistant: 'still live' })
    expect(state).toMatchObject({ route: 'design', workspaceRoot: '/tmp/design-navigation', liveAssistant: 'still live' })
    if (branch === 'newer-draft') {
      useDesignWorkspaceStore.getState().addDefaultElement('text')
      useDesignWorkspaceStore.getState().markSaved(original)
    }
    saved.resolve(branch !== 'save-fails')
    await vi.waitFor(() => expect(state.error).toBe(i18n.t('common:designCloseSaveFailed')))
    expect(state.workspaceRoot).toBe('/tmp/design-navigation')
    expect(useDesignWorkspaceStore.getState().document!.pages[0].elements).toHaveLength(branch === 'newer-draft' ? 1 : 0)
  })

  it('does not destroy a loading/importing editor or flush during a busy operation', async () => {
    const flush = vi.fn(async () => true)
    unregister = registerDesignSaveSession({ flush, isNativeDirty: () => false, isBusy: () => true })
    set({ route: 'settings' })
    await vi.waitFor(() => expect(state.error).toBeTruthy())
    expect(state.route).toBe('design')
    expect(flush).not.toHaveBeenCalled()
  })
})
