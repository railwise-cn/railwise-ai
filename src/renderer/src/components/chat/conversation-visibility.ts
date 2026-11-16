import i18n from '../../i18n'
import type { ConversationViewMode } from '@shared/app-settings'
import type { ChatBlock } from '../../agent/types'

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
    return {
      ...block,
      summary: includeDetail ? redactRuntimeText(block.summary) : semanticToolSummary(block),
      ...(includeDetail && block.detail ? { detail: redactRuntimeText(block.detail) } : { detail: undefined }),
      ...(block.filePath ? { filePath: redactRuntimeText(block.filePath) } : {}),
      meta: { ...(redactUnknown(block.meta) as Record<string, unknown> ?? {}), ...(!includeDetail ? { presentationSummary: semanticToolSummary(block) } : {}) }
    }
  }
  if (block.kind === 'compaction') {
    return {
      ...block,
      summary: redactRuntimeText(block.summary),
      ...(includeDetail && block.detail ? { detail: redactRuntimeText(block.detail) } : { detail: undefined })
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
    return {
      ...block,
      text: redactRuntimeText(block.text),
      ...(includeDetail && block.detail ? { detail: redactRuntimeText(block.detail) } : { detail: undefined })
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

export function isCriticalProcessBlock(block: ChatBlock): boolean {
  if (block.kind === 'approval') return block.status === 'pending' || block.status === 'error'
  if (block.kind === 'user_input') return block.status === 'pending' || block.status === 'error'
  if (block.kind === 'tool' || block.kind === 'compaction') return block.status === 'error'
  if (block.kind === 'system') return block.severity === 'warning' || block.severity === 'error'
  return false
}

/**
 * Removes private model reasoning in every view. Concise mode keeps only
 * actionable interruptions; standard mode keeps semantic operation summaries;
 * developer mode may include redacted detail.
 */
export function visibleProcessBlocksForMode(
  blocks: ChatBlock[],
  mode: ConversationViewMode
): ChatBlock[] {
  const nonPrivate = blocks.filter(
    (block) => block.kind !== 'reasoning' && block.kind !== 'assistant'
  )
  const selected = mode === 'concise' ? nonPrivate.filter(isCriticalProcessBlock) : nonPrivate
  return selected.map((block) => redactBlock(block, mode === 'developer'))
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
  const toolName = typeof latest.meta?.toolName === 'string' ? latest.meta.toolName.toLowerCase() : ''
  const text = `${toolName} ${latest.summary}`.toLowerCase()
  let phase: SemanticProgress['phase'] = 'working'
  if (/test|verify|validate|diagnos|lint|typecheck|build/.test(text)) phase = 'validating'
  else if (/ppt|slide|image|generate|render|export/.test(text)) phase = 'generating'
  else if (latest.toolKind === 'file_change' || /write|edit|patch|save/.test(text)) phase = 'editing'
  else if (/browser|fetch|web|search_query|mcp/.test(text)) phase = 'researching'
  else if (/read|grep|find|list|\bls\b/.test(text)) phase = 'reading'
  else if (latest.toolKind === 'command_execution') phase = 'executing'
  return { phase, operationCount: tools.length, active: processing || latest.status === 'running' }
}
