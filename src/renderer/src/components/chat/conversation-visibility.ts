import i18n from '../../i18n'
import type { ConversationViewMode } from '@shared/app-settings'
import type { ChatBlock } from '../../agent/types'
import { operationPhase } from '../../agent/operation-phase'

const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i

export function redactRuntimeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[-_]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
}

function redactUnknown(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactRuntimeText(value)
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactUnknown(entryValue, entryKey)
    ])
  )
}

function redactBlock(block: ChatBlock, includeDetail: boolean): ChatBlock {
  if (block.kind === 'tool') {
    const includeOutput = includeDetail || (block.status === 'error' && !block.meta?.outcomeUnknown)
    return {
      ...block,
      summary: includeDetail ? redactRuntimeText(block.summary) : semanticToolSummary(block),
      detail: includeOutput && block.detail ? redactRuntimeText(block.detail) : undefined,
      ...(block.filePath ? { filePath: redactRuntimeText(block.filePath) } : {}),
      meta: { ...(redactUnknown(block.meta) as Record<string, unknown> ?? {}), ...(!includeDetail ? { presentationSummary: semanticToolSummary(block) } : {}) }
    }
  }
  if (block.kind === 'compaction') {
    return {
      ...block,
      summary: redactRuntimeText(block.summary),
      detail: (includeDetail || block.status === 'error') && block.detail ? redactRuntimeText(block.detail) : undefined
    }
  }
  if (block.kind === 'approval') {
    return {
      ...block,
      summary: redactRuntimeText(block.summary),
      ...(block.errorMessage ? { errorMessage: redactRuntimeText(block.errorMessage) } : {}),
      ...(block.meta ? { meta: redactUnknown(block.meta) as typeof block.meta } : {})
    }
  }
  if (block.kind === 'system') {
    if (isRuntimeRetryRecord(block)) {
      const detail = block.detail?.includes(block.text)
        ? block.detail
        : [block.text, block.detail].filter(Boolean).join('\n\n')
      return { ...block, text: i18n.t('common:runtimeRetryRecord'), detail: redactRuntimeText(detail) }
    }
    return {
      ...block,
      text: redactRuntimeText(block.text),
      detail: (includeDetail || block.severity === 'error') && block.detail ? redactRuntimeText(block.detail) : undefined
    }
  }
  return block
}

function semanticToolSummary(block: Extract<ChatBlock, { kind: 'tool' }>): string {
  if (block.meta?.outcomeUnknown) return i18n.t('common:taskReceiptStatus_outcome_unknown')
  if (block.status === 'error') return i18n.t('common:taskReceiptStatus_failed')
  if (block.status === 'success') return i18n.t('common:processed')
  const phase = deriveSemanticProgress([block], true).phase
  return i18n.t(`common:semanticProgress_${phase}`)
}

export function isPendingProcessControl(block: ChatBlock): boolean {
  return (block.kind === 'approval' || block.kind === 'user_input') && block.status === 'pending'
}

export function activeConversationControls(blocks: readonly ChatBlock[]): ChatBlock[] {
  const controls = new Map<string, Extract<ChatBlock, { kind: 'approval' | 'user_input' }>>()
  let latestCapability: ChatBlock | undefined
  let latestIntent: ChatBlock | undefined
  for (const block of blocks) {
    if (block.kind === 'user') {
      latestCapability = undefined
      latestIntent = undefined
    }
    if (block.kind === 'assistant' && block.capabilityCard) latestCapability = block
    if (block.kind === 'assistant' && block.intentCard) latestIntent = block
    if (block.kind !== 'approval' && block.kind !== 'user_input') continue
    const key = block.kind === 'approval' ? `approval:${block.approvalId}` : `input:${block.requestId}`
    const earlier = controls.get(key)
    if (block.status === 'pending' && earlier && earlier.status !== 'pending' && earlier.status !== 'error') continue
    controls.set(key, block)
  }
  const pending = [...controls.values()].filter(isPendingProcessControl)
  return [...new Set([...pending, latestCapability, latestIntent].filter(block => block !== undefined))]
}

export function composerReplyQuestion(controls: readonly ChatBlock[]): Extract<ChatBlock, { kind: 'user_input' }> | undefined {
  const block = controls.length === 1 ? controls[0] : undefined
  if (block?.kind === 'user_input' && block.status === 'pending' && block.questions.length === 1 && block.questions[0].options.length === 0) return block
  return undefined
}

export function isInlineProcessControl(block: ChatBlock): boolean {
  return isPendingProcessControl(block) ||
    ((block.kind === 'approval' || block.kind === 'user_input') && block.status === 'error')
}

function isRuntimeRetryRecord(block: Extract<ChatBlock, { kind: 'system' }>): boolean {
  return block.code === 'turn_attempt_exception' || block.code === 'task_acceptance_retry'
}

function isConciseProcessBlock(block: ChatBlock): boolean {
  if (isInlineProcessControl(block)) return true
  if (block.kind === 'tool' || block.kind === 'compaction') return block.status === 'error'
  if (block.kind === 'system') return isRuntimeRetryRecord(block) || block.severity === 'warning' || block.severity === 'error'
  return false
}

/**
 * Removes private model reasoning in every view. Concise mode keeps controls
 * and exceptional diagnostics; standard mode adds semantic operation summaries.
 * Developer mode also includes redacted outputs from normal operations.
 */
export function visibleProcessBlocksForMode(
  blocks: ChatBlock[],
  mode: ConversationViewMode
): ChatBlock[] {
  const nonPrivate = blocks.filter(
    (block) => block.kind !== 'reasoning' && block.kind !== 'assistant'
  )
  return (mode === 'concise' ? nonPrivate.filter(isConciseProcessBlock) : nonPrivate)
    .map((block) => redactBlock(block, mode === 'developer'))
}

export type SemanticProgress = {
  phase: 'reading' | 'researching' | 'editing' | 'generating' | 'validating' | 'executing' | 'working'
  operationCount: number
  active: boolean
}

/** Converts technical runtime events into one stable, user-facing progress state. */
export function deriveSemanticProgress(blocks: ChatBlock[], processing: boolean): SemanticProgress {
  const tools = blocks.filter((block): block is Extract<ChatBlock, { kind: 'tool' }> => block.kind === 'tool')
  const active = [...tools].reverse().find((block) => block.status === 'running')
  const latest = active ?? tools.at(-1)
  if (!latest) return { phase: 'working', operationCount: 0, active: processing }
  const toolName = typeof latest.meta?.toolName === 'string' ? latest.meta.toolName : ''
  const phase = operationPhase(`${toolName} ${latest.summary}`, latest.toolKind)
  return { phase, operationCount: tools.length, active: processing || latest.status === 'running' }
}
