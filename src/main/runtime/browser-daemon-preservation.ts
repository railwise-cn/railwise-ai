import Database from 'better-sqlite3'
import { OperationReceiptSchema, TaskRunSchema } from '../../../kun/src/contracts/tasks'
import { operationFingerprint } from '../../../kun/src/services/task-run-repository'

export type BrowserDaemonPreservation = {
  preserveDaemon: boolean
  reason: 'clear' | 'runtime_exit_unconfirmed' | 'unsettled_browser_action' | 'unverified_history' | 'database_unavailable'
}

const pending = new Set(['prepared', 'running', 'outcome_unknown'])
const browserWrites = new Set(['browser_fill', 'browser_click', 'browser_press'])

/** Read the complete journal only after Runtime exit. This reader never migrates or writes its database. */
export function browserDaemonPreservation(databasePath: string, runtimeStopped: boolean): BrowserDaemonPreservation {
  if (!runtimeStopped) return { preserveDaemon: true, reason: 'runtime_exit_unconfirmed' }
  let database: Database.Database | undefined
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1000 })
    const db = database
    return db.transaction((): BrowserDaemonPreservation => {
      const taskById = db.prepare('SELECT id, status, data_json FROM task_runs WHERE id = ?')
      const proofById = db.prepare("SELECT idempotency_key, data_json FROM operation_receipts WHERE owner_id = ? AND json_extract(data_json, '$.id') = ?")
      for (const row of db.prepare('SELECT owner_id, idempotency_key, data_json FROM operation_receipts').iterate() as Iterable<{ owner_id: string; idempotency_key: string; data_json: string }>) {
        const parsed = OperationReceiptSchema.safeParse(JSON.parse(row.data_json))
        if (!parsed.success || parsed.data.ownerId !== row.owner_id || parsed.data.idempotencyKey !== row.idempotency_key) {
          return { preserveDaemon: true, reason: 'unverified_history' }
        }
        const receipt = parsed.data
        const toolName = String(receipt.request?.toolName ?? receipt.toolName ?? '')
        const relevant = receipt.kind === 'browser_action_dispatch' || receipt.kind === 'browser_schedule_action_outcome' ||
          receipt.kind === 'tool' && browserWrites.has(toolName)
        if (!relevant || !pending.has(receipt.status) ||
          receipt.kind === 'tool' && receipt.status === 'prepared' && receipt.request?.dispatchTracking === 'host-v1') continue
        const taskRow = taskById.get(receipt.ownerId) as { id: string; status: string; data_json: string } | undefined
        const task = taskRow ? TaskRunSchema.safeParse(JSON.parse(taskRow.data_json)) : undefined
        if (!task?.success || task.data.id !== taskRow?.id || task.data.status !== taskRow?.status) {
          return { preserveDaemon: true, reason: 'unverified_history' }
        }
        if (task.data.status === 'cancelled') continue
        if (receipt.fingerprint !== operationFingerprint(receipt.request ?? {})) return { preserveDaemon: true, reason: 'unverified_history' }
        const resolution = receipt.resolution
        const proofRow = resolution ? proofById.get(receipt.ownerId, resolution.receiptId) as { idempotency_key: string; data_json: string } | undefined : undefined
        const proof = proofRow ? OperationReceiptSchema.parse(JSON.parse(proofRow.data_json)) : undefined
        const evidence = (proof?.result as { evidence?: unknown } | undefined)?.evidence
        const verified = proof?.ownerId === receipt.ownerId && proof.kind === 'effect_verification' && proof.idempotencyKey === proofRow?.idempotency_key && proof.status === 'succeeded' &&
          proof.fingerprint === operationFingerprint(proof.request ?? {}) &&
          proof.request?.originalReceiptId === receipt.id && proof.request?.originalFingerprint === receipt.fingerprint &&
          evidence !== undefined && resolution?.evidence.verified === true && operationFingerprint(evidence) === operationFingerprint(resolution.evidence)
        if (!verified) return { preserveDaemon: true, reason: 'unsettled_browser_action' }
      }
      return { preserveDaemon: false, reason: 'clear' }
    })()
  } catch {
    return { preserveDaemon: true, reason: 'database_unavailable' }
  } finally { database?.close() }
}

/** A timeout is a separate outcome from confirmed Runtime exit. */
export async function disposeBrowserAfterRuntimeStop(options: {
  runtimeStopped: boolean
  databasePath: () => Promise<string>
  dispose: (options: { preserveDaemon: boolean }) => Promise<void>
}): Promise<BrowserDaemonPreservation> {
  let result: BrowserDaemonPreservation = { preserveDaemon: true, reason: 'runtime_exit_unconfirmed' }
  if (options.runtimeStopped) {
    try { result = browserDaemonPreservation(await options.databasePath(), true) }
    catch { result = { preserveDaemon: true, reason: 'database_unavailable' } }
  }
  await options.dispose({ preserveDaemon: result.preserveDaemon })
  return result
}
