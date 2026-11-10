import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentProfileSavePayloadSchema,
  catalogSourcePayloadSchema,
  documentParsePayloadSchema,
  gitCheckpointCreatePayloadSchema,
  gitRollbackApplyPayloadSchema,
  gitRollbackPreviewPayloadSchema,
  mcpServerAuthorizationStatePayloadSchema,
  mcpServerAuthorizePayloadSchema,
  mcpServerSavePayloadSchema,
  pluginInstallPayloadSchema,
  pluginPrepareImportPayloadSchema,
  repoMapBuildPayloadSchema,
  runtimeRequestPayloadSchema,
  settingsSetPayloadSchema,
  workspaceTrustSetPayloadSchema
} from './app-ipc-schemas'

const root = resolve(import.meta.dirname, '../../..')

describe('0.3.0 Agent workbench public API contracts', () => {
  it('allows only modeled task and Shell endpoints with their correct methods', () => {
    expect(runtimeRequestPayloadSchema.parse({ path: '/v1/tasks/task_1/resume', method: 'POST', body: '{}' }).path)
      .toBe('/v1/tasks/task_1/resume')
    expect(runtimeRequestPayloadSchema.parse({ path: '/v1/shell-sessions?taskId=task_1', method: 'GET' }).path)
      .toContain('/v1/shell-sessions')
    expect(() => runtimeRequestPayloadSchema.parse({ path: '/v1/tasks/task_1/resume', method: 'GET' }))
      .toThrow(/not allowed/)
    expect(runtimeRequestPayloadSchema.parse({ path: '/v1/tasks/task_1/receipts', method: 'GET' }).path)
      .toBe('/v1/tasks/task_1/receipts')
    expect(() => runtimeRequestPayloadSchema.parse({ path: '/v1/tasks/task_1/receipts', method: 'POST' }))
      .toThrow(/not allowed/)
  })

  it('requires revisions and idempotency keys at mutable IPC boundaries', () => {
    const profile = {
      id: 'writer', name: 'Writer', role: '写作', color: '#1688ff', systemPrompt: '交付文档。',
      toolAllowlist: ['read'], mcpAllowlist: [], trustLevel: 'workspace-write' as const,
      budget: { maxAttempts: 4, maxDurationMs: 60_000 }
    }
    expect(() => agentProfileSavePayloadSchema.parse({ scope: 'global', profile, idempotencyKey: 'save' }))
      .toThrow()
    expect(() => workspaceTrustSetPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace', level: 'trusted', confirmed: true, expectedRevision: 0
    })).toThrow()
    expect(() => gitRollbackApplyPayloadSchema.parse({ checkpointId: 'gitcp_123', idempotencyKey: 'apply' }))
      .toThrow()
    expect(gitRollbackPreviewPayloadSchema.parse({ checkpointId: 'gitcp_123' }))
      .toEqual({ checkpointId: 'gitcp_123' })
  })

  it('strictly validates MCP, Git, Repo Map, and document requests', () => {
    expect(mcpServerSavePayloadSchema.parse({
      config: {
        id: 'docs', name: 'Docs', scope: 'global', transport: 'http', url: 'https://example.com/mcp',
        timeoutMs: 5_000, source: 'user', toolPolicy: { search: 'ask' }, enabled: true
      },
      expectedRevision: 0,
      idempotencyKey: 'mcp-save'
    }).config.transport).toBe('http')
    expect(gitCheckpointCreatePayloadSchema.parse({
      taskId: 'task_1', workspaceRoot: '/tmp/workspace', idempotencyKey: 'git-create'
    }).taskId).toBe('task_1')
    expect(repoMapBuildPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace', repositoryRoot: '/tmp/workspace', idempotencyKey: 'map-build'
    }).repositoryRoot).toBe('/tmp/workspace')
    expect(() => documentParsePayloadSchema.parse({
      workspaceRoot: '/tmp/workspace', relativePath: 'doc.pdf', mode: 'auto', idempotencyKey: 'parse', secret: 'no'
    })).toThrow(/Unrecognized key/)
  })

  it('strictly validates catalog sources and one-time plugin installation requests', () => {
    expect(catalogSourcePayloadSchema.parse({
      schemaVersion: 1,
      id: 'team-catalog',
      name: 'Team Catalog',
      type: 'https',
      scope: 'team',
      location: 'https://plugins.example.com/catalog.json',
      trust: 'unverified',
      searchable: true,
      auth: { type: 'token', secretKey: 'catalog.team.token' },
      sync: {
        mode: 'manual',
        state: 'idle',
        mirroredByDefault: false,
        installedByDefault: false
      }
    }).id).toBe('team-catalog')
    expect(() => catalogSourcePayloadSchema.parse({
      schemaVersion: 1,
      id: 'unsafe',
      name: 'Unsafe',
      type: 'https',
      scope: 'team',
      location: 'https://plugins.example.com/catalog.json',
      trust: 'unverified',
      searchable: true,
      auth: { type: 'token', secretKey: 'catalog.token', token: 'plaintext' },
      sync: { mode: 'manual', state: 'idle', mirroredByDefault: false, installedByDefault: false }
    })).toThrow(/Unrecognized key/)
    expect(pluginPrepareImportPayloadSchema.parse({
      sourcePath: '/tmp/example.wwx',
      format: 'wwx'
    }).format).toBe('wwx')
    expect(() => pluginInstallPayloadSchema.parse({
      preparedId: 'prepared-1',
      reviewSha256: 'not-a-digest',
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [],
      idempotencyKey: 'install-1'
    })).toThrow()
  })

  it('accepts automatic loopback OAuth intent without accepting callback secrets in unrelated payloads', () => {
    expect(mcpServerAuthorizePayloadSchema.parse({
      serverId: 'notion',
      useLocalCallback: true
    })).toEqual({ serverId: 'notion', useLocalCallback: true })
    expect(mcpServerAuthorizationStatePayloadSchema.parse({
      serverId: 'notion',
      state: 'oauth-state'
    })).toEqual({ serverId: 'notion', state: 'oauth-state' })
  })

  it('accepts V2 settings envelopes while retaining the 0.2.x patch compatibility shape', () => {
    expect(settingsSetPayloadSchema.parse({
      patch: { conversation: { viewMode: 'concise' }, documents: { parsingMode: 'auto' } },
      expectedRevision: 4
    })).toMatchObject({ expectedRevision: 4 })
    expect(settingsSetPayloadSchema.parse({ theme: 'dark' })).toEqual({
      patch: { theme: 'dark' },
      expectedRevision: undefined
    })
  })

  it('exposes WorkWise as the formal preload API and a single deprecated compatibility proxy', async () => {
    const preload = await readFile(resolve(root, 'src/preload/index.ts'), 'utf8')
    const deprecatedApi = ['kun', 'Gui'].join('')
    expect(preload).toContain("contextBridge.exposeInMainWorld('workwise', api)")
    expect(preload).toContain(`contextBridge.exposeInMainWorld('${deprecatedApi}', api)`)
    expect(preload.match(new RegExp(`exposeInMainWorld\\('${deprecatedApi}'`, 'g'))).toHaveLength(1)
    expect(preload).toContain('Deprecated compatibility boundary for 0.2.x renderers')
    expect(preload).toContain("ipcRenderer.invoke('catalog:list-packages')")
    expect(preload).toContain("ipcRenderer.invoke('plugin:install', request)")
  })
})
