import { z } from 'zod'
import { BrowserExecutionScope } from './browser-skill.js'

/** Future read-only execution consent, never a resolution of an earlier operation. */
export const BrowserPublicQueryRecoveryBindingSchema = z.object({
  mode: z.literal('task_reauthorization').optional(),
  consentReceiptId: z.string().min(1).optional(),
  ownerTaskId: z.string().min(1), receiptId: z.string().min(1),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/), sourceTaskId: z.string().min(1),
  browserIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  scheduleId: z.string().min(1).optional(), versionId: z.string().min(1).optional(),
  planScopeHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict().superRefine((value,ctx)=>{
  if(value.mode==='task_reauthorization' ? !value.consentReceiptId || Boolean(value.scheduleId||value.versionId||value.planScopeHash) : Boolean(value.consentReceiptId)) ctx.addIssue({code:'custom',message:'Fresh task consent and standing plan authority are distinct'})
})
export type BrowserPublicQueryRecoveryBinding = z.infer<typeof BrowserPublicQueryRecoveryBindingSchema>
export type BrowserPublicQueryRecoverySnapshot = {
  taskId: string; taskRevision: number; state: 'unavailable' | 'eligible' | 'prepared' | 'needs_scope_review'; message: string;
  reason?: string; receiptId?: string; unknownOperationCount: number; origins?:string[];
  mode?:'task_reauthorization'; scopeReview?:OneOffScopeReview; consentExpiresAt?:string; consentRevoked?:boolean;consentReceiptId?:string
}

export const ONE_OFF_TOOLS = ['browser_session_start','browser_session_stop','browser_observe','browser_navigate','browser_get_html','browser_read','browser_extract','browser_screenshot','browser_click','browser_fill','publish_artifact','read_artifact','verify_web_artifact','read_task_context','todo_list','todo_write']
export const ONE_OFF_PROVIDERS = ['browser-skill','managed-artifacts','document-delivery','todo']
export const OneOffScopeReviewSchema = z.object({
  reviewHash:z.string().regex(/^[a-f0-9]{64}$/),environmentHash:z.string().regex(/^[a-f0-9]{64}$/),
  purpose:z.string().min(1),browserLabel:z.string(),browserIdentity:z.string().regex(/^[a-f0-9]{64}$/),
  scope:BrowserExecutionScope.omit({publicQueryAuthorization:true}).strict().refine(value=>value.origins.length>0&&value.interaction==='interact'&&value.verificationPolicy==='public_query_target','A fresh review authorizes only bounded public query targets'),
  allowedToolNames:z.array(z.string()).min(1),allowedProviderIds:z.array(z.string()).min(1),maxTtlSeconds:z.literal(900)
}).strict()
export type OneOffScopeReview=z.infer<typeof OneOffScopeReviewSchema>
export const OneOffScopeConfirmationSchema=z.object({reviewHash:z.string().regex(/^[a-f0-9]{64}$/),expectedBrowserRevision:z.number().int().nonnegative(),browserInstanceId:z.string().min(1),origins:z.array(z.string()).min(1).max(64),duration:z.literal('task'),ttlSeconds:z.number().int().min(1).max(900),confirmed:z.literal(true)}).strict()
export type OneOffScopeConfirmation=z.infer<typeof OneOffScopeConfirmationSchema>
