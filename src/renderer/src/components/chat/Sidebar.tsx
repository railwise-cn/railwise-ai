import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Settings,
  Smartphone
} from 'lucide-react'
import type { NormalizedThread } from '../../agent/types'
import { useChatStore, type AppRoute, type SettingsRouteSection } from '../../store/chat-store'
import type {
  ClawImChannelV1,
} from '@shared/app-settings'
import {
  ClawSidebarContent
} from './SidebarClaw'
import type { ClawImDialogMode } from './SidebarClawDialogHelpers'
import { ClawAddImDialog } from './SidebarClawDialog'
import { ConnectPhoneSidebarPanel } from './ConnectPhoneView'
import { SidebarProjectsSection } from './SidebarProjectsSection'
import { WorkspaceModeTabs } from './WorkspaceModeTabs'
import { DesignSidebarContent } from '../design/DesignSidebarContent'
import { EngineeringSidebarContent } from '../engineering/EngineeringSidebarContent'
import { dispatchEngineeringProjectCreate } from '../engineering/engineering-project-navigation'
import {
  SidebarCommandRow,
  SidebarFrame
} from '../sidebar/SidebarPrimitives'
import { WorkspaceSecondaryNavigation } from '../sidebar/WorkspaceSecondaryNavigation'

type Props = {
  threads: NormalizedThread[]
  activeThreadId: string | null
  activeView: 'chat' | 'write' | 'claw' | 'schedule' | 'design' | 'flow' | 'engineering'
  navigationRoute: AppRoute
  connectPhoneSidebarOpen: boolean
  focusModeEnabled: boolean
  runtimeReady: boolean
  threadSearch: string
  showArchivedThreads: boolean
  onThreadSearchChange: (query: string) => void
  onShowArchivedThreadsChange: (show: boolean) => void
  onSelectThread: (id: string) => void
  onRenameThread: (id: string, title: string) => Promise<void>
  onArchiveThread: (id: string) => Promise<void>
  onDeleteThread: (id: string) => Promise<void>
  onRestoreThread: (id: string) => Promise<void>
  onNewChat: () => void
  onNewChatInWorkspace: (workspaceRoot: string) => void
  onOpenSettings: (section?: SettingsRouteSection) => void
  onOpenPlugins: () => void
  onToggleConnectPhone: () => void
  onCodeOpen: () => void
  onToggleFocusMode: () => void
  onWriteOpen: () => void
  onScheduleOpen: () => void
  onFlowOpen: () => void
  onDesignOpen: () => void
  onTasksOpen?: () => void
  onEngineeringOpen: () => void
  onToggleSidebar: () => void
}

export function Sidebar({
  threads,
  activeThreadId,
  activeView,
  navigationRoute,
  connectPhoneSidebarOpen,
  focusModeEnabled,
  runtimeReady,
  threadSearch,
  showArchivedThreads,
  onThreadSearchChange,
  onShowArchivedThreadsChange,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onRestoreThread,
  onNewChat,
  onNewChatInWorkspace,
  onOpenSettings,
  onOpenPlugins,
  onToggleConnectPhone,
  onCodeOpen,
  onToggleFocusMode,
  onWriteOpen,
  onScheduleOpen,
  onFlowOpen,
  onDesignOpen,
  onTasksOpen,
  onEngineeringOpen,
  onToggleSidebar
}: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  const toolCapabilities = useChatStore((s) => s.runtimeCapabilities?.workspaces)
  const codeWorkspaceRoots = useChatStore((s) => s.codeWorkspaceRoots)
  const chooseWorkspace = useChatStore((s) => s.chooseWorkspace)
  const deleteWorkspace = useChatStore((s) => s.deleteWorkspace)
  const busy = useChatStore((s) => s.busy)
  const watchTurnCompletion = useChatStore((s) => s.watchTurnCompletion)
  const unreadThreadIds = useChatStore((s) => s.unreadThreadIds)
  const clawChannels = useChatStore((s) => s.clawChannels)
  const activeClawChannelId = useChatStore((s) => s.activeClawChannelId)
  const selectClawChannel = useChatStore((s) => s.selectClawChannel)
  const addClawChannel = useChatStore((s) => s.addClawChannel)
  const deleteClawChannel = useChatStore((s) => s.deleteClawChannel)
  const resetClawChannelSession = useChatStore((s) => s.resetClawChannelSession)

  const [imDialogMode, setImDialogMode] = useState<ClawImDialogMode | null>(null)

  const activeClawChannel = useMemo(
    () => clawChannels.find((channel) => channel.id === activeClawChannelId) ?? clawChannels[0] ?? null,
    [clawChannels, activeClawChannelId]
  )

  return (
    <>
    <SidebarFrame
      title={t('appName')}
      onCollapse={onToggleSidebar}
      footer={
        <div className="space-y-1">
          <SidebarCommandRow
            icon={<Smartphone className="h-4 w-4" strokeWidth={1.75} />}
            label={t('claw')}
            onClick={onToggleConnectPhone}
            active={connectPhoneSidebarOpen}
            activeSemantics="pressed"
            variant="footer"
          />
          <SidebarCommandRow
            icon={<Settings className="h-4 w-4" strokeWidth={1.75} />}
            label={t('settings')}
            onClick={() => onOpenSettings('general')}
            variant="footer"
          />
        </div>
      }
    >
      <div className="ds-no-drag flex flex-col px-1">
        <WorkspaceModeTabs
          activeRoute={navigationRoute}
          focusModeEnabled={focusModeEnabled}
          onCodeOpen={onCodeOpen}
          onToggleFocusMode={onToggleFocusMode}
          onEngineeringOpen={onEngineeringOpen}
        />

        <WorkspaceSecondaryNavigation
          toolCapabilities={toolCapabilities}
          activeRoute={navigationRoute}
          onWriteOpen={onWriteOpen}
          onOpenPlugins={onOpenPlugins}
          onScheduleOpen={onScheduleOpen}
          onFlowOpen={onFlowOpen}
          onDesignOpen={onDesignOpen}
          onTasksOpen={onTasksOpen}
        />

        <div className="mx-2 my-2 border-t border-[var(--ds-sidebar-divider)]" />

        <SidebarCommandRow
          icon={<Plus className="h-4 w-4" strokeWidth={2} />}
          label={activeView === 'engineering' ? t('engineeringNewProject') : t('newAgent')}
          onClick={runtimeReady ? (activeView === 'engineering' ? dispatchEngineeringProjectCreate : onNewChat) : undefined}
          disabled={!runtimeReady}
          disabledHint={t('runtimeActionNeedsConnection')}
          variant="accent"
        />
      </div>

      <div className="ds-no-drag mx-1 my-3" />

      {connectPhoneSidebarOpen ? (
        <ConnectPhoneSidebarPanel
          channels={clawChannels}
          onAddProvider={async (provider, agentProfile, platformCredential, options) => {
            await addClawChannel(provider, agentProfile, platformCredential, options)
            onToggleConnectPhone()
          }}
          onDisconnect={(channelId) => deleteClawChannel(channelId)}
          onOpenSettings={() => onOpenSettings('claw')}
        />
      ) : activeView === 'claw' ? (
        <ClawSidebarContent
          channels={clawChannels}
          activeChannelId={activeClawChannelId}
          activeThreadId={activeThreadId}
          runtimeReady={runtimeReady}
          onSelectChannel={(channelId) => void selectClawChannel(channelId)}
          onAddChannel={() => setImDialogMode('add')}
          onResetChannel={(channelId) => void resetClawChannelSession(channelId)}
          onOpenSettings={() => setImDialogMode('edit')}
          t={t}
        />
      ) : activeView === 'schedule' ? (
        <SidebarProjectsSection
          threads={threads}
          activeView="chat"
          activeThreadId={activeThreadId}
          runtimeReady={runtimeReady}
          searchQuery={threadSearch}
          showArchived={showArchivedThreads}
          workspaceRoot={workspaceRoot}
          workspaceRoots={codeWorkspaceRoots}
          busy={busy}
          watchTurnCompletion={watchTurnCompletion}
          unreadThreadIds={unreadThreadIds}
          locale={i18n.language}
          onPickWorkspace={() => void chooseWorkspace()}
          onRemoveWorkspace={deleteWorkspace}
          onCreateThreadInWorkspace={onNewChatInWorkspace}
          onSelectThread={onSelectThread}
          onRenameThread={onRenameThread}
          onArchiveThread={onArchiveThread}
          onDeleteThread={onDeleteThread}
          onRestoreThread={onRestoreThread}
          onSearchQueryChange={onThreadSearchChange}
          onShowArchivedChange={onShowArchivedThreadsChange}
          t={t}
        />
      ) : activeView === 'design' ? (
        <DesignSidebarContent workspaceRoot={workspaceRoot} />
      ) : activeView === 'engineering' ? (
        <EngineeringSidebarContent workspaceRoot={workspaceRoot} runtimeReady={runtimeReady} />
      ) : activeView === 'flow' ? (
        <div className="ds-no-drag mx-2 rounded-2xl border border-ds-border-muted bg-ds-card/70 p-3 text-[12px] leading-5 text-ds-muted">
          Flow 仍为 Preview。请在画布中配置、校验并测试流程。
        </div>
      ) : (
      <SidebarProjectsSection
        threads={threads}
        activeView={activeView === 'write' ? 'write' : 'chat'}
        activeThreadId={activeThreadId}
        runtimeReady={runtimeReady}
        searchQuery={threadSearch}
        showArchived={showArchivedThreads}
        workspaceRoot={workspaceRoot}
        workspaceRoots={codeWorkspaceRoots}
        busy={busy}
        watchTurnCompletion={watchTurnCompletion}
        unreadThreadIds={unreadThreadIds}
        locale={i18n.language}
        onPickWorkspace={() => void chooseWorkspace()}
        onRemoveWorkspace={deleteWorkspace}
        onCreateThreadInWorkspace={onNewChatInWorkspace}
        onSelectThread={onSelectThread}
        onRenameThread={onRenameThread}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onRestoreThread={onRestoreThread}
        onSearchQueryChange={onThreadSearchChange}
        onShowArchivedChange={onShowArchivedThreadsChange}
        t={t}
      />
      )}

    </SidebarFrame>

    {imDialogMode ? (
      <ClawAddImDialog
        mode={imDialogMode}
        initialProvider={activeClawChannel?.provider}
        initialChannelId={imDialogMode === 'edit' ? activeClawChannel?.id : undefined}
        channels={clawChannels}
        onClose={() => setImDialogMode(null)}
        onAddProvider={(provider, agentProfile, platformCredential, options) =>
          addClawChannel(provider, agentProfile, platformCredential, options)
        }
        onDeleteChannel={(channelId) => deleteClawChannel(channelId)}
        t={t}
      />
    ) : null}
    </>
  )
}
