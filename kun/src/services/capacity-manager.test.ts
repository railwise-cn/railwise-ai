import { describe,expect,it } from 'vitest'
import { CapacityManager } from './capacity-manager.js'
import { inspectProcess,processIdentity } from './process-identity.js'
import { SteeringQueue } from '../loop/steering-queue.js'

describe('shared execution resources',()=>{
  it('holds one model budget reservation for a root across children, allowing other roots to progress',async()=>{
    const capacity=new CapacityManager({model:3,worker:2,shell:2,workspaceShell:1})
    const first=capacity.reserve({id:'a',rootTaskId:'root',serialRoot:true,resources:{model:1}})
    let started=false
    const queued=capacity.acquire({id:'b',rootTaskId:'root',serialRoot:true,resources:{model:1}}).then(permit=>{started=true;return permit})
    const other=capacity.reserve({id:'c',rootTaskId:'other',resources:{model:1}})
    await Promise.resolve(); expect(started).toBe(false)
    first.release();const next=await queued;expect(started).toBe(true)
    other.release();next.release(); expect(capacity.snapshot()).toHaveLength(0)
  })
  it('removes cancelled waiters and enforces a shared workspace process limit',async()=>{
    const capacity=new CapacityManager({model:1,worker:1,shell:2,workspaceShell:1})
    const shell=capacity.reserve({id:'shell',workspaceRoot:'/project',resources:{shell:1}})
    expect(()=>capacity.reserve({id:'shell2',workspaceRoot:'/project',resources:{shell:1}})).toThrow(/workspace/)
    const occupied=capacity.reserve({id:'model',resources:{model:1}})
    const abort=new AbortController()
    const queued=capacity.acquire({id:'cancelled',resources:{model:1}},abort.signal)
    abort.abort(new Error('cancel'))
    await expect(queued).rejects.toThrow('cancel')
    occupied.release();shell.release();expect(capacity.snapshot()).toHaveLength(0)
  })
  it('never confuses an unavailable fingerprint with proof of process exit',()=>{
    expect(processIdentity()).toMatchObject({pid:process.pid})
    expect(inspectProcess(processIdentity()!)).toBe('alive')
    expect(inspectProcess({pid:process.pid,fingerprint:'different-start'})).toBe('exited')
    expect(inspectProcess({pid:process.pid,fingerprint:'unverified:old'})).toBe('unknown')
  })
  it('keeps simultaneous worker steering isolated when the active turn changes',()=>{
    const steering=new SteeringQueue()
    steering.setTurn('a');steering.enqueue('a','first')
    steering.setTurn('b');steering.enqueue('b','second')
    expect(steering.drain('a')).toEqual(['first'])
    steering.clear('a');expect(steering.drain('b')).toEqual(['second'])
  })
})
