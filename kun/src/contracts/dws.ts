import { z } from 'zod'

/** Main-process diagnosis only. No token or model-controlled command belongs here. */
export const DwsCapabilityConfig = z.object({
  enabled:z.boolean().default(true),authState:z.enum(['not_installed','needs_login','installed','error']).default('not_installed'),
  executablePath:z.string().min(1).optional(),executableHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profile:z.string().min(1).optional(),corpId:z.string().min(1).optional(),userId:z.string().min(1).optional(),
  identityFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Official auth status does not expose business scopes. Empty means unknown;
  // it must never be projected as remote authorization for an API operation.
  scopes:z.array(z.string()).default([])
}).strict()
export type DwsCapabilityConfig = z.infer<typeof DwsCapabilityConfig>
