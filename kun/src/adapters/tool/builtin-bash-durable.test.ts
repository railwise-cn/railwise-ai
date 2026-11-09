import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { createBashLocalTool,stopAllBashSessions } from './builtin-bash-tool.js'
import { CapacityManager } from '../../services/capacity-manager.js'
import { processIdentity } from '../../services/process-identity.js'
import type { BashSessionLifecycle } from './builtin-tool-types.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
const roots:string[]=[]
afterEach(async()=>{await stopAllBashSessions();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function workspace(){const root=await mkdtemp(join(tmpdir(),'railwise-shell-'));roots.push(root);return root}
function context(root:string,signal:AbortSignal=new AbortController().signal):ToolHostContext{return {workspace:root,threadId:'thread',turnId:'turn',approvalPolicy:'auto',abortSignal:signal,awaitApproval:async()=>'allow'}}
describe('durable shell process identity and cancellation',()=>{
  it('persists a fast process start before its final receipt and flushes the output at shutdown',async()=>{
    const root=await workspace(),order:string[]=[],starts:Parameters<NonNullable<BashSessionLifecycle['onStarted']>>[0][]=[]
    const tool=createBashLocalTool({sessionOutputRoot:root,sessionLifecycle:{async onStarted(input){starts.push(input);await new Promise(resolve=>setTimeout(resolve,30));order.push('started')},onFinished(){order.push('finished')}}})
    const result=await tool.execute({command:'printf durable-shell',timeout:5},context(root))
    expect(result.isError).toBeFalsy()
    await stopAllBashSessions()
    expect(order).toEqual(['started','finished'])
    expect(starts[0]).toMatchObject({pid:expect.any(Number),processFingerprint:expect.any(String)})
    expect(await readFile(starts[0]!.outputPath,'utf8')).toBe('durable-shell')
  })
  it('retains the turn cancellation signal after yielding and releases the shared process permit',async()=>{
    const root=await workspace(),capacity=new CapacityManager(),abort=new AbortController()
    let finished!:()=>void
    const done=new Promise<void>(resolve=>{finished=resolve})
    const tool=createBashLocalTool({capacityManager:capacity,sessionOutputRoot:root,sessionLifecycle:{onFinished(input){expect(input.status).toBe('terminated');finished()}}})
    const result=await tool.execute({command:'echo started; sleep 10',yield_seconds:1,timeout:15},context(root,abort.signal))
    expect(result.output).toMatchObject({status:'running'})
    expect(capacity.snapshot()).toHaveLength(1)
    abort.abort()
    await done
    expect(capacity.snapshot()).toHaveLength(0)
  },10_000)
  it('offers recovered output read-only and refuses to signal a reused PID',async()=>{
    const root=await workspace(),outputPath=join(root,'recovered.log')
    await writeFile(outputPath,'preserved evidence')
    const tool=createBashLocalTool({recoverSession:()=>({id:'recovered',taskId:'task',nodeId:'node',workspaceRoot:root,commandSummary:'old command',cwd:root,status:'outcome_unknown',outputPath,outputBytes:18,createdAt:new Date().toISOString(),revision:1,pid:process.pid,processFingerprint:'old-start-fingerprint'})})
    const polled=await tool.execute({action:'poll',session_id:'recovered'},context(root))
    expect(polled.output).toMatchObject({output:'preserved evidence',read_only:true,process_state:'exited'})
    const stopped=await tool.execute({action:'stop',session_id:'recovered'},context(root))
    expect(stopped).toMatchObject({isError:true,output:{code:'outcome_unknown'}})
    expect(processIdentity()?.pid).toBe(process.pid)
  })
})
