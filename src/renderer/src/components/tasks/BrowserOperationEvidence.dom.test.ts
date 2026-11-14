// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { TaskOperationReceiptV1, TaskOperationVerificationV1 } from '@shared/agent-workbench'
import { BrowserOperationEvidence } from './BrowserOperationEvidence'

afterEach(() => vi.useRealTimers())

const receipt: TaskOperationReceiptV1 = {
  id: 'browser-receipt', taskId: 'task-browser', purpose: 'browser_action', provider: 'browser-skill', operation: 'click',
  toolName: 'browser_click', requestHash: 'a'.repeat(64), status: 'outcome_unknown',
  browser: { action: 'click', pageUrl: 'https://example.com/notices', canReview: true },
  createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z'
}

function review(expiresAt: string): TaskOperationVerificationV1 {
  return { taskId: receipt.taskId, receiptId: receipt.id, status: 'outcome_unknown', browserReview: {
    id: 'review-private-id', expiresAt, action: 'click', pageUrl: 'https://example.com/notices',
    observationText: '<script>untrusted page text</script>\n查询结果：工程监测公告', targetLabel: '公开公告查询', value: '工程测量'
  } }
}

it('checks only on request and requires an explicit human confirmation before recording the original action', async () => {
  await i18n.changeLanguage('zh')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const check = vi.fn(async () => review(new Date(Date.now() + 120_000).toISOString()))
  const confirm = vi.fn(async (): Promise<TaskOperationVerificationV1> => ({ taskId: receipt.taskId, receiptId: receipt.id, status: 'verified',
    evidence: { kind: 'human_confirmation', provider: 'browser-skill', operation: 'click', target: 'https://example.com/notices', status: 'public_query_confirmed_by_user', verified: true, verifiedAt: new Date().toISOString(), resultHash: 'b'.repeat(64) } }))
  const configure = vi.fn()
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!
  try {
    await act(async () => root.render(createElement(BrowserOperationEvidence, { receipt, ended: false, onVerify: check, onConfirm: confirm, onConfigure: configure })))
    expect(check).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.textContent).not.toContain('browser_click')
    await act(async () => button('检查原网页结果').click())
    expect(check).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('<script>untrusted page text</script>')
    expect(button('保存我的核对结果').disabled).toBe(true)
    expect(container.textContent).toContain('工程测量')
    expect(container.textContent).not.toContain('review-private-id')
    await act(async () => container.querySelector<HTMLInputElement>('input[value="completed"]')!.click())
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => checkbox.click())
    expect(button('保存我的核对结果').disabled).toBe(false)
    await act(async () => button('保存我的核对结果').click())
    expect(confirm).toHaveBeenCalledExactlyOnceWith(receipt, 'review-private-id', 'completed')
    expect(container.textContent).toContain('你已核对本次操作')
    expect(container.textContent).not.toContain('已执行并验证')
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
    expect(configure).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it.each([false, true])('requires a separate incomplete statement and rejects a mismatched result (mismatch=%s)', async mismatch => {
  await i18n.changeLanguage('zh')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const check = vi.fn(async () => review(new Date(Date.now() + 120_000).toISOString()))
  const confirm = vi.fn(async (): Promise<TaskOperationVerificationV1> => ({ taskId: receipt.taskId, receiptId: receipt.id, status: 'verified',
    outcome: mismatch ? 'succeeded' : 'not_completed', evidence: { kind: 'human_confirmation', provider: 'browser-skill', operation: 'click',
      target: receipt.browser!.pageUrl!, status: mismatch ? 'public_query_confirmed_by_user' : 'public_query_reviewed_incomplete', verified: true, verifiedAt: new Date().toISOString(), resultHash: 'b'.repeat(64) } }))
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!
  try {
    await act(async () => root.render(createElement(BrowserOperationEvidence, { receipt, ended: false, onVerify: check, onConfirm: confirm })))
    await act(async () => button('检查原网页结果').click())
    expect(container.querySelector('input:checked')).toBeNull()
    await act(async () => container.querySelector<HTMLInputElement>('input[value="completed"]')!.click())
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => container.querySelector<HTMLInputElement>('input[value="not_completed"]')!.click())
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    expect(button('保存我的核对结果').disabled).toBe(true)
    expect(container.textContent).toContain('这不会证明原操作未产生任何效果')
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => button('保存我的核对结果').click())
    expect(confirm).toHaveBeenCalledExactlyOnceWith(receipt, 'review-private-id', 'not_completed')
    expect(container.textContent).not.toContain('你已核对本次操作已完成')
    expect(container.textContent).toContain(mismatch ? '暂时无法核验原网页' : '你已核对本次公开查询未完成')
    expect(check).toHaveBeenCalledTimes(1)
    if (!mismatch) {
      await act(async () => root.unmount())
      const reloaded = createRoot(container)
      await act(async () => reloaded.render(createElement(BrowserOperationEvidence, { receipt: { ...receipt, resolution: {
        status: 'verified', outcome: 'not_completed', receiptId: 'proof', evidence: (await confirm()).evidence!, resolvedAt: new Date().toISOString() } }, ended: false, onVerify: check, onConfirm: confirm })))
      expect(container.textContent).toContain('不计为成功')
      expect(container.querySelector('button')).toBeNull()
      await act(async () => reloaded.unmount())
    }
  } finally { if (mismatch) await act(async () => root.unmount()); container.remove() }
})

it('expires the observed review and never confirms from a stale checkbox', async () => {
  await i18n.changeLanguage('zh')
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z'))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const check = vi.fn(async () => review('2026-11-14T00:02:00Z'))
  const confirm = vi.fn()
  try {
    await act(async () => root.render(createElement(BrowserOperationEvidence, { receipt, ended: false, onVerify: check, onConfirm: confirm })))
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === '检查原网页结果')!.click())
    await act(async () => container.querySelector<HTMLInputElement>('input[value="completed"]')!.click())
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(container.textContent).toContain('这次检查已过期')
    expect([...container.querySelectorAll('button')].some(item => item.textContent === '保存我的核对结果')).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps unsupported and cancelled operations unknown with connection access and no automatic inspection', async () => {
  await i18n.changeLanguage('en')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const check = vi.fn(), confirm = vi.fn(), configure = vi.fn()
  try {
    const unsupported = { ...receipt, browser: { ...receipt.browser!, canReview: false } }
    await act(async () => root.render(createElement(BrowserOperationEvidence, { receipt: unsupported, ended: false, onVerify: check, onConfirm: confirm, onConfigure: configure })))
    expect(container.textContent).toContain('cannot be verified yet')
    expect([...container.querySelectorAll('button')].some(item => item.textContent === 'Check the original page')).toBe(false)
    await act(async () => [...container.querySelectorAll('button')].find(item => item.textContent === 'Browser connection')!.click())
    expect(configure).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(BrowserOperationEvidence, { receipt, ended: true, onVerify: check, onConfirm: confirm, onConfigure: configure })))
    expect(container.querySelector('button')).toBeNull()
    expect(check).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})
