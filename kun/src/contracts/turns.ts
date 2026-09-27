import { z } from 'zod'
import { TurnItem } from './items.js'
import { isGuiPlanRelativePath } from '../shared/gui-plan.js'
import { ApprovalPolicySchema, SandboxModeSchema } from './policy.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from './resource-limits.js'
import { WorkspaceReferenceSchema } from './workspace-references.js'
import { UiActionAudit } from './ui-actions.js'

const byteLimitedString = (maxBytes: number) =>
  z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
    message: `must not exceed ${maxBytes} UTF-8 bytes`
  })

/**
 * Mode enum, inlined here (instead of importing `ThreadMode` from
 * `threads.js`) to avoid a `threads <-> turns` module init cycle:
 * `threads.ts` already imports `TurnSchema` from this file. The two
 * literals must stay in sync with `ThreadMode` in `threads.ts`.
 */
const TurnModeSchema = z.enum(['agent', 'plan'])
export const TurnReasoningEffortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max'])
export type TurnReasoningEffort = z.infer<typeof TurnReasoningEffortSchema>

/**
 * Plan operation kinds the renderer can advertise on a plan turn.
 * Mirrors the shared renderer contract so request metadata stays
 * stable across reconnects and replays.
 */
export const GuiPlanOperationSchema = z.enum(['draft', 'refine'])
export type GuiPlanOperationJson = z.infer<typeof GuiPlanOperationSchema>

/**
 * Plan context the renderer can attach to a `StartTurnRequest`. The
 * thread mode is carried on the thread record; this struct adds the
 * reserved path and source request needed to scope `create_plan`.
 */
export const GuiPlanContextSchema = z.object({
  operation: GuiPlanOperationSchema,
  workspaceRoot: z.string().min(1),
  relativePath: z
    .string()
    .min(1)
    .refine(isGuiPlanRelativePath, {
      message: 'relativePath must be a direct Markdown file under .workwise/plans'
    }),
  planId: z.string().min(1),
  sourceRequest: z.string().optional(),
  title: z.string().optional()
})
export type GuiPlanContextJson = z.infer<typeof GuiPlanContextSchema>

/**
 * Design canvas context attached by the renderer for an assistant turn.
 * This is a capability boundary, not model-authored data: the runtime uses
 * it to expose the canvas command tool only for the exact active document.
 */
export const GuiDesignContextSchema = z.object({
  workspaceRoot: z.string().min(1),
  documentId: z.string().min(1).max(160),
  pageId: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative()
})
export type GuiDesignContextJson = z.infer<typeof GuiDesignContextSchema>

export const TurnStatus = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'aborted'
])
export type TurnStatus = z.infer<typeof TurnStatus>

export const TurnSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  status: TurnStatus,
  prompt: z.string(),
  model: z.string().optional(),
  providerId: z.string().trim().min(1).max(200).optional(),
  engineeringExecution: z.boolean().optional(),
  engineeringPlanId: z.string().min(1).max(200).optional(),
  reasoningEffort: TurnReasoningEffortSchema.optional(),
  /** Steered text queued by the user mid-turn. Cleared on completion. */
  steering: z.array(z.string()).default([]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  items: z.array(TurnItem).default([]),
  attachmentIds: z.array(z.string().min(1)).default([]),
  workspaceReferences: z.array(WorkspaceReferenceSchema).max(32).optional(),
  /** Structured Runtime action that started this turn; never a user prompt. */
  uiAction: UiActionAudit.optional(),
  activeSkillIds: z.array(z.string().min(1)).default([]),
  injectedMemoryIds: z.array(z.string().min(1)).default([]),
  skillInjectionBytes: z.number().int().nonnegative().optional(),
  toolCatalogFingerprint: z.string().optional(),
  toolCatalogToolCount: z.number().int().nonnegative().optional(),
  toolCatalogDrift: z.boolean().optional(),
  guiPlan: GuiPlanContextSchema.optional(),
  guiDesign: GuiDesignContextSchema.optional(),
  /**
   * Optional per-turn mode override. When set, it takes precedence over
   * the thread mode for this turn (e.g. a Plan-mode turn inside an
   * otherwise agent thread, or a Build turn that runs as agent).
   */
  mode: TurnModeSchema.optional(),
  /**
   * True when no interactive user is attached to this turn (IM bridges,
   * headless runs). Kun hides `user_input`/`request_user_input` and
   * rejects calls to them instead of blocking on a GUI answer.
   */
  disableUserInput: z.boolean().optional(),
  /** Stable caller key used by communication bridges to recover a turn after a crash. */
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
  error: z.string().optional()
})
export type Turn = z.infer<typeof TurnSchema>

export const StartTurnRequest = z.object({
  prompt: byteLimitedString(RUNTIME_RESOURCE_LIMITS_V1.promptBytes).pipe(z.string().min(1)),
  displayText: byteLimitedString(RUNTIME_RESOURCE_LIMITS_V1.displayTextBytes).optional(),
  model: z.string().optional(),
  providerId: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: TurnReasoningEffortSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  /**
   * Optional per-turn mode. Overrides the thread mode for this turn so
   * the GUI can toggle Plan/agent without recreating the thread. In Plan
   * mode Kun advertises `create_plan` for the whole conversation.
   */
  mode: TurnModeSchema.optional(),
  attachmentIds: z.array(z.string().min(1)).max(8).default([]),
  workspaceReferences: z.array(WorkspaceReferenceSchema).max(32).default([]),
  /**
   * Optional GUI plan context. When set, Kun advertises the
   * `create_plan` tool for the turn and writes only to the reserved
   * path advertised in the context.
   */
  guiPlan: GuiPlanContextSchema.optional(),
  guiDesign: GuiDesignContextSchema.optional(),
  /**
   * True when the caller cannot relay structured input prompts to a
   * user (IM bridges such as WeChat/Feishu, headless runs). The turn
   * runs without the `user_input`/`request_user_input` tools.
   */
  disableUserInput: z.boolean().optional(),
  /** Stable caller key used to return the same turn on a retry. */
  idempotencyKey: z.string().trim().min(1).max(256).optional()
})
export type StartTurnRequest = z.input<typeof StartTurnRequest>

export const StartTurnResponse = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  userMessageItemId: z.string().min(1)
})
export type StartTurnResponse = z.infer<typeof StartTurnResponse>

export const SteerTurnRequest = z.object({
  text: byteLimitedString(RUNTIME_RESOURCE_LIMITS_V1.steerBytes).pipe(z.string().min(1))
})
export type SteerTurnRequest = z.infer<typeof SteerTurnRequest>

export const InterruptTurnRequest = z.object({
  /**
   * When true, discard generated items from the interrupted turn while
   * preserving the user's prompt. Omitted/false keeps the aborted items
   * visible for inspection.
   */
  discard: z.boolean().optional()
})
export type InterruptTurnRequest = z.infer<typeof InterruptTurnRequest>

export const InterruptTurnResponse = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  status: TurnStatus
})
export type InterruptTurnResponse = z.infer<typeof InterruptTurnResponse>

export const CompactRequest = z.object({
  reason: z.string().optional(),
  /** Optional explicit token budget. */
  budgetTokens: z.number().int().positive().optional()
})
export type CompactRequest = z.infer<typeof CompactRequest>

export const CompactResponse = z.object({
  threadId: z.string().min(1),
  replacedTokens: z.number().int().nonnegative(),
  summary: z.string(),
  pinnedConstraints: z.array(z.string()),
  sourceDigest: z.string().min(1).optional(),
  digestMarker: z.string().min(1).optional(),
  sourceItemIds: z.array(z.string().min(1)).optional()
})
export type CompactResponse = z.infer<typeof CompactResponse>
