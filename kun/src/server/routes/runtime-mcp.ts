import { McpConfigurationUpdateSchema } from '../../services/managed-mcp-runtime.js'
import type { Router } from '../router.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'

/** Main sends its saved configuration snapshot. Generic renderer forwarding rejects this route. */
export function registerRuntimeMcpRoutes(router: Router, runtime: ServerRuntime, authorized: (request: Request) => boolean): void {
  router.add('POST', '/v1/runtime/mcp-config', async request => {
    if (!authorized(request)) return ERRORS.unauthorized()
    if (!runtime.refreshMcpConfiguration) return ERRORS.unavailable('MCP configuration refresh is unavailable.')
    const body = await readJsonBody(request)
    if (!body.ok) return body.response
    const parsed = McpConfigurationUpdateSchema.safeParse(body.value)
    if (!parsed.success) return ERRORS.validation('Invalid MCP configuration snapshot.')
    try { return jsonResponse(await runtime.refreshMcpConfiguration(parsed.data)) }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'mcp_configuration_failed'
      // Never echo a configuration, URL query, environment value or SDK error here.
      return jsonResponse({ code, message: 'MCP 配置未能应用，请重新检查已保存的连接器配置。' }, 409)
    }
  })
}
