import { parseDwsIdentityBinding } from '../../src/services/dws-cli-identity.js'
import type { DwsRunner } from '../../src/adapters/tool/dws-tool-provider.js'
import { DwsCapabilityConfig } from '../../src/contracts/dws.js'
export const dwsTestIdentity={success:true,authenticated:true,token_valid:true,refresh_token_valid:true,corp_id:'corp-synthetic',user_id:'user-synthetic'}
const parsed=parseDwsIdentityBinding(JSON.stringify(dwsTestIdentity))
export const dwsTestConfig=DwsCapabilityConfig.parse({enabled:true,authState:'installed',executablePath:'/managed/dws',executableHash:'a'.repeat(64),
  corpId:parsed.corpId,userId:parsed.userId,profile:parsed.profile,identityFingerprint:parsed.identityFingerprint})
export function withDwsTestIdentity(runner:DwsRunner):DwsRunner{return async(path,args,signal,hash)=>args[0]==='auth'?{ok:true,output:dwsTestIdentity}:runner(path,args,signal,hash)}
