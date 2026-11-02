import { flushDesignWorkspaceSafely, isDesignWorkspaceReadyForUpdate } from '../design/design-workspace-safety'
import i18n from '../i18n'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const navigationKeys = new Set<keyof ChatState>([
  'route', 'workspaceRoot', 'workspaceLabel', 'settingsSection', 'settingsReturnRoute', 'pluginHostRoute', 'flowFilter'
])

/** Keep the native Design view alive until its current edits are safely saved. */
export function protectDesignNavigation(rawSet: ChatStoreSet, get: ChatStoreGet): ChatStoreSet {
  let navigationEpoch = 0
  return (partial) => {
    const before = get()
    const patch = typeof partial === 'function' ? partial(before) : partial
    const requestsNavigation = 'route' in patch || 'workspaceRoot' in patch
    const epoch = requestsNavigation ? ++navigationEpoch : navigationEpoch
    const leavingDesign = before.route === 'design' &&
      ((patch.route !== undefined && patch.route !== 'design') ||
       (patch.workspaceRoot !== undefined && patch.workspaceRoot !== before.workspaceRoot))
    if (!leavingDesign || isDesignWorkspaceReadyForUpdate()) {
      rawSet(patch)
      return
    }
    const navigation: Partial<ChatState> = {}
    const immediate: Partial<ChatState> = {}
    for (const key of Object.keys(patch) as Array<keyof ChatState>) {
      Object.assign(navigationKeys.has(key) ? navigation : immediate, { [key]: patch[key] })
    }
    // Runtime/SSE state must never wait for a document save or be replayed later.
    if (Object.keys(immediate).length) rawSet(immediate)
    void flushDesignWorkspaceSafely().catch(() => false).then((saved) => {
      if (epoch !== navigationEpoch || get().route !== before.route || get().workspaceRoot !== before.workspaceRoot) return
      if (!saved || !isDesignWorkspaceReadyForUpdate()) {
        rawSet({ error: i18n.t('common:designCloseSaveFailed') })
        return
      }
      rawSet(navigation)
    })
  }
}
