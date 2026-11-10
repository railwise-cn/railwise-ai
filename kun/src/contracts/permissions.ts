import { z } from 'zod'
import { ApprovalPolicySchema, SandboxModeSchema } from './policy.js'

export const WorkspaceTrustLevelSchema = z.enum(['read-only', 'workspace-write', 'trusted', 'full-access'])
export type WorkspaceTrustLevel = z.infer<typeof WorkspaceTrustLevelSchema>

/** Server-created, immutable scope for a single Turn. Never accepted from model/user arguments. */
export const ExecutionGrantSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  workspaceRoot: z.string(),
  workspaceTrust: WorkspaceTrustLevelSchema,
  agentTrust: WorkspaceTrustLevelSchema,
  approvalPolicy: ApprovalPolicySchema,
  sandboxMode: SandboxModeSchema,
  allowedToolNames: z.array(z.string().min(1)).optional(),
  allowedProviderIds: z.array(z.string().min(1)).optional(),
  allowedMcpProviderIds: z.array(z.string().min(1)).optional(),
  pathAllowlist: z.array(z.string()).default([]),
  networkAllowlist: z.array(z.string()).default([]),
  connectorScopes: z.array(z.string()).default([]),
  externalTargets: z.array(z.string()).default([]),
  workspaceRevision: z.number().int().nonnegative(),
  agentRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional()
})
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>

export type ExecutionScope = Pick<ExecutionGrant, 'networkAllowlist' | 'connectorScopes' | 'externalTargets'> &
  Pick<Partial<ExecutionGrant>, 'allowedProviderIds' | 'pathAllowlist' | 'expiresAt'>
