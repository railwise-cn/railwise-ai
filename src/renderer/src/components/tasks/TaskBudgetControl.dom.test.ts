// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { TaskBudgetControl } from './TaskBudgetControl'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; Reflect.deleteProperty(window, 'workwise'); vi.restoreAllMocks() })

async function mount(overrides: Partial<TaskRunV1> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  const task = { id: 'root', status: 'paused', revision: 4, budget: { version: 2, maxExecutionMs: 1_800_000 }, ...overrides } as TaskRunV1
  const extendTaskBudget = vi.fn(async () => ({ ...task, revision: 5 }))
  const resumeTask = vi.fn()
  const onChanged = vi.fn(async () => undefined)
  Object.defineProperty(window, 'workwise', { configurable: true, value: { extendTaskBudget, resumeTask } })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => root.render(createElement(TaskBudgetControl, { task, onChanged })))
  const click = () => act(async () => container.querySelector('button')!.click())
  return { container, extendTaskBudget, resumeTask, onChanged, click }
}

it('adds time in Chinese through the production API without resuming or exposing internal IDs', async () => {
  const { container, extendTaskBudget, resumeTask, onChanged, click } = await mount()
  expect(container.textContent).toContain('追加 10 分钟执行时间')
  await click()
  expect(extendTaskBudget).toHaveBeenCalledWith('root', expect.objectContaining({ expectedRevision: 4, additionalExecutionMs: 600_000 }))
  expect(container.textContent).toContain('任务仍暂停')
  expect(onChanged).toHaveBeenCalledOnce()
  expect(resumeTask).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('budget:')
})

it('reuses the exact request after a lost response, preventing duplicate extensions', async () => {
  const { extendTaskBudget, click } = await mount()
  extendTaskBudget.mockRejectedValueOnce(new Error('网络中断'))
  await click(); await click()
  expect(extendTaskBudget).toHaveBeenCalledTimes(2)
  expect(extendTaskBudget.mock.calls[0]).toEqual(extendTaskBudget.mock.calls[1])
})

it.each([{ status: 'running' }, { status: 'completed' }, { parentTaskId: 'parent' }, { retryOfTaskId: 'previous' }, { budget: { maxDurationMs: 1_800_000 } }])('hides budget mutation for ineligible tasks: %j', async overrides => {
  const { container } = await mount(overrides as Partial<TaskRunV1>)
  expect(container.querySelector('button')).toBeNull()
})

it('adds time to a failed root while preserving its failed state and requiring a separate Retry', async () => {
  const { container, extendTaskBudget, resumeTask, click } = await mount({ status: 'failed' })
  await click()
  expect(extendTaskBudget).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('任务仍失败')
  expect(container.textContent).toContain('重试')
  expect(resumeTask).not.toHaveBeenCalled()
})
