import {describe,it,expect} from 'vitest'
import {verifiedEffectReceipts} from './external-effect-evidence.js'
import type {OperationReceipt,TaskRun} from '../contracts/tasks.js'

const task={id:'t',goal:'同意飞书审批',acceptance:{kind:'effect',effect:{provider:'lark',operation:'approve',target:'a'}}} as TaskRun
const evidence={kind:'external_operation',provider:'lark',operation:'approve',target:'a',status:'APPROVED',verified:true,verifiedAt:'2026-11-10T00:00:00Z',remoteOperationId:'remote-a',resultHash:'hash'}
const receipt={id:'r',ownerId:'t',kind:'tool',status:'succeeded',request:{toolName:'lark_approval_approve',provider:'lark',target:'a'},result:{approved:true,item:{isError:false,output:{ok:true,status:'succeeded',evidence}}}} as OperationReceipt
const patch=(overrides:Record<string,unknown>)=>({...receipt,...overrides}) as OperationReceipt

describe('trusted external operation acceptance',()=>{
  it('accepts only matching verified provider target operation evidence',()=>{
    expect(verifiedEffectReceipts(task,[receipt])).toEqual([evidence])
    expect(verifiedEffectReceipts(task,[patch({ownerId:'other'})])).toEqual([])
    expect(verifiedEffectReceipts(task,[patch({status:'outcome_unknown'})])).toEqual([])
    expect(verifiedEffectReceipts(task,[patch({request:{...receipt.request,target:'other'}})])).toEqual([])
  })
  it('never treats a read or a fabricated tool name as proof of approval',()=>{
    for(const toolName of ['lark_task_list','bash','send_approval_fake'])
      expect(verifiedEffectReceipts(task,[patch({request:{...receipt.request,toolName}})])).toEqual([])
  })
  it('requires explicit confirmation and verified readback for writes',()=>{
    const result=receipt.result as {approved:boolean;item:{isError:boolean;output:Record<string,unknown>}}
    expect(verifiedEffectReceipts(task,[patch({result:{...result,approved:false}})])).toEqual([])
    expect(verifiedEffectReceipts(task,[patch({result:{...result,item:{...result.item,output:{ok:true,status:'succeeded',evidence:{...evidence,verified:false}}}}})])).toEqual([])
    expect(verifiedEffectReceipts(task,[patch({result:{...result,item:{...result.item,output:{ok:true,status:'succeeded'}}}})])).toEqual([])
  })
})
