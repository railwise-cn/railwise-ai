import type i18next from 'i18next'
import type { AppSettingsV1 } from '@shared/app-settings'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { persistComposerSelection, readStoredComposerSelection } from './chat-store-helpers'
import type { ChatState, ChatStoreGet, ChatStoreSet, InitialSetupMode, PluginHostRoute, SettingsRouteSection } from './chat-store-types'

type CreateAppActionsOptions = {
  set: ChatStoreSet
  get: ChatStoreGet
  i18n: typeof i18next
  persistComposerModel: (model: string) => void
  readStoredComposerModel: (allowedIds: readonly string[]) => string
  mergeComposerPickList: (upstreamOk: boolean, upstreamIds: string[]) => string[]
  getComposerModelLoadPromise: () => Promise<void> | null
  setComposerModelLoadPromise: (promise: Promise<void> | null) => void
  applyTheme: (theme: AppSettingsV1['theme']) => void
  applyUiFontScale: (scale: AppSettingsV1['uiFontScale']) => void
  applyDocumentLocale: (locale: AppSettingsV1['locale']) => void
  workspaceLabelFromPath: (workspaceRoot: string) => string
  normalizeWorkspaceRoot: (workspaceRoot?: string | null) => string
}

export function createAppActions(options: CreateAppActionsOptions): Pick<
  ChatState,
  | 'setError'
  | 'setComposerModel'
  | 'loadComposerModels'
  | 'setRoute'
  | 'openWrite'
  | 'openSettings'
  | 'openPlugins'
  | 'openClaw'
  | 'openSchedule'
  | 'openFlow'
  | 'openDesign'
  | 'openEngineering'
  | 'openInitialSetup'
  | 'closeInitialSetup'
  | 'selectInspectorItem'
  | 'applyI18nFromSettings'
  | 'reloadUiSettings'
> {
  const {
    set,
    get,
    i18n,
    persistComposerModel,
    readStoredComposerModel,
    mergeComposerPickList,
    getComposerModelLoadPromise,
    setComposerModelLoadPromise,
    applyTheme,
    applyUiFontScale,
    applyDocumentLocale,
    workspaceLabelFromPath,
    normalizeWorkspaceRoot
  } = options

  return {
    setError: (message) => set({ error: message }),

    setComposerModel: (modelId, providerId) => {
      persistComposerModel(modelId)
      persistComposerSelection(modelId, providerId)
      set({ composerModel: modelId, composerProviderId: providerId })
    },

    loadComposerModels: async () => {
      if (getComposerModelLoadPromise()) return getComposerModelLoadPromise()!
      if (typeof window.workwise === 'undefined') return
      const task = (async () => {
        const res = await window.workwise.fetchUpstreamModels()
        const pick = mergeComposerPickList(res.ok, res.ok ? res.modelIds : [])
        const groups = res.ok ? res.modelGroups ?? [] : []
        const allowed = new Set(pick)
        set((state) => {
          const selection = readStoredComposerSelection()
          // Keep explicit identities even when a provider is temporarily absent.
          // Sending then fails explicitly instead of silently changing endpoints.
          if (selection?.providerId) return { composerPickList: pick, composerModel: selection.model, composerProviderId: selection.providerId, composerModelGroups: groups }
          let model = state.composerModel
          if (model !== '' && !allowed.has(model)) {
            model = readStoredComposerModel(pick)
          }
          if (model !== '' && !allowed.has(model)) model = ''
          if (model !== state.composerModel) persistComposerModel(model)
          return { composerPickList: pick, composerModel: model, composerProviderId: undefined, composerModelGroups: groups }
        })
      })().finally(() => {
        setComposerModelLoadPromise(null)
      })
      setComposerModelLoadPromise(task)
      return task
    },

    setRoute: (route) => set({ route }),

    openWrite: async () => {
      set({ route: 'write' })
    },

    openSettings: (section: SettingsRouteSection = 'general') =>
      set((state) => ({
        route: 'settings',
        settingsSection: section,
        settingsReturnRoute: state.route === 'settings' ? state.settingsReturnRoute : state.route
      })),

    openPlugins: (host?: PluginHostRoute) =>
      set((state) => ({
        route: 'plugins',
        pluginHostRoute: host ?? (state.route === 'claw' ? 'claw' : 'chat')
      })),

    openClaw: () => {
      set({ route: 'claw' })
      void get().refreshClawChannels()
    },

    openSchedule: () => {
      set({ route: 'schedule' })
    },

    openFlow: (filter) => {
      set({ route: 'flow', flowFilter: filter ?? 'all' })
    },

    openDesign: () => {
      set({ route: 'design' })
    },

    openEngineering: () => {
      set({ route: 'engineering' })
    },

    openInitialSetup: (mode: InitialSetupMode = 'required') =>
      set({ initialSetupOpen: true, initialSetupMode: mode }),

    closeInitialSetup: () => set({ initialSetupOpen: false, initialSetupMode: 'required' }),

    selectInspectorItem: (id) => set({ inspectorSelectedId: id }),

    applyI18nFromSettings: async (locale) => {
      await i18n.changeLanguage(locale)
      applyDocumentLocale(locale)
    },

    reloadUiSettings: async () => {
      if (typeof window.workwise === 'undefined') return
      const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
      const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot)
      applyTheme(settings.theme)
      applyUiFontScale(settings.uiFontScale)
      set({
        workspaceRoot,
        workspaceLabel: workspaceLabelFromPath(workspaceRoot),
        clawChannels: settings.claw.channels,
        activeClawChannelId: settings.claw.channels.some(
          (channel) => channel.id === get().activeClawChannelId && channel.enabled
        )
          ? get().activeClawChannelId
          : settings.claw.channels.find((channel) => channel.enabled)?.id ?? ''
      })
      await get().applyI18nFromSettings(settings.locale)
      if (get().runtimeConnection === 'ready') {
        void get().refreshThreads()
      }
      void get().loadComposerModels()
    }
  }
}
