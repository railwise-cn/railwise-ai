import { expect,it } from 'vitest'
import { BrowserPublicQueryRecoveryBindingSchema,OneOffScopeConfirmationSchema } from './browser-public-query-recovery.js'
it('reads legacy standing binding bytes without adding new fields or silently converting authority',()=>{
 const old={ownerTaskId:'old',receiptId:'audit',scopeHash:'a'.repeat(64),sourceTaskId:'source',browserIdentity:'b'.repeat(64),scheduleId:'plan',versionId:'version',planScopeHash:'c'.repeat(64)}
 expect(JSON.stringify(BrowserPublicQueryRecoveryBindingSchema.parse(old))).toBe(JSON.stringify(old))
 const fresh={...old,mode:'task_reauthorization',consentReceiptId:'new-consent'}
 expect(BrowserPublicQueryRecoveryBindingSchema.safeParse(fresh).success).toBe(false)
 const {scheduleId:_plan,versionId:_version,planScopeHash:_scope,...once}=fresh
 expect(BrowserPublicQueryRecoveryBindingSchema.parse(once)).toEqual(once)
 expect(BrowserPublicQueryRecoveryBindingSchema.safeParse({...once,consentReceiptId:undefined}).success).toBe(false)
})
it('never accepts a client expiration, standing duration or unchecked fresh scope as one-off consent',()=>{
 const fresh={reviewHash:'a'.repeat(64),expectedBrowserRevision:1,browserInstanceId:'browser',origins:['https://public.test'],duration:'task',ttlSeconds:900,confirmed:true}
 expect(OneOffScopeConfirmationSchema.safeParse(fresh).success).toBe(true)
 for(const changed of [{ttlSeconds:901},{ttlSeconds:0},{duration:'schedule'},{confirmed:false},{issuedAt:'2099-01-01'},{expiresAt:'2099-01-01'}])expect(OneOffScopeConfirmationSchema.safeParse({...fresh,...changed}).success).toBe(false)
})
