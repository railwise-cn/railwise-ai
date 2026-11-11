import type { ChatBlock } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

let startupRuntimeProbeTimer: ReturnType<typeof setTimeout> | null = null
let startupRuntimeProbeController: AbortController | null = null
const STARTUP_RUNTIME_PROBE_DELAYS = [900, 1500, 3000, 5000, 5000]
let busyWatchdogTimer: ReturnType<typeof setTimeout> | null = null
let busyRecoveryAttempts = 0
let turnCompletionPollTimer: ReturnType<typeof setInterval> | null = null

type BusyWatchdogOptions = {
  timeoutMs: number
  maxAttempts: number
  finalizeBusyState: (state: ChatState) => Partial<ChatState>
  flushLiveBlocks: (state: ChatState, base: Partial<ChatState>) => Partial<ChatState>
  busyTimeoutMessage: () => string
}

type TurnCompletionPollOptions = {
  loadThreadState: (
    state: ChatState,
    threadId: string
  ) => Promise<{
    blocks: ChatBlock[]
    threadStatus?: string
    latestTurnId?: string
    latestTurnStatus?: string
    latestTurnError?: string
  }>
  threadLooksRunning: (blocks: ChatBlock[], threadStatus?: string) => boolean
  onCompletedThreads: (
    doneThreads: Array<{
      threadId: string
      turnId?: string
      turnStatus?: string
      turnError?: string
    }>,
    state: ChatState,
    set: ChatStoreSet,
    get: ChatStoreGet
  ) => void | Promise<void>
  onWaitingApprovals?: (
    approvals: Array<{
      threadId: string
      turnId?: string
      approvalId: string
    }>,
    state: ChatState,
    set: ChatStoreSet,
    get: ChatStoreGet
  ) => void | Promise<void>
}

export function cancelStartupRuntimeProbe(): void {
  if (startupRuntimeProbeTimer) clearTimeout(startupRuntimeProbeTimer)
  startupRuntimeProbeTimer = null
  startupRuntimeProbeController?.abort()
  startupRuntimeProbeController = null
  if (typeof window !== 'undefined') window.removeEventListener?.('beforeunload', cancelStartupRuntimeProbe)
}

/** A true result requests another health probe within the finite startup budget. */
export function scheduleStartupRuntimeProbe(probe: (signal: AbortSignal) => Promise<boolean>): void {
  cancelStartupRuntimeProbe()
  const controller = new AbortController()
  startupRuntimeProbeController = controller
  if (typeof window !== 'undefined') window.addEventListener?.('beforeunload', cancelStartupRuntimeProbe, { once: true })
  let attempt = 0
  const tick = async (): Promise<void> => {
    startupRuntimeProbeTimer = null
    let retry = false
    try {
      retry = await probe(controller.signal)
    } catch {
      // The probe owns its error presentation.
    }
    if (controller.signal.aborted || startupRuntimeProbeController !== controller) return
    attempt += 1
    if (!retry || attempt >= STARTUP_RUNTIME_PROBE_DELAYS.length) {
      cancelStartupRuntimeProbe()
      return
    }
    startupRuntimeProbeTimer = setTimeout(() => { void tick() }, STARTUP_RUNTIME_PROBE_DELAYS[attempt])
  }
  startupRuntimeProbeTimer = setTimeout(() => { void tick() }, STARTUP_RUNTIME_PROBE_DELAYS[0])
}

export function clearBusyWatchdog(): void {
  if (busyWatchdogTimer) {
    clearTimeout(busyWatchdogTimer)
    busyWatchdogTimer = null
  }
}

export function resetBusyRecoveryAttempts(): void {
  busyRecoveryAttempts = 0
}

export function armBusyWatchdog(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: BusyWatchdogOptions
): void {
  clearBusyWatchdog()
  busyWatchdogTimer = setTimeout(() => {
    const state = get()
    if (!state.busy) return
    busyRecoveryAttempts += 1
    if (busyRecoveryAttempts <= options.maxAttempts && state.activeThreadId) {
      void state.recoverActiveTurn()
      return
    }
    set((snapshot) => {
      const base: Partial<ChatState> = {
        ...options.finalizeBusyState(snapshot),
        busy: false,
        currentTurnId: null,
        error: options.busyTimeoutMessage()
      }
      return options.flushLiveBlocks(snapshot, base)
    })
    // The thread is idle again as far as the UI is concerned; queued
    // messages would otherwise wait for a completion event that will
    // never come.
    void get().drainQueuedMessages?.()
  }, options.timeoutMs)
}

export function stopTurnCompletionPoll(): void {
  if (turnCompletionPollTimer) {
    clearInterval(turnCompletionPollTimer)
    turnCompletionPollTimer = null
  }
}

export function syncTurnCompletionPoll(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: TurnCompletionPollOptions
): void {
  const ids = Object.keys(get().watchTurnCompletion).filter((id) => get().watchTurnCompletion[id])
  if (ids.length === 0) {
    stopTurnCompletionPoll()
    return
  }
  if (turnCompletionPollTimer != null) return

  const tick = (): void => {
    void pollTurnCompletionWatch(set, get, options)
  }

  turnCompletionPollTimer = setInterval(tick, 2500)
  void tick()
}

async function pollTurnCompletionWatch(
  set: ChatStoreSet,
  get: ChatStoreGet,
  options: TurnCompletionPollOptions
): Promise<void> {
  const state = get()
  if (state.runtimeConnection !== 'ready') {
    stopTurnCompletionPoll()
    return
  }

  const ids = Object.keys(state.watchTurnCompletion).filter((id) => state.watchTurnCompletion[id])
  if (ids.length === 0) {
    stopTurnCompletionPoll()
    return
  }

  const doneThreads: Array<{
    threadId: string
    turnId?: string
    turnStatus?: string
    turnError?: string
  }> = []
  const waitingApprovals: Array<{
    threadId: string
    turnId?: string
    approvalId: string
  }> = []
  for (const threadId of ids) {
    try {
      const {
        blocks,
        threadStatus,
        latestTurnId,
        latestTurnStatus,
        latestTurnError
      } = await options.loadThreadState(state, threadId)
      for (const block of blocks) {
        if (block.kind === 'approval' && block.status === 'pending') {
          waitingApprovals.push({
            threadId,
            turnId: latestTurnId,
            approvalId: block.approvalId
          })
        }
      }
      if (!options.threadLooksRunning(blocks, threadStatus)) {
        doneThreads.push({
          threadId,
          turnId: latestTurnId,
          turnStatus: latestTurnStatus,
          turnError: latestTurnError
        })
      }
    } catch {
      /* ignore */
    }
  }

  const currentState = get()
  const watchGenerationUnchanged = currentState.watchTurnCompletion === state.watchTurnCompletion
  const currentWaitingApprovals = watchGenerationUnchanged
    ? waitingApprovals.filter((approval) => currentState.watchTurnCompletion[approval.threadId])
    : []
  const currentDoneThreads = watchGenerationUnchanged
    ? doneThreads.filter((done) => currentState.watchTurnCompletion[done.threadId])
    : []

  if (currentWaitingApprovals.length > 0) {
    await options.onWaitingApprovals?.(currentWaitingApprovals, currentState, set, get)
  }

  if (currentDoneThreads.length > 0) {
    await options.onCompletedThreads(currentDoneThreads, currentState, set, get)
  }

  if (Object.keys(get().watchTurnCompletion).filter((id) => get().watchTurnCompletion[id]).length === 0) {
    stopTurnCompletionPoll()
  }
}
