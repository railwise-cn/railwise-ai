import { registerGuiUpdateSaveHandler } from '../lib/gui-update-install-preflight'
import { useDesignWorkspaceStore } from './design-workspace-store'

type DesignSaveSession = { flush: () => Promise<boolean>; isNativeDirty: () => boolean; isBusy?: () => boolean }
let session: DesignSaveSession | null = null
let pendingSaves = 0

/** The view owns the native editor; navigation must save before destroying it. */
export function registerDesignSaveSession(value: DesignSaveSession): () => void {
  session = value
  return () => { if (session === value) session = null }
}

export function trackDesignSave(operation: () => Promise<boolean>): Promise<boolean> {
  pendingSaves += 1
  return Promise.resolve().then(operation).finally(() => { pendingSaves -= 1 })
}

export function isDesignWorkspaceReadyForUpdate(): boolean {
  const state = useDesignWorkspaceStore.getState()
  return pendingSaves === 0 && !state.nativeDirty && !session?.isNativeDirty() && !session?.isBusy?.() &&
    state.saveState !== 'saving' && state.saveState !== 'error' && !state.saveError &&
    (!state.document || state.persistedRevision === state.document.revision)
}

export async function flushDesignWorkspaceSafely(): Promise<boolean> {
  if (isDesignWorkspaceReadyForUpdate()) return true
  const current = session
  if (current?.isBusy?.()) return false
  if (!current || !await current.flush()) return false
  return session === current && isDesignWorkspaceReadyForUpdate()
}

/** AppShell keeps this registered while Settings replaces Workbench. */
export function registerDesignGuiUpdateSaveGuard(): () => void {
  return registerGuiUpdateSaveHandler('Design', flushDesignWorkspaceSafely, {
    isReady: isDesignWorkspaceReadyForUpdate,
    beginHandoff: () => {
      useDesignWorkspaceStore.setState({ guiUpdateInstallPending: true })
      return () => useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
    }
  })
}
