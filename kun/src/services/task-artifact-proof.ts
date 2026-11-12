import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import type { Turn } from '../contracts/turns.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint } from './task-run-repository.js'

export type AuthorizedArtifactWrite = {
  absolutePath: string
  authorizedRoot: string
  executionGrantId: string
  turnId: string
  operationId: string
  sha256: string
}

export function containedArtifact(root: string, target: string): boolean {
  const from = process.platform === 'win32' ? root.toLowerCase() : root
  const to = process.platform === 'win32' ? target.toLowerCase() : target
  const path = relative(from, to)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Only successful file-changing receipts bound to the immutable Turn grant authorize external output. */
export async function authorizedArtifactWrites(task: TaskRun, receipts: OperationReceipt[], turns: Turn[]): Promise<Map<string, AuthorizedArtifactWrite>> {
  const writes = new Map<string, AuthorizedArtifactWrite>()
  for (const receipt of receipts) {
    if (receipt.ownerId !== task.id || receipt.kind !== 'tool' || receipt.status !== 'succeeded') continue
    const result = receipt.result as { approved?: boolean; item?: { kind?: string; status?: string; isError?: boolean; toolName?: string; toolKind?: string; turnId?: string; output?: unknown } } | undefined
    const item = result?.item
    if (result?.approved !== true || item?.kind !== 'tool_result' || item.status !== 'completed' || item.isError) continue
    if (!['write', 'edit', 'export_document', 'propose_document'].includes(item.toolName ?? '') || receipt.request?.toolName !== item.toolName) continue
    const parsed = ExecutionGrantSchema.safeParse(receipt.request?.executionGrant)
    if (!parsed.success) continue
    const grant = parsed.data
    if (grant.allowedToolNames && !grant.allowedToolNames.includes(item.toolName!)) continue
    const turn = turns.find(turn => turn.id === grant.turnId)
    if (grant.taskId !== task.id || grant.threadId !== task.threadId || grant.turnId !== item.turnId || receipt.request?.turnId !== grant.turnId
      || !turn?.executionGrant || operationFingerprint(turn.executionGrant) !== operationFingerprint(grant)) continue
    const output = item.output && typeof item.output === 'object' ? item.output as Record<string, unknown> : {}
    const records = [output, ...(Array.isArray(output.generatedFiles) ? output.generatedFiles : [])]
    for (const value of records) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      const path = record.path ?? record.absolutePath ?? record.relativePath ?? record.relative_path
      if (typeof path !== 'string' || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.sha256)) continue
      const target = await realpath(resolve(task.workspaceRoot, path)).catch(() => '')
      if (!target) continue
      for (const scope of grant.writePathAllowlist ?? []) {
        if (!isAbsolute(scope)) continue
        const root = await realpath(scope).catch(() => '')
        if (!root || !containedArtifact(root, target) || !containedArtifact(root, resolve(scope)) || !containedArtifact(resolve(scope), root)) continue
        writes.set(target, { absolutePath: target, authorizedRoot: root, executionGrantId: grant.id, turnId: grant.turnId, operationId: receipt.id, sha256: record.sha256.toLowerCase() })
        break
      }
    }
  }
  return writes
}
