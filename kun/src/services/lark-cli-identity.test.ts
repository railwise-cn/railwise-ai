import { describe, expect, it } from 'vitest'
import { parseLarkIdentityBinding } from './lark-cli-identity.js'

const identity = { identity: 'user', appId: 'cli-synthetic', brand: 'feishu', identities: { user: { available: true, openId: 'ou-synthetic', scope: 'task:task:read task:task:write' } } }
describe('official Lark identity binding', () => {
  it('binds the app, brand and exact user while keeping scope renewal out of the fingerprint', () => {
    const parsed = parseLarkIdentityBinding(JSON.stringify(identity))
    expect(parsed).toMatchObject({ available: true, appId: identity.appId, userOpenId: 'ou-synthetic', identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const renewed = { ...identity, identities: { user: { ...identity.identities.user, scope: 'task:task:read' } } }
    expect(parseLarkIdentityBinding(JSON.stringify(renewed)).identityFingerprint).toBe(parsed.identityFingerprint)
    for (const changed of [{ ...identity, appId: 'cli-other' }, { ...identity, brand: 'lark' }, { ...identity, identities: { user: { ...identity.identities.user, openId: 'ou-other' } } }]) {
      expect(parseLarkIdentityBinding(JSON.stringify(changed)).identityFingerprint).not.toBe(parsed.identityFingerprint)
    }
  })
  it('fails closed for missing IDs, unverified/bot identities, and unknown output', () => {
    for (const changed of [{ ...identity, appId: '' }, { ...identity, verified: false }, { ...identity, identity: 'bot' }, { ...identity, identities: { user: { available: true } } }, null]) {
      expect(parseLarkIdentityBinding(JSON.stringify(changed)).available).toBe(false)
    }
    expect(parseLarkIdentityBinding('not json')).toEqual({ available: false, scopes: [] })
  })
})
