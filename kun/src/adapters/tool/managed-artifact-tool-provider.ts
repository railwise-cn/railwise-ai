import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { prepareHtmlArtifact } from '../../services/html-artifact.js'
import type { TaskController } from '../../services/task-controller.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { atomicWriteFileLocked, serializeFileOperation } from '../file/atomic-write.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'
import { executionGrantBlock } from './sandbox-policy.js'

const Input = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(8 * 1024 * 1024)
}).strict()
const maxReadBytes = 3 * 8 * 1024 * 1024 + Buffer.byteLength(prepareHtmlArtifact(''))
const ReadInput = z.object({ path: z.string().min(1).max(240), offset_bytes: z.number().int().min(0).max(maxReadBytes).default(0), limit_bytes: z.number().int().min(4).max(256 * 1024).default(64 * 1024) }).strict()
const readError = (code: string, message: string) => Object.assign(new Error(message), { code })
const identity = (info: Stats, file = false) => [info.dev, info.ino, info.birthtimeMs, ...(file ? [info.size, info.mtimeMs, info.ctimeMs] : [])].join(':')
const formats = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.svg', '.csv'])

function inputPath(path: string): string[] {
  const parts = path.split('/')
  // eslint-disable-next-line no-control-regex
  if (path !== path.trim() || isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !formats.has(extname(path).toLowerCase())) {
    throw new Error('成果文件名必须是任务目录内的相对路径，支持 HTML、CSS、JS、JSON、TXT、Markdown、SVG 和 CSV。')
  }
  return parts
}

/** The model never chooses the physical output root or obtains general dataDir access. */
export function buildManagedArtifactToolProviders(tasks: Pick<TaskController, 'managedArtifactRoot' | 'getTask'>): CapabilityToolProvider[] {
  function rootFor(context: ToolHostContext): string {
    const grant = context.executionGrant
    const expected = grant?.taskId ? tasks.managedArtifactRoot(grant.taskId) : undefined
    if (!expected || grant?.managedArtifactRoot !== expected || grant.turnId !== context.turnId || grant.threadId !== context.threadId) {
      throw Object.assign(new Error('当前执行没有对应的任务成果目录。'), { code: 'execution_grant_scope' })
    }
    return expected
  }

  async function validateRead(context: ToolHostContext): Promise<string> {
    await context.validateExecutionGrant?.()
    context.abortSignal.throwIfAborted()
    context.assertExecution?.()
    const block = executionGrantBlock(context)
    if (block) throw readError(block.code, block.message)
    const root = rootFor(context), task = tasks.getTask(context.executionGrant!.taskId!)
    if (!task || task.threadId !== context.threadId || task.activeTurnId !== context.turnId || task.status !== 'running') {
      throw readError('execution_grant_scope', '当前成果读取不属于正在执行的任务轮次。')
    }
    return root
  }

  /** Read-only traversal: missing directories stay missing; no path creates authority. */
  async function readSnapshot(root: string, parts: string[]): Promise<string[]> {
    const base = dirname(dirname(root)), paths = [base, join(base, 'task-artifacts'), root]
    for (let index = 1; index <= parts.length; index++) paths.push(join(root, ...parts.slice(0, index)))
    const snapshot: string[] = []
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!, file = index === paths.length - 1, info = await lstat(path)
      if (info.isSymbolicLink() || (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) || await realpath(path) !== resolve(path)) {
        throw readError('artifact_read_blocked', '成果读取路径包含链接、替换目录或非普通文件。')
      }
      snapshot.push(identity(info, file))
    }
    return snapshot
  }

  return [{ id: 'managed-artifacts', kind: 'built-in', enabled: true, available: true, tools: [defineLocalTool({
    name: 'publish_artifact',
    description: 'Save a real deliverable in this task’s application-managed output directory, including HTML webpages and their local CSS/JS/SVG assets. Available with a read-only user workspace. Pass a relative filename and complete content. When read_artifact is available, use it to inspect the exact saved bytes with the same relative filename; generic read remains workspace-scoped and cannot read this application-managed directory. HTML deliverables appear in the built-in preview after verification. This does not save to a user-selected workspace path. For reports include a title, collection time, source coverage, verified facts, original source links and unresolved fields. Use UTF-8, responsive layout and local resources. HTML without author styles receives an offline Chinese report stylesheet. Cite only observed sources and label partial coverage.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative filename, e.g. report.html or assets/chart.svg.' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    toolKind: 'file_change', policy: 'auto',
    shouldAdvertise: context => Boolean(context.executionGrant?.managedArtifactRoot),
    validateArguments: (args, context) => { const input = Input.parse(args); inputPath(input.path); rootFor(context) },
    execute: async (args, context) => {
      const input = Input.parse(args)
      const parts = inputPath(input.path)
      const content = /\.html?$/i.test(input.path) ? prepareHtmlArtifact(input.content) : input.content
      const root = rootFor(context)
      const target = join(root, ...parts)
      const verify = async (): Promise<void> => {
        await context.validateExecutionGrant?.()
        if (context.abortSignal.aborted) throw new Error('成果保存已取消。')
        rootFor(context)
        // Check each managed directory before traversing or creating its child.
        const base = dirname(dirname(root))
        if (await realpath(base) !== resolve(base)) throw new Error('任务成果存储位置已变化。')
        let directory = base
        for (const part of ['task-artifacts', root.split(/[\\/]/).at(-1)!, ...parts.slice(0, -1)]) {
          directory = join(directory, part)
          await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
          const info = await lstat(directory)
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('任务成果目录包含链接或已被替换。')
        }
        const existing = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('成果目标必须是普通文件。')
      }
      return serializeFileOperation(target, async () => {
        await verify()
        await atomicWriteFileLocked(target, content, { beforeReplace: verify })
        return { output: { path: target, name: input.path, storage: 'task', bytes_written: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), read_artifact: { path: input.path } } }
      })
    }
  }), defineLocalTool({
    name: 'read_artifact',
    description: 'Read the exact UTF-8 bytes of this active task’s own application-managed artifact, including HTML and local text assets saved by publish_artifact. Use the same relative filename, never its physical output path or generic read. Works with a read-only user workspace without enlarging workspace permissions. Returns bounded content, complete file byte_size/sha256 and byte paging metadata; continue with next_offset_bytes until truncated=false. This tool only reads existing files and never creates directories, republishes, executes HTML or accesses another task’s artifacts.',
    inputSchema: z.toJSONSchema(ReadInput) as Record<string, unknown>, policy: 'auto',
    shouldAdvertise: context => Boolean(context.executionGrant?.managedArtifactRoot),
    validateArguments: (args, context) => { const input = ReadInput.parse(args); inputPath(input.path); rootFor(context) },
    execute: async (args, context) => {
      const input = ReadInput.parse(args), parts = inputPath(input.path), root = await validateRead(context), target = join(root, ...parts)
      return serializeFileOperation(target, async () => {
        const before = await readSnapshot(root, parts)
        await validateRead(context)
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.nlink !== 1 || identity(info, true) !== before.at(-1)) throw readError('artifact_read_changed', '成果文件在读取前发生变化。')
          if (info.size > maxReadBytes) throw readError('artifact_read_too_large', '成果文件超过受管理发布内容的最大读取字节数。')
          const bytes = Buffer.alloc(info.size)
          let offset = 0
          while (offset < bytes.length) {
            context.abortSignal.throwIfAborted()
            const result = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset)
            if (!result.bytesRead) break
            offset += result.bytesRead
          }
          await validateRead(context)
          const after = await readSnapshot(root, parts), final = await handle.stat()
          if (offset !== bytes.length || JSON.stringify(before) !== JSON.stringify(after) || identity(final, true) !== identity(info, true)) throw readError('artifact_read_changed', '成果文件或目录在读取期间发生变化，请重新核对。')
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw readError('artifact_read_encoding', '成果文件不是有效的 UTF-8 文本。') }
          const start = input.offset_bytes
          if (start > bytes.length || start < bytes.length && (bytes[start]! & 0xc0) === 0x80) throw readError('artifact_read_range', '读取偏移必须是文件内的 UTF-8 字符边界。')
          let end = Math.min(bytes.length, start + input.limit_bytes)
          while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
          const selected = bytes.subarray(start, end)
          await validateRead(context)
          return { output: { name: input.path, storage: 'task', content: selected.toString('utf8'), encoding: 'utf-8', byte_size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), offset_bytes: start, bytes_returned: selected.length,
            truncated: end < bytes.length, next_offset_bytes: end < bytes.length ? end : null } }
        } finally { await handle.close() }
      })
    }
  })] }]
}
