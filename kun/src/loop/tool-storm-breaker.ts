import type { ExecutionGrant } from '../contracts/permissions.js'
import type { ToolCallLike, ToolHostResult } from '../ports/tool-host.js'

export type ToolStormBreakerOptions = {
  windowSize?: number
  threshold?: number
  validateEgoNavigationProgress?: (call: ToolCallLike, result: ToolHostResult, grant: ExecutionGrant) => boolean
}

type RecentToolCall = {
  callId: string
  name: string
  args: string
  readOnly: boolean
  browserKey?: string
}

type BrowserRecoveryBudget = { pending: Set<string>; spent: Map<string, number>; blocked: Set<string>; failures: Set<string> }

const DEFAULT_WINDOW_SIZE = 8
const DEFAULT_THRESHOLD = 3
const MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'edit_diff', 'apply_patch', 'delete', 'move'])
const STORM_EXEMPT_TOOL_NAMES = new Set(['request_user_input', 'user_input'])
const BROWSER_READS = new Set(['browser_observe', 'browser_get_html', 'browser_read', 'browser_extract', 'browser_screenshot'])
const EGO_READS = new Set(['ego_browser_observe', 'ego_browser_read'])
const EGO_ACTIONS = new Set(['ego_browser_open', 'ego_browser_next_page'])
const BROWSER_ACTIONS = new Set(['browser_navigate', 'browser_click', 'browser_fill', 'browser_press'])
const LOCAL_STALE_ERRORS = new Set(['browser_context_stale', 'browser_element_unverified'])
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sessionId = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value ? value : undefined

/**
 * Prevents repeated identical tool calls from inflating dynamic history
 * and cache misses. It is deliberately turn-scoped; a new user turn is
 * a new intent, so the AgentLoop resets the breaker between turns.
 */
export class ToolStormBreaker {
  private readonly windowSize: number
  private readonly threshold: number
  private readonly recent: RecentToolCall[] = []
  private readonly egoProgress = new Set<string>()
  private readonly browserSessions = new Map<string, string>()
  private readonly validateEgoNavigationProgress?: ToolStormBreakerOptions['validateEgoNavigationProgress']
  private readonly browserRecovery = new Map<string, BrowserRecoveryBudget>()

  constructor(options: ToolStormBreakerOptions = {}) {
    this.validateEgoNavigationProgress = options.validateEgoNavigationProgress
    this.windowSize = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE))
    this.threshold = Math.max(2, Math.floor(options.threshold ?? DEFAULT_THRESHOLD))
  }

  inspect(call: ToolCallLike, grant?: ExecutionGrant): { suppress: boolean; reason?: string } {
    if (STORM_EXEMPT_TOOL_NAMES.has(call.toolName)) return { suppress: false }
    const name = call.toolName
    const args = stableStringify(call.arguments)
    const readOnly = !isMutatingToolCall(call)
    const scope = this.browserScope(call, grant), session = scope ? sessionId(call.arguments.sessionId) ?? this.browserSessions.get(scope) : undefined
    const browserKey = scope && session && (BROWSER_READS.has(name) || EGO_READS.has(name)) ? JSON.stringify([scope, session]) : undefined
    const recovery = scope && session && name === 'browser_observe' ? this.browserRecovery.get(scope) : undefined
    if (session && recovery?.blocked.has(session)) return { suppress: true,
      reason: 'browser_observe exhausted two fresh recovery observations without a successful action in this owned browser session. Preserve the real stale/ref error; do not replay the action or restart sessions to evade the bound.' }
    const credited = Boolean(session && recovery?.pending.delete(session))
    if (credited) recovery!.spent.set(session!, (recovery!.spent.get(session!) ?? 0) + 1)

    if (!readOnly) {
      this.clearReadOnlyEntries()
    }

    const count = this.recent.reduce(
      (sum, entry) => sum + (entry.name === name && entry.args === args && entry.browserKey === browserKey ? 1 : 0),
      0
    )
    if (!credited && count >= this.threshold - 1) {
      return {
        suppress: true,
        reason:
          `${name} was called with identical arguments ${count + 1} times in this turn; ` +
          'repeat-loop guard suppressed the duplicate. Choose a narrower query or explain why another identical call is needed.'
      }
    }

    this.recent.push({ callId: call.callId, name, args, readOnly, ...(browserKey ? { browserKey } : {}) })
    while (this.recent.length > this.windowSize) this.recent.shift()
    return { suppress: false }
  }

  reset(): void {
    this.recent.length = 0
    this.egoProgress.clear()
    this.browserSessions.clear()
    this.browserRecovery.clear()
  }

  /** Only actual scoped Host results may grant one read-only recovery, never model prose. */
  observeResult(call: ToolCallLike, result: ToolHostResult, grant?: ExecutionGrant): void {
    const scope = this.browserScope(call, grant), item = result.item
    if (!scope || !grant || item.kind !== 'tool_result' || item.threadId !== grant.threadId || item.turnId !== grant.turnId ||
      item.callId !== call.callId || item.toolName !== call.toolName) return
    const output = object(item.output), evidence = object(output.evidence), requested = sessionId(call.arguments.sessionId), returned = sessionId(output.sessionId)
    if (call.providerId === 'ego-browser') {
      const previous = this.browserSessions.get(scope)
      if (output.provider !== 'ego-browser' || !returned || !Number.isSafeInteger(output.taskSpaceId) || String(output.taskSpaceId) !== returned ||
        previous && previous !== returned || !result.approved || item.isError || output.status !== 'succeeded') return
      this.browserSessions.set(scope, returned)
      const read = this.recent.find(entry => entry.callId === call.callId && EGO_READS.has(entry.name))
      if (read) read.browserKey = JSON.stringify([scope, returned])
      // The callback is supplied by the server factory and checks the genuine
      // persisted Host, TaskSpace and before/after navigation/read receipts.
      const progressId = typeof evidence.navigationReceiptId === 'string' ? JSON.stringify([scope, evidence.navigationReceiptId]) : undefined
      let progressed = false
      try { progressed = Boolean(progressId && !this.egoProgress.has(progressId)) && EGO_ACTIONS.has(call.toolName) && this.validateEgoNavigationProgress?.(call, result, grant) === true } catch { /* an invalid proof never resets the guard */ }
      if (progressed) {
        this.egoProgress.add(progressId!)
        const key = JSON.stringify([scope, returned])
        for (let index = this.recent.length - 1; index >= 0; index--) if (this.recent[index]?.browserKey === key && EGO_READS.has(this.recent[index]!.name)) this.recent.splice(index, 1)
      }
      return
    }
    if (output.provider !== undefined && output.provider !== 'browser-skill' || requested && returned && requested !== returned ||
      output.browserInstanceId !== undefined && output.browserInstanceId !== grant.browserScope!.browserInstanceId) return
    const session = requested ?? returned ?? this.browserSessions.get(scope)
    if (!session) return
    const succeeded = result.approved && item.isError !== true && output.status === 'succeeded'
    if (returned && succeeded) this.browserSessions.set(scope, returned)
    const read = this.recent.find(entry => entry.callId === call.callId && BROWSER_READS.has(entry.name))
    if (read && returned) read.browserKey = JSON.stringify([scope, returned])
    if (output.status === 'outcome_unknown' || output.code === 'outcome_unknown' || output.readbackPending === true || evidence.readbackPending === true) return
    if (succeeded && BROWSER_ACTIONS.has(call.toolName)) {
      const key = JSON.stringify([scope, session]), budget = this.browserRecovery.get(scope)
      for (let index = this.recent.length - 1; index >= 0; index--) if (this.recent[index]?.browserKey === key) this.recent.splice(index, 1)
      budget?.pending.delete(session); budget?.spent.delete(session); budget?.blocked.delete(session)
      return
    }
    if (output.actionAcknowledged === true || evidence.actionAcknowledged === true || output.effectState !== undefined && output.effectState !== 'none') return
    if (item.isError !== true || !BROWSER_ACTIONS.has(call.toolName)) return
    const nativeStale = result.approved && output.provider === 'browser-skill' && output.code === 'permission_denied' &&
      output.vendorReason === 'observation_changed' && output.vendorPhase === 'observation' && output.effectState === 'none'
    const localStale = LOCAL_STALE_ERRORS.has(String(output.code ?? '')) && (output.stage === undefined || output.stage === 'preflight')
    if (!nativeStale && !localStale) return
    const budget = this.browserRecovery.get(scope) ?? { pending: new Set<string>(), spent: new Map<string, number>(), blocked: new Set<string>(), failures: new Set<string>() }
    this.browserRecovery.set(scope, budget)
    if (budget.failures.has(call.callId)) return
    budget.failures.add(call.callId)
    if (budget.pending.has(session) || budget.blocked.has(session)) return
    // The two-read budget spans sessions in this exact Task/Turn/grant. A
    // successful action releases only this session's own spent allowance.
    const used = [...budget.spent.values()].reduce((sum, count) => sum + count, 0) + budget.pending.size
    if (used >= 2) budget.blocked.add(session)
    else budget.pending.add(session)
  }

  private browserScope(call: ToolCallLike, grant?: ExecutionGrant): string | undefined {
    if (!grant?.taskId || !grant.browserScope?.browserInstanceId) return undefined
    if (call.providerId === 'ego-browser') return grant.browserScope.provider === 'ego-browser' && grant.connectorIdentityFingerprints?.['ego-browser']
      ? JSON.stringify(['ego-browser', grant.taskId, grant.threadId, grant.turnId, grant.id, grant.revision, grant.browserScope.browserInstanceId, grant.browserScope.revision, grant.connectorIdentityFingerprints['ego-browser']]) : undefined
    if (call.providerId !== 'browser-skill' || grant.browserScope.provider === 'ego-browser') return undefined
    return JSON.stringify([grant.taskId, grant.threadId, grant.turnId, grant.id, grant.revision, grant.browserScope.browserInstanceId, grant.browserScope.revision])
  }

  private clearReadOnlyEntries(): void {
    for (let index = this.recent.length - 1; index >= 0; index -= 1) {
      if (this.recent[index]?.readOnly && !this.recent[index]?.browserKey) this.recent.splice(index, 1)
    }
  }
}

function isMutatingToolCall(call: ToolCallLike): boolean {
  if (call.toolKind === 'file_change') return true
  return MUTATING_TOOL_NAMES.has(call.toolName)
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value))
  } catch {
    return String(value)
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}
