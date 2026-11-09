import { RUNTIME_RESOURCE_LIMITS_V1 } from '../contracts/resource-limits.js'
export type CapacityRequest = { id: string; rootTaskId?: string; serialRoot?: boolean; workspaceRoot?: string; resources: { model?: number; worker?: number; shell?: number } }
export type CapacityPermit = { release(): void }
/** One owner for all runnable model/worker/process reservations. No permit is held while queued. */
export class CapacityManager {
  private readonly reservations = new Map<string, CapacityRequest>()
  private readonly waiters = new Set<() => void>()
  constructor(private readonly limits = { model: 4, worker: 4, shell: RUNTIME_RESOURCE_LIMITS_V1.processesApplication, workspaceShell: RUNTIME_RESOURCE_LIMITS_V1.processesPerWorkspace }) {}
  reserve(request: CapacityRequest): CapacityPermit {
    if (this.reservations.has(request.id)) throw Object.assign(new Error('capacity reservation already exists'), { code: 'capacity_conflict' })
    // A finite cost budget belongs to the root. Serialize its model requests
    // so concurrent children cannot each spend the same remaining allowance.
    if (request.serialRoot && request.rootTaskId && (request.resources.model ?? 0) > 0 && [...this.reservations.values()].some(item => item.rootTaskId === request.rootTaskId && (item.resources.model ?? 0) > 0)) throw Object.assign(new Error('root model budget is currently reserved'), { code: 'resource_limit' })
    for (const key of ['model', 'worker', 'shell'] as const) {
      const used = [...this.reservations.values()].reduce((sum, item) => sum + (item.resources[key] ?? 0), 0)
      if (used + (request.resources[key] ?? 0) > this.limits[key]) throw Object.assign(new Error(`application ${key} capacity exhausted`), { code: 'resource_limit' })
    }
    const workspaceShell = [...this.reservations.values()].filter(item => item.workspaceRoot === request.workspaceRoot).reduce((sum, item) => sum + (item.resources.shell ?? 0), 0)
    if (workspaceShell + (request.resources.shell ?? 0) > this.limits.workspaceShell) throw Object.assign(new Error('workspace process capacity exhausted'), { code: 'resource_limit' })
    this.reservations.set(request.id, request)
    let released = false
    return { release: () => { if (released) return; released = true; this.reservations.delete(request.id); for (const notify of [...this.waiters]) notify() } }
  }
  acquire(request: CapacityRequest, signal?: AbortSignal): Promise<CapacityPermit> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiters.delete(attempt); reject(signal?.reason ?? new Error('operation cancelled')) }
      const attempt = () => {
        if (signal?.aborted) return abort()
        try { const permit = this.reserve(request); this.waiters.delete(attempt); signal?.removeEventListener('abort', abort); resolve(permit) }
        catch (error) { if ((error as { code?: string }).code !== 'resource_limit') { signal?.removeEventListener('abort', abort); reject(error) } else this.waiters.add(attempt) }
      }
      signal?.addEventListener('abort', abort, { once: true }); attempt()
    })
  }
  snapshot(): CapacityRequest[] { return [...this.reservations.values()] }
}
