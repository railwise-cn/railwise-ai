export type ManagedDwsStatus = {
  enabled?: boolean
  state: 'not_installed' | 'needs_login' | 'installed' | 'error'
  message?: string
  version?: string
  executablePath?: string
  executableHash?: string
  profile?: string
  corpId?: string
  userId?: string
  identityFingerprint?: string
  scopes?: string[]
}

export type ManagedDwsResult =
  | { ok: true; status?: ManagedDwsStatus; state?: 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; verificationUrl?: string; userCode?: string; expiresAt?: string; message?: string }
  | { ok: false; message: string; status?: ManagedDwsStatus }
