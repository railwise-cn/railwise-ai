import { z } from 'zod'

/** Future read-only execution consent, never a resolution of an earlier operation. */
export const BrowserPublicQueryRecoveryBindingSchema = z.object({
  ownerTaskId: z.string().min(1), receiptId: z.string().min(1),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/), sourceTaskId: z.string().min(1),
  browserIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  scheduleId: z.string().min(1).optional(), versionId: z.string().min(1).optional(),
  planScopeHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()
export type BrowserPublicQueryRecoveryBinding = z.infer<typeof BrowserPublicQueryRecoveryBindingSchema>
export type BrowserPublicQueryRecoverySnapshot = {
  taskId: string; taskRevision: number; state: 'unavailable' | 'eligible' | 'prepared'; message: string;
  reason?: string; receiptId?: string; unknownOperationCount: number; origins?:string[]
}
