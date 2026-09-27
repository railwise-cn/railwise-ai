import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineeringContextSnapshotV1 } from '../../contracts/engineering-ai.js'
import { createSurveyContextMcpServer, type SurveyContextServerDependencies } from './survey-context-server.js'

function snapshot(): EngineeringContextSnapshotV1 {
  return {
    schemaVersion: 1, projectId: 'project-a', projectRevision: 2, contextHash: 'sha256-context', generatedAt: '2026-09-19T00:00:00Z',
    project: { name: 'PRIVATE_PROJECT_NAME', monitoringType: 'survey', unit: 'm', reportPeriod: {}, thresholds: {} },
    datasets: [], analyses: [], runs: [], citations: [], watchDrafts: [], surveyAdjustments: [],
    surveyNetworks: [{ id: 'network-a', revision: 1, networkType: 'leveling', coordinateSystem: 'PRIVATE_CRS', verticalDatum: 'PRIVATE_DATUM', pointCount: 3, observationCount: 4, qualityStatus: 'valid' }]
  }
}

const closeSessions: Array<() => Promise<void>> = []
afterEach(async () => { while (closeSessions.length) await closeSessions.pop()!() })

async function connect(deps?: SurveyContextServerDependencies) {
  const server = createSurveyContextMcpServer(deps)
  // This client name is intentionally not the authenticated principal.
  const client = new Client({ name: 'untrusted-client-name', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  closeSessions.push(async () => { await client.close(); await server.close() })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('Survey MCP SDK protocol boundary', () => {
  it('rejects truthy non-boolean grants on the SDK path before storage access', async () => {
    const readSnapshot = vi.fn(snapshot)
    for (const grant of ['false', {}, Promise.resolve(false), 1]) {
      const canReadProject = (() => grant) as unknown as SurveyContextServerDependencies['canReadProject']
      const client = await connect({ principalId: 'host-principal', canReadProject, snapshot: readSnapshot })
      const result = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })
      expect(result).toMatchObject({ isError: true, content: [{ text: 'survey_context_access_denied' }] })
    }
    expect(readSnapshot).not.toHaveBeenCalled()
  })

  it('checks revocation after a snapshot and redacts malformed output on the SDK path', async () => {
    let allowed = true
    const client = await connect({ principalId: 'host-principal', canReadProject: () => allowed, snapshot: () => {
      allowed = false
      return snapshot()
    } })
    const denied = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })
    expect(denied).toMatchObject({ isError: true, content: [{ text: 'survey_context_access_denied' }] })
    expect(denied.structuredContent).toBeUndefined()

    const malformed = snapshot()
    Object.assign(malformed.surveyNetworks[0]!, { id: { privatePath: '/PRIVATE_PROJECT_PATH' } })
    const malformedClient = await connect({ principalId: 'host-principal', canReadProject: () => true, snapshot: () => malformed })
    const failure = await malformedClient.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })
    expect(failure).toMatchObject({ isError: true, content: [{ text: 'survey_context_unavailable' }] })
    expect(failure.structuredContent).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain('PRIVATE')
  })

  it('initializes and advertises only the read-only tool; an unconfigured host grants nothing', async () => {
    const client = await connect()
    expect(client.getServerVersion()?.name).toBe('railwise-survey-context')
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['survey_context_read'])
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(tools[0]!.inputSchema.additionalProperties).toBe(false)
    const denied = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })
    expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: 'survey_context_access_denied' }] })
  })

  it('performs tools/call with the host identity and returns bounded metadata without private fields', async () => {
    const grants = vi.fn((principal: string, project: string) => principal === 'host-principal' && project === 'project-a')
    const client = await connect({ principalId: 'host-principal', canReadProject: grants, snapshot })
    const result = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a', expectedProjectRevision: 2, expectedContextHash: 'sha256-context' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ projectId: 'project-a', access: 'read-only-summary', verification: 'context-metadata-only', untrusted: true })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(grants).toHaveBeenCalledWith('host-principal', 'project-a')
    expect(grants).not.toHaveBeenCalledWith('untrusted-client-name', 'project-a')
  })

  it('denies cross-project access before reading storage and applies revocation to an existing connection', async () => {
    let allowed = true
    const readSnapshot = vi.fn(snapshot)
    const client = await connect({ principalId: 'host-principal', canReadProject: (_, project) => allowed && project === 'project-a', snapshot: readSnapshot })
    const call = (projectId: string) => client.callTool({ name: 'survey_context_read', arguments: { projectId } })
    expect((await call('project-b')).isError).toBe(true)
    expect(readSnapshot).not.toHaveBeenCalled()
    expect((await call('project-a')).isError).not.toBe(true)
    allowed = false
    expect((await call('project-a')).isError).toBe(true)
    expect(readSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not infer identity from client initialization or allow forged grants in tool arguments', async () => {
    const readSnapshot = vi.fn(snapshot)
    const client = await connect({ canReadProject: () => true, snapshot: readSnapshot })
    expect((await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a', principalId: 'admin', allowedProjects: ['project-a'] } })).isError).toBe(true)
    expect(readSnapshot).not.toHaveBeenCalled()
  })

  it('returns stale and cross-project errors without any snapshot content', async () => {
    const client = await connect({ principalId: 'host-principal', canReadProject: () => true, snapshot })
    const stale = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a', expectedProjectRevision: 1 } })
    expect(stale).toMatchObject({ isError: true, content: [{ text: 'survey_context_stale' }] })
    const wrongProject = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-b' } })
    expect(wrongProject).toMatchObject({ isError: true, content: [{ text: 'survey_context_project_mismatch' }] })
    expect(JSON.stringify([stale, wrongProject])).not.toContain('PRIVATE')
  })

  it.each(['authorization', 'storage'] as const)('redacts unexpected %s failures on the real protocol', async boundary => {
    const fail = () => { throw new Error('/private/secret.sqlite3 token=PRIVATE_CREDENTIAL') }
    const client = await connect({ principalId: 'host-principal', canReadProject: boundary === 'authorization' ? fail : () => true, snapshot: boundary === 'storage' ? fail : snapshot })
    const error = await client.callTool({ name: 'survey_context_read', arguments: { projectId: 'project-a' } })
    expect(error).toMatchObject({ isError: true, content: [{ text: 'survey_context_unavailable' }] })
    expect(JSON.stringify(error)).not.toContain('PRIVATE')
    expect(error.structuredContent).toBeUndefined()
  })
})
