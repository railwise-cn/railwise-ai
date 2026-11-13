import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { prepareHtmlArtifact } from '../../services/html-artifact.js'
import type { TaskController } from '../../services/task-controller.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { atomicWriteFileLocked, serializeFileOperation } from '../file/atomic-write.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'

const Input = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(8 * 1024 * 1024)
}).strict()
const formats = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.svg', '.csv'])

function inputPath(path: string): string[] {
  const parts = path.split('/')
  // eslint-disable-next-line no-control-regex
  if (isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !formats.has(extname(path).toLowerCase())) {
    throw new Error('成果文件名必须是任务目录内的相对路径，支持 HTML、CSS、JS、JSON、TXT、Markdown、SVG 和 CSV。')
  }
  return parts
}

/** The model never chooses the physical output root or obtains general dataDir access. */
export function buildManagedArtifactToolProviders(tasks: Pick<TaskController, 'managedArtifactRoot'>): CapabilityToolProvider[] {
  function rootFor(context: ToolHostContext): string {
    const grant = context.executionGrant
    const expected = grant?.taskId ? tasks.managedArtifactRoot(grant.taskId) : undefined
    if (!expected || grant?.managedArtifactRoot !== expected || grant.turnId !== context.turnId || grant.threadId !== context.threadId) {
      throw Object.assign(new Error('当前执行没有对应的任务成果目录。'), { code: 'execution_grant_scope' })
    }
    return expected
  }

  return [{ id: 'managed-artifacts', kind: 'built-in', enabled: true, available: true, tools: [defineLocalTool({
    name: 'publish_artifact',
    description: 'Save a real deliverable in this task’s application-managed output directory, including HTML webpages and their local CSS/JS/SVG assets. Available with a read-only user workspace. Pass a relative filename and complete content. HTML deliverables appear in the built-in preview after verification. This does not save to a user-selected workspace path. For reports include a title, collection time, source coverage, verified facts, original source links and unresolved fields. Use UTF-8, responsive layout and local resources. HTML without author styles receives an offline Chinese report stylesheet. Cite only observed sources and label partial coverage.',
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
        return { output: { path: target, name: input.path, storage: 'task', bytes_written: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } }
      })
    }
  })] }]
}
