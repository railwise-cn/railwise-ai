import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createSurveyContextReader, SurveyContextReadRequestSchema, type SurveyContextReadDependencies } from './survey-context-reader.js'

export type SurveyContextServerDependencies = {
  /** Authenticated identity supplied by the embedding host, never MCP clientInfo or arguments. */
  principalId?: string
  /** Resolve current project grants on every call; absent policy denies every project. */
  canReadProject?: (principalId: string, projectId: string) => boolean
  snapshot?: SurveyContextReadDependencies['snapshot']
}

const SAFE_ERRORS = new Set([
  'survey_context_invalid_request', 'survey_context_access_denied',
  'survey_context_unavailable', 'survey_context_project_mismatch',
  'survey_context_stale', 'survey_context_response_too_large'
])

/**
 * One server per authenticated host session. Embedders own authentication,
 * transport setup, lifecycle and project grants. No listener, process, token,
 * user MCP configuration or Runtime HTTP route is created by this factory.
 */
export function createSurveyContextMcpServer(deps: SurveyContextServerDependencies = {}): McpServer {
  const principalId = deps.principalId?.trim()
  const read = createSurveyContextReader({
    canReadProject: projectId => principalId ? deps.canReadProject?.(principalId, projectId) === true : false,
    snapshot: projectId => {
      if (!deps.snapshot) throw new Error('survey_context_unavailable')
      return deps.snapshot(projectId)
    }
  })
  const server = new McpServer({ name: 'railwise-survey-context', version: '1.0.0' })
  server.registerTool('survey_context_read', {
    description: 'Read a bounded metadata-only Survey summary for a host-authorized project. No raw observations, coordinates, paths, writes, exports or instrument control. Historical results are not proof of current source eligibility or verified deliverables.',
    inputSchema: SurveyContextReadRequestSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => {
    try {
      const result = read(args)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      }
    } catch (error) {
      // Host authorization failures and malformed storage must not leak paths,
      // credentials or implementation detail through SDK-generated tool errors.
      const code = error instanceof Error && SAFE_ERRORS.has(error.message)
        ? error.message : 'survey_context_unavailable'
      return { isError: true, content: [{ type: 'text' as const, text: code }] }
    }
  })
  return server
}
