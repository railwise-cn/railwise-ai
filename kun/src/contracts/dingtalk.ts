import { z } from 'zod'

export const DingTalkCapabilityConfig = z.object({
  enabled: z.boolean().default(false),
  credentialRef: z.string().min(1).optional(),
  workflowCredentialRef: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecretRef: z.string().min(1).optional(),
  redirectUri: z.string().url().optional(),
  /** Internal-app API permissions are configured in the DingTalk admin console. */
  scopes: z.array(z.string()).default([]),
  /** Delegated user permissions requested in OAuth (e.g. Todo.Todo.Read). */
  userScopes: z.array(z.enum(['Contact.User.Read', 'Todo.Todo.Read', 'Todo.Todo.Write'])).default([]),
  // The server binds workflow actions to this user; model arguments cannot impersonate others.
  userId: z.string().min(1).optional(),
  unionId: z.string().min(1).optional(),
  allowedWriteUserIds: z.array(z.string().min(1)).default([])
}).strict()
export type DingTalkCapabilityConfig = z.infer<typeof DingTalkCapabilityConfig>

export type DingTalkCredential = {
  accessToken: string
  expiresAt: string
  unionId: string
  userId?: string
  scopes: string[]
  kind: 'user' | 'internal-app'
}
