import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { SurveyContextAccessError, type SurveyContextAccessStore } from '../../adapters/mcp/survey-context-access-store.js'
import { createSurveyContextMcpServer } from '../../adapters/mcp/survey-context-server.js'
import type { SurveyContextReadDependencies } from '../../adapters/mcp/survey-context-reader.js'
import { bearerToken, isAuthorized } from '../auth.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { Router } from '../router.js'

export type SurveyContextMcpHost = {
  access: SurveyContextAccessStore
  snapshot: SurveyContextReadDependencies['snapshot']
  projectExists: (projectId: string) => boolean
}
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const clientRequest = z.object({ label: z.string().trim().min(1).max(100).default('Survey read-only client') }).strict()
const emptyRequest = z.object({}).strict()
const identity = z.string().min(1).max(200)
const safeResponse = (code: string, status: number): JsonResponse => ({ ...jsonResponse({ code }, status),
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const reply = (value: unknown, status = 200): JsonResponse => ({ ...jsonResponse(value, status),
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Local host-controlled ingress, separate from outbound MCP client config.
 * The owner credential only administers clients; a newly issued scoped secret is
 * required for protocol reads. insecure mode must never bypass either boundary. */
export function registerSurveyContextMcpRoutes(router: Router, dependencies: {
  getHost: () => SurveyContextMcpHost | undefined
  runtimeToken: string
  secureLoopback: boolean
}): void {
  const boundary = (request: Request): JsonResponse | undefined => {
    if (!dependencies.secureLoopback || !dependencies.runtimeToken) return safeResponse('survey_context_host_unavailable', 503)
    const url = new URL(request.url)
    if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) return safeResponse('survey_context_origin_denied', 403)
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== url.origin) return safeResponse('survey_context_origin_denied', 403)
  }
  const base = '/v1/engineering/mcp/clients'
  const management = (method: string, path: string, action: (host: SurveyContextMcpHost, params: Record<string, string>, value: unknown) => JsonResponse): void => {
    router.add(method, base + path, async (request, context) => {
      const rejected = boundary(request)
      if (rejected) return rejected
      if (!isAuthorized(request.headers, dependencies.runtimeToken, false)) return safeResponse('unauthorized', 401)
      const host = dependencies.getHost()
      if (!host) return safeResponse('survey_context_host_unavailable', 503)
      if (Object.values(context.params).some(value => !identity.safeParse(value).success)) return safeResponse('survey_context_invalid_request', 400)
      let value: unknown = {}
      if (method === 'POST' || method === 'PUT') {
        const read = await boundedJson(request, 8 * 1024)
        if (!read.ok) return read.response
        value = read.value
      }
      try { return action(host, context.params, value) }
      catch (error) {
        if (error instanceof z.ZodError) return safeResponse('survey_context_invalid_request', 400)
        if (error instanceof SurveyContextAccessError) return safeResponse(`survey_context_access_${error.code}`, error.code === 'not-found' ? 404 : 429)
        return safeResponse('survey_context_host_unavailable', 503)
      }
    })
  }
  management('GET', '', host => reply(host.access.listClients()))
  management('POST', '', (host, _params, value) => reply(host.access.createClient(clientRequest.parse(value).label), 201))
  management('DELETE', '/:clientId', (host, params) => { host.access.revokeClient(params.clientId!); return reply({ revoked: true }) })
  management('PUT', '/:clientId/grants/:projectId', (host, params, value) => {
    emptyRequest.parse(value)
    if (host.projectExists(params.projectId!) !== true) return safeResponse('not_found', 404)
    host.access.setGrant(params.clientId!, params.projectId!, true)
    return reply({ projectId: params.projectId, access: 'read-only-summary' })
  })
  management('DELETE', '/:clientId/grants/:projectId', (host, params) => {
    // Revocation does not depend on the project still existing.
    host.access.setGrant(params.clientId!, params.projectId!, false)
    return reply({ projectId: params.projectId, revoked: true })
  })
  for (const method of ['GET', 'POST', 'DELETE']) router.add(method, '/v1/engineering/mcp/survey', async request => {
    const rejected = boundary(request)
    if (rejected) return rejected
    const host = dependencies.getHost()
    if (!host) return safeResponse('survey_context_host_unavailable', 503)
    let principalId: string | null
    try { principalId = host.access.resolvePrincipal(bearerToken(request.headers)) }
    catch { return safeResponse('survey_context_host_unavailable', 503) }
    if (!principalId) return safeResponse('unauthorized', 401)
    // Stateless JSON responses avoid open SSE channels and unbounded session
    // state. Every request authenticates again, including an existing SDK client.
    if (method !== 'POST') return safeResponse('method_not_allowed', 405)
    const read = await boundedJson(request, 32 * 1024)
    if (!read.ok) return read.response
    const server = createSurveyContextMcpServer({ principalId,
      canReadProject: (principal, projectId) => host.access.canReadProject(principal, projectId), snapshot: host.snapshot })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    try {
      await server.connect(transport)
      const response = await transport.handleRequest(request, { parsedBody: read.value })
      response.headers.set('cache-control', 'no-store')
      return response
    } catch { return safeResponse('survey_context_unavailable', 503) }
    finally { await server.close().catch(() => undefined) }
  })
}

async function boundedJson(request: Request, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; response: JsonResponse }> {
  const failed = (code: string, status: number) => ({ ok: false as const, response: safeResponse(code, status) })
  if (Number(request.headers.get('content-length')) > limit) return failed('payload_too_large', 413)
  if (!request.body) return { ok: true, value: {} }
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel().catch(() => undefined); return failed('payload_too_large', 413) }
      chunks.push(value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return { ok: true, value: text.length ? JSON.parse(text) : {} }
  } catch { return failed('survey_context_invalid_request', 400) }
  finally { reader.releaseLock() }
}
