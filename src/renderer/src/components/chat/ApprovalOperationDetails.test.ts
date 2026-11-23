// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { ApprovalOperationDetails } from './ApprovalOperationDetails'

describe('file approval details', () => {
  it.each([
    { action: 'write', toolName: 'write', title: '写入文件', impact: '允许助手创建此文件或覆盖已有内容。' },
    { action: 'edit', title: '编辑文件', impact: '允许助手修改此文件的内容。' }
  ])('shows the $action target and impact while folding the technical details', async ({ action, toolName, title, impact }) => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const element = document.createElement('div')
    const root = createRoot(element)
    const digest = 'a'.repeat(64)
    const summary = `Run ${action}\nTarget: <workspace>/reports/token=fixture-secret.md\nRequest SHA256: ${digest}`
    try {
      await act(async () => root.render(createElement(ApprovalOperationDetails, { summary, toolName })))
      expect(element.textContent).toContain(title)
      expect(element.textContent).toContain(impact)
      expect(element.querySelector('dt')?.textContent).toBe('工作区文件')
      expect(element.querySelector('dd')?.textContent).toBe('reports/token=[REDACTED]')
      expect(element.textContent).not.toContain(digest)
      const details = element.querySelector('details')!
      expect(details.open).toBe(false)
      expect(element.querySelector('pre')).toBeNull()
      await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
      expect(element.querySelector('pre')?.textContent).toContain(digest)
      expect(element.textContent).not.toContain('fixture-secret')
    } finally { await act(async () => root.unmount()) }
  })

  it.each([
    { summary: 'Run write\nTarget: <outside-workspace>' },
    { summary: 'Run write\nTarget: <workspace>/../private.md' },
    { summary: 'Run write\nTarget: <workspace>/report.md', toolName: 'unknown' }
  ])('keeps the generic review when the file target or operation is unavailable', async ({ summary, toolName }) => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const element = document.createElement('div')
    const root = createRoot(element)
    try {
      await act(async () => root.render(createElement(ApprovalOperationDetails, { summary, toolName })))
      expect(element.textContent).toContain('请检查本次操作的目的和权限范围')
      expect(element.textContent).not.toContain('工作区文件')
      expect(element.querySelector('pre')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})
