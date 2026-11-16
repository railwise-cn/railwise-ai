import { z } from 'zod'
import { BrowserOrigin, BrowserVerificationPolicy } from './browser-skill.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const BrowserScheduleActionSchema = z.object({
  id: hash,
  sourceTaskId: z.string().min(1),
  scheduleId: z.string().min(1),
  purposeHash: hash,
  requirementHash: hash,
  browserInstanceId: z.string().min(1),
  browserRevision: z.number().int().nonnegative(),
  origin: BrowserOrigin,
  pageUrl: z.string().url(),
  elementHash: hash,
  action: z.enum(['click', 'fill']),
  valueHash: hash.optional(),
  accountState: z.literal('unknown'),
  access: z.literal('public_query'),
  verificationPolicy: BrowserVerificationPolicy.optional(),
  approvalId: z.string().min(1),
  summary: z.string().min(1).max(400000)
}).strict()
export type BrowserScheduleAction = z.infer<typeof BrowserScheduleActionSchema>

export const BrowserScheduleBindingSchema = z.object({
  scheduleId: z.string().min(1),
  versionId: z.string().min(1),
  scopeHash: hash,
  sourceTaskId: z.string().min(1),
  actionsHash: hash
}).strict()
export type BrowserScheduleBinding = z.infer<typeof BrowserScheduleBindingSchema>
export type BrowserScheduleResolution = { binding: BrowserScheduleBinding; actions: BrowserScheduleAction[] }
