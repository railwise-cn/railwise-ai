/** Timeout reports an incomplete handoff without cancelling it or treating it as success. */
export function createGuiUpdateShutdown(stop: () => Promise<void>, timeoutMs = 30_000): () => Promise<void> {
  let stopping: Promise<void> | undefined
  let stopped = false
  return async () => {
    if (stopped) return
    if (!stopping) {
      stopping = Promise.resolve().then(stop).then(() => { stopped = true }, error => {
        stopping = undefined
        throw error
      })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stopping,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('应用仍在保存并停止运行，更新包已保留。请稍后重试升级。')), timeoutMs)
        })
      ])
    } finally { clearTimeout(timer) }
  }
}
