import { describe, expect, it } from 'vitest'
import { deliveryPrompt, TASK_DELIVERY_TEMPLATES } from '../../kun/src/delivery/templates'
import { isMatchingExecutionGrantExpiredAttention, taskDisplayGoal } from './task-presentation'
import type { TaskAttentionV1, TaskRunV1 } from './agent-workbench'

describe('taskDisplayGoal', () => {
  it.each(TASK_DELIVERY_TEMPLATES)('recovers the original goal from historical $id execution prompts without changing the record', template => {
    const goal = '整理本月资料并形成报告。\n保留待确认项。'
    const task = { templateId: template.id, goal: deliveryPrompt(template.id, { workspaceRoot: '/workspace', goal, sourcePaths: ['source.md'] }) }
    const original = task.goal
    expect(taskDisplayGoal(task)).toBe(goal)
    expect(task.goal).toBe(original)
    expect(original).toContain('source_refs')
  })

  it('preserves ordinary goals and new concise template goals verbatim', () => {
    const goal = '用户目标：核对 source_refs 字段。\n工作区：保持资料原样。'
    expect(taskDisplayGoal({ goal })).toBe(goal)
    expect(taskDisplayGoal({ goal, templateId: 'research-document' })).toBe(goal)
  })
})

it('translates only the pending typed expiry matching the actual owner, reason and attention bytes', () => {
  const raw='Execution grant expired; start a newly authorized Turn.'
  const owner={id:'retry-child',status:'waiting_user',waitingReason:raw} as TaskRunV1
  const capability={provider:'workspace',status:'blocked',errorCode:'execution_grant_expired',message:raw}
  const item:TaskAttentionV1={id:'capability-child',ownerKind:'task',ownerId:owner.id,taskId:owner.id,status:'pending',kind:'blocked',title:'确认任务执行权限',revision:0,
    createdAt:'2026-11-16T12:00:00Z',updatedAt:'2026-11-16T12:00:00Z',message:raw,payload:{kind:'capability_required',capability}}
  expect(isMatchingExecutionGrantExpiredAttention(item,owner)).toBe(true)
  expect(isMatchingExecutionGrantExpiredAttention(item,{...owner,status:'failed'})).toBe(true)
  for(const change of [{ownerId:'root'},{taskId:'root'},{status:'answered'},{message:'A different actionable blocker'},
    {payload:{kind:'capability_required',capability:{...capability,errorCode:'future_failure'}}}]){
    expect(isMatchingExecutionGrantExpiredAttention({...item,...change} as TaskAttentionV1,owner)).toBe(false)
  }
  for(const change of [{id:'root'},{status:'running'},{waitingReason:'A newer blocker'}])expect(isMatchingExecutionGrantExpiredAttention(item,{...owner,...change} as TaskRunV1)).toBe(false)
  expect(isMatchingExecutionGrantExpiredAttention(item,undefined)).toBe(false)
})
