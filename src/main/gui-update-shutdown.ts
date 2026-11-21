/** Timeout reports an incomplete handoff without cancelling it or treating it as success. */
export function createGuiUpdateShutdown(stop: () => Promise<void>, timeoutMs = 30_000) {
  let stopping: Promise<void> | undefined
  let stopped = false
  let recovering: Promise<void> | undefined
  const shutdown = async () => {
    if (stopped) return
    if (!stopping) {
      stopping = Promise.resolve().then(stop).then(() => { stopped = true }, error => {
        stopping = undefined
        throw error
      })
    }
    await untilDeadline(stopping, timeoutMs, new Error('应用仍在保存并停止运行，更新包已保留。请稍后重试升级。'))
  }
  return Object.assign(shutdown, {
    isRecovering: () => recovering !== undefined,
    async recover(resume: () => Promise<void>, recoveryTimeoutMs = 5_000): Promise<void> {
      if (!recovering) {
        // The UI deadline does not cancel the owned process shutdown underneath it.
        recovering = (async () => {
          await stopping?.catch(() => undefined)
          await resume()
          stopped = false
          stopping = undefined
        })().finally(() => { recovering = undefined })
      }
      await untilDeadline(recovering, recoveryTimeoutMs, new GuiUpdateRecoveryPendingError())
    }
  })
}

export class GuiUpdateRecoveryPendingError extends Error {
  constructor() { super('任务服务仍在恢复，请稍候。') }
}

async function untilDeadline(operation: Promise<void>, timeoutMs: number, timeoutError: Error): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
}
