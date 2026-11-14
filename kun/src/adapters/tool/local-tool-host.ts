import type {
  ToolHost,
  ToolHostContext,
  ToolHostResult,
  ToolCallLike,
  ToolExecutionUpdate
} from '../../ports/tool-host.js'
import { createHash } from 'node:crypto'
import type { ApprovalRequest } from '../../domain/approval.js'
import { createApprovalRequest } from '../../domain/approval.js'
import { buildToolArgumentSummary } from '../../security/tool-persistence-security.js'
import type { TurnItem } from '../../contracts/items.js'
import { makeToolResultItem, makeApprovalItem } from '../../domain/item.js'
import { buildBuiltinLocalTools } from './builtin-tools.js'
import type { BuiltinLocalToolsOptions } from './builtin-tool-types.js'
import { CapabilityRegistry } from './capability-registry.js'
import {
  applyPostToolHookResults,
  applyPreToolHookResults,
  runToolHooks,
  type ResolvedToolHook
} from './tool-hooks.js'
import {
  normalizeRateLimitedToolOutput
} from './tool-rate-limit.js'
import {
  normalizeReadTrackerOptions,
  ReadTracker,
  type ReadTrackerOptions
} from './read-tracker.js'
import { effectiveApprovalPolicy, sandboxBlockForTool, type SandboxBlock } from './sandbox-policy.js'
import { defineLocalTool } from './local-tool-definition.js'
import type { ToolEffectDefinition } from '../../ports/tool-effect.js'
import { waitForApprovalDecision } from '../../ports/approval-gate.js'

/**
 * A single registered tool. Tools are pure functions that observe the
 * abort signal and may be guarded by an approval policy.
 */
export type LocalTool = {
  effect?: ToolEffectDefinition
  name: string
  description: string
  inputSchema: Record<string, unknown>
  toolKind: 'tool_call' | 'command_execution' | 'file_change'
  /**
   * Tool policy. `auto` runs the tool without asking. `on-request` and
   * `suggest` always ask the user. `never` blocks the tool. `untrusted`
   * prompts unless the call is in an allow-list.
   */
  policy: 'auto' | 'on-request' | 'suggest' | 'never' | 'untrusted'
  /** External writes must obtain a real user confirmation, even under legacy auto policy. */
  requireExplicitApproval?: boolean
  /** Trusted Provider verifies a persisted, task-scoped authorization against the current target. */
  hasScopedApproval?: (args: Record<string, unknown>, context: ToolHostContext) => Promise<boolean>
  /** A trusted Provider checks hard scope limits before approval or dispatch. */
  contextBlock?: (context: ToolHostContext) => { code: string; message: string } | undefined
  /** A trusted Provider reads and describes the actual target before user review. */
  approvalSummary?: (args: Record<string, unknown>, context: ToolHostContext) => Promise<string>
  /**
   * Optional gating predicate. When present, the tool is only listed
   * and only executed when `shouldAdvertise` returns true for the
   * active turn context. Use this for mode/plan-only tools such as
   * `create_plan`.
   */
  shouldAdvertise?: (context: ToolHostContext) => boolean
  /** Pure argument checks run before asking the user to approve a request. */
  validateArguments?: (args: Record<string, unknown>, context: ToolHostContext) => void
  execute: (
    args: Record<string, unknown>,
    context: ToolHostContext,
    onUpdate?: (update: ToolExecutionUpdate) => Promise<void> | void
  ) => Promise<{ output: unknown; isError?: boolean }>
}

export type LocalToolHostOptions = {
  tools?: LocalTool[]
  registry?: CapabilityRegistry
  /** Allow-list for `untrusted` policy. Tools outside the list always prompt. */
  allowList?: string[]
  /** Optional PreToolUse/PostToolUse hooks. */
  hooks?: readonly ResolvedToolHook[]
  /** Runtime read-before-edit guard. Disabled by default for direct unit use. */
  readTracker?: boolean | ReadTrackerOptions
}

/**
 * Default tool host. Runs tools in-process with abort-signal support
 * and approval gating through the `ToolHostContext.awaitApproval`
 * callback. The host is approval-aware at two layers:
 *
 * 1. A tool with `policy: 'never'` is rejected up front.
 * 2. A tool with `policy: 'on-request' | 'suggest' | 'untrusted'`
 *    always asks before running when the runtime approval policy
 *    permits tool execution.
 *
 * Tools that declare a `shouldAdvertise` predicate are also gated at
 * the listing layer and the execution layer. This is how `create_plan`
 * stays scoped to GUI plan/refine turns.
 */
export class LocalToolHost implements ToolHost {
  readonly id = 'local'
  private readonly registry: CapabilityRegistry
  private readonly allowList: Set<string>
  private readonly hooks: readonly ResolvedToolHook[]
  private readonly readTracker: ReadTracker

  constructor(options: LocalToolHostOptions) {
    this.registry = options.registry ?? CapabilityRegistry.fromLocalTools(options.tools ?? [])
    this.allowList = new Set(options.allowList ?? [])
    this.hooks = options.hooks ?? []
    this.readTracker = new ReadTracker(normalizeReadTrackerOptions(options.readTracker))
  }

  listTools(context?: ToolHostContext) {
    return Promise.resolve(this.registry.listTools(context))
  }

  diagnostics() {
    return this.registry.diagnostics()
  }

  describeEffect(toolName: string): ToolEffectDefinition | undefined {
    return this.registry.describeEffect(toolName)
  }

  async execute(
    call: ToolCallLike,
    context: ToolHostContext,
    onUpdate?: (item: TurnItem) => Promise<void> | void
  ): Promise<ToolHostResult> {
    if (context.abortSignal.aborted) {
      throw new Error('tool call aborted before start')
    }
    let tool: LocalTool
    let originalProviderId: string
    try {
      await context.validateExecutionGrant?.()
      const resolved = this.registry.resolveTool(call.toolName, context, call.providerId)
      tool = resolved.tool
      originalProviderId = resolved.provider.id
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (typeof code !== 'string' || !/^(sandbox_|execution_grant_|workspace_trust_|browser_)/.test(code)) throw error
      return { item: this.errorToolResult(context, call, { toolKind: call.toolKind ?? 'tool_call' }, error instanceof Error ? error.message : String(error), code), approved: false }
    }
    if (tool.policy === 'never') {
      throw new Error(`tool ${call.toolName} is disabled by policy`)
    }
    const sandboxBlock = sandboxBlockForTool(tool, context)
    if (sandboxBlock) {
      return {
        item: this.errorToolResult(context, call, tool, sandboxBlock.message, sandboxBlock.code),
        approved: false
      }
    }
    let preHookResults
    try {
      preHookResults = await runToolHooks({
        hooks: this.hooks,
        invocation: {
          phase: 'PreToolUse',
          call,
          context: hookContext(context)
        }
      })
    } catch (error) {
      return {
        item: this.errorToolResult(context, call, tool, hookErrorMessage(error), 'hook_failed'),
        approved: false
      }
    }
    const preHookDecision = applyPreToolHookResults(call, preHookResults)
    if (preHookDecision.denied) {
      return {
        item: this.errorToolResult(context, preHookDecision.call, tool, preHookDecision.denied, 'hook_denied'),
        approved: false
      }
    }
    const activeCall = preHookDecision.call
    try {
      tool.validateArguments?.(activeCall.arguments, context)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      return {
        item: this.errorToolResult(context, activeCall, tool, error instanceof Error ? error.message : String(error), typeof code === 'string' ? code : 'invalid_tool_arguments'),
        approved: false
      }
    }
    const readValidation = this.readTracker.validateBeforeTool({ context, call: activeCall })
    if (!readValidation.ok) {
      return {
        item: this.errorToolResult(context, activeCall, tool, readValidation.message, 'read_before_edit_required'),
        approved: false
      }
    }
    const runtimeBlock = this.runtimePolicyBlock(tool, activeCall, context)
    if (runtimeBlock) {
      return {
        item: this.errorToolResult(
          context,
          activeCall,
          tool,
          runtimeBlock.message,
          runtimeBlock.code
        ),
        approved: false
      }
    }
    let needsApproval: boolean
    let reviewedSummary: string | undefined
    try {
      needsApproval = await this.requiresApproval(tool, activeCall, context)
      if (needsApproval) reviewedSummary = await tool.approvalSummary?.(activeCall.arguments, context)
    } catch (error) {
      if (context.abortSignal.aborted) throw error
      const code = (error as { code?: unknown })?.code
      return { item: this.errorToolResult(context, activeCall, tool, error instanceof Error ? error.message : String(error),
        typeof code === 'string' ? code : 'tool_preflight_failed'), approved: false }
    }
    const approvedRequestHash = createHash('sha256').update(JSON.stringify(activeCall.arguments)).digest('hex')
    const approvalId = `appr_${createHash('sha256').update(JSON.stringify([context.threadId, context.turnId, activeCall.callId, activeCall.toolName, approvedRequestHash])).digest('hex')}`
    if (needsApproval) {
      const approval: ApprovalRequest = createApprovalRequest({
        id: approvalId,
        threadId: context.threadId,
        turnId: context.turnId,
        toolName: activeCall.toolName,
        requestHash: approvedRequestHash,
        callId: activeCall.callId,
        summary: reviewedSummary ?? this.buildApprovalSummary(activeCall, context.workspace)
      })
      const decision = context.claimUndispatchedApproval?.(approval)
        ? 'allow'
        : await waitForApprovalDecision(() => context.awaitApproval(approval), context.abortSignal)
      if (decision !== 'allow') {
        const item = makeApprovalItem({
          id: `item_${approvalId}`,
          turnId: context.turnId,
          threadId: context.threadId,
          approvalId,
          toolName: activeCall.toolName,
          summary: approval.summary
        })
        return { item, approved: false }
      }
    }
    if (context.abortSignal.aborted) {
      throw new Error('tool call aborted while waiting for approval')
    }
    let result: Awaited<ReturnType<LocalTool['execute']>>
    try {
      await context.validateExecutionGrant?.()
      if (needsApproval && createHash('sha256').update(JSON.stringify(activeCall.arguments)).digest('hex') !== approvedRequestHash) {
        throw Object.assign(new Error('Tool arguments changed after review. Request approval for the actual operation.'), { code: 'approval_request_changed' })
      }
      // A connector can be disabled, refreshed or rebound while approval is
      // pending. Approval covers this exact tool instance, never its replacement.
      let currentTool
      try {
        currentTool = this.registry.resolveTool(activeCall.toolName, context, activeCall.providerId)
      } catch {
        throw Object.assign(new Error('Tool availability changed while awaiting dispatch. Check capabilities and request approval again.'), { code: 'tool_catalog_changed' })
      }
      if (currentTool.tool !== tool || currentTool.provider.id !== originalProviderId) {
        throw Object.assign(new Error('The approved tool was replaced. Check capabilities and request approval again.'), { code: 'tool_catalog_changed' })
      }
      context.assertExecution?.()
      if (needsApproval && reviewedSummary && await tool.approvalSummary?.(activeCall.arguments, context) !== reviewedSummary) {
        throw Object.assign(new Error('浏览器目标在审阅后发生变化，请重新确认实际操作。'), { code: 'approval_target_changed' })
      }
      if (needsApproval) context.recordExplicitApproval?.({ toolName: activeCall.toolName, requestHash: approvedRequestHash })
      await context.claimTaskPermission?.()
      context.assertExecution?.()
      if (context.abortSignal.aborted) throw new Error('Tool call aborted before dispatch')
      let finishWork = context.beginExecutionWork?.()
      let humanWaits = 0
      let toolFinished = false
      const withoutExecutionWork = async <T>(wait: () => Promise<T>): Promise<T> => {
        humanWaits++
        finishWork?.()
        finishWork = undefined
        try {
          return await wait()
        } finally {
          humanWaits--
          if (humanWaits === 0 && !toolFinished && !context.abortSignal.aborted) {
            context.assertExecution?.()
            finishWork = context.beginExecutionWork?.()
          }
        }
      }
      try {
        context.recordToolDispatch?.()
        result = await tool.execute(activeCall.arguments, {
          ...context,
          // Providers may request approval from inside execute. Only this tool's
          // work pauses; concurrent model, tool and child-task work stays charged.
          awaitApproval: approval => withoutExecutionWork(() => context.awaitApproval(approval)),
          ...(context.awaitUserInput ? {
            awaitUserInput: request => withoutExecutionWork(() => context.awaitUserInput!(request))
          } : {}),
          explicitApproval: needsApproval ? { approvalId, callId: activeCall.callId, toolName: activeCall.toolName, requestHash: approvedRequestHash } : undefined
        }, async (update) => {
          if (!onUpdate) return
          const partialItem = makeToolResultItem({
            id: `item_${activeCall.callId}`,
            turnId: context.turnId,
            threadId: context.threadId,
            callId: activeCall.callId,
            toolName: activeCall.toolName,
            toolKind: activeCall.toolKind ?? tool.toolKind,
            output: update.output,
            isError: update.isError,
            status: 'running'
          })
          await onUpdate(partialItem)
        })
      } finally {
        toolFinished = true
        finishWork?.()
      }
    } catch (error) {
      // A tool blowing up (an MCP server returning a protocol error, a
      // provider bug) is feedback for the model, not a reason to kill the
      // whole turn. Only abort keeps propagating.
      if (context.abortSignal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      return {
        item: this.errorToolResult(context, activeCall, tool, message, typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'tool_execution_failed'),
        approved: true
      }
    }
    let postHookResults
    try {
      postHookResults = await runToolHooks({
        hooks: this.hooks,
        invocation: {
          phase: 'PostToolUse',
          call: activeCall,
          context: hookContext(context),
          result
        }
      })
    } catch (error) {
      return {
        item: this.errorToolResult(context, activeCall, tool, hookErrorMessage(error), 'hook_failed'),
        approved: true
      }
    }
    const hookedResult = applyPostToolHookResults(result, postHookResults)
    const rateLimited = normalizeRateLimitedToolOutput(hookedResult.output)
    const output = rateLimited.rateLimited ? rateLimited.output : hookedResult.output
    const isError = hookedResult.isError || rateLimited.isError
    this.readTracker.observeToolResult({
      context,
      call: activeCall,
      output,
      isError
    })
    const item = makeToolResultItem({
      id: `item_${activeCall.callId}`,
      turnId: context.turnId,
      threadId: context.threadId,
      callId: activeCall.callId,
      toolName: activeCall.toolName,
      toolKind: activeCall.toolKind ?? tool.toolKind,
      output,
      isError
    })
    return { item, approved: true }
  }

  clearReadTracker(threadId?: string): void {
    this.readTracker.clear(threadId)
  }

  private runtimePolicyBlock(
    tool: LocalTool,
    call: ToolCallLike,
    context: ToolHostContext
  ): SandboxBlock | { code: 'approval_policy_blocked'; message: string } | null {
    const sandboxBlock = sandboxBlockForTool(
      { name: call.toolName, toolKind: call.toolKind ?? tool.toolKind },
      context
    )
    if (sandboxBlock) return sandboxBlock
    if (this.isInteractiveGuiGateTool(call.toolName)) return null
    if (effectiveApprovalPolicy(context) !== 'never') return null
    if (tool.policy === 'never') return null
    return {
      code: 'approval_policy_blocked',
      message: `tool ${call.toolName} is disabled by runtime approval policy`
    }
  }

  private async requiresApproval(tool: LocalTool, call: ToolCallLike, context: ToolHostContext): Promise<boolean> {
    if (this.isInteractiveGuiGateTool(call.toolName)) return false
    const approvalPolicy = effectiveApprovalPolicy(context)
    if (tool.policy === 'never' || approvalPolicy === 'never') return false
    if (tool.requireExplicitApproval) {
      const provider = this.registry.resolveTool(call.toolName, context, call.providerId).provider
      if (provider.id === 'browser-skill' && ['browser_click', 'browser_fill'].includes(tool.name) &&
        await tool.hasScopedApproval?.(call.arguments, context)) return false
      return true
    }
    if (context.executionGrant && tool.toolKind === 'command_execution') return true
    // The user already reviewed this task's exact file scope. The file tools
    // still canonicalize the target and validate the immutable Grant at write.
    const grant = context.executionGrant
    if (['write', 'edit'].includes(tool.name) && tool.toolKind === 'file_change' &&
      (grant?.taskPermissionId || grant?.scheduleScopeHash) && grant.writePathAllowlist?.length &&
      this.registry.resolveTool(call.toolName, context, call.providerId).provider.kind === 'built-in') return false
    switch (approvalPolicy) {
      case 'auto':
        return false
      case 'on-request':
      case 'suggest':
        return tool.policy !== 'auto'
      case 'untrusted':
        if (tool.policy === 'auto') return !this.allowList.has(call.toolName)
        return true
    }
  }

  private isInteractiveGuiGateTool(toolName: string): boolean {
    return toolName === 'user_input' || toolName === 'request_user_input'
  }

  private buildApprovalSummary(call: ToolCallLike, workspace?: string): string {
    return buildToolArgumentSummary({
      toolName: call.toolName,
      arguments: call.arguments,
      workspace
    })
  }

  private errorToolResult(
    context: ToolHostContext,
    call: ToolCallLike,
    tool: Pick<LocalTool, 'toolKind'>,
    message: string,
    code: string
  ): TurnItem {
    return makeToolResultItem({
      id: `item_${call.callId}`,
      turnId: context.turnId,
      threadId: context.threadId,
      callId: call.callId,
      toolName: call.toolName,
      toolKind: call.toolKind ?? tool.toolKind,
      output: { code, error: message },
      isError: true
    })
  }

  /** Tool builder helper for tests and feature scripts. */
  static defineTool(
    tool: Omit<LocalTool, 'policy' | 'toolKind'> & {
      policy?: LocalTool['policy']
      toolKind?: LocalTool['toolKind']
    }
  ): LocalTool {
    return defineLocalTool(tool)
  }
}

function hookContext(
  context: ToolHostContext
): Pick<ToolHostContext, 'threadId' | 'turnId' | 'workspace' | 'threadMode' | 'approvalPolicy' | 'sandboxMode'> {
  return {
    threadId: context.threadId,
    turnId: context.turnId,
    workspace: context.workspace,
    approvalPolicy: context.approvalPolicy,
    ...(context.sandboxMode ? { sandboxMode: context.sandboxMode } : {}),
    ...(context.threadMode ? { threadMode: context.threadMode } : {})
  }
}

function hookErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `tool hook failed: ${message}`
}

/**
 * Tiny default tool used by smoke tests: echoes its argument so the
 * rest of the loop has a tool to call when the GUI hasn't provided any.
 */
export const echoTool: LocalTool = LocalToolHost.defineTool({
  name: 'echo',
  description: 'Echo the input argument back to the model.',
  toolKind: 'tool_call',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  policy: 'auto',
  execute: async (args) => ({ output: { echoed: args.text ?? '' } })
})

function createUserInputTool(name: string): LocalTool {
  const optionSchema = {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['label']
      }
    ]
  }
  return LocalToolHost.defineTool({
    name,
    description: 'Ask the GUI user a structured question and wait for the answer.',
    toolKind: 'tool_call',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        question: { type: 'string' },
        message: { type: 'string' },
        options: {
          type: 'array',
          description: 'Optional answer choices for a single question. Use strings or {label, description} objects.',
          items: optionSchema
        },
        questions: {
          type: 'array',
          description: 'One to three structured questions. Each question may include answer options.',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string' },
              id: { type: 'string' },
              question: { type: 'string' },
              options: {
                type: 'array',
                items: optionSchema
              }
            },
            required: ['question']
          }
        }
      },
      required: []
    },
    policy: 'auto',
    // Only advertised when the turn can actually resolve structured
    // input (IM bridges and headless runs omit `awaitUserInput`).
    shouldAdvertise: (context) => typeof context.awaitUserInput === 'function',
    execute: async (args, context) => {
      if (!context.awaitUserInput) {
        return {
          output: { error: 'GUI user input is not available in this runtime context' },
          isError: true
        }
      }
      const inputId = `in_${Math.random().toString(36).slice(2, 10)}`
      const itemId = `item_${inputId}`
      const prompt = String(args.prompt ?? args.question ?? args.message ?? 'Input requested')
      const questions = normalizeUserInputQuestions(args, inputId, prompt)
      const resolution = await context.awaitUserInput({ id: inputId, itemId, prompt, questions })
      return {
        output: resolution,
        isError: resolution.status === 'cancelled'
      }
    }
  })
}

export const userInputTool: LocalTool = createUserInputTool('user_input')
export const requestUserInputTool: LocalTool = createUserInputTool('request_user_input')

export const defaultLocalTools: LocalTool[] = [
  ...buildBuiltinLocalTools(),
  echoTool,
  userInputTool,
  requestUserInputTool
]

function normalizeUserInputQuestions(
  args: Record<string, unknown>,
  fallbackId: string,
  fallbackPrompt: string
): Array<{
  header: string
  id: string
  question: string
  options: Array<{ label: string; description: string }>
}> {
  const rawQuestions = Array.isArray(args.questions) ? args.questions : null
  if (rawQuestions && rawQuestions.length > 0) {
    const questions = rawQuestions
      .map((question, index) => normalizeUserInputQuestion(question, index, fallbackId))
      .filter((question) => question !== null)
    if (questions.length > 0) return questions
  }
  const options = Array.isArray(args.options)
    ? args.options
        .map((option) => normalizeUserInputOption(option))
        .filter((option) => option !== null)
    : []
  return [
    {
      header: 'Input',
      id: String(args.id ?? fallbackId),
      question: fallbackPrompt,
      options
    }
  ]
}

function normalizeUserInputQuestion(
  value: unknown,
  index: number,
  fallbackId: string
): {
  header: string
  id: string
  question: string
  options: Array<{ label: string; description: string }>
} | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const question = typeof raw.question === 'string' && raw.question.trim()
    ? raw.question.trim()
    : null
  if (!question) return null
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => normalizeUserInputOption(option))
        .filter((option) => option !== null)
    : []
  return {
    header: typeof raw.header === 'string' && raw.header.trim() ? raw.header.trim() : `Question ${index + 1}`,
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${fallbackId}_${index + 1}`,
    question,
    options
  }
}

function normalizeUserInputOption(
  value: unknown
): { label: string; description: string } | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      label: value.trim(),
      description: ''
    }
  }
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null
  if (!label) return null
  return {
    label,
    description: typeof raw.description === 'string' ? raw.description : ''
  }
}

import { createCreatePlanTool, type CreatePlanAdapterOptions } from './create-plan-tool.js'

/**
 * Build the default tool list including the `create_plan` tool. The
 * `create_plan` tool is gated to plan/refine turns via its
 * `shouldAdvertise` predicate, so it is safe to ship with the
 * default set: non-plan turns never see it in the model tool list.
 */
export function buildDefaultLocalTools(
  planOptions: CreatePlanAdapterOptions = {},
  builtinOptions: BuiltinLocalToolsOptions = {}
): LocalTool[] {
  return [
    ...buildBuiltinLocalTools(builtinOptions),
    echoTool,
    userInputTool,
    requestUserInputTool,
    createCreatePlanTool(planOptions)
  ]
}
