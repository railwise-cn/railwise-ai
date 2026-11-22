export class RuntimeStartBlockedForShutdownError extends Error {
  constructor() { super('runtime_shutdown_in_progress') }
}

/** Inspect a settled local Runtime without starting it or connecting to a foreign process. */
export async function readGuiUpdateRuntimeOwnership(options: {
  pendingStarts: ReadonlyArray<Promise<unknown> | null>
  isOwnedChildRunning: () => boolean
  isConfiguredPortAvailable: () => Promise<boolean>
}): Promise<'owned' | 'idle'> {
  const hadOwnedChild = options.isOwnedChildRunning()
  const startupResults = await Promise.allSettled(options.pendingStarts)
  if (options.isOwnedChildRunning()) return 'owned'
  const startupUnconfirmed = startupResults.some(result => {
    if (result.status === 'fulfilled') return false
    const reason: unknown = result.reason
    return !(reason instanceof RuntimeStartBlockedForShutdownError ||
      (reason instanceof Error && reason.cause instanceof RuntimeStartBlockedForShutdownError))
  })
  if (hadOwnedChild || startupUnconfirmed) {
    throw new Error('正在启动或运行的任务服务未能确认就绪。请重新检查后升级。')
  }
  const available = await options.isConfiguredPortAvailable()
  if (options.isOwnedChildRunning()) return 'owned'
  if (!available) throw new Error('应用无法确认当前任务服务由本应用启动。请先退出使用该服务的程序，再尝试升级。')
  return 'idle'
}
