import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { createKunServeRuntime, startKunServe, type KunServeHandle } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'

const ownerToken = 'local-owner-for-transport-test'
const accessPath = '/v1/engineering/mcp/clients'
const endpointPath = '/v1/engineering/mcp/survey'
const optionsFor = (dataDir: string, insecure = false) => ({
  host: '127.0.0.1', port: 0, dataDir, runtimeToken: ownerToken, apiKey: 'unused',
  baseUrl: 'http://127.0.0.1:9', model: 'deepseek-v4-pro', approvalPolicy: 'on-request' as const,
  sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure,
  storage: { backend: 'file' as const }
})
const originFor = (handle: KunServeHandle) => `http://127.0.0.1:${handle.port}`
async function send(handle: KunServeHandle, path: string, method = 'GET', token = ownerToken, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(originFor(handle) + path, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
}
async function createClient(handle: KunServeHandle) {
  const response = await send(handle, accessPath, 'POST', ownerToken, { label: 'External review tool' })
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return await response.json() as { clientId: string; token: string }
}
async function connect(handle: KunServeHandle, token: string) {
  // This declaration must never become the authenticated identity.
  const client = new Client({ name: 'owner-principal', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(originFor(handle) + endpointPath), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  }))
  return client
}
const read = (client: Client, projectId: string) => client.callTool({ name: 'survey_context_read', arguments: { projectId } })
// Node/Electron fetch may replace forbidden Host headers. Use the actual Node
// HTTP socket API here so the server observes a hostile DNS-rebinding header.
function sendHostOverride(handle: KunServeHandle, token: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(originFor(handle) + endpointPath, { method: 'POST', headers: {
      host: 'attacker.example', authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)) })
    request.once('error', reject)
    request.end(JSON.stringify(body))
  })
}

describe('Survey MCP authenticated host over real loopback TCP', () => {
  it('persists scoped grants across runtime restart, applies revocation to a connected client, and keeps credentials private', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'survey-mcp-http-'))
    let handle: KunServeHandle | undefined, client: Client | undefined
    try {
      handle = await startKunServe(optionsFor(dataDir))
      const engineering = handle.runtime.engineeringService!
      const project = engineering.createProject({ name: 'PRIVATE_PROJECT_NAME', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'project-a' })
      const other = engineering.createProject({ name: 'PRIVATE_OTHER_NAME', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'project-b' })
      const created = await createClient(handle)
      client = await connect(handle, created.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['survey_context_read'])
      expect(await read(client, project.id)).toMatchObject({ isError: true, content: [{ text: 'survey_context_access_denied' }] })
      const grantPath = `${accessPath}/${created.clientId}/grants/${project.id}`
      expect((await send(handle, grantPath, 'PUT', ownerToken, {})).status).toBe(200)
      const result = await read(client, project.id)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ projectId: project.id, projectRevision: 1, networks: [], adjustments: [],
        access: 'read-only-summary', verification: 'context-metadata-only', untrusted: true })
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect((await read(client, other.id)).isError).toBe(true)
      const listing = await (await send(handle, accessPath)).json()
      expect(JSON.stringify(listing)).not.toContain(created.token)
      expect(listing).toMatchObject({ clients: [{ clientId: created.clientId, grants: [project.id] }] })
      const database = join(dataDir, 'engineering', 'mcp-access', 'survey-context-access.sqlite3')
      expect((await readFile(database)).includes(Buffer.from(created.token))).toBe(false)
      if (process.platform !== 'win32') expect((await stat(database)).mode & 0o777).toBe(0o600)
      await client.close(); client = undefined
      await handle.close(); handle = undefined
      handle = await startKunServe(optionsFor(dataDir))
      client = await connect(handle, created.token)
      expect((await read(client, project.id)).isError).not.toBe(true)
      expect((await send(handle, grantPath, 'DELETE')).status).toBe(200)
      expect(await read(client, project.id)).toMatchObject({ isError: true, content: [{ text: 'survey_context_access_denied' }] })
      expect((await send(handle, grantPath, 'PUT', ownerToken, {})).status).toBe(200)
      expect((await read(client, project.id)).isError).not.toBe(true)
      expect((await send(handle, `${accessPath}/${created.clientId}`, 'DELETE')).status).toBe(200)
      await expect(read(client, project.id)).rejects.toMatchObject({ code: 401 })
      expect(handle.runtime.engineeringService!.getProject(project.id)?.name).toBe('PRIVATE_PROJECT_NAME')
      await client.close(); client = undefined
      await handle.close(); handle = undefined
      handle = await startKunServe(optionsFor(dataDir))
      await expect(connect(handle, created.token)).rejects.toMatchObject({ code: 401 })
      expect(await (await send(handle, accessPath)).json()).toEqual({ clients: [] })
      expect(handle.runtime.engineeringService!.getProject(project.id)?.name).toBe('PRIVATE_PROJECT_NAME')
    } finally {
      await client?.close()
      await handle?.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('denies unauthenticated, owner-as-client, forged identity, client self-authorization, nonlocal host/origin and oversized requests', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'survey-mcp-denial-'))
    let handle: KunServeHandle | undefined, client: Client | undefined
    try {
      handle = await startKunServe(optionsFor(dataDir))
      const project = handle.runtime.engineeringService!.createProject({ name: 'private', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'project-denial' })
      expect((await send(handle, accessPath, 'POST', '', {})).status).toBe(401)
      const created = await createClient(handle)
      client = await connect(handle, created.token)
      expect((await send(handle, accessPath, 'GET', created.token)).status).toBe(401)
      const grantPath = `${accessPath}/${created.clientId}/grants/${project.id}`
      expect((await send(handle, grantPath, 'PUT', created.token, {})).status).toBe(401)
      expect((await read(client, project.id)).isError).toBe(true)
      expect((await send(handle, `${accessPath}/${created.clientId}/grants/nonexistent-project`, 'PUT', ownerToken, {})).status).toBe(404)
      expect((await send(handle, grantPath, 'PUT', ownerToken, { principalId: created.clientId, allowed: true })).status).toBe(400)
      expect((await send(handle, grantPath, 'PUT', ownerToken, {})).status).toBe(200)
      const forged = await client.callTool({ name: 'survey_context_read', arguments: { projectId: project.id, principalId: 'admin', allowedProjects: [project.id] } })
      expect(forged.isError).toBe(true)
      await expect(connect(handle, ownerToken)).rejects.toMatchObject({ code: 401 })
      await expect(connect(handle, 'invalid-client-token')).rejects.toMatchObject({ code: 401 })
      const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'owner', version: '1' } } }
      expect(await sendHostOverride(handle, created.token, request)).toBe(403)
      expect((await send(handle, endpointPath, 'POST', created.token, request, { origin: 'https://attacker.example' })).status).toBe(403)
      expect((await send(handle, accessPath, 'POST', ownerToken, {}, { origin: 'null' })).status).toBe(403)
      expect((await send(handle, endpointPath, 'POST', created.token, { ...request, padding: 'x'.repeat(65 * 1024) })).status).toBe(413)
    } finally { await client?.close(); await handle?.close(); await rm(dataDir, { recursive: true, force: true }) }
  })

  it('does not allow insecure runtime mode to expose grant administration or MCP data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'survey-mcp-insecure-'))
    let handle: KunServeHandle | undefined
    try {
      handle = await startKunServe(optionsFor(dataDir, true))
      expect((await send(handle, accessPath, 'POST', ownerToken, {})).status).toBe(503)
      expect((await send(handle, accessPath, 'GET', '')).status).toBe(503)
      expect((await send(handle, endpointPath, 'POST', ownerToken, {})).status).toBe(503)
    } finally { await handle?.close(); await rm(dataDir, { recursive: true, force: true }) }
  })

  it('does not enable the host when the actual runtime is configured to listen beyond loopback', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'survey-mcp-nonlocal-'))
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
    try {
      // No nonlocal listener is opened by this test. Exercise the production
      // factory/router composition with its configured interface instead.
      runtime = await createKunServeRuntime({ ...optionsFor(dataDir), host: '0.0.0.0' })
      expect(runtime.surveyContextMcp).toBeUndefined()
      const response = await dispatchRequest(buildRouter(runtime), new Request(`http://127.0.0.1${accessPath}`, {
        headers: { authorization: `Bearer ${ownerToken}` }
      }))
      expect(response.status).toBe(503)
    } finally { await runtime?.shutdown?.(); await rm(dataDir, { recursive: true, force: true }) }
  })
})
