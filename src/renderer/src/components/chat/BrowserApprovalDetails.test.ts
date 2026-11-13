// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { BrowserApprovalDetails } from './BrowserApprovalDetails'
import { MessageBubble } from './message-timeline-bubbles'

const summary = ['确认浏览器操作', '站点 "https://example.com"', '动作 "填写网页输入框"', '目标 "input · 采购关键词"',
  '输入内容 "轨道交通监测"', `输入摘要 "${'a'.repeat(64)}"`, `目标摘要 "${'b'.repeat(64)}"`, `请求摘要 "${'c'.repeat(64)}"`,
  '授权期限 "仅本次操作"', '操作说明 "执行后读取页面核验。"'].join('\n')

describe('browser approval business view', () => {
  it.each(['details', 'chat'] as const)('shows reviewable fields and reveals technical evidence only after an explicit open in %s', async surface => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const element = document.createElement('div')
    const root = createRoot(element)
    try {
      await act(async () => root.render(surface === 'details' ? createElement(BrowserApprovalDetails, { summary }) : createElement(MessageBubble, { block: { kind: 'approval', id: 'review', approvalId: 'appr', status: 'pending', toolName: 'browser_fill', summary } })))
      expect(element.textContent).toContain('https://example.com')
      expect(element.textContent).toContain('采购关键词')
      expect(element.textContent).toContain('轨道交通监测')
      expect(element.textContent).not.toContain('a'.repeat(64))
      expect(element.textContent).not.toContain('输入摘要')
      expect(element.textContent).not.toContain('browser_fill')
      expect(element.querySelector('pre')).toBeNull()
      await act(async () => { const details = element.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
      expect(element.querySelector('pre')?.textContent).toBe(summary)
    } finally { await act(async () => root.unmount()) }
  })
})
