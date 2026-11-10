import type { LarkCliRunner } from '../../src/adapters/tool/lark-cli-tool-provider.js'
import { parseLarkIdentityBinding } from '../../src/services/lark-cli-identity.js'

export const larkTestIdentity = {
  identity: 'user', appId: 'cli-synthetic', brand: 'feishu',
  identities: { user: { available: true, openId: 'ou-synthetic', scope: 'task:task:read task:task:write approval:task:read approval:instance:read approval:task:write' } }
}
const parsed = parseLarkIdentityBinding(JSON.stringify(larkTestIdentity))
export const larkTestBinding = {
  brand:parsed.brand!,appId:parsed.appId!,userOpenId:parsed.userOpenId!,identityFingerprint:parsed.identityFingerprint!,
  profile: 'cli-synthetic', executableHash: 'a'.repeat(64)
}
export function withLarkTestIdentity(runner: LarkCliRunner): LarkCliRunner {
  return async (path, args, signal, hash) => args[0] === 'auth'
    ? { ok: true, output: larkTestIdentity }
    : runner(path, args, signal, hash)
}
