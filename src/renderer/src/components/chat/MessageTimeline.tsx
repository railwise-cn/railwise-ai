import type { ReactElement, RefObject } from 'react'
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatBlock, RuntimeConnectionStatus } from '../../agent/types'
import type { ConversationViewMode } from '@shared/app-settings'
import { useChatStore } from '../../store/chat-store'
import { resolveTimelineWorkspaceRoot, useTimelineStores } from './use-timeline-stores'
import { useTimelineScroll } from './use-timeline-scroll'
import { deriveTurnSections } from './derive-turn-sections'
import { MessageTimelineEmptyHero, ThreadForkBanner, ThreadForkPoint } from './message-timeline-empty'
import { GeneratedFilesPanel, MessageBubble } from './message-timeline-bubbles'
import { ReviewPlanCard, ReviewSummaryCard, TurnChangeSummary, WorkMetaRow } from './message-timeline-cards'
import { ProcessSectionRow, groupProcessSections } from './message-timeline-process'
import { AnimatedWorkLogo } from './AnimatedWorkLogo'
import {
  groupTurns,
  sameTurnContent,
  splitThink,
  stableTurnKey,
  turnHasPendingRuntimeWork,
  type Turn
} from './message-timeline-turns'
import { extractPlanMetadataFromBlock } from '../../plan/plan-tool'
import { planDisplayNameFromRelativePath } from '../../plan/plan-path'
import {
  isCriticalProcessBlock,
  deriveSemanticProgress,
  visibleProcessBlocksForMode
} from './conversation-visibility'

export { summarizeToolBlock } from './message-timeline-process'

type Props = {
  blocks: ChatBlock[]
  liveReasoning: string
  live: string
  activeThreadId: string | null
  runtimeConnection: RuntimeConnectionStatus
  runtimeError?: string | null
  onRetryConnection: () => void
  onOpenSettings: () => void
  onSelectSuggestion?: (prompt: string) => void
  devPreviewCard?: ReactElement | null
  /** Disables the inline Review Plan card's Build action while a turn runs. */
  planActionsBusy?: boolean
  /** Runs the active plan (Build button on the inline Review Plan card). */
  onBuildPlan?: () => void
  /** Opens/focuses the Plan panel (Open button on the inline card). */
  onOpenPlan?: () => void
  viewMode?: ConversationViewMode
  professionalSurface?: boolean
}

const TURN_PAGE_SIZE = 18
const AUTO_COLLAPSE_THRESHOLD = 24

function blockScrollStamp(block: ChatBlock | undefined): string {
  if (!block) return ''
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'system':
      return `${block.id}:${block.kind}:${block.text.length}`
    case 'tool':
      return `${block.id}:${block.kind}:${block.status}:${block.summary.length}:${block.detail?.length ?? 0}`
    case 'review':
      return `${block.id}:${block.kind}:${block.status}:${block.reviewText?.length ?? 0}`
    case 'approval':
    case 'user_input':
    case 'compaction':
      return `${block.id}:${block.kind}:${block.status}`
    default:
      return ''
  }
}

export function MessageTimeline({
  blocks,
  liveReasoning,
  live,
  activeThreadId,
  runtimeConnection,
  runtimeError,
  onRetryConnection,
  onOpenSettings,
  onSelectSuggestion,
  devPreviewCard,
  planActionsBusy,
  onBuildPlan,
  onOpenPlan,
  viewMode = 'concise',
  professionalSurface = false
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const {
    route,
    workspaceRoot,
    chooseWorkspace,
    activeClawChannel,
    busy,
    currentTurnUserId,
    turnStartedAtByUserId,
    turnDurationByUserId,
    turnReasoningFirstAtByUserId,
    turnReasoningLastAtByUserId,
    activeThread
  } = useTimelineStores(activeThreadId)

  const heroRoute: 'chat' | 'claw' = route === 'claw' ? 'claw' : 'chat'
  const hasContent = blocks.length > 0 || live || liveReasoning
  const endRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const turns = useMemo(() => groupTurns(blocks), [blocks])
  const latestBlock = blocks[blocks.length - 1]
  const scrollContentKey = [
    activeThreadId ?? '',
    turns.length,
    blocks.length,
    blockScrollStamp(latestBlock),
    live.length,
    liveReasoning.length
  ].join(':')
  const {
    visibleTurnCount,
    hiddenTurnCount,
    loadEarlierTurns,
    collapseEarlierTurns
  } = useTimelineScroll({
    containerRef,
    endRef,
    activeThreadId,
    pageSize: TURN_PAGE_SIZE,
    autoCollapseThreshold: AUTO_COLLAPSE_THRESHOLD,
    totalTurns: turns.length,
    busy,
    scrollDeps: {
      contentKey: scrollContentKey,
      streaming: Boolean(live.trim() || liveReasoning.trim()),
      userTurnKey: currentTurnUserId ?? ''
    }
  })
  const visibleTurns = useMemo(
    () => (hiddenTurnCount > 0 ? turns.slice(hiddenTurnCount) : turns),
    [hiddenTurnCount, turns]
  )
  const forkedFromTitle = activeThread?.forkedFromTitle?.trim() ?? ''
  const timelineWorkspaceRoot = resolveTimelineWorkspaceRoot(activeThread, workspaceRoot)
  const forkBoundaryTurnCount =
    typeof activeThread?.forkedFromTurnCount === 'number'
      ? Math.max(0, activeThread.forkedFromTurnCount)
      : undefined

  // Tick a clock while a turn is running so the live "Worked for Xs" updates.
  const [tickNow, setTickNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy || !currentTurnUserId) return
    setTickNow(Date.now())
    const id = window.setInterval(() => setTickNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [busy, currentTurnUserId])

  return (
    <div ref={containerRef} className="ds-no-drag flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div className="ds-message-timeline-content ds-chat-column-inset mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-8 pb-10 pt-8">
        {!hasContent || !activeThreadId ? (
          <MessageTimelineEmptyHero
            route={heroRoute}
            ready={runtimeConnection === 'ready'}
            hasWorkspace={!!workspaceRoot}
            runtimeError={runtimeError}
            activeClawChannel={activeClawChannel}
            onPickWorkspace={() => void chooseWorkspace()}
            onRetry={onRetryConnection}
            onOpenSettings={onOpenSettings}
            onSelectSuggestion={onSelectSuggestion}
          />
        ) : null}

        {!professionalSurface && activeThread?.forkedFromThreadId ? (
          <ThreadForkBanner parentTitle={forkedFromTitle} />
        ) : null}

        {hiddenTurnCount > 0 ? (
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => loadEarlierTurns({ userInitiated: true })}
              className="ds-chip rounded-full px-4 py-2 text-[13px] font-medium text-ds-muted transition hover:text-ds-ink"
            >
              {t('timelineShowEarlierTurns', { count: Math.min(hiddenTurnCount, TURN_PAGE_SIZE) })}
            </button>
          </div>
        ) : null}

        {visibleTurns.map((turn, index) => {
          const absoluteTurnIndex = hiddenTurnCount + index
          const userId = turn.user?.id
          const isLive = !!(userId && currentTurnUserId === userId)
          const startedAt = userId ? turnStartedAtByUserId[userId] : undefined
          const recordedDuration = userId ? turnDurationByUserId[userId] : undefined
          const durationMs =
            recordedDuration ??
            (isLive && typeof startedAt === 'number'
              ? Math.max(0, tickNow - startedAt)
              : undefined)
          const reasoningFirst = userId ? turnReasoningFirstAtByUserId[userId] : undefined
          const reasoningLast = userId ? turnReasoningLastAtByUserId[userId] : undefined
          const reasoningDurationMs =
            typeof reasoningFirst === 'number' && typeof reasoningLast === 'number'
              ? Math.max(0, reasoningLast - reasoningFirst)
              : undefined
          const turnPending = turnHasPendingRuntimeWork(turn)
          const isLatestTurn = index === visibleTurns.length - 1
          const hasLiveStream = isLatestTurn && !!(liveReasoning.trim() || live.trim())
          const showForkPoint = !professionalSurface &&
            forkBoundaryTurnCount !== undefined && absoluteTurnIndex === forkBoundaryTurnCount
          return (
            <Fragment key={stableTurnKey(turn, absoluteTurnIndex)}>
              {showForkPoint ? <ThreadForkPoint parentTitle={forkedFromTitle} /> : null}
              <MemoMessageTurn
                turn={turn}
                professionalSurface={professionalSurface}
                isProcessing={(busy && isLatestTurn) || turnPending || hasLiveStream}
                liveReasoning={isLatestTurn ? liveReasoning : ''}
                live={isLatestTurn ? live : ''}
                durationMs={durationMs}
                reasoningDurationMs={reasoningDurationMs}
                devPreviewCard={isLatestTurn ? devPreviewCard : null}
                planActionsBusy={planActionsBusy}
                onBuildPlan={onBuildPlan}
                onOpenPlan={onOpenPlan}
                viewportRef={containerRef}
                workspaceRoot={timelineWorkspaceRoot}
                activeThreadId={activeThreadId}
                viewMode={viewMode}
              />
            </Fragment>
          )
        })}

        {!professionalSurface && forkBoundaryTurnCount !== undefined &&
        forkBoundaryTurnCount === turns.length &&
        hasContent ? (
          <ThreadForkPoint parentTitle={forkedFromTitle} />
        ) : null}

        {hiddenTurnCount === 0 && turns.length > TURN_PAGE_SIZE && turns.length > AUTO_COLLAPSE_THRESHOLD && !busy ? (
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => {
                collapseEarlierTurns()
              }}
              className="rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            >
              {t('timelineCollapseEarlierTurns')}
            </button>
          </div>
        ) : null}

        {blocks.length === 0 && (live || liveReasoning) ? (
          <MemoMessageTurn
            turn={{ blocks: [] }}
            professionalSurface={professionalSurface}
            isProcessing={busy}
            liveReasoning={liveReasoning}
            live={live}
            devPreviewCard={devPreviewCard}
            viewportRef={containerRef}
            workspaceRoot={timelineWorkspaceRoot}
            activeThreadId={activeThreadId}
            viewMode={viewMode}
            durationMs={
              currentTurnUserId && typeof turnStartedAtByUserId[currentTurnUserId] === 'number'
                ? Math.max(0, tickNow - turnStartedAtByUserId[currentTurnUserId])
                : undefined
            }
            reasoningDurationMs={(() => {
              if (!currentTurnUserId) return undefined
              const first = turnReasoningFirstAtByUserId[currentTurnUserId]
              const last = turnReasoningLastAtByUserId[currentTurnUserId]
              if (typeof first !== 'number' || typeof last !== 'number') return undefined
              return Math.max(0, last - first)
            })()}
          />
        ) : null}
        <div ref={endRef} aria-hidden className="h-px w-full shrink-0" />
      </div>
    </div>
  )
}

function MessageTurn({
  turn,
  isProcessing,
  liveReasoning,
  live,
  durationMs,
  reasoningDurationMs,
  devPreviewCard,
  planActionsBusy,
  onBuildPlan,
  onOpenPlan,
  viewportRef,
  workspaceRoot,
  activeThreadId,
  viewMode,
  professionalSurface
}: {
  turn: Turn
  isProcessing: boolean
  liveReasoning: string
  live: string
  durationMs?: number
  reasoningDurationMs?: number
  devPreviewCard?: ReactElement | null
  planActionsBusy?: boolean
  onBuildPlan?: () => void
  onOpenPlan?: () => void
  viewportRef: RefObject<HTMLDivElement | null>
  workspaceRoot: string
  activeThreadId: string | null
  viewMode: ConversationViewMode
  professionalSurface: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  // Inline Review Plan card: surfaced under a turn that produced a
  // successful `create_plan` result so the user can open/build the plan
  // without leaving the conversation.
  const planResult = useMemo(() => {
    if (isProcessing) return null
    for (let index = turn.blocks.length - 1; index >= 0; index -= 1) {
      const block = turn.blocks[index]
      if (block.kind !== 'tool' || block.status !== 'success') continue
      const meta = extractPlanMetadataFromBlock(block)
      if (meta) return meta
    }
    return null
  }, [turn.blocks, isProcessing])
  const { think: liveThink, content: liveContent } = splitThink(live)
  const liveProcessText = [liveReasoning, liveThink].filter(Boolean).join('\n\n')
  const [workExpandedOverride, setWorkExpandedOverride] = useState<boolean | null>(null)

  const { processBlocks, assistantContentBlocks, generatedFileBlocks, turnFileChanges } = useMemo(
    () =>
      deriveTurnSections({
        turn,
        isProcessing,
        liveProcessText,
        liveContent,
        workspaceRoot
      }),
    [turn, isProcessing, liveProcessText, liveContent, workspaceRoot]
  )
  const reviewBlocks = useMemo(
    () => turn.blocks.filter((block) => block.kind === 'review'),
    [turn.blocks]
  )

  const visibleProcessBlocks = useMemo(
    () => visibleProcessBlocksForMode(processBlocks, viewMode),
    [processBlocks, viewMode]
  )
  const semanticProgress = useMemo(
    () => deriveSemanticProgress(processBlocks, isProcessing),
    [processBlocks, isProcessing]
  )
  const criticalProcessVisible = visibleProcessBlocks.some(isCriticalProcessBlock)
  const workExpanded = criticalProcessVisible || (workExpandedOverride ?? false)

  const processSections = useMemo(
    () => (workExpanded ? groupProcessSections(visibleProcessBlocks) : []),
    [visibleProcessBlocks, workExpanded]
  )
  const reasoningSectionCount = useMemo(
    () => processSections.filter((section) => section.kind === 'reasoning').length,
    [processSections]
  )
  const hasProcess = isProcessing || visibleProcessBlocks.length > 0

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {turn.user ? <MessageBubble block={turn.user} professionalSurface={professionalSurface} /> : null}

      {hasProcess ? (
        <div className="flex flex-col gap-1 pb-2">
          {professionalSurface
            ? <p role="status" className="py-0.5 text-[13px] font-medium text-ds-muted">{t('engineeringRuntimeProcessing')}</p>
            : <WorkMetaRow
              processing={isProcessing}
              stepCount={visibleProcessBlocks.length}
              durationMs={durationMs}
              reasoningDurationMs={reasoningDurationMs}
              expanded={workExpanded}
              onToggle={() => setWorkExpandedOverride((value) => !(value ?? false))}
            />}
          {!professionalSurface && workExpanded && processSections.length > 0 ? (
            <div className="flex flex-col gap-1">
              {processSections.map((section) => (
                <ProcessSectionRow
                  key={section.id}
                  section={section}
                  processing={isProcessing}
                  reasoningDurationMs={reasoningDurationMs}
                  singleReasoningSection={reasoningSectionCount === 1}
                  viewportRef={viewportRef}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {assistantContentBlocks.map((block) => (
        <MessageBubble key={block.id} block={block} professionalSurface={professionalSurface} />
      ))}

      <GeneratedFilesPanel
        blocks={generatedFileBlocks}
        workspaceRoot={workspaceRoot}
        activeThreadId={activeThreadId}
        professionalSurface={professionalSurface}
      />

      {!professionalSurface ? reviewBlocks.map((review) => (
        <ReviewSummaryCard key={review.id} review={review} />
      )) : null}

      {isProcessing && !professionalSurface ? <LiveTurnProgressRow progress={semanticProgress} /> : null}

      {!isProcessing && !professionalSurface && devPreviewCard ? devPreviewCard : null}

      {planResult && !professionalSurface ? (
        <ReviewPlanCard
          title={planResult.title?.trim() || planDisplayNameFromRelativePath(planResult.relativePath)}
          relativePath={planResult.relativePath}
          busy={planActionsBusy === true}
          onOpen={onOpenPlan}
          onBuild={onBuildPlan}
        />
      ) : null}

      {!isProcessing && !professionalSurface && turnFileChanges.length > 0 ? (
        <TurnChangeSummary changes={turnFileChanges} viewportRef={viewportRef} />
      ) : null}
    </div>
  )
}

function LiveTurnProgressRow({ progress }: { progress: ReturnType<typeof deriveSemanticProgress> }): ReactElement {
  const { t } = useTranslation('common')

  return (
    <div className="flex w-fit max-w-full items-center gap-2 py-0.5 text-[14px] font-medium text-ds-muted">
      <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5">
        <AnimatedWorkLogo active phase="trail" size="sm" />
      </span>
      <span className="ds-shiny-text">
        {t(`semanticProgress_${progress.phase}`, { count: progress.operationCount })}
      </span>
    </div>
  )
}

const MemoMessageTurn = memo(MessageTurn, (prev, next) => (
  sameTurnContent(prev.turn, next.turn) &&
  prev.isProcessing === next.isProcessing &&
  prev.liveReasoning === next.liveReasoning &&
  prev.live === next.live &&
  prev.durationMs === next.durationMs &&
  prev.reasoningDurationMs === next.reasoningDurationMs &&
  prev.devPreviewCard === next.devPreviewCard &&
  prev.planActionsBusy === next.planActionsBusy &&
  prev.onBuildPlan === next.onBuildPlan &&
  prev.onOpenPlan === next.onOpenPlan &&
  prev.viewportRef === next.viewportRef &&
  prev.workspaceRoot === next.workspaceRoot &&
  prev.activeThreadId === next.activeThreadId &&
  prev.viewMode === next.viewMode &&
  prev.professionalSurface === next.professionalSurface
))
