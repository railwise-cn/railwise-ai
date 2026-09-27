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
  it('translates receipt chrome and known steps while retaining IDs, hashes, custom text and the stored original', () => {
    const english = engineeringPlanTranscriptText(receipt, 'en-US')
    expect(english).toContain('Nothing has been executed.')
    expect(english).toContain('Validate the survey network and datum (survey_network_validate, individual approval required)')
    expect(english).toContain('项目自定义步骤 (survey_adjustment_read, read-only)')
    expect(english).toContain(`Context hash: sha256-${'a'.repeat(64)}`)
    expect(english).toContain('Plan ID: eplan_12345678-abcd')
    expect(engineeringPlanTranscriptText(receipt, 'zh-CN')).toBe(receipt)
  })
  it('does not translate partial, altered or quoted messages', () => {
    for (const text of ['Please explain:\n' + receipt, receipt + '\nextra', receipt.replace('2. 项目', '9. 项目'), receipt.replace('eplan_', 'other_')]) {
      expect(engineeringPlanTranscriptText(text, 'en')).toBe(text)
    }
  })
})
