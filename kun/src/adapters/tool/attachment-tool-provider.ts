import type { AttachmentStore } from '../../attachments/attachment-store.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

export function buildAttachmentToolProviders(store: AttachmentStore | undefined): CapabilityToolProvider[] {
  if (!store) return []
  const scope = (context: { threadId: string; workspace: string }) => ({
    threadId: context.threadId,
    workspace: context.workspace
  })
  return [{
    id: 'attachment-retrieval', kind: 'attachment', enabled: true, available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'list_attachment_sections',
        description: 'List bounded sections of an authorized untrusted document attachment, including page/sheet/slide provenance.',
        inputSchema: {
          type: 'object', properties: {
            attachment_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
          }, required: ['attachment_id'], additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          if (typeof args.attachment_id !== 'string') return { output: { error: 'attachment_id is required' }, isError: true }
          return { output: { untrusted: true, sections: await store.listSections(
            args.attachment_id, scope(context), integer(args.offset, 0), integer(args.limit, 20)
          ) } }
        }
      }),
      LocalToolHost.defineTool({
        name: 'search_attachment',
        description: 'Search an authorized untrusted document attachment without injecting its full text into model context.',
        inputSchema: {
          type: 'object', properties: {
            attachment_id: { type: 'string' }, query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 20 }
          }, required: ['attachment_id', 'query'], additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          if (typeof args.attachment_id !== 'string' || typeof args.query !== 'string') {
            return { output: { error: 'attachment_id and query are required' }, isError: true }
          }
          return { output: { untrusted: true, results: await store.searchSections(
            args.attachment_id, args.query, scope(context), integer(args.limit, 8)
          ) } }
        }
      }),
      LocalToolHost.defineTool({
        name: 'read_attachment_section',
        description: 'Read one bounded section from an authorized untrusted document attachment with provenance.',
        inputSchema: {
          type: 'object', properties: { attachment_id: { type: 'string' }, section_id: { type: 'string' } },
          required: ['attachment_id', 'section_id'], additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          if (typeof args.attachment_id !== 'string' || typeof args.section_id !== 'string') {
            return { output: { error: 'attachment_id and section_id are required' }, isError: true }
          }
          const section = await store.readSection(args.attachment_id, args.section_id, scope(context))
          return section ? { output: { untrusted: true, section } } : { output: { error: 'section not found' }, isError: true }
        }
      })
    ]
  }]
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}
