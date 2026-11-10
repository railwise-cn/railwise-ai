import { describe, expect, it } from 'vitest'
import { parseDwsIdentityBinding } from './dws-cli-identity.js'

describe('official DingTalk readonly identity', () => {
  it('binds the exact organization/user and does not invent business scopes', () => {
    const result = parseDwsIdentityBinding(JSON.stringify({ success: true, authenticated: true, token_valid: true, corp_id: 'corp-fixture', user_id: 'user-fixture' }))
    expect(result).toMatchObject({ state: 'installed', profile: 'corp-fixture:user-fixture', scopes: [], identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(parseDwsIdentityBinding(JSON.stringify({ success: true, authenticated: true, refresh_token_valid: true, corp_id: 'corp-fixture', user_id: 'user-other' })).identityFingerprint).not.toBe(result.identityFingerprint)
  })
  it('distinguishes confirmed logout from unknown and unreadable state', () => {
    expect(parseDwsIdentityBinding('{"success":true,"authenticated":false}').state).toBe('needs_login')
    for (const output of ['not json', '{}', '{"success":true,"authenticated":false,"reason":"dek_missing"}', '{"success":true,"authenticated":true,"token_valid":true}']) expect(parseDwsIdentityBinding(output).state).toBe('error')
  })
})
