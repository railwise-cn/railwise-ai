import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertDwsCredentialAccess, resolveDwsEnvironment } from './dws-cli-environment.js'

describe('managed DingTalk credential isolation', () => {
  it('uses separate managed config/file-key storage and preserves the system HOME', () => {
    const toolsRoot = join(tmpdir(), 'managed-tools')
    const env = resolveDwsEnvironment({ HOME: '/system-home', WORKWISE_TOOLS_ROOT: toolsRoot, DWS_ACCESS_TOKEN: 'private', DWS_MCP_BASE_URL: 'https://untrusted.invalid', DWS_CONFIG_DIR: '/system-home/.dws' })
    expect(env.HOME).toBe('/system-home')
    expect(env.DWS_CONFIG_DIR).toBe(join(toolsRoot, 'dws-state', 'config'))
    expect(env.DWS_KEYCHAIN_DIR).toBe(join(toolsRoot, 'dws-state', 'keychain'))
    expect(env.DWS_DISABLE_KEYCHAIN).toBe('1')
    expect(env.DWS_ACCESS_TOKEN).toBeUndefined(); expect(env.DWS_MCP_BASE_URL).toBeUndefined()
  })
  it('fails closed for credential-disabled candidates and path or symlink escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dws-isolation-')); const outside = mkdtempSync(join(tmpdir(), 'dws-outside-'))
    try {
      const env = { WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: root, WORKWISE_CANDIDATE_HOME: join(root, 'home'), WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '0' }
      expect(() => assertDwsCredentialAccess(env)).toThrow('disabled')
      expect(resolveDwsEnvironment(env).DWS_CONFIG_DIR).toBe(join(root, 'home', '.railwise-dws', 'config'))
      expect(() => resolveDwsEnvironment({ ...env, WORKWISE_CANDIDATE_HOME: outside })).toThrow('isolated')
      symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : undefined)
      expect(() => resolveDwsEnvironment({ ...env, WORKWISE_CANDIDATE_HOME: join(root, 'linked') })).toThrow('isolated')
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
  })
})
