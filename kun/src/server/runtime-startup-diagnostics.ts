type RuntimeStartupPhase = 'usage-carryover' | 'mcp-connect' | 'skills' | 'attachment-cleanup'

/** Internal process logs only. Never include options, credentials, or error payloads. */
export async function traceRuntimeStartupPhase<T>(
  phase: RuntimeStartupPhase,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  console.info(`[runtime startup] ${phase} begin`)
  try {
    const result = await operation()
    console.info(`[runtime startup] ${phase} done elapsedMs=${Date.now() - startedAt}`)
    return result
  } catch (error) {
    console.info(`[runtime startup] ${phase} failed elapsedMs=${Date.now() - startedAt}`)
    throw error
  }
}
