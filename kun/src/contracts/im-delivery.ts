import { z } from 'zod'

/** Main-process transport observations never satisfy a task's business-effect acceptance. */
export const ImDeliveryObservationSchema = z.object({
  operationId: z.string().min(1).max(256),
  purpose: z.literal('assistant_reply'),
  provider: z.enum(['feishu', 'weixin']),
  phase: z.enum(['upload', 'send']),
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeThreadId: z.string().min(1).max(256),
  runtimeTurnId: z.string().min(1).max(256),
  status: z.enum(['started', 'succeeded', 'failed', 'outcome_unknown']),
  remoteOperationId: z.string().min(1).max(512).optional(),
  clientOperationId: z.string().min(1).max(512).optional(),
  observedAt: z.iso.datetime()
}).strict()
export type ImDeliveryObservation = z.infer<typeof ImDeliveryObservationSchema>
