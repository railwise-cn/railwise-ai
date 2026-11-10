import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LarkCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildLarkCliToolProvider, _larkCliToolProviderInternals } from './lark-cli-tool-provider.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import { larkTestBinding, larkTestIdentity, withLarkTestIdentity } from '../../../tests/helpers/lark-identity.js'

const scopes = ['task:task:read', 'task:task:write', 'approval:task:read', 'approval:instance:read', 'approval:task:write']
const config = () => LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', ...larkTestBinding, scopes })
const context = (awaitApproval: ToolHostContext['awaitApproval'] = vi.fn(async () => 'allow' as const)): ToolHostContext => ({ threadId: 'thread', turnId: 'turn', workspace: '/workspace', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval, assertExternalTarget: vi.fn(), executionGrant: ExecutionGrantSchema.parse({
  id:'grant',threadId:'thread',turnId:'turn',workspaceRoot:'/workspace',workspaceTrust:'workspace-write',agentTrust:'full-access',sandboxMode:'workspace-write',approvalPolicy:'auto',
  networkAllowlist:['https://open.feishu.cn'],connectorScopes:scopes,connectorIdentityFingerprints:{'lark-cli':larkTestBinding.identityFingerprint},
  workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'grant',issuedAt:'2026-11-10T00:00:00.000Z'
}) })
afterEach(() => vi.unstubAllEnvs())

describe('verified typed Lark CLI provider', () => {
  it('uses the isolated Candidate config for the actual CLI child process', async () => {
    const root = mkdtempSync(join(tmpdir(),'lark-runner-environment-'))
    const home = join(root,'home');mkdirSync(home)
    vi.stubEnv('WORKWISE_CANDIDATE','1');vi.stubEnv('WORKWISE_CANDIDATE_ROOT',root);vi.stubEnv('WORKWISE_CANDIDATE_HOME',home)
    vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS','1');vi.stubEnv('LARKSUITE_CLI_CONFIG_DIR','/formal-config')
    try {
      const result = await _larkCliToolProviderInternals.defaultRunner(process.execPath,['-e',"process.stdout.write(JSON.stringify({configDir:process.env.LARKSUITE_CLI_CONFIG_DIR}))"],new AbortController().signal,createHash('sha256').update(readFileSync(process.execPath)).digest('hex'))
      expect(result).toMatchObject({ok:true,output:{configDir:join(home,'.lark-cli')}})
    } finally {rmSync(root,{recursive:true,force:true})}
  })
  it.each(['lark_task_list','lark_task_get','lark_approval_get','lark_task_complete'])('blocks disabled Candidate credential access before %s dispatch, including old provider references', async name => {
    const runner = vi.fn()
    const provider = buildLarkCliToolProvider(config(),runner)!
    vi.stubEnv('WORKWISE_CANDIDATE','1');vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS','0')
    const args = name === 'lark_approval_get'?{instanceCode:'instance-1'}:name === 'lark_task_list'?{}:{taskId:'task-1'}
    await expect(provider.tools.find(tool => tool.name === name)!.execute(args,context())).rejects.toMatchObject({code:'candidate_credentials_disabled'})
    expect(runner).not.toHaveBeenCalled()
  })
  it('binds diagnosis and every CLI call to one profile and the account captured in the execution grant', async () => {
    const runner = vi.fn(async (_path:string,args:string[]) => ({ok:true,output:args[0] === 'auth' ? larkTestIdentity : {code:0,data:{items:[]}}}))
    const tool = buildLarkCliToolProvider({...config(),profile:'bound-profile'},runner)!.tools.find(item=>item.name==='lark_task_list')!
    await tool.execute({},context())
    expect(runner.mock.calls.map(call=>call[1])).toEqual([
      ['auth','status','--profile','bound-profile','--json'],
      ['task','+get-my-tasks','--complete=false','--format','json','--as','user','--profile','bound-profile']
    ])
  })
  it('rejects missing and changed grant identities before reading any account or target', async () => {
    const runner=vi.fn(),tool=buildLarkCliToolProvider(config(),runner)!.tools.find(item=>item.name==='lark_task_list')!
    for(const [fingerprint,code] of [[undefined,'connector_identity_unverified'],['b'.repeat(64),'connector_identity_changed']] as const){
      const current=context();current.executionGrant={...current.executionGrant!,connectorIdentityFingerprints:fingerprint?{'lark-cli':fingerprint}:undefined}
      await expect(tool.execute({},current)).rejects.toMatchObject({code})
    }
    expect(runner).not.toHaveBeenCalled()
  })
  it.each(['account','application','scope'] as const)('blocks stale %s diagnosis before any business operation', async changed => {
    const live=structuredClone(larkTestIdentity)
    if(changed==='account')live.identities.user.openId='ou-other'
    if(changed==='application')live.appId='cli-other'
    if(changed==='scope')live.identities.user.scope=''
    const runner=vi.fn(async()=>({ok:true,output:live}))
    const tool=buildLarkCliToolProvider(config(),runner)!.tools.find(item=>item.name==='lark_task_list')!
    await expect(tool.execute({},context())).rejects.toMatchObject({code:changed==='scope'?'connector_scope_missing':'connector_identity_changed'})
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]).toEqual([config().executablePath,['auth','status','--profile','cli-synthetic','--json'],expect.any(AbortSignal),larkTestBinding.executableHash])
  })
  it('keeps a write unknown if the account changes before its verification read, and never repeats the mutation', async () => {
    let authReads=0
    const changed={...larkTestIdentity,appId:'cli-other'}
    const runner=vi.fn(async (_path:string,args:string[])=>({ok:true,output:args[0]==='auth' ? ++authReads===1?larkTestIdentity:changed : {code:0,data:{}}}))
    const tool=buildLarkCliToolProvider(config(),runner)!.tools.find(item=>item.name==='lark_task_complete')!
    expect(await tool.execute({taskId:'guid-1'},context())).toMatchObject({isError:true,output:{status:'outcome_unknown',data:{code:'connector_identity_changed'}}})
    expect(runner.mock.calls.filter(call=>call[1][0]!=='auth').map(call=>call[1].slice(0,2))).toEqual([['task','+complete']])
  })
  it('does not launch a binary changed after diagnosis', async () => {
    await expect(_larkCliToolProviderInternals.defaultRunner(process.execPath,['-e','process.exit(99)'],new AbortController().signal,'0'.repeat(64))).rejects.toMatchObject({code:'connector_executable_changed'})
  })
  it('keeps list reads available but refuses unscoped writes before invoking the CLI', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: { code: 0, data: { items: [] } } }))
    const provider = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!
    const unscoped = { ...context(), assertExternalTarget: undefined }
    await provider.tools.find(tool => tool.name === 'lark_task_list')!.execute({}, unscoped)
    await expect(provider.tools.find(tool => tool.name === 'lark_task_complete')!.execute({ taskId: 'outside' }, unscoped)).rejects.toMatchObject({ code: 'external_target_blocked' })
    expect(runner).toHaveBeenCalledOnce()
  })

  it('checks the current reviewed provider/action/target before an approval write', async () => {
    const runner = vi.fn()
    const tool = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!.tools.find(tool => tool.name === 'lark_approval_approve')!
    const assertExternalTarget = vi.fn((provider: string, operation: string, target: string) => {
      expect([provider, operation, target]).toEqual(['lark', 'approve', 'task-2'])
      throw Object.assign(new Error('Not reviewed'), { code: 'external_target_blocked' })
    })
    await expect(tool.execute({ instanceCode: 'ic-1', taskId: 'task-2' }, { ...context(), assertExternalTarget })).rejects.toMatchObject({ code: 'external_target_blocked' })
    expect(runner).not.toHaveBeenCalled()
  })
  it('requires diagnosed user identity, brand, and actual scopes', () => {
    expect(buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'needs_login' }))).toBeUndefined()
    expect(buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/cli' }))).toBeUndefined()
    const readOnly = buildLarkCliToolProvider({ ...config(), scopes: ['approval:task:read'] })!
    expect(readOnly.tools.map(tool => tool.name)).toEqual(['lark_approval_list'])
  })

  it('does not advertise task detail or write tools without their read and write scopes', () => {
    const writeOnly = buildLarkCliToolProvider({ ...config(), scopes: ['task:task:write'] })
    expect(writeOnly?.tools.map(tool => tool.name) ?? []).not.toContain('lark_task_get')
    expect(writeOnly?.tools.map(tool => tool.name) ?? []).not.toContain('lark_task_complete')

    const approvalWriteOnly = buildLarkCliToolProvider({ ...config(), scopes: ['approval:task:write', 'approval:instance:read'] })!
    expect(approvalWriteOnly.tools.map(tool => tool.name)).not.toContain('lark_approval_approve')
    expect(approvalWriteOnly.tools.map(tool => tool.name)).not.toContain('lark_approval_reject')
  })

  it('maps validated task reads without shell interpolation and normalizes successful evidence', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { items: [] } } }))
    const provider = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!
    const tool = provider.tools.find(tool => tool.name === 'lark_task_list')!
    const result = await tool.execute({ query: '$(touch /tmp/not-run)' }, context())
    expect(runner.mock.calls[0]?.[1]).toEqual(['task', '+get-my-tasks', '--complete=false', '--query', '$(touch /tmp/not-run)', '--format', 'json', '--as', 'user','--profile','cli-synthetic'])
    expect(result).toMatchObject({ output: { status: 'succeeded', evidence: { provider: 'lark', operation: 'list', verified: true } } })
    await expect(provider.tools.find(tool => tool.name === 'lark_task_get')!.execute({ taskId: '' }, context())).rejects.toThrow()
  })

  it('always requests explicit confirmation for writes even under runtime auto policy', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { guid: 'guid-1', status: 'done', completed_at: '100' } } }))
    const provider = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!
    const approval = vi.fn(async () => 'deny' as const)
    const host = new LocalToolHost({ tools: [...provider.tools] })
    await host.execute({ callId: 'c1', toolName: 'lark_task_complete', arguments: { taskId: 'guid-1' } }, context(approval))
    expect(approval).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
  })

  it('checks the exact approval task state after mutation and produces target-bound evidence', async () => {
    const runner = vi.fn(async (_path: string, args: string[], _signal: AbortSignal) => ({ ok: true, output: args.includes('approve') ? { code: 0, request_id: 'trace-1', data: {} } : { code: 0, data: { instance_code: 'ic-1', tasks: [{ id: 'task-1', status: 'APPROVED' }] } } }))
    const tool = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!.tools.find(tool => tool.name === 'lark_approval_approve')!
    const result = await tool.execute({ instanceCode: 'ic-1', taskId: 'task-1', comment: '同意' }, context())
    expect(runner.mock.calls.map(call => call[1].slice(0, 3))).toEqual([['approval', 'tasks', 'approve'], ['approval', 'instances', 'get']])
    expect(result).toMatchObject({ output: { status: 'succeeded', evidence: { operation: 'approve', target: 'task-1', status: 'APPROVED', verified: true } } })
    expect(result).not.toHaveProperty('output.evidence.remoteOperationId')
    expect(result.output).toHaveProperty('evidence.resultHash')
  })

  it('does not mistake another task or transport success for a verified mutation', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { guid: 'other', completed_at: '100' } } }))
    const tool = buildLarkCliToolProvider(config(), withLarkTestIdentity(runner))!.tools.find(tool => tool.name === 'lark_task_complete')!
    const result = await tool.execute({ taskId: 'guid-1' }, context())
    expect(result).toMatchObject({ isError: true, output: { status: 'outcome_unknown', code: 'external_outcome_unknown' } })
    // One write followed by one read; no blind replay.
    expect(runner.mock.calls[0]?.[1][1]).toBe('+complete')
    expect(runner.mock.calls[1]?.[1].slice(0, 3)).toEqual(['task', 'tasks', 'get'])
  })

  it.each([undefined, {}, { code: 999 }, { error: 'denied' }, { ok: false }, []])('rejects exit-zero invalid/API-error payload %j', output => {
    expect(_larkCliToolProviderInternals.normalizeLarkResult({ ok: true, output }).ok).toBe(false)
  })
})
