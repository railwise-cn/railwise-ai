import { z } from 'zod'
import { WorkspaceTrustLevelSchema } from './permissions.js'

const exactId = z.string().min(1).max(256).refine((value) => value === value.trim() && !/\p{Cc}/u.test(value))

export const CallableCapabilityReferenceSchema = z.object({
  kind: z.enum(['plugin', 'connector']),
  id: exactId
}).strict()
export type CallableCapabilityReference = z.infer<typeof CallableCapabilityReferenceSchema>
export const CallableCapabilityReferencesSchema = z.array(CallableCapabilityReferenceSchema).max(8)

export type CallableCapabilityChoice = CallableCapabilityReference & { label: string; description?: string }

export const CallableCapabilityScopeSchema = z.object({
  threadId: exactId.optional(),
  workspace: z.string().max(4096).optional(),
  mode: z.enum(['agent', 'plan']).optional(),
  agentProfile: z.object({
    trustLevel: WorkspaceTrustLevelSchema,
    toolAllowlist: z.array(exactId).max(512),
    mcpAllowlist: z.array(exactId).max(512)
  }).strict().optional()
}).strict()
export type CallableCapabilityScope = z.infer<typeof CallableCapabilityScopeSchema>
