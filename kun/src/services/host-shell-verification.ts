import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { HostShellAuthorizationSchema } from '../contracts/permissions.js'
import type { OperationReceipt } from '../contracts/tasks.js'
import { pollBashSessionReadonly } from '../adapters/tool/builtin-bash-tool.js'
import { inspectProcess } from './process-identity.js'
import type { TaskRunRepository } from './task-run-repository.js'

export type HostShellReadback = {
  status: 'verified' | 'running' | 'failed' | 'outcome_unknown'
  verifiedAt: string
  exitCode?: number
  outputSha256?: string
  outputBytes?: number
  errorCode?: string
  message: string
}
export type HostShellVerificationResult = {
  taskId: string; receiptId: string; status: 'verified' | 'outcome_unknown' | 'running' | 'failed'; errorCode?: string; shell: HostShellReadback
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Resolves only an existing host command's process receipt. It cannot execute a command or prove an external business action. */
export class HostShellVerificationService {
  constructor(private readonly repository: TaskRunRepository, private readonly outputRoot: string, private readonly nowIso: () => string) {}

  handles(taskId: string, receiptId: string): boolean {
    return this.repository.operations(taskId, 'host_shell').some(receipt => receipt.id === receiptId)
  }

  async reconcile(taskId: string): Promise<void> {
    for (const receipt of this.repository.operations(taskId, 'host_shell')) {
      if (!['running', 'outcome_unknown'].includes(receipt.status)) continue
      const saved = object(receipt.result)
      const sessionId = saved.sessionId ?? object(object(saved.shell).output).session_id
      if (typeof sessionId !== 'string' || !this.repository.getShellSession(sessionId)) continue
      await this.readback(receipt)
    }
  }

  async verify(taskId: string, receiptId: string, input: { expectedRevision: number; idempotencyKey: string }): Promise<HostShellVerificationResult> {
    const key = `verify-host-shell:${receiptId}:${input.idempotencyKey}`
    const previous = this.repository.operation(taskId, key)
    if (previous && previous.request?.expectedRevision !== input.expectedRevision) throw Object.assign(new Error('核验键已用于其他任务版本。'), { code: 'idempotency_conflict' })
    if (previous?.result) return previous.result as HostShellVerificationResult
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error('任务不存在。'), { code: 'not_found' })
    if (task.revision !== input.expectedRevision) throw Object.assign(new Error('任务已更新，请刷新后核验。'), { code: 'stale_request' })
    const receipt = this.repository.operations(taskId, 'host_shell').find(value => value.id === receiptId)
    if (!receipt) throw Object.assign(new Error('主机命令回执不存在。'), { code: 'not_found' })
    this.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'host_shell_verification', request: { receiptId, expectedRevision: input.expectedRevision }, nowIso: this.nowIso() })
    const shell = await this.readback(receipt)
    const result: HostShellVerificationResult = { taskId, receiptId, status: shell.status, shell, ...(shell.errorCode ? { errorCode: shell.errorCode } : {}) }
    if (shell.status === 'running' || shell.status === 'outcome_unknown') {
      const current = this.repository.operation(taskId, receipt.idempotencyKey)!
      this.repository.finishOperation(taskId, receipt.idempotencyKey, { status: current.status, result: { ...object(current.result), verification: shell } }, this.nowIso())
    }
    this.repository.finishOperation(taskId, key, { status: shell.status === 'verified' ? 'succeeded' : 'failed', result }, this.nowIso())
    return result
  }

  private async readback(original: OperationReceipt): Promise<HostShellReadback> {
    const saved = object(original.result)
    const authority = HostShellAuthorizationSchema.safeParse(saved.authorization)
    const unknown = (errorCode: string, message: string): HostShellReadback => ({ status: 'outcome_unknown', errorCode, message, verifiedAt: this.nowIso() })
    if (!authority.success || authority.data.taskId !== original.ownerId || authority.data.requestHash !== original.request?.requestHash || authority.data.commandHash !== original.request?.commandHash) {
      return unknown('host_shell_authority_missing', '原命令缺少可核对的任务授权记录。')
    }
    const authorization = authority.data
    const approval = this.repository.humanRequest(authorization.approvalId)
    if (approval?.status !== 'answered' || object(approval.resolution).decision !== 'allow' || approval.threadId !== authorization.threadId || approval.turnId !== authorization.turnId) {
      return unknown('host_shell_approval_missing', '原命令缺少已确认的审批回执。')
    }
    const approvedCall = object(approval.payload.approval)
    if (approvedCall.toolName !== 'request_host_shell' || approvedCall.requestHash && approvedCall.requestHash !== authorization.requestHash) {
      return unknown('host_shell_approval_mismatch', '审批记录与原命令不一致，结果仍待核实。')
    }
    const sessionId = saved.sessionId ?? object(object(saved.shell).output).session_id
    if (typeof sessionId !== 'string') return unknown('host_shell_session_missing', '原命令未记录进程会话关联，当前无法确认其执行结果。')
    let session = this.repository.getShellSession(sessionId)
    const belongs = () => session?.taskId === authorization.taskId && session.executionId === authorization.executionId &&
      session.ownerId === authorization.ownerId && session.workspaceRoot === authorization.workspaceRoot
    if (!session || !belongs()) return unknown('host_shell_session_unconfirmed', '尚未找到属于原任务和授权的进程记录。')
    try { await pollBashSessionReadonly(sessionId) } catch {
      return unknown('host_shell_output_pending', '进程输出仍在保存，稍后可以再次核验。')
    }
    session = this.repository.getShellSession(sessionId)
    if (!session || !belongs()) return unknown('host_shell_session_unconfirmed', '原进程关联已变化，无法确认执行结果。')
    const processState = session.pid && session.processFingerprint ? inspectProcess({ pid: session.pid, fingerprint: session.processFingerprint }) : 'unknown'
    if (['starting', 'running'].includes(session.status) && processState === 'alive') return { status: 'running', verifiedAt: this.nowIso(), message: '原命令仍在运行，正在读取已有进程状态。', errorCode: 'host_shell_running' }
    if (!['completed', 'failed', 'terminated'].includes(session.status) || session.exitCode === undefined || !session.finishedAt || processState === 'alive') {
      return unknown('host_shell_exit_unknown', '已保留原进程和输出记录，但尚无明确退出码，结果仍待核实。')
    }
    let outputSha256: string
    let outputBytes: number
    try {
      const [root, path] = await Promise.all([realpath(this.outputRoot), realpath(session.outputPath)])
      const part = relative(root, path)
      if (!part || part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) return unknown('host_shell_output_scope', '输出路径不属于当前 Runtime 保存的命令记录。')
      const info = await stat(path)
      if (!info.isFile() || info.size !== session.outputBytes) return unknown('host_shell_output_unconfirmed', '输出文件与持久记录不一致，结果仍待核实。')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      outputSha256 = hash.digest('hex')
      outputBytes = info.size
    } catch { return unknown('host_shell_output_missing', '原命令的持久输出文件暂不可读，请保留任务后再次核验。') }
    const success = session.status === 'completed' && session.exitCode === 0
    const verification: HostShellReadback = { status: success ? 'verified' : 'failed', verifiedAt: this.nowIso(), exitCode: session.exitCode,
      outputSha256, outputBytes, message: success ? '原命令已确认成功退出。' : `原命令已结束，退出码为 ${session.exitCode}。`,
      ...(!success ? { errorCode: 'host_shell_failed_exit' } : {}) }
    const { code: _code, error: _error, message: _message, ...previousOutput } = object(object(saved.shell).output)
    const shellOutput = { ...previousOutput, session_id: sessionId, status: success ? 'completed' : 'failed', exit_code: session.exitCode,
      output_sha256: outputSha256, output_bytes: outputBytes, read_only_verification: true }
    if (object(saved.verification).outputSha256 === outputSha256 && object(saved.verification).status === verification.status) return verification
    this.repository.transact(() => {
      const receipt = this.repository.operation(original.ownerId, original.idempotencyKey)!
      const current = object(receipt.result)
      this.repository.finishOperation(original.ownerId, original.idempotencyKey, { status: success ? 'succeeded' : 'failed',
        result: { ...current, sessionId, shell: { output: shellOutput, isError: !success }, verification,
          originalOutcome: current.originalOutcome ?? { status: original.status, result: original.result } } }, this.nowIso())
      for (const tool of this.repository.operations(original.ownerId, 'tool')) {
        if (typeof approvedCall.callId !== 'string' || tool.request?.callId !== approvedCall.callId || tool.request?.toolName !== 'request_host_shell' ||
          tool.request?.approvalRequestHash !== authorization.requestHash || tool.request?.turnId !== authorization.turnId) continue
        const result = object(tool.result)
        const item = object(result.item)
        this.repository.finishOperation(original.ownerId, tool.idempotencyKey, { status: success ? 'succeeded' : 'failed',
          result: { ...result, approved: true, item: { ...item, kind: 'tool_result', toolName: 'request_host_shell', output: shellOutput, isError: !success }, verification,
            originalOutcome: result.originalOutcome ?? { status: tool.status, result: tool.result } } }, this.nowIso())
      }
      const task = this.repository.get(original.ownerId)
      if (task && ['stalled', 'waiting_user'].includes(task.status) && this.repository.unsettledOperations(task.id).length === 0) {
        this.repository.update(task.id, task.revision, currentTask => ({ ...currentTask, status: 'waiting_user', stalledReason: undefined,
          waitingReason: success ? '原命令结果已核实，可以继续原任务。' : verification.message, updatedAt: this.nowIso() }),
        { key: `host-shell-readback:${original.id}:${outputSha256}`, kind: 'host_shell_verified', payload: { receiptId: original.id, ...verification }, createdAt: this.nowIso() })
        const attention = this.repository.attention(`unknown_${task.id}`)
        if (attention) this.repository.putAttention({ ...attention, status: 'answered', revision: attention.revision + 1, updatedAt: this.nowIso() })
      }
    })
    return verification
  }
}

export function hostShellReceiptProjection(receipt: OperationReceipt) {
  const saved = object(receipt.result)
  const verification = object(saved.verification)
  const output = object(object(saved.shell).output)
  return { id: receipt.id, taskId: receipt.ownerId, purpose: 'host_shell' as const, provider: 'local', operation: 'host_shell', toolName: 'request_host_shell',
    requestHash: receipt.fingerprint, status: receipt.status, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
    shell: { canPoll: typeof (saved.sessionId ?? output.session_id) === 'string', ...(typeof output.exit_code === 'number' ? { exitCode: output.exit_code } : {}),
      ...(typeof verification.outputSha256 === 'string' ? { outputSha256: verification.outputSha256 } : {}),
      ...(typeof verification.message === 'string' ? { message: verification.message } : {}) } }
}
