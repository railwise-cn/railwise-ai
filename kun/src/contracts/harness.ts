import { z } from 'zod'
import { ApprovalPolicySchema, SandboxModeSchema } from './policy.js'
import { WorkspaceTrustLevelSchema } from './permissions.js'

export const ExternalTaskProviderSchema = z.enum(['dingtalk', 'lark'])
export type ExternalTaskProvider = z.infer<typeof ExternalTaskProviderSchema>
export const TaskIntentSchema = z.object({
  kind: z.enum(['chat', 'status', 'external_task', 'connect_provider', 'workspace_action']),
  provider: ExternalTaskProviderSchema.optional(),
  operation: z.enum(['list', 'detail', 'approve', 'reject', 'complete', 'send', 'transfer', 'upload']).optional(),
  operations: z.array(z.enum(['approve', 'reject', 'complete', 'send', 'transfer', 'upload'])).min(2).optional(),
  target: z.string().optional(), mutation: z.boolean(), confidence: z.enum(['rule', 'model_fallback'])
})
export type TaskIntent = z.infer<typeof TaskIntentSchema>
const ResolutionSchema = z.object({
  kind: z.enum(['install', 'connect', 'grant', 'switch_workspace', 'retry']), route: z.string(), label: z.string()
})
export const CapabilityPreflightSchema = z.object({
  provider: ExternalTaskProviderSchema,
  status: z.enum(['available', 'not_installed', 'needs_authorization', 'unsupported', 'blocked']),
  message: z.string(), errorCode: z.string().optional(), toolId: z.string().optional(), executablePath: z.string().optional(),
  requiredScopes: z.array(z.string().min(1)).optional(),
  credentialState: z.enum(['missing', 'invalid', 'valid', 'unknown']), networkState: z.enum(['available', 'blocked', 'unknown']),
  workspaceState: z.enum(['allowed', 'blocked', 'unknown']), sandboxState: z.enum(['allowed', 'blocked']),
  approvalState: z.enum(['not_required', 'required', 'denied']),
  executionContext: z.object({
    workspaceRoot: z.string(), workspaceTrust: WorkspaceTrustLevelSchema, agentTrust: WorkspaceTrustLevelSchema,
    sandboxMode: SandboxModeSchema, approvalPolicy: ApprovalPolicySchema, availableTools: z.array(z.string()).max(256).optional()
  }).optional(),
  action: ResolutionSchema.optional(), resolution: ResolutionSchema.optional(), checkedAt: z.string()
})
export type CapabilityPreflight = z.infer<typeof CapabilityPreflightSchema>
/** Produced by trusted tool adapters; assistant text never constitutes evidence. */
export const ResultEvidenceSchema = z.object({
  kind: z.enum(['external_operation', 'file', 'tool_result', 'human_confirmation']),
  provider: z.string(), operation: z.string(), target: z.string().min(1), status: z.string().min(1),
  verified: z.boolean(), verifiedAt: z.string(), remoteOperationId: z.string().min(1).optional(),
  backend: z.enum(['dws', 'openapi', 'lark-cli']).optional(),
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resultHash: z.string().min(1), sourceVersion: z.string().optional(), targetVersion: z.string().optional()
})
export type ResultEvidence = z.infer<typeof ResultEvidenceSchema>
