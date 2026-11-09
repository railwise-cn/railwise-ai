import { describe, expect, it } from 'vitest'
import { deliveryPrompt, TASK_DELIVERY_TEMPLATES } from '../../kun/src/delivery/templates'
import { taskDisplayGoal } from './task-presentation'

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
