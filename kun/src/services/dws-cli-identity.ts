import { createHash } from 'node:crypto'

export type DwsIdentityBinding = {
  state: 'installed' | 'needs_login' | 'error'
  corpId?: string
  userId?: string
  profile?: string
  identityFingerprint?: string
  scopes: string[]
}

/** auth status is a compatibility JSON object, not the business envelope. */
export function parseDwsIdentityBinding(output: string): DwsIdentityBinding {
  let value: Record<string, unknown>
  try {
    const decoded: unknown = JSON.parse(output)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { state: 'error', scopes: [] }
    value = decoded as Record<string, unknown>
  } catch { return { state: 'error', scopes: [] } }
  if (value.success !== true || typeof value.authenticated !== 'boolean' || (typeof value.reason === 'string' && value.reason)) return { state: 'error', scopes: [] }
  if (value.authenticated === false) return { state: 'needs_login', scopes: [] }
  const corpId = typeof value.corp_id === 'string' ? value.corp_id.trim() : ''
  const userId = typeof value.user_id === 'string' ? value.user_id.trim() : ''
  if (!corpId || !userId || corpId.includes(':') || userId.includes(':') || (value.token_valid !== true && value.refresh_token_valid !== true)) return { state: 'error', scopes: [] }
  return { state: 'installed', corpId, userId, profile: `${corpId}:${userId}`, scopes: [], identityFingerprint: createHash('sha256').update(JSON.stringify(['dws-user-v1', corpId, userId])).digest('hex') }
}
