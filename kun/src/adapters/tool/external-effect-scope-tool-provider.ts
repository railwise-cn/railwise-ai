import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { TaskController } from '../../services/task-controller.js'
import type { RequiredEffect } from '../../contracts/tasks.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'
import { DINGTALK_SCOPES } from './dingtalk-tool-provider.js'
import { assertGrantConnectorScopes } from './sandbox-policy.js'

const ACTIONS = {
  lark_task_get: { provider: 'lark', operation: 'detail', scopes: ['task:task:read'] },
  lark_approval_get: { provider: 'lark', operation: 'detail', scopes: ['approval:instance:read'] },
  lark_task_complete: { provider: 'lark', operation: 'complete', scopes: ['task:task:read', 'task:task:write'] },
  lark_approval_approve: { provider: 'lark', operation: 'approve', scopes: ['approval:task:read', 'approval:task:write', 'approval:instance:read'] },
  lark_approval_reject: { provider: 'lark', operation: 'reject', scopes: ['approval:task:read', 'approval:task:write', 'approval:instance:read'] },
  dingtalk_complete_task: { provider: 'dingtalk', operation: 'complete', scopes: [DINGTALK_SCOPES.todoRead, DINGTALK_SCOPES.todoWrite] },
  dingtalk_approve: { provider: 'dingtalk', operation: 'approve', scopes: [DINGTALK_SCOPES.workflowRead, DINGTALK_SCOPES.workflowWrite] },
  dingtalk_reject: { provider: 'dingtalk', operation: 'reject', scopes: [DINGTALK_SCOPES.workflowRead, DINGTALK_SCOPES.workflowWrite] },
  dingtalk_transfer: { provider: 'dingtalk', operation: 'transfer', scopes: [DINGTALK_SCOPES.workflowRead, DINGTALK_SCOPES.workflowWrite] },
  dingtalk_get_task: { provider: 'dingtalk', operation: 'detail', scopes: [DINGTALK_SCOPES.todoRead] },
  dingtalk_get_approval: { provider: 'dingtalk', operation: 'detail', scopes: [DINGTALK_SCOPES.workflowRead] }
} as const
const toolNames = Object.keys(ACTIONS) as [keyof typeof ACTIONS, ...Array<keyof typeof ACTIONS>]
// This bound ensures every target is fully visible in the persisted approval.
const requestSchema = z.object({
  expected_revision: z.number().int().nonnegative().describe('The effect scope revision from get_external_effect_scope, not the general TaskRun revision.'),
  idempotency_key: z.string().trim().min(1).max(200),
  effects: z.array(z.object({ tool_name: z.enum(toolNames), target: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/) }).strict()).min(1).max(8)
}).strict()

/** The approval fixes the whole task's finite success set; it is not a provider grant. */
export function buildExternalEffectScopeToolProviders(tasks: TaskController): CapabilityToolProvider[] {
  const current = (context: ToolHostContext) => {
    const task = tasks.activeTask(context.threadId)
    return task?.activeTurnId === context.turnId && task.acceptance.kind === 'effect' && task.acceptance.effect ? task : null
  }
  return [{ id: 'effect-scope', kind: 'built-in', enabled: true, available: true, tools: [
    defineLocalTool({
      name: 'get_external_effect_scope',
      description: 'Read the active external task revision and its complete reviewed action set before selecting exact detail targets or proposing mutations. No external operation is performed.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, policy: 'auto',
      shouldAdvertise: context => Boolean(current(context)),
      execute: async (_args, context) => {
        const task = current(context)
        return task ? { output: { taskId: task.id, revision: task.acceptance.effect!.scopeRevision ?? 0, taskRevision: task.revision, provider: task.acceptance.effect!.provider, requiredEffects: task.acceptance.effect!.requiredEffects ?? [], scopeConfirmationId: task.acceptance.effect!.scopeConfirmationId } }
          : { output: { code: 'effect_scope_required' }, isError: true }
      }
    }),
    defineLocalTool({
      name: 'confirm_external_effect_scope',
      description: 'After reading real provider tasks, ask the user to review the entire finite set of exact detail reads or write actions for this task (up to eight). The user must explicitly confirm every listed provider/action/target. For detail reads, target is the task GUID or approval instance ID, and only read scopes are required. Lists use current_user and do not belong in this set. Persist the set BEFORE any mutation; completion requires verified receipts for ALL entries. The confirmed set cannot be replaced or reduced. This does not grant connector permissions or bypass each write confirmation.',
      inputSchema: z.toJSONSchema(requestSchema) as Record<string, unknown>, policy: 'on-request', requireExplicitApproval: true,
      shouldAdvertise: context => Boolean(current(context)),
      execute: async (raw, context) => {
        const request = requestSchema.parse(raw)
        if (context.explicitApproval?.toolName !== 'confirm_external_effect_scope' || context.explicitApproval.requestHash !== createHash('sha256').update(JSON.stringify(raw)).digest('hex')) throw Object.assign(new Error('A real approval of this exact finite action set is required.'), { code: 'effect_scope_confirmation_required' })
        const task = current(context)
        if (!task) throw Object.assign(new Error('No active external task for this Turn.'), { code: 'effect_scope_required' })
        const effects: RequiredEffect[] = request.effects.map(item => {
          const spec = ACTIONS[item.tool_name]
          const providerId = spec.provider === 'lark' ? 'lark-cli' : 'dingtalk'
          const grant = context.executionGrant
          if (spec.provider !== task.acceptance.effect!.provider || !grant || (grant.allowedProviderIds && !grant.allowedProviderIds.includes(providerId)) || (grant.allowedToolNames && !grant.allowedToolNames.includes(item.tool_name))) {
            throw Object.assign(new Error('An action is outside the current task grant.'), { code: 'execution_grant_scope' })
          }
          assertGrantConnectorScopes(spec.scopes, context)
          return { provider: spec.provider, operation: spec.operation, target: item.target, requiredScopes: [...spec.scopes], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback' }
        })
        const updated = tasks.confirmEffectScope(context.turnId, request.expected_revision, request.idempotency_key, effects)
        return { output: { taskId: updated.id, revision: updated.acceptance.effect!.scopeRevision, taskRevision: updated.revision, scopeConfirmationId: updated.acceptance.effect!.scopeConfirmationId, requiredEffects: updated.acceptance.effect!.requiredEffects, status: 'scope_confirmed' } }
      }
    })
  ] }]
}
