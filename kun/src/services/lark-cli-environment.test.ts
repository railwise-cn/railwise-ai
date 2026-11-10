import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertLarkCliCredentialAccess, resolveLarkCliEnvironment } from './lark-cli-environment.js'
import { ManagedLarkRuntime } from './managed-lark-runtime.js'
import { LarkCapabilityConfig } from '../contracts/capabilities.js'
import { larkTestBinding } from '../../tests/helpers/lark-identity.js'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lark-environment-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  return {root,home,env:{WORKWISE_CANDIDATE:'1',WORKWISE_CANDIDATE_ROOT:root,WORKWISE_CANDIDATE_HOME:home}}
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}) })

describe('Lark CLI configuration isolation', () => {
  it('preserves production CLI configuration and unrelated environment values', () => {
    const env = {HOME:'/formal-home',LARKSUITE_CLI_CONFIG_DIR:'/custom-existing-config',PATH:'/tool-path'}
    expect(resolveLarkCliEnvironment(env)).toEqual(env)
    expect(() => assertLarkCliCredentialAccess(env)).not.toThrow()
  })
  it('forces Candidate CLI configuration into the same isolated home without changing HOME', () => {
    const {env,home} = fixture()
    expect(resolveLarkCliEnvironment({...env,HOME:'/formal-home',LARKSUITE_CLI_CONFIG_DIR:'/formal-config'})).toMatchObject({
      HOME:'/formal-home',LARKSUITE_CLI_CONFIG_DIR:join(home,'.lark-cli')
    })
  })
  it('rejects missing roots, escaped homes and escaped config symlinks', () => {
    const {env,home,root} = fixture()
    expect(() => resolveLarkCliEnvironment({WORKWISE_CANDIDATE:'1'})).toThrow()
    expect(() => resolveLarkCliEnvironment({...env,WORKWISE_CANDIDATE_HOME:join(root,'..','outside')})).toThrow()
    const outside = mkdtempSync(join(tmpdir(),'lark-outside-'));roots.push(outside)
    symlinkSync(outside,join(home,'.lark-cli'),process.platform === 'win32'?'junction':'dir')
    expect(() => resolveLarkCliEnvironment(env)).toThrow('inside its isolated root')
  })
  it.each([undefined,'0','2'])('blocks Candidate credential reads unless explicitly enabled (access=%s)', access => {
    expect(() => assertLarkCliCredentialAccess({WORKWISE_CANDIDATE:'1',WORKWISE_CANDIDATE_CREDENTIAL_ACCESS:access})).toThrowError(expect.objectContaining({code:'candidate_credentials_disabled'}))
    expect(() => assertLarkCliCredentialAccess({WORKWISE_CANDIDATE:'1',WORKWISE_CANDIDATE_CREDENTIAL_ACCESS:'1'})).not.toThrow()
  })
  it('blocks cached available capability before allocating a Candidate task Turn', () => {
    const runtime = new ManagedLarkRuntime(LarkCapabilityConfig.parse({enabled:true,authState:'installed',executablePath:'/managed/lark-cli',brand:'feishu',scopes:['task:task:read']}))
    vi.stubEnv('WORKWISE_CANDIDATE','1');vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS','0')
    expect(runtime.preflight('查询飞书待办')).toMatchObject({status:'blocked',errorCode:'candidate_credentials_disabled'})
    const unconfigured = new ManagedLarkRuntime(LarkCapabilityConfig.parse({enabled:true}))
    expect(unconfigured.preflight('查询飞书待办')).toMatchObject({status:'not_installed'})
  })
  it('persists only the diagnosed identity in execution scope and blocks legacy unbound connector state', () => {
    const legacy=new ManagedLarkRuntime(LarkCapabilityConfig.parse({enabled:true,authState:'installed',executablePath:'/managed/lark-cli',brand:'feishu',scopes:['task:task:read']}))
    expect(legacy.preflight('查询飞书待办')).toMatchObject({status:'needs_authorization',errorCode:'connector_identity_unverified'})
    expect(legacy.scope()).not.toHaveProperty('connectorIdentityFingerprints')
    const ready=new ManagedLarkRuntime(LarkCapabilityConfig.parse({...legacy.state(),...larkTestBinding}))
    expect(ready.preflight('查询飞书待办')).toMatchObject({status:'available'})
    expect(ready.scope()).toMatchObject({connectorIdentityFingerprints:{'lark-cli':larkTestBinding.identityFingerprint}})
  })
})
