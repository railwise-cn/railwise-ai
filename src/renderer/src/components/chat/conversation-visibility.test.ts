import { describe, expect, it } from 'vitest'
import type { TaskAttentionV1, TaskRunV1 } from '@shared/agent-workbench'
import { pausedTaskQuestionRequestIds } from '@shared/task-workspace-projection'
import type { ChatBlock } from '../../agent/types'
import {
  composerReplyQuestion,
  redactRuntimeText,
  deriveSemanticProgress,
  visibleProcessBlocksForMode
} from './conversation-visibility'

const blocks: ChatBlock[] = [
  { kind: 'reasoning', id: 'reasoning', text: 'private chain of thought' },
  {
    kind: 'tool',
    id: 'read',
    summary: 'Read /Users/alice/project/secret.md',
    detail: 'Authorization: Bearer top-secret',
    status: 'success'
  },
  {
    kind: 'tool',
    id: 'failed',
    summary: 'Command failed in /Users/alice/project',
    detail: 'token=top-secret',
    status: 'error'
  },
  {
    kind: 'approval',
    id: 'approval',
    approvalId: 'approval-1',
    summary: 'Allow write?',
    status: 'pending'
  }
]

describe('conversation visibility', () => {
  it('keeps one free-text question answerable when other controls remain visible', () => {
    const question: ChatBlock = { kind: 'user_input', id: 'question', requestId: 'question-request', status: 'pending',
      questions: [{ id: 'website', header: '官网', question: '请提供官网网址。', options: [] }] }
    const approval: ChatBlock = { kind: 'approval', id: 'approval', approvalId: 'approval-request',
      summary: '读取浏览器页面', status: 'pending' }

    expect(composerReplyQuestion([approval, question])).toBe(question)
    expect(composerReplyQuestion([question, { ...question, id: 'second', requestId: 'second-request' }])).toBeUndefined()
    expect(composerReplyQuestion([approval, { ...question, questions: [{ ...question.questions[0]!, options: [{ label: '官网 A', description: '' }] }] }]))
      .toBeUndefined()
  })

  it('keeps a different conversation question available when a paused task question is excluded', () => {
    const pausedTaskQuestion: ChatBlock = { kind: 'user_input', id: 'paused-task', requestId: 'paused-task-request', status: 'pending',
      questions: [{ id: 'website', header: '官网', question: '请提供官网网址。', options: [] }] }
    const ordinaryQuestion: ChatBlock = { kind: 'user_input', id: 'ordinary', requestId: 'ordinary-request', status: 'pending',
      questions: [{ id: 'period', header: '时间范围', question: '请提供时间范围。', options: [] }] }

    expect(composerReplyQuestion([pausedTaskQuestion, ordinaryQuestion], new Set(['paused-task-request'])))
      .toBe(ordinaryQuestion)
  })

  it('excludes only pending questions owned by paused tasks in the active conversation', () => {
    const task = { id: 'paused-task', status: 'paused', threadId: 'worker-thread', originThreadId: 'active-thread' } as TaskRunV1
    const otherTask = { id: 'waiting-task', status: 'waiting_user', threadId: 'active-thread' } as TaskRunV1
    const attention = [
      { id: 'paused', ownerKind: 'task', ownerId: 'paused-task', taskId: 'paused-task', kind: 'question', status: 'pending', requestId: 'paused-request' },
      { id: 'answered', ownerKind: 'task', ownerId: 'paused-task', taskId: 'paused-task', kind: 'question', status: 'answered', requestId: 'answered-request' },
      { id: 'other', ownerKind: 'task', ownerId: 'waiting-task', taskId: 'waiting-task', kind: 'question', status: 'pending', requestId: 'other-request' }
    ] as TaskAttentionV1[]

    expect(pausedTaskQuestionRequestIds([task, otherTask], attention, 'active-thread'))
      .toEqual(new Set(['paused-request']))
    expect(pausedTaskQuestionRequestIds([task], attention, null)).toEqual(new Set())
  })

  it('never exposes private reasoning in any display mode', () => {
    for (const mode of ['concise', 'standard', 'developer'] as const) {
      expect(visibleProcessBlocksForMode(blocks, mode).some((block) => block.kind === 'reasoning'))
        .toBe(false)
    }
  })

  it('keeps only actionable interruptions in concise mode', () => {
    expect(visibleProcessBlocksForMode(blocks, 'concise').map((block) => block.id)).toEqual([
      'failed',
      'approval'
    ])
  })

  it('keeps semantic summaries without stdout in standard mode', () => {
    const visible = visibleProcessBlocksForMode(blocks, 'standard')
    expect(visible.map((block) => block.id)).toEqual(['read', 'failed', 'approval'])
    expect(visible.find((block) => block.kind === 'tool' && block.id === 'read'))
      .toMatchObject({ detail: undefined })
  })

  it('redacts secrets and absolute user paths in developer mode', () => {
    const visible = visibleProcessBlocksForMode(blocks, 'developer')
    expect(JSON.stringify(visible)).not.toContain('top-secret')
    expect(JSON.stringify(visible)).not.toContain('/Users/alice')
    expect(redactRuntimeText('C:\\Users\\alice\\file token=abc')).toBe('~\\file token=[REDACTED]')
  })

  it('merges technical operations into a stable semantic progress phase', () => {
    expect(deriveSemanticProgress([
      { kind: 'tool', id: 'read-1', summary: 'read file a', status: 'success', meta: { toolName: 'read' } },
      { kind: 'tool', id: 'read-2', summary: 'read file b', status: 'success', meta: { toolName: 'read' } },
      { kind: 'tool', id: 'validate', summary: 'validate presentation', status: 'running', meta: { toolName: 'validate_pptx' } }
    ], true)).toEqual({ phase: 'validating', operationCount: 3, active: true })
  })
})

  it('uses semantic task status while keeping commands available only in developer details', () => {
    const input: ChatBlock[] = [{ kind: 'tool', id: 'shell', status: 'error', summary: 'request_host_shell curl.exe https://example.test', detail: 'curl.exe --verbose', meta: { toolName: 'request_host_shell', command: 'curl.exe --verbose', outcomeUnknown: true } }]
    const standard = visibleProcessBlocksForMode(input, 'standard')[0]!
    expect(standard).toMatchObject({ detail: undefined })
    expect('summary' in standard && standard.summary).not.toContain('request_host_shell')
    expect('summary' in standard && standard.summary).not.toContain('curl.exe')
    expect(visibleProcessBlocksForMode(input, 'developer')[0]).toMatchObject({ detail: 'curl.exe --verbose' })
  })
