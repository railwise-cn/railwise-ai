import { describe, expect, it } from 'vitest'
import { deliveryPrompt, TASK_DELIVERY_TEMPLATES } from '../../kun/src/delivery/templates'
import { isMatchingExecutionGrantExpiredAttention, taskDisplayGoal, taskDisplayTitle } from './task-presentation'
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

describe('taskDisplayTitle', () => {
  it('prefers an explicitly named task to action words in later disclaimers without changing the request', () => {
    const goal = '新任务：大单网临时实钟验收（0.5.7，临时验证）。此任务与原来的正式采集计划独立。\n使用原任务范围继续验证。'
    const task = { goal }
    expect(taskDisplayTitle(task)).toBe('大单网临时实钟验收')
    expect(taskDisplayGoal(task)).toBe(goal)
    expect(task.goal).toBe(goal)
  })

  it.each([
    ['任务名称：桥梁沉降分析（东侧）\n整理本期数据。', '桥梁沉降分析（东侧）'],
    ['任务标题:  临时验收 (v0.5.7，测试)\n采集本次结果。', '临时验收'],
    ['新任务：大单网\t临时验收\n分析执行记录。', '大单网 临时验收']
  ])('uses the named first line and preserves meaningful title qualifiers: %s', (goal, expected) => {
    expect(taskDisplayTitle({ goal })).toBe(expected)
  })

  it('keeps ordinary action titles and plain goals unchanged', () => {
    expect(taskDisplayTitle({ goal: '创建一个完整、独立运行的 HTML 文件，使用 SVG 绘制一只正在骑自行车的鹈鹕，并制作成二维动画。所有代码包含在同一个文件中。' })).toBe('绘制骑自行车的鹈鹕')
    expect(taskDisplayTitle({ goal: '整理本月资料并形成报告。保留待确认项。' })).toBe('整理本月资料并形成报告')
    expect(taskDisplayTitle({ goal: 'Monthly monitoring review' })).toBe('Monthly monitoring review')
    expect(taskDisplayTitle({ goal: '说明中提到新任务：示例。绘制一张示意图。' })).toBe('绘制示意图')
  })

  it('keeps the existing title length limit for long explicit task names', () => {
    const title = taskDisplayTitle({ goal: `新任务：${'跨期监测资料'.repeat(10)}\n采集本期数据。` })
    expect(title).toHaveLength(42)
    expect(title.endsWith('…')).toBe(true)
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
