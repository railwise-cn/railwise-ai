import { registerGuiUpdateSaveHandler } from '../lib/gui-update-install-preflight'
import { isWriteWorkspaceReadyForUpdate, useWriteWorkspaceStore } from './write-workspace-store'

/** Owned by AppShell across Workbench, Settings and other route transitions. */
export function registerWriteGuiUpdateSaveGuard(): () => void {
  return registerGuiUpdateSaveHandler('Write', async () => {
    const workspaceRoot = useWriteWorkspaceStore.getState().workspaceRoot
    if (!workspaceRoot.trim()) return true
    if (!await useWriteWorkspaceStore.getState().flushSave(workspaceRoot)) return false
    return isWriteWorkspaceReadyForUpdate()
  }, {
    isReady: isWriteWorkspaceReadyForUpdate,
    beginHandoff: () => {
      useWriteWorkspaceStore.setState({ guiUpdateInstallPending: true })
      return () => useWriteWorkspaceStore.setState({ guiUpdateInstallPending: false })
    }
  })
}
