// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { TaskExecutionEvidence } from './TaskExecutionEvidence'
import type { TaskOperationReceiptV1, TaskRunV1 } from '@shared/agent-workbench'

afterEach(() => vi.useRealTimers())

it('shows a compact local-command result and polls only its existing receipt', async () => {
  await i18n.changeLanguage('zh')
  vi.useFakeTimers()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const receipt: TaskOperationReceiptV1 = { id: 'receipt-local', taskId: 'task-local', purpose: 'host_shell', provider: 'local', operation: 'host_shell',
    toolName: 'request_host_shell', requestHash: 'a'.repeat(64), status: 'outcome_unknown', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', shell: { canPoll: true } }
  const task = { id: 'task-local', status: 'stalled', acceptance: { kind: 'answer' } } as TaskRunV1
  const verify = vi.fn(async () => ({ taskId: task.id, receiptId: receipt.id, status: 'verified' as const,
    shell: { status: 'verified' as const, exitCode: 0, message: '原命令已确认成功退出。' } }))
  try {
    await act(async () => root.render(createElement(TaskExecutionEvidence, { task, relatedTasks: [task], receipts: [receipt], onVerify: verify })))
    expect(container.textContent).toContain('本机命令执行结果')
    expect(container.textContent).toContain('结果待核实')
    expect(container.textContent).not.toContain('request_host_shell')
    expect(container.querySelector('details')?.open).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(verify).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(container.textContent).toContain('原命令已确认成功退出。')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
