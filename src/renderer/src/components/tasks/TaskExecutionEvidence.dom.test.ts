// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { TaskExecutionEvidence } from './TaskExecutionEvidence'
import type { TaskOperationReceiptV1, TaskResultEvidenceV1, TaskRunV1 } from '@shared/agent-workbench'

afterEach(() => vi.useRealTimers())

function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement
  copy.querySelectorAll('details:not([open])').forEach(details => {
    const summary = details.querySelector('summary')?.cloneNode(true)
    details.replaceChildren(...(summary ? [summary] : []))
  })
  return copy.textContent ?? ''
}

async function withEvidence(task: TaskRunV1, receipts: TaskOperationReceiptV1[], inspect: (container: HTMLElement) => void | Promise<void>): Promise<void> {
  await i18n.changeLanguage('zh')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(TaskExecutionEvidence, { task, relatedTasks: [task], receipts })))
    await inspect(container)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

const fileEvidence: TaskResultEvidenceV1 = {
  kind: 'file', provider: 'managed-artifacts', operation: 'verify_web_artifact',
  target: 'D:\\a\\railwise-ai\\temp\\task-artifacts\\每日网页报告.html', status: 'source_verified', verified: true,
  resultHash: 'a'.repeat(64), sourceVersion: 'source-proof-private', targetVersion: 'a'.repeat(64), verifiedAt: '2026-11-15T00:00:00Z'
}

it('presents a completed file as a verified deliverable and keeps raw tool, path and hashes inside closed details', async () => {
  const task = { id: 'files', status: 'completed', acceptance: { kind: 'files', requiresWebEvidence: true }, resultEvidence: [fileEvidence] } as TaskRunV1
  await withEvidence(task, [], container => {
    expect(visibleText(container)).toContain('成果核验')
    expect(visibleText(container)).toContain('成果文件 · 每日网页报告.html')
    expect(visibleText(container)).toContain('文件及来源已核验')
    expect(visibleText(container)).not.toContain('外部执行')
    expect(visibleText(container)).not.toContain('未执行')
    for (const raw of ['managed-artifacts', 'verify_web_artifact', 'D:\\a\\', fileEvidence.resultHash, fileEvidence.sourceVersion!]) {
      expect(visibleText(container)).not.toContain(raw)
    }
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('执行详情')
    details.open = true
    for (const raw of ['managed-artifacts', 'verify_web_artifact', fileEvidence.target, fileEvidence.resultHash]) expect(visibleText(container)).toContain(raw)
  })
})

it.each(['effect', 'files'] as const)('keeps required external actions visibly unexecuted even when the %s task has no effect contract', async kind => {
  const task = { id: 'required-effect', status: 'waiting_approval', acceptance: { kind, requiresExternalEffects: true }, resultEvidence: kind === 'files' ? [fileEvidence] : [] } as TaskRunV1
  await withEvidence(task, [], container => {
    expect(visibleText(container)).toContain('尚无外部操作回执。')
    expect(visibleText(container)).toContain('外部操作尚未执行，等待授权。')
    expect(visibleText(container)).not.toContain('任务尚未执行')
    if (kind === 'files') expect(visibleText(container)).toContain('文件及来源已核验')
  })
})

it.each([
  ['waiting_user', '外部操作尚未执行，等待你处理待办。'],
  ['failed', '本次执行失败，尚无成功的外部操作证据。'],
  ['queued', '外部操作尚未执行。']
] as const)('distinguishes the required external action state for %s without claiming file failure', async (status, label) => {
  const task = { id: 'external-state', status, acceptance: { kind: 'effect' } } as TaskRunV1
  await withEvidence(task, [], container => expect(visibleText(container)).toContain(label))
})

it('does not contradict verified external evidence while its receipt list is empty', async () => {
  const evidence: TaskResultEvidenceV1 = { ...fileEvidence, kind: 'external_operation', provider: 'lark', operation: 'send', target: '验收会话', status: 'sent' }
  const task = { id: 'external-evidence', status: 'completed', acceptance: { kind: 'effect' }, resultEvidence: [evidence] } as TaskRunV1
  await withEvidence(task, [], container => {
    expect(visibleText(container)).toContain('已执行并验证')
    expect(visibleText(container)).toContain('尚无外部操作回执。')
    expect(visibleText(container)).not.toContain('尚未执行')
  })
})

it('uses English business labels and keeps internal paths in details there too', async () => {
  const task = { id: 'english-file', status: 'completed', acceptance: { kind: 'files' }, resultEvidence: [fileEvidence] } as TaskRunV1
  await withEvidence(task, [], async container => {
    await act(async () => { await i18n.changeLanguage('en') })
    expect(visibleText(container)).toContain('Deliverable verification')
    expect(visibleText(container)).toContain('File and sources verified')
    expect(visibleText(container)).not.toContain('has not executed')
    expect(visibleText(container)).not.toContain(fileEvidence.target)
  })
})

it('does not infer that an ordinary answer task is unexecuted from having no external receipts', async () => {
  const task = { id: 'answer', status: 'completed', acceptance: { kind: 'answer' } } as TaskRunV1
  await withEvidence(task, [], container => expect(container.textContent).toBe(''))
})

it.each(['outcome_unknown', 'failed'] as const)('preserves a mixed task external %s blocker beside its verified file', async status => {
  const task = { id: 'mixed', status: 'stalled', acceptance: { kind: 'files', requiresExternalEffects: true, effect: { provider: 'lark', operation: 'send', target: '验收会话' } }, resultEvidence: [fileEvidence] } as TaskRunV1
  const receipt: TaskOperationReceiptV1 = { id: 'receipt-external', taskId: task.id, provider: 'lark', operation: 'send', toolName: 'internal_send_message', target: '验收会话', requestHash: 'b'.repeat(64), status,
    errorCode: status === 'failed' ? 'provider_network_failed' : undefined, createdAt: fileEvidence.verifiedAt, updatedAt: fileEvidence.verifiedAt }
  await withEvidence(task, [receipt], container => {
    expect(visibleText(container)).toContain('文件及来源已核验')
    expect(visibleText(container)).toContain(status === 'failed' ? '执行失败' : '结果待核实')
    expect(visibleText(container)).toContain(status === 'failed' ? '失败记录会保留' : '系统不会自动重放')
    expect(visibleText(container)).not.toContain('internal_send_message')
    expect(visibleText(container)).not.toContain('provider_network_failed')
    expect(visibleText(container)).not.toContain(receipt.requestHash)
  })
})

it('does not promote unverified or non-source file evidence into source verification', async () => {
  const files: TaskResultEvidenceV1[] = [
    { ...fileEvidence, verified: false },
    { ...fileEvidence, target: '/private/internal/报告.pdf', operation: 'write_file', status: 'valid' }
  ]
  const task = { id: 'file-status', status: 'stalled', acceptance: { kind: 'files' }, resultEvidence: files } as TaskRunV1
  await withEvidence(task, [], container => {
    expect(visibleText(container)).toContain('尚未验证')
    expect(visibleText(container)).toContain('文件已核验')
    expect(visibleText(container)).not.toContain('文件及来源已核验')
    expect(visibleText(container)).not.toContain('已执行并验证')
  })
})

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
