import { afterEach,describe,expect,it,vi } from 'vitest'
import { DwsCapabilityConfig } from '../contracts/dws.js'
import { ManagedDwsRuntime } from './managed-dws-runtime.js'
import { dwsTestConfig } from '../../tests/helpers/dws-identity.js'
afterEach(()=>vi.unstubAllEnvs())
describe('managed official DingTalk preflight',()=>{
  it('uses install and scan-login actions without allocating a model or business command',()=>{
    expect(new ManagedDwsRuntime(undefined).preflight('帮我处理钉钉待办')).toMatchObject({status:'not_installed',resolution:{kind:'install',route:'marketplace'}})
    expect(new ManagedDwsRuntime(DwsCapabilityConfig.parse({authState:'needs_login',executablePath:'/managed/dws'})).preflight('连接钉钉')).toMatchObject({status:'needs_authorization',resolution:{kind:'connect'}})
    expect(new ManagedDwsRuntime(dwsTestConfig).preflight('如何使用钉钉审批')).toBeNull()
  })
  it('binds the execution grant to the diagnosed account without inventing business scopes',()=>{
    const runtime=new ManagedDwsRuntime(dwsTestConfig)
    expect(runtime.preflight('查询钉钉待办')).toMatchObject({status:'available',credentialState:'valid'})
    expect(runtime.scope()).toMatchObject({connectorScopes:[],connectorIdentityFingerprints:{dingtalk:dwsTestConfig.identityFingerprint}})
    expect(runtime.preflight('转交钉钉审批')).toMatchObject({status:'unsupported'})
    vi.stubEnv('WORKWISE_CANDIDATE','1');vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS','0')
    expect(runtime.preflight('查询钉钉待办')).toMatchObject({status:'blocked',errorCode:'candidate_credentials_disabled'})
  })
})
