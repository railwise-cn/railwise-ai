import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { LocalTool } from './local-tool-host.js'
import { defineLocalTool } from './local-tool-definition.js'
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  firstChangedLine,
  generateDisplayDiff,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from './edit-diff.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import type { EditLocalToolOptions, WriteLocalToolOptions } from './builtin-tool-types.js'
import { defaultEditLocalToolOperations, defaultWriteLocalToolOperations } from './builtin-tool-operations.js'
import { parseEditInstructions, resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { assertCanWritePath } from './sandbox-policy.js'
import { atomicWriteFile } from '../file/atomic-write.js'

export function createWriteLocalTool(_options: WriteLocalToolOptions = {}): LocalTool {
  const mkdirOp = _options.operations?.mkdir ?? defaultWriteLocalToolOperations.mkdir!
  const writeFileOp = _options.operations?.writeFile
  return defineLocalTool({
    name: 'write',
    description: 'Create or overwrite a workspace file with the provided content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'file_change',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const content = typeof args.content === 'string' ? args.content : null
      if (!rawPath.trim() || content == null) {
        return { output: { error: 'path and content are required' }, isError: true }
      }
      const { absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context, 'write')
      assertCanWritePath(absolutePath, context)
      return withFileMutationQueue(absolutePath, async () => {
        await resolveWorkspacePath(rawPath, context, 'write')
        await _options.mutationLifecycle?.beforeMutation?.({
          absolutePath,
          relativePath,
          workspaceRoot: context.workspace,
          threadId: context.threadId,
          turnId: context.turnId
        })
        await mkdirOp(dirname(absolutePath))
        if (writeFileOp) {
          await writeFileOp(absolutePath, content)
        } else {
          await atomicWriteFile(absolutePath, content, {
            beforeReplace: async () => {
              await resolveWorkspacePath(rawPath, context, 'write')
            }
          })
        }
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            bytes_written: Buffer.byteLength(content, 'utf8'),
            sha256: createHash('sha256').update(content, 'utf8').digest('hex')
          }
        }
      })
    })
  })
}

export const createWriteTool = createWriteLocalTool
export const createWriteToolDefinition = createWriteLocalTool

export function createEditLocalTool(_options: EditLocalToolOptions = {}): LocalTool {
  const readFileOp = _options.operations?.readFile ?? defaultEditLocalToolOperations.readFile!
  const writeFileOp = _options.operations?.writeFile
  return defineLocalTool({
    name: 'edit',
    description: 'Edit a workspace file using exact text replacement. Supports multiple disjoint edits in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' }
            },
            required: ['oldText', 'newText'],
            additionalProperties: false
          }
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'file_change',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const edits = parseEditInstructions(args)
      if (!rawPath.trim() || edits.length === 0) {
        return { output: { error: 'path and at least one edit are required' }, isError: true }
      }
      const { absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      assertCanWritePath(absolutePath, context)
      return withFileMutationQueue(absolutePath, async () => {
        await resolveWorkspacePath(rawPath, context)
        await _options.mutationLifecycle?.beforeMutation?.({
          absolutePath,
          relativePath,
          workspaceRoot: context.workspace,
          threadId: context.threadId,
          turnId: context.turnId
        })
        const rawSource = await readFileOp(absolutePath)
        const { bom, text: source } = stripBom(rawSource)
        const lineEnding = detectLineEnding(source)
        const normalizedSource = normalizeToLF(source)
        const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedSource, edits, relativePath)
        const next = bom + restoreLineEndings(newContent, lineEnding)
        if (writeFileOp) {
          await writeFileOp(absolutePath, next)
        } else {
          await atomicWriteFile(absolutePath, next, {
            beforeReplace: async () => {
              await resolveWorkspacePath(rawPath, context)
            }
          })
        }
        const diff = generateDisplayDiff(baseContent, newContent)
        const patch = generateUnifiedPatch(relativePath, baseContent, newContent)
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            replacements: edits.length,
            bytes_written: Buffer.byteLength(next, 'utf8'),
            sha256: createHash('sha256').update(next, 'utf8').digest('hex'),
            diff,
            patch,
            first_changed_line: firstChangedLine(baseContent, newContent)
          }
        }
      })
    })
  })
}

export const createEditTool = createEditLocalTool
export const createEditToolDefinition = createEditLocalTool
