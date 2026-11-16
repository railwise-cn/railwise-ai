/** Cleanup failure must never skip stopping the process owned by this app. */
export async function stopRuntimeAfterCleanup(options: {
  cleanup: () => Promise<void>
  stopRuntime: () => Promise<void>
  isRuntimeRunning: () => boolean
}): Promise<void> {
  const errors: unknown[] = []
  try { await options.cleanup() } catch (error) { errors.push(error) }
  try {
    await options.stopRuntime()
    if (options.isRuntimeRunning()) throw new Error('Runtime process exit could not be confirmed.')
  } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Application cleanup and Runtime shutdown did not complete.')
}

/** Repeated Electron quit events share one attempt. Failure keeps the app alive. */
export function createConfirmedQuit(options: {
  stop: () => Promise<void>
  quit: () => void
  onFailure: (error: unknown) => void
}): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(options.stop).then(() => {
        options.quit()
        return true
      }, error => {
        options.onFailure(error)
        return false
      }).finally(() => { pending = undefined })
    }
    return pending
  }
}
