import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TaskRun, OperationReceipt } from '../contracts/tasks.js'
import type { TaskRunRepository } from '../services/task-run-repository.js'

export type TaskDeliveryVerification = { complete: boolean; reasons: string[]; files: Array<{ path: string; format: string; sha256: string }> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function checkedHash(root: string, path: string, limit = 64 * 1024 * 1024): string {
  const canonicalRoot = realpathSync(root)
  const absolute = resolve(root, path)
  if (lstatSync(absolute).isSymbolicLink()) throw new Error('symbolic link cannot prove a delivered file')
  const target = realpathSync(absolute)
  const rel = relative(canonicalRoot, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('delivery path escapes its task workspace')
  const info = statSync(target)
  if (!info.isFile() || info.size > limit) throw new Error('delivery file is unavailable or too large')
  return createHash('sha256').update(readFileSync(target)).digest('hex')
}

/** Completion is evidence about persisted files, not the model's final sentence. */
export function verifyTaskDelivery(repository: TaskRunRepository, task: TaskRun): TaskDeliveryVerification {
  const result: TaskDeliveryVerification = { complete: true, reasons: [], files: [] }
  if (!task.templateId) return result
  const require = (test: boolean, reason: string): void => { if (!test) result.reasons.push(reason) }
  const operations = repository.operations(task.id)
  const allCandidates = operations.filter(item => item.kind === 'document_candidate' && item.status === 'succeeded')
  const superseded = new Set(allCandidates.map(item => record(item.result)).filter(item => typeof item.supersedesCandidatePath === 'string' && typeof item.supersedesCandidateHash === 'string').map(item => `${item.supersedesCandidatePath}\0${item.supersedesCandidateHash}`))
  const candidates = allCandidates.filter(item => { const value = record(item.result); return !superseded.has(`${value.path}\0${value.candidateHash}`) })
  require(candidates.length > 0, '尚未生成有持久回执的 Markdown 草稿')
  const verifySources = (receipt: OperationReceipt): void => {
    const sources = record(receipt.result).sources
    for (const source of Array.isArray(sources) ? sources : []) {
      const ref = record(source)
      if (typeof ref.path !== 'string' || typeof ref.sha256 !== 'string') { result.reasons.push('交付来源缺少路径或哈希'); continue }
      try { require(checkedHash(task.workspaceRoot, ref.path, 32 * 1024 * 1024) === ref.sha256, `来源已变化：${ref.path}`) }
      catch { result.reasons.push(`来源不可核验：${ref.path}`) }
    }
  }
  for (const candidate of candidates) {
    const value = record(candidate.result)
    if (typeof value.path !== 'string' || typeof value.candidateHash !== 'string') { result.reasons.push('候选草稿缺少路径或哈希'); continue }
    let valid = false
    try { valid = checkedHash(task.workspaceRoot, value.path, 8 * 1024 * 1024) === value.candidateHash } catch { /* recorded below */ }
    require(valid, `候选草稿已变化或不可读取：${value.path}`)
    verifySources(candidate)
    if (valid) result.files.push({ path: value.path, format: 'md', sha256: value.candidateHash })
    for (const format of ['docx', 'pdf']) {
      const receipt = operations.find(item => item.kind === 'document_export' && item.status === 'succeeded'
        && item.request?.format === format && item.request?.expectedHash === value.candidateHash
        && typeof item.request?.sourcePath === 'string' && resolve(task.workspaceRoot, String(item.request.sourcePath)) === resolve(task.workspaceRoot, value.path as string))
      const exported = record(receipt?.result)
      let exportValid = false
      if (exported.status === 'exported' && typeof exported.path === 'string' && typeof exported.sha256 === 'string') {
        try { exportValid = checkedHash(task.workspaceRoot, exported.path) === exported.sha256 } catch { /* recorded below */ }
      }
      require(exportValid, `${format.toUpperCase()} 尚未从当前草稿成功导出或文件不可核验：${value.path}`)
      if (exportValid) result.files.push({ path: String(exported.path), format, sha256: String(exported.sha256) })
    }
  }
  if (task.templateId === 'monitoring-report') {
    const analyses = operations.filter(item => item.kind === 'monitoring_delivery' && item.status === 'succeeded' && record(item.result).status === 'analyzed')
    require(analyses.length > 0, '监测资料尚未通过确定性校验、统计和图表工具')
    for (const analysis of analyses) {
      verifySources(analysis)
      const chart = record(record(analysis.result).chart)
      let valid = false
      if (typeof chart.relativePath === 'string' && typeof chart.sha256 === 'string') {
        try { valid = checkedHash(task.workspaceRoot, chart.relativePath) === chart.sha256 } catch { /* recorded below */ }
      }
      require(valid, '监测图表不可核验或已变化')
      if (valid) result.files.push({ path: String(chart.relativePath), format: 'svg', sha256: String(chart.sha256) })
    }
  }
  result.complete = result.reasons.length === 0
  return result
}
