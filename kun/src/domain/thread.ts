import type {
  ThreadMode,
  ThreadRecord,
  ThreadGoal,
  ThreadAgentProfile,
  ThreadTodoList,
  ThreadSummary,
  ThreadRelation,
  ThreadStatus
} from '../contracts/threads.js'
import type { ThreadDomain } from '../contracts/threads.js'
import type { TurnItem } from '../contracts/items.js'
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  type ApprovalPolicy,
  type SandboxMode
} from '../contracts/policy.js'

/**
 * Domain helper for thread records. The contract type is the source of
 * truth; this module only adds small factory/utility helpers so the
 * services and stores can stay free of date-string formatting.
 */
export type ThreadEntity = ThreadRecord

export function createThreadRecord(input: {
  id: string
  title: string
  workspace: string
  model: string
  mode?: ThreadMode
  status?: ThreadStatus
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  agentId?: string
  agentRevision?: number
  agentProfile?: ThreadAgentProfile
  costBudgetUsd?: number
  costBudgetWarningSent?: boolean
  domain?: ThreadDomain
  projectId?: string
  relation?: ThreadRelation
  parentThreadId?: string
  forkedFromThreadId?: string
  forkedFromTitle?: string
  forkedAt?: string
  forkedFromMessageCount?: number
  forkedFromTurnCount?: number
  goal?: ThreadGoal
  todos?: ThreadTodoList
  createdAt?: string
}): ThreadEntity {
  const now = input.createdAt ?? new Date().toISOString()
  return {
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: input.model,
    mode: input.mode ?? 'agent',
    status: input.status ?? 'idle',
    approvalPolicy: input.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
    sandboxMode: input.sandboxMode ?? DEFAULT_SANDBOX_MODE,
    agentId: input.agentId ?? 'general',
    agentRevision: input.agentRevision ?? 0,
    ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
    ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
    ...(input.costBudgetWarningSent !== undefined ? { costBudgetWarningSent: input.costBudgetWarningSent } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    relation: input.relation ?? 'primary',
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.forkedFromThreadId ? { forkedFromThreadId: input.forkedFromThreadId } : {}),
    ...(input.forkedFromTitle ? { forkedFromTitle: input.forkedFromTitle } : {}),
    ...(input.forkedAt ? { forkedAt: input.forkedAt } : {}),
    ...(input.forkedFromMessageCount !== undefined ? { forkedFromMessageCount: input.forkedFromMessageCount } : {}),
    ...(input.forkedFromTurnCount !== undefined ? { forkedFromTurnCount: input.forkedFromTurnCount } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.todos ? { todos: input.todos } : {}),
    createdAt: now,
    updatedAt: now,
    turns: []
  }
}

export function touchThread(thread: ThreadEntity, updatedAt?: string): ThreadEntity {
  return { ...thread, updatedAt: updatedAt ?? new Date().toISOString() }
}

export function toThreadSummary(
  thread: ThreadEntity
): ThreadSummary {
  const items = thread.turns.flatMap((turn) => turn.items)
  return {
    id: thread.id,
    title: thread.title,
    workspace: thread.workspace,
    model: thread.model,
    mode: thread.mode,
    status: thread.status,
    approvalPolicy: thread.approvalPolicy,
    sandboxMode: thread.sandboxMode,
    agentId: thread.agentId,
    agentRevision: thread.agentRevision,
    ...(thread.agentProfile ? { agentProfile: thread.agentProfile } : {}),
    ...(thread.costBudgetUsd !== undefined ? { costBudgetUsd: thread.costBudgetUsd } : {}),
    ...(thread.costBudgetWarningSent !== undefined ? { costBudgetWarningSent: thread.costBudgetWarningSent } : {}),
    ...(thread.domain ? { domain: thread.domain } : {}),
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    relation: thread.relation ?? 'primary',
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    ...(thread.forkedFromThreadId ? { forkedFromThreadId: thread.forkedFromThreadId } : {}),
    ...(thread.forkedFromTitle ? { forkedFromTitle: thread.forkedFromTitle } : {}),
    ...(thread.forkedAt ? { forkedAt: thread.forkedAt } : {}),
    ...(thread.forkedFromMessageCount !== undefined ? { forkedFromMessageCount: thread.forkedFromMessageCount } : {}),
    ...(thread.forkedFromTurnCount !== undefined ? { forkedFromTurnCount: thread.forkedFromTurnCount } : {}),
    ...(thread.goal ? { goal: thread.goal } : {}),
    ...(thread.todos ? { todos: thread.todos } : {}),
    messageCount: countVisibleThreadMessages(items),
    preview: previewFromThreadItems(items),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt
  }
}

/** Local coordinator history contributes to the sidebar, without execution Turns. */
export function toConversationThreadSummary(thread: ThreadEntity, conversationItems: readonly TurnItem[]): ThreadSummary {
  if (conversationItems.length === 0) return toThreadSummary(thread)
  const items = [...new Map([
    ...thread.turns.flatMap((turn) => turn.items),
    ...conversationItems
  ].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    ...toThreadSummary(thread),
    messageCount: countVisibleThreadMessages(items),
    preview: previewFromThreadItems(items),
    updatedAt: conversationItems.reduce((latest, item) => item.createdAt > latest ? item.createdAt : latest, thread.updatedAt)
  }
}

/** User-visible conversation count; reasoning, tools and approvals are not messages. */
export function countVisibleThreadMessages(items: readonly TurnItem[]): number {
  return items.reduce(
    (count, item) => count + (item.kind === 'user_message' || item.kind === 'assistant_text' ? 1 : 0),
    0
  )
}

export function previewFromThreadItems(items: readonly TurnItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item) continue
    if (item.kind === 'user_message' || item.kind === 'assistant_text') {
      return item.text.slice(0, 500)
    }
    if (item.kind === 'error') return item.message.slice(0, 500)
    if (item.kind === 'tool_call') return (item.summary ?? item.toolName).slice(0, 500)
  }
  return ''
}
