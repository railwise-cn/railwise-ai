import type { ReactElement } from 'react'
import type { ReviewTarget } from '../../agent/types'

export type BuiltinSlashCommandId = 'plan' | 'goal' | 'review' | 'compact' | 'fork' | 'archive' | 'restore' | 'btw'
export type SkillSlashCommandId = `skill:${string}`
export type SlashCommandId = BuiltinSlashCommandId | SkillSlashCommandId

export type SkillMentionContext = {
  start: number
  end: number
  query: string
}

export type SlashCommand = {
  id: SlashCommandId
  kind?: 'builtin' | 'skill'
  title: string
  description: string
  keywords: string[]
  icon: ReactElement
  badge?: string
  scopeLabel?: string
  disabled?: boolean
}

export type CompactCommand = {
  reason?: string
}

export type GoalCommand =
  | { action: 'menu' }
  | { action: 'set'; objective: string }
  | { action: 'pause' | 'resume' | 'clear' }

export const COMPACT_COMMAND_ALIASES = [
  'compact',
  'compress',
  'summarize',
  'summary',
  '压缩会话',
  '总结会话',
  '压缩',
  '总结'
]

export const REVIEW_COMMAND_ALIASES = [
  'review',
  'code-review',
  'codereview',
  '审查',
  '代码审查'
]

export function getSlashQuery(input: string): string | null {
  const normalized = input.trimStart().normalize('NFKC').toLowerCase()
  if (!normalized.startsWith('/') || /[\r\n/\\]/.test(normalized.slice(1))) return null
  if (/\s/u.test(normalized) && (
    normalized.startsWith('/skill:') || normalized.startsWith('/plan ') || parseGoalCommand(normalized) || parseCompactCommand(normalized) ||
    parseReviewCommand(normalized) !== false || parseBtwCommand(normalized) !== false
  )) return null
  return normalized.slice(1).trim()
}

/** Returns the active @skill token when the cursor is still inside it. */
export function getSkillMentionAtCursor(input: string, cursor: number): SkillMentionContext | null {
  const boundedCursor = Math.max(0, Math.min(cursor, input.length))
  const beforeCursor = input.slice(0, boundedCursor)
  const match = /(?:^|[\s([{，。；：、])@([^\s@"']*)$/u.exec(beforeCursor)
  if (!match) return null
  const query = match[1] ?? ''
  return {
    start: boundedCursor - query.length - 1,
    end: boundedCursor,
    query
  }
}

export function getGoalPanelDraftObjective(input: string, goalPanelOpen: boolean): string {
  const objective = input.trim()
  if (!goalPanelOpen || objective.length === 0 || objective.startsWith('/')) return ''
  return objective
}

export function parseCompactCommand(input: string): CompactCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1).trimStart()
  const lowerBody = body.toLowerCase()
  for (const alias of COMPACT_COMMAND_ALIASES) {
    const lowerAlias = alias.toLowerCase()
    if (lowerBody !== lowerAlias && !isSlashAliasMatch(lowerBody, lowerAlias)) continue
    const reason = body.slice(alias.length).trim()
    return reason ? { reason } : {}
  }
  return null
}

export function parseGoalCommand(input: string): GoalCommand | false {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/goal')) return false
  const rest = trimmed.slice(5)
  if (rest.length > 0 && !/^\s/.test(rest)) return false
  const body = rest.trim()
  if (!body) return { action: 'menu' }
  const lowered = body.toLowerCase()
  if (lowered === 'pause') return { action: 'pause' }
  if (lowered === 'resume') return { action: 'resume' }
  if (lowered === 'clear') return { action: 'clear' }
  return { action: 'set', objective: body }
}

export function parseReviewCommand(input: string): ReviewTarget | false {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return false
  const body = trimmed.slice(1).trimStart()
  const lowerBody = body.toLowerCase()
  let rest: string | null = null
  for (const alias of REVIEW_COMMAND_ALIASES) {
    const lowerAlias = alias.toLowerCase()
    if (lowerBody === lowerAlias) {
      rest = ''
      break
    }
    if (isSlashAliasMatch(lowerBody, lowerAlias)) {
      rest = body.slice(alias.length).trim()
      break
    }
  }
  if (rest == null) return false
  if (!rest) return { kind: 'uncommittedChanges' }
  const [verb = '', ...parts] = rest.split(/\s+/)
  const value = parts.join(' ').trim()
  switch (verb.toLowerCase()) {
    case 'base':
    case 'branch':
    case 'against':
      return value ? { kind: 'baseBranch', branch: value } : { kind: 'custom', instructions: rest }
    case 'commit':
      return value ? { kind: 'commit', sha: value } : { kind: 'custom', instructions: rest }
    default:
      return { kind: 'custom', instructions: rest }
  }
}

function isSlashAliasMatch(body: string, alias: string): boolean {
  if (!body.startsWith(alias)) return false
  const next = body.at(alias.length)
  return next != null && /\s/.test(next)
}

/**
 * Returns the seed for a side conversation. False means the input is not
 * a /btw command, and null opens a side draft with an empty seed.
 */
export function parseBtwCommand(input: string): string | null | false {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/btw')) return false
  // The `/btw` token must be standalone (followed by whitespace or end).
  const rest = trimmed.slice(4)
  if (rest.length > 0 && !/^\s/.test(rest)) return false
  const question = rest.trim()
  return question.length > 0 ? question : null
}
