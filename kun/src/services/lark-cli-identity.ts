import { createHash } from 'node:crypto'

export type LarkIdentityBinding = {
  available: boolean
  scopes: string[]
  brand?: 'feishu' | 'lark'
  appId?: string
  userOpenId?: string
  identityFingerprint?: string
}

/** Parse official auth status, never token contents or a display name. */
export function parseLarkIdentityBinding(output: string): LarkIdentityBinding {
  let value: Record<string, unknown>
  try {
    const decoded: unknown = JSON.parse(output)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { available: false, scopes: [] }
    value = decoded as Record<string, unknown>
  } catch { return { available: false, scopes: [] } }
  const identities = value.identities as { user?: { available?: boolean; scope?: string; verified?: boolean; openId?: string } } | undefined
  const user = identities?.user
  const brand = value.brand === 'feishu' || value.brand === 'lark' ? value.brand : undefined
  const appId = typeof value.appId === 'string' && value.appId.trim() ? value.appId.trim() : undefined
  const userOpenId = typeof user?.openId === 'string' && user.openId.trim() ? user.openId.trim() : undefined
  const available = value.identity === 'user' && user?.available === true && user.verified !== false && value.verified !== false && Boolean(brand && appId && userOpenId)
  const scopes = available && typeof user?.scope === 'string' ? [...new Set(user.scope.split(/[\s,]+/).filter(Boolean))] : []
  return {
    available, scopes, ...(brand ? { brand } : {}), ...(appId ? { appId } : {}), ...(userOpenId ? { userOpenId } : {}),
    ...(available ? { identityFingerprint: createHash('sha256').update(JSON.stringify(['lark-user-v1', brand, appId, userOpenId])).digest('hex') } : {})
  }
}
