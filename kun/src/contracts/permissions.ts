import { z } from 'zod'
import { ApprovalPolicySchema, SandboxModeSchema } from './policy.js'

export const WorkspaceTrustLevelSchema = z.enum(['read-only', 'workspace-write', 'trusted', 'full-access'])
export type WorkspaceTrustLevel = z.infer<typeof WorkspaceTrustLevelSchema>

/** Explicit task scope. Omitted fields keep the existing authority ceiling. */
export const TaskPermissionScopeSchema = z.object({
  readPaths: z.array(z.string().min(1)).optional(),
  writePaths: z.array(z.string().min(1)).optional(),
  networkOrigins: z.array(z.string().min(1)).optional(),
  providerIds: z.array(z.string().min(1)).optional(),
  externalTargets: z.array(z.string().min(1)).optional()
}).strict()
export type TaskPermissionScope = z.infer<typeof TaskPermissionScopeSchema>

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
  readPathAllowlist: z.array(z.string()).optional(),
  writePathAllowlist: z.array(z.string()).optional(),
  networkAllowlist: z.array(z.string()).default([]),
  connectorScopes: z.array(z.string()).default([]),
  connectorIdentityFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  connectorBackends: z.record(z.string(), z.enum(['dws', 'openapi', 'lark-cli'])).optional(),
  externalTargets: z.array(z.string()).default([]),
  workspaceRevision: z.number().int().nonnegative(),
  agentRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional()
  ,taskPermissionId: z.string().min(1).optional(),
  permissionDuration: z.enum(['task', 'next_operation']).optional()
})
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>

/** A server-owned, single-command exception; it never changes ambient workspace trust. */
export const HostShellAuthorizationSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), threadId: z.string().min(1), turnId: z.string().min(1),
  executionId: z.string().min(1), ownerId: z.string().min(1), leaseRevision: z.number().int().nonnegative(),
  executionGrantId: z.string().min(1), workspaceRoot: z.string().min(1),
  workspaceRevision: z.number().int().nonnegative(), agentRevision: z.number().int().nonnegative(),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvalId: z.string().min(1), idempotencyKey: z.string().min(1),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime()
})
export type HostShellAuthorization = z.infer<typeof HostShellAuthorizationSchema>

export const TaskApprovalGrantSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), threadId: z.string().min(1),
  previousPolicy: ApprovalPolicySchema, approvalPolicy: z.literal('on-request'),
  workspaceRoot: z.string().min(1), workspaceRevision: z.number().int().nonnegative(),
  workspaceTrust: WorkspaceTrustLevelSchema, agentRevision: z.number().int().nonnegative(),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['prepared','active']), confirmed: z.literal(true),
  confirmedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), idempotencyKey: z.string().min(1)
  ,scope: TaskPermissionScopeSchema.optional(),
  duration: z.enum(['task', 'next_operation']).optional(),
  consumedOperationId: z.string().min(1).optional(),
  consumedAt: z.iso.datetime().optional()
})
export type TaskApprovalGrant = z.infer<typeof TaskApprovalGrantSchema>

export const TaskPermissionConfirmationSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().trim().min(1).max(256),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
  approvalPolicy: z.literal('on-request'), ttlSeconds: z.number().int().min(60).max(900),
  scope: TaskPermissionScopeSchema.optional(),
  duration: z.enum(['task', 'next_operation']).optional()
}).strict()
export type TaskPermissionConfirmation = z.infer<typeof TaskPermissionConfirmationSchema>

export type ExecutionScope = Pick<ExecutionGrant, 'networkAllowlist' | 'connectorScopes' | 'externalTargets'> &
  Pick<Partial<ExecutionGrant>, 'connectorIdentityFingerprints' | 'connectorBackends'> &
  Pick<Partial<ExecutionGrant>, 'allowedToolNames'> &
  Pick<Partial<ExecutionGrant>, 'allowedProviderIds' | 'pathAllowlist' | 'readPathAllowlist' | 'writePathAllowlist' | 'expiresAt' | 'taskPermissionId' | 'permissionDuration'> &
  { permissionScope?: TaskPermissionScope }
