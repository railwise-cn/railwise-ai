import { EventType, PROTOCOL_VERSION } from '@ag-ui/core'
import {
  ActivitySnapshotEventSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema
} from '@ag-ui/core/schemas'
import { TASK_RUN_STATUSES, type TaskProgressV1, type TaskRunV1 } from '@shared/agent-workbench'
import { z } from 'zod'
import type { CoreRuntimeEventJson } from './runtime-contract'
import { operationPhase } from './operation-phase'

const threadActivitySchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['running', 'waiting_approval', 'waiting_user', 'completed', 'failed', 'cancelled']),
  phase: z.enum(['reading', 'researching', 'editing', 'generating', 'validating', 'executing', 'working'])
})
export type ThreadRunActivity = z.infer<typeof threadActivitySchema>

const taskActivitySchema = z.object({
  status: z.enum(TASK_RUN_STATUSES),
  phase: z.enum(['thinking', 'searching', 'reading', 'writing', 'verifying', 'working']).optional(),
  artifactCount: z.number().int().nonnegative()
})

function activityContent<T>(messageId: string, activityType: string, content: Record<string, unknown>, schema: z.ZodType<T>): T | undefined {
  const event = ActivitySnapshotEventSchema.safeParse({
    type: EventType.ACTIVITY_SNAPSHOT, messageId, activityType, content, replace: true
  })
  if (!event.success) return
  const decoded = schema.safeParse(event.data.content)
  return decoded.success ? decoded.data : undefined
}

const activityEvents = new Set([
  'turn_started', 'turn_completed', 'turn_aborted', 'turn_failed',
  'tool_call_ready', 'tool_call_started', 'tool_call_finished',
  'approval_requested', 'approval_resolved', 'user_input_requested', 'user_input_resolved'
])

/** Independent presentation only. Native KUN dispatch still owns tools, approvals and replay. */
export function createThreadRunActivity(threadId: string, sinceSeq: number) {
  let latestSeq = sinceSeq
  let run: ThreadRunActivity | undefined
  const approvals = new Set<string>()
  const questions = new Set<string>()

  function reset(seq: number): void {
    latestSeq = seq
    run = undefined
    approvals.clear()
    questions.clear()
  }

  function apply(events: CoreRuntimeEventJson[]): ThreadRunActivity | undefined {
    const previous = run
    for (const event of events) {
      const { kind, seq, turnId } = event
      if (event.threadId !== threadId || !kind || !turnId || event.child ||
          typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= latestSeq || !activityEvents.has(kind)) continue
      latestSeq = seq

      if (kind === 'turn_started' || !run) {
        if (run?.runId === turnId) continue
        const started = RunStartedEventSchema.safeParse({
          type: EventType.RUN_STARTED, threadId, runId: turnId, protocolVersion: PROTOCOL_VERSION
        })
        if (!started.success) continue
        approvals.clear()
        questions.clear()
        run = { threadId: started.data.threadId, runId: started.data.runId, status: 'running', phase: 'working' }
      }
      if (run.runId !== turnId || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') continue

      let { phase } = run
      const approvalId = event.approvalId ?? event.itemId
      const questionId = event.inputId ?? event.itemId
      if (kind === 'approval_requested' && approvalId && !['auto', 'never'].includes(event.approvalPolicy ?? '')) approvals.add(approvalId)
      if (kind === 'approval_resolved' && approvalId) approvals.delete(approvalId)
      if (kind === 'user_input_requested' && questionId) questions.add(questionId)
      if (kind === 'user_input_resolved' && questionId) questions.delete(questionId)
      if (kind === 'tool_call_ready' || kind === 'tool_call_started') {
        const name = event.item?.toolName ?? event.toolName
        phase = operationPhase(typeof name === 'string' ? name : '', event.item?.toolKind)
      }
      if (kind === 'tool_call_finished') phase = 'working'

      let status: ThreadRunActivity['status'] = approvals.size ? 'waiting_approval' : questions.size ? 'waiting_user' : 'running'
      if (kind === 'turn_failed') {
        if (!RunErrorEventSchema.safeParse({ type: EventType.RUN_ERROR, message: 'Run failed' }).success) continue
        status = 'failed'
      } else if (kind === 'turn_completed' || kind === 'turn_aborted') {
        const outcome = kind === 'turn_aborted' || event.reason === 'aborted' ? 'cancelled' : 'success'
        const finished = RunFinishedEventSchema.safeParse({
          type: EventType.RUN_FINISHED, threadId, runId: turnId, outcome: { type: outcome }
        })
        if (!finished.success) continue
        status = outcome === 'cancelled' ? 'cancelled' : 'completed'
      }

      if (run.status !== status || run.phase !== phase) run = { ...run, status, phase }
    }
    if (!run || run === previous) return
    return activityContent(`railwise:${run.runId}`, 'railwise.run.v1', run, threadActivitySchema)
  }

  return { apply, reset }
}

export function projectTaskRunActivity(task: TaskRunV1, sample: TaskProgressV1 | undefined, artifactCount: number) {
  // The task store has already checked the current revision and lease sequence.
  const phase = sample?.active && Date.parse(sample.leaseExpiresAt) > Date.now() ? sample.activity?.phase : undefined
  return activityContent(`railwise:task:${task.id}`, 'railwise.task.v1', { status: task.status, phase, artifactCount }, taskActivitySchema)
}
