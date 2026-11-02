import type { GuiUpdateInstallResult } from '@shared/gui-update'

type SaveHandler = () => boolean | Promise<boolean>
type SaveGuard = {
  /** Synchronous final validation, immediately before installer IPC dispatch. */
  isReady: () => boolean
  /** Freeze dirty mutations until installation fails or the application exits. */
  beginHandoff?: () => () => void
}

const saveHandlers = new Map<string, { save: SaveHandler; guard?: SaveGuard }>()

export function registerGuiUpdateSaveHandler(id: string, handler: SaveHandler, guard?: SaveGuard): () => void {
  const registration = { save: handler, guard }
  saveHandlers.set(id, registration)
  return () => {
    if (saveHandlers.get(id) === registration) saveHandlers.delete(id)
  }
}

export async function flushGuiUpdateEditors(): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = []
  for (const [id, handler] of saveHandlers) {
    try {
      if (await handler.save() === false) failed.push(id)
    } catch {
      failed.push(id)
    }
  }
  return { ok: failed.length === 0, failed }
}

export async function preflightAndInstallGuiUpdate(): Promise<GuiUpdateInstallResult> {
  const currentVersion = await window.workwise.getAppVersion().catch(() => '')
  const saved = await flushGuiUpdateEditors()
  if (!saved.ok) {
    return {
      ok: false,
      currentVersion,
      code: 'install_failed',
      message: `无法保存正在编辑的内容：${saved.failed.join('、')}。应用仍保持打开，请处理后重试。`
    }
  }
  const preflight = await window.workwise.preflightGuiUpdateInstall()
  if (!preflight.ok) {
    return {
      ok: false,
      currentVersion,
      code: 'install_failed',
      message: preflight.message ?? '无法检查正在运行的任务，应用仍保持打开。'
    }
  }
  if (preflight.activeWork.length > 0) {
    const list = preflight.activeWork
      .map((item) => `• ${item.kind.toUpperCase()} · ${item.label} (${item.status})${item.recoverable ? '' : ' · 不可恢复'}`)
      .join('\n')
    const confirmed = window.confirm(
      `以下工作仍在运行。重启会先建立可恢复检查点并停止运行时；不可恢复节点会被中止。\n\n${list}\n\n是否继续“重启并更新”？`
    )
    if (!confirmed) {
      return { ok: false, currentVersion, code: 'install_failed', message: '已取消更新，应用和任务保持运行。' }
    }
  }
  const release: Array<() => void> = []
  let handedOff = false
  try {
    const registrations = [...saveHandlers]
    const failed = registrations.filter(([, handler]) => handler.guard && !handler.guard.isReady()).map(([id]) => id)
    if (failed.length) return { ok: false, currentVersion, code: 'install_failed', message: `检查更新期间编辑内容已变化：${failed.join('、')}。应用仍保持打开，请保存后重试。` }
    for (const [, handler] of registrations) {
      const unlock = handler.guard?.beginHandoff?.()
      if (unlock) release.push(unlock)
    }
    // Prevent input handlers and editor shortcuts from creating a new draft in
    // the interval while main checkpoints runtimes and hands off the installer.
    const events = ['beforeinput', 'keydown', 'pointerdown', 'click', 'paste', 'cut', 'drop'] as const
    const blockInput = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
    for (const event of events) window.addEventListener?.(event, blockInput, { capture: true })
    release.push(() => { for (const event of events) window.removeEventListener?.(event, blockInput, { capture: true }) })
    // No await separates this last synchronous validation and the install IPC.
    if (registrations.some(([, handler]) => handler.guard && !handler.guard.isReady())) {
      return { ok: false, currentVersion, code: 'install_failed', message: '编辑内容已变化，应用仍保持打开，请保存后重试。' }
    }
    const result = await window.workwise.installGuiUpdate({ confirmActiveWork: preflight.activeWork.length > 0 })
    handedOff = result.ok
    return result
  } finally {
    // A successful handoff has already called quitAndInstall. Stay read-only
    // until process exit; any failure restores normal editing immediately.
    if (!handedOff) for (const unlock of release.reverse()) unlock()
  }
}
