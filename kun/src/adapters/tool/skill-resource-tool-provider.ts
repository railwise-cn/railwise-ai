import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { SkillResourceScope, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PAGE_BYTES = 24 * 1024
const Input = z.object({
  skill_id: z.string().min(1).max(256).describe('The activated Skill ID shown in this turn’s instructions.'),
  path: z.string().min(1).max(512).describe('Relative resource path inside the activated Skill, such as references/pipeline.md.'),
  offset_bytes: z.number().int().min(0).max(MAX_FILE_BYTES).default(0)
    .describe('Use the previous response’s next_offset_bytes to continue reading.')
}).strict()

function pathParts(path: string): string[] {
  const parts = path.split(/[\\/]/)
  // eslint-disable-next-line no-control-regex
  if (path !== path.trim() || /[:\x00-\x1f\x7f]/.test(path) || parts.some(part => !part || part.startsWith('.') ||
    /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw resourceError('skill_resource_path', 'Use a relative file path inside the activated Skill, such as references/pipeline.md.')
  }
  return parts
}

function activeScopes(context: ToolHostContext): readonly SkillResourceScope[] {
  return context.activeSkillResources?.filter(scope => context.activeSkillIds?.includes(scope.skillId)) ?? []
}

function resourceError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function unavailable() {
  return resourceError('skill_resource_unavailable', 'The Skill resource is missing or its package or file identity changed.')
}

function identity(info: Stats, file: boolean): string {
  return [info.dev, info.ino, info.birthtimeMs, ...(file ? [info.size, info.mtimeMs, info.ctimeMs] : [])].join(':')
}

function isResourceFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && !info.isSymbolicLink()
}

async function readPathSnapshot(scope: SkillResourceScope, parts: string[]): Promise<string[]> {
  try {
    const root = await lstat(scope.root)
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== scope.device || root.ino !== scope.inode ||
      root.birthtimeMs !== scope.birthtimeMs || relative(scope.canonicalRoot, await realpath(scope.root)) !== '') {
      throw unavailable()
    }
    const result = [identity(root, false)]
    let path = scope.canonicalRoot
    for (const [index, part] of parts.entries()) {
      path = join(path, part)
      const info = await lstat(path)
      const file = index === parts.length - 1
      if ((file ? !isResourceFile(info) : !info.isDirectory() || info.isSymbolicLink()) ||
        relative(path, await realpath(path)) !== '') throw unavailable()
      result.push(identity(info, file))
    }
    return result
  } catch {
    throw unavailable()
  }
}

async function readPage(scope: SkillResourceScope, parts: string[], offset: number, signal: AbortSignal) {
  const before = await readPathSnapshot(scope, parts)
  const target = join(scope.canonicalRoot, ...parts)
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    .catch(() => { throw unavailable() })
  try {
    const file = await handle.stat()
    const fileIdentity = identity(file, true)
    if (!isResourceFile(file) || fileIdentity !== before.at(-1)) throw unavailable()
    if (file.size > MAX_FILE_BYTES) throw resourceError('skill_resource_size', 'This Skill resource exceeds the 8 MiB text file limit.')
    if (offset > file.size) throw resourceError('skill_resource_range', 'The requested offset exceeds the Skill resource size.')
    const bytes = Buffer.alloc(Math.min(file.size - offset, MAX_PAGE_BYTES + 1))
    let position = 0
    while (position < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, offset + position)
      if (bytesRead === 0) throw unavailable()
      position += bytesRead
    }
    const after = await readPathSnapshot(scope, parts)
    if (before.some((stamp, index) => stamp !== after[index]) || fileIdentity !== identity(await handle.stat(), true)) {
      throw unavailable()
    }
    let end = Math.min(bytes.length, MAX_PAGE_BYTES)
    // Keep the continuation offset on a UTF-8 character boundary.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    const page = bytes.subarray(0, end)
    try {
      if (page.includes(0)) throw new Error('NUL byte')
      return {
        content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(page),
        encoding: 'utf-8',
        byte_size: file.size,
        offset_bytes: offset,
        bytes_returned: page.length,
        next_offset_bytes: offset + page.length < file.size ? offset + page.length : null
      }
    } catch {
      throw resourceError('skill_resource_encoding', 'Use a UTF-8 text resource and a valid character offset.')
    }
  } finally {
    await handle.close()
  }
}

export function buildSkillResourceToolProvider(): CapabilityToolProvider {
  return {
    id: 'skill-resources',
    kind: 'skill',
    enabled: true,
    available: true,
    tools: [defineLocalTool({
      name: 'read_skill_resource',
      description: 'Read a bounded UTF-8 text file referenced by an activated Skill. Use its active Skill ID and a relative file path. This is read-only and carries no permission to run any referenced instructions, access another directory, or change files.',
      inputSchema: z.toJSONSchema(Input, { io: 'input' }),
      policy: 'auto',
      contextBlock: context => (context.executionGrant?.sandboxMode ?? context.sandboxMode) === 'external-sandbox'
        ? { code: 'sandbox_read_only', message: 'The external sandbox does not allow in-process Skill resource reads.' }
        : undefined,
      shouldAdvertise: context => activeScopes(context).length > 0,
      validateArguments: (args, context) => {
        const input = Input.parse(args)
        pathParts(input.path)
        if (!activeScopes(context).some(scope => scope.skillId === input.skill_id)) {
          throw resourceError('skill_resource_scope', 'Choose a Skill activated for this turn.')
        }
      },
      execute: async (args, context) => {
        const input = Input.parse(args)
        const scope = activeScopes(context).find(candidate => candidate.skillId === input.skill_id)
        if (!scope) throw resourceError('skill_resource_scope', 'Choose a Skill activated for this turn.')
        const page = await readPage(scope, pathParts(input.path), input.offset_bytes, context.abortSignal)
          .catch((error: unknown) => {
            context.abortSignal.throwIfAborted()
            if (error instanceof Error && (error as { code?: string }).code?.startsWith('skill_resource_')) throw error
            throw unavailable()
          })
        await context.validateExecutionGrant?.()
        context.abortSignal.throwIfAborted()
        context.assertExecution?.()
        return { output: { skill_id: input.skill_id, path: input.path, ...page } }
      }
    })]
  }
}
