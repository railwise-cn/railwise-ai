import { describe, expect, it } from 'vitest'
import { engineeringPlanTranscriptText } from './engineering-plan-transcript'

const receipt = [
  '已生成工程测量 Typed Plan，当前仅供审查，尚未执行。',
  '计划编号：eplan_12345678-abcd',
  `上下文哈希：sha256-${'a'.repeat(64)}`,
  '1. 校核测量网络与基准（survey_network_validate，需单独审批）\n2. 项目自定义步骤（survey_adjustment_read，只读）',
  '审批并明确启动前，不会创建 TaskRun、调用模型或执行任何工具。'
].join('\n\n')

describe('Legacy plan receipt display', () => {
  it('projects receipt chrome and known steps without exposing internal IDs or hashes', () => {
    const english = engineeringPlanTranscriptText(receipt, 'en-US')
    expect(english).toContain('Nothing has been run.')
    expect(english).toContain('Validate survey network and datum (needs confirmation)')
    expect(english).toContain('Check survey data (automatic check)')
    expect(english).not.toContain('survey_network_validate')
    expect(english).not.toContain('survey_adjustment_read')
    expect(english).not.toContain('Context hash:')
    expect(english).not.toContain('Plan ID:')
    expect(english).not.toContain('TaskRun')
    const chinese = engineeringPlanTranscriptText(receipt, 'zh-CN')
    expect(chinese).toContain('测量执行方案已生成')
    expect(chinese).toContain('检查测量资料（自动检查）')
    expect(chinese).not.toContain('上下文哈希：')
    expect(chinese).not.toContain('计划编号：')
    expect(chinese).not.toContain('TaskRun')
  })
  it('leaves unrelated text alone and safely summarizes partial or quoted plans', () => {
    expect(engineeringPlanTranscriptText('控制网资料已准备好。', 'zh-CN')).toBe('控制网资料已准备好。')
    for (const text of ['Please explain:\n' + receipt, receipt + '\nextra', receipt.replace('2. 项目', '9. 项目'), receipt.replace('eplan_', 'other_')]) {
      const shown = engineeringPlanTranscriptText(text, 'en')
      expect(shown).not.toContain('eplan_12345678-abcd')
      expect(shown).not.toContain('sha256-')
      expect(shown).not.toContain('survey_network_validate')
      expect(shown).not.toContain('survey_adjustment_read')
      expect(shown).not.toContain('TaskRun')
      expect(shown).toContain('Processing starts after your confirmation.')
    }
  })
  it('summarizes oversized pending plans without returning protocol text', () => {
    const oversized = `${receipt}\n${'internal payload '.repeat(2_500)}`
    const shown = engineeringPlanTranscriptText(oversized, 'zh-CN')

    expect(shown).toContain('校核测量网络与基准（需要确认）')
    expect(shown).toContain('检查测量资料（自动检查）')
    expect(shown).toContain('确认后将开始处理')
    expect(shown).not.toContain('eplan_12345678-abcd')
    expect(shown).not.toContain('上下文哈希')
    expect(shown).not.toContain('survey_network_validate')
    expect(shown).not.toContain('TaskRun')
    expect(shown).not.toContain('internal payload')
  })
  it('keeps readable steps and risk labels when receipt metadata is malformed', () => {
    const malformed = receipt
      .replace('计划编号：eplan_12345678-abcd', '计划编号：eplan_hidden-7')
      .replace(`上下文哈希：sha256-${'a'.repeat(64)}`, '上下文哈希：sha256-private-value')
    const shown = engineeringPlanTranscriptText(malformed, 'zh-CN')

    expect(shown).toContain('校核测量网络与基准（需要确认）')
    expect(shown).toContain('检查测量资料（自动检查）')
    expect(shown).toContain('确认后将开始处理')
    expect(shown).not.toContain('eplan_hidden-7')
    expect(shown).not.toContain('sha256-private-value')
    expect(shown).not.toContain('survey_network_validate')
    expect(shown).not.toContain('TaskRun')
  })
  it('hides attached JSON while retaining a pending plan summary', () => {
    const withJson = `${receipt}\n\n{"planId":"eplan_secret-123","contextHash":"sha256-secret","tool":"survey_network_validate"}`
    const shown = engineeringPlanTranscriptText(withJson, 'zh-CN')

    expect(shown).toContain('校核测量网络与基准（需要确认）')
    expect(shown).toContain('确认后将开始处理')
    expect(shown).not.toContain('planId')
    expect(shown).not.toContain('eplan_secret-123')
    expect(shown).not.toContain('sha256-secret')
    expect(shown).not.toContain('survey_network_validate')
    expect(shown).not.toContain('{"')
  })
})
