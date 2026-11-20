// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultScheduleSettings, mergeScheduleSettings, type AppSettingsPatch, type ScheduledTaskV1, type WorkWiseSettingsV2 } from '@shared/app-settings'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import i18n from '../../i18n'
import { newScheduledTask, ScheduleTasksView } from './ScheduleTasksView'

function task(id: string, changes: Partial<ScheduledTaskV1> = {}): ScheduledTaskV1 {
  return { ...newScheduledTask('/workspace'), id, title: `Plan ${id}`, prompt: 'Run the report.', ...changes }
}

function settings(revision: number, tasks: ScheduledTaskV1[]): WorkWiseSettingsV2 {
  return { revision, workspaceRoot: '/workspace', schedule: { ...defaultScheduleSettings(), enabled: true, tasks } } as WorkWiseSettingsV2
}

describe('scheduled task settings races', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(() => root.unmount())
    container.remove()
    rendererRuntimeClient.invalidateSettings()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows chat-created plans alongside legacy plans and manages them from one page', async () => {
    const plan = {
      id: 'schedule_task_chat', revision: 1, title: '每日网页报告', originThreadId: 'thr_chat',
      enabled: true, times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', nextRunAt: '2026-11-21T00:30:00Z'
    }
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: JSON.stringify({ schedules: [plan] }) })
      .mockResolvedValueOnce({ ok: true, body: JSON.stringify({ schedule: { ...plan, enabled: false, revision: 2 } }) })
      .mockResolvedValueOnce({ ok: true, body: JSON.stringify({ schedule: { ...plan, revision: 3 } }) })
    const onOpenThread = vi.fn()
    vi.stubGlobal('workwise', { getSettings: async () => settings(1, [task('legacy')]), runtimeRequest: request })
    await act(() => root.render(createElement(ScheduleTasksView, {
      leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), onOpenThread
    })))
    expect(container.textContent).toContain('Plan legacy')
    expect(container.textContent).toContain('每日网页报告')
    expect(container.textContent).toContain('08:30, 16:30')
    expect(container.textContent).toContain('Asia/Shanghai')

    const button = (key: string) =>
      Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === i18n.t(key))!
    await act(() => button('scheduleManagedOpenConversation').click())
    expect(onOpenThread).toHaveBeenCalledWith('thr_chat')
    await act(() => button('scheduleManagedPause').click())
    expect(request).toHaveBeenNthCalledWith(2, '/v1/task-schedules/schedule_task_chat', 'PATCH',
      JSON.stringify({ enabled: false, expectedRevision: 1 }))
    expect(container.textContent).toContain(i18n.t('scheduleManagedPaused'))
    await act(() => button('scheduleManagedResume').click())
    expect(request).toHaveBeenNthCalledWith(3, '/v1/task-schedules/schedule_task_chat', 'PATCH',
      JSON.stringify({ enabled: true, expectedRevision: 2 }))
    expect(container.textContent).toContain(i18n.t('scheduleManagedEnabled'))
  })

  it('gives a recoverable message if saved conversation plans cannot be read', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 503, body: '{}' })
    vi.stubGlobal('workwise', { getSettings: async () => settings(1, []), runtimeRequest: request })
    await act(() => root.render(createElement(ScheduleTasksView, {
      leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn()
    })))
    expect(container.textContent).toContain(i18n.t('scheduleManagedUnavailable'))
    expect(container.textContent).not.toContain(i18n.t('scheduleEmpty'))
  })

  it('ignores an older poll that completes after a later snapshot', async () => {
    let finishOldRead!: (value: WorkWiseSettingsV2) => void
    const oldRead = new Promise<WorkWiseSettingsV2>((resolve) => { finishOldRead = resolve })
    const getSettings = vi.fn()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValue(settings(2, [task('current', { lastStatus: 'success', lastMessage: 'Current result' })]))
    vi.stubGlobal('workwise', { getSettings })
    await act(() => root.render(createElement(ScheduleTasksView, { leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn() })))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(container.textContent).toContain('Current result')

    await act(() => finishOldRead(settings(1, [task('old', { lastStatus: 'running', lastMessage: 'Old attempt' })])))

    expect(container.textContent).toContain('Current result')
    expect(container.textContent).not.toContain('Old attempt')
  })

  it('rebuilds the plan edit on revision conflict while preserving results and siblings', async () => {
    const original = task('edited')
    const fresh = task('edited', { lastStatus: 'success', lastMessage: 'New report', lastThreadId: 'thr_new', nextRunAt: '2099-11-20T09:00:00Z' })
    const sibling = task('created-after-opening')
    let latest = settings(1, [original])
    const getSettings = vi.fn(async () => latest)
    const setSettings = vi.fn(async (patch: AppSettingsPatch, revision: number) => {
      if (revision !== latest.revision) throw new Error('revision conflict')
      latest = {
        ...latest,
        revision: latest.revision + 1,
        schedule: mergeScheduleSettings(latest.schedule, patch.schedule)
      }
      return latest
    })
    vi.stubGlobal('workwise', { getSettings, setSettings })
    await act(() => root.render(createElement(ScheduleTasksView, { leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn() })))
    const editLabel = i18n.t('scheduleEditTask')
    await act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${editLabel}"]`)!.click())
    const placeholder = i18n.t('scheduleTaskNamePlaceholder')
    const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Edited title')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await rendererRuntimeClient.getSettings()
    latest = settings(2, [fresh, sibling])

    await act(() => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())

    expect(setSettings.mock.calls.map(([, revision]) => revision)).toEqual([1, 2])
    expect(latest.schedule.tasks).toMatchObject([{ ...fresh, title: 'Edited title', updatedAt: expect.any(String) }, sibling])
    expect(container.textContent).toContain('New report')
  })

  it('leaves an expired one-time plan disabled when toggled', async () => {
    const expired = task('expired', { enabled: false, lastStatus: 'success', lastMessage: 'Prior report', schedule: {
      kind: 'at', atTime: '2026-01-01T09:00:00Z', everyMinutes: 60, timeOfDay: '09:00'
    } })
    const getSettings = vi.fn(async () => settings(3, [expired]))
    const setSettings = vi.fn()
    vi.stubGlobal('workwise', { getSettings, setSettings })
    await act(() => root.render(createElement(ScheduleTasksView, { leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn() })))
    const label = i18n.t('scheduleToggleTask', { title: expired.title })
    const toggle = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    await act(() => toggle.click())

    expect(setSettings).not.toHaveBeenCalled()
    expect(toggle.checked).toBe(false)
    expect(container.textContent).toContain(i18n.t('scheduleAtTimePast'))
    expect(container.textContent).toContain('Prior report')
  })
})
