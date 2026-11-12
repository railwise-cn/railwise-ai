import { createHash } from 'node:crypto'

export type UpdateActiveWork = {
  kind: 'agent' | 'flow' | 'schedule'
  id: string
  label: string
  status: string
  recoverable: boolean
}

export type UpdateSnapshot = { ok: true; activeWork: UpdateActiveWork[]; snapshotId: string }

/** The update fence lives in the Runtime, so HTTP, schedules and child work share it. */
export class RuntimeUpdateLifecycle {
  private suspended = false
  private preparation?: Promise<void>

  constructor(private readonly dependencies: {
    snapshot: () => UpdateActiveWork[]
    suspend: () => Promise<void>
    resume: () => void
    stop: () => Promise<void>
    timeoutMs?: number
  }) {}

  isSuspended(): boolean { return this.suspended }

  snapshot(): UpdateSnapshot {
    const activeWork = this.dependencies.snapshot().sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
    const snapshotId = createHash('sha256').update(JSON.stringify(activeWork)).digest('hex')
    return { ok: true, activeWork, snapshotId }
  }

  async prepare(confirmedSnapshotId?: string): Promise<UpdateSnapshot> {
    if (!this.preparation) {
      this.suspended = true
      this.preparation = (async () => {
        await this.dependencies.suspend()
        const current = this.snapshot()
        const unsafe = current.activeWork.filter(item => !item.recoverable)
        if (unsafe.length || (current.activeWork.length && current.snapshotId !== confirmedSnapshotId)) {
          this.dependencies.resume()
          this.suspended = false
          this.preparation = undefined
          if (unsafe.length) throw new Error(`以下工作暂时无法安全暂停，请等待结束后重试升级：${unsafe.map(item => item.label).join('、')}。更新包已保留。`)
          throw new Error('运行任务已变化，请重新检查并确认后升级。')
        }
        await this.dependencies.stop()
      })().catch(error => {
        this.preparation = undefined
        throw error
      })
    }
    // Keep the fence and the same promise on timeout. A retry observes this
    // handoff instead of starting another cancellation or replaying work.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.preparation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('运行任务仍在安全停止中。更新包已保留，请稍后重试升级。')), this.dependencies.timeoutMs ?? 30_000)
        })
      ])
      return this.snapshot()
    } finally { clearTimeout(timer) }
  }
}
