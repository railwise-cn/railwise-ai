// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { BrowserApprovalDetails } from './BrowserApprovalDetails'
import { MessageBubble } from './message-timeline-bubbles'

const actionSummary = ['确认浏览器操作', '站点 "https://example.com"', '动作 "填写网页输入框"', '目标 "input · 采购关键词"',
  '输入内容 "轨道交通监测"', `输入摘要 "${'a'.repeat(64)}"`, `目标摘要 "${'b'.repeat(64)}"`, `请求摘要 "${'c'.repeat(64)}"`,
  '授权期限 "仅本次操作"', '操作说明 "执行后读取页面核验。"'].join('\n')

const scheduleSummary = ['确认周期浏览器权限', '计划目的 "每日公开公告查询"', '执行时刻 "08:30、16:30"', '时区 "Asia/Shanghai"',
  '读取路径 ""', '写入路径 "成果目录"', '站点 "https://example.com"', '网页动作 "填写采购关键词：轨道交通监测"',
  '浏览器 "Chrome 验收实例"', '账号状态 "未知；仅包含无需账号的公开查询。"', '授权期限 "持续到计划停用或原授权撤销"',
  '操作说明 "元素或输入变化时重新审阅"', `授权版本 "${'a'.repeat(64)}"`].join('\n')

describe('browser approval business view', () => {
  it.each(['details', 'chat', 'schedule'] as const)('shows reviewable fields and reveals technical evidence only after an explicit open in %s', async surface => {
    const summary = surface === 'schedule' ? scheduleSummary : actionSummary
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const element = document.createElement('div')
    const root = createRoot(element)
    try {
      await act(async () => root.render(surface === 'details' ? createElement(BrowserApprovalDetails, { summary }) : createElement(MessageBubble, { block: { kind: 'approval', id: 'review', approvalId: 'appr', status: 'pending', toolName: surface === 'schedule' ? 'schedule_task' : 'browser_fill', summary } })))
      expect(element.textContent).toContain('https://example.com')
      expect(element.textContent).toContain('采购关键词')
      expect(element.textContent).toContain('轨道交通监测')
      expect(element.textContent).not.toContain('a'.repeat(64))
      expect(element.textContent).not.toContain('输入摘要')
      expect(element.textContent).not.toContain('browser_fill')
      if (surface === 'schedule') {
        expect(element.textContent).toContain('08:30、16:30')
        expect(element.textContent).toContain('Asia/Shanghai')
        expect(element.textContent).toContain('未知；仅包含无需账号的公开查询')
        expect(element.textContent).not.toContain('schedule_task')
      }
      expect(element.querySelector('pre')).toBeNull()
      await act(async () => { const details = element.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
      expect(element.querySelector('pre')?.textContent).toBe(summary)
    } finally { await act(async () => root.unmount()) }
  })
})
