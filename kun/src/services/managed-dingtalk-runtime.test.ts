import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DingTalkCapabilityConfig, type DingTalkCredential } from '../contracts/dingtalk.js'
import type { ConnectorSecretStore } from '../connectors/dingtalk-auth.js'
import { ManagedDingTalkRuntime } from './managed-dingtalk-runtime.js'

class MemorySecrets implements ConnectorSecretStore {
  values = new Map<string, Buffer>()
  async set(key: string, value: Buffer) { this.values.set(key, Buffer.from(value)) }
  async get(key: string) { const value = this.values.get(key); return value ? Buffer.from(value) : null }
}

const scopes = ['Todo.Todo.Read', 'Todo.Todo.Write']
const credential = (overrides: Partial<DingTalkCredential> = {}): DingTalkCredential => ({
  accessToken: 'private-access-token', expiresAt: '2027-01-01T00:00:00.000Z', unionId: 'union-1',
  kind: 'user', scopes: ['Todo.Todo.Read', 'Todo.Todo.Write'], ...overrides
})
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const config = DingTalkCapabilityConfig.parse({ enabled: true, credentialRef: 'user-ref', unionId: 'union-1', userScopes: scopes, userId: 'user-1', allowedWriteUserIds: ['user-1'] })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('ManagedDingTalkRuntime', () => {
  it('registers only the tools backed by a non-expired credential with a verified identity', async () => {
    const secrets = new MemorySecrets()
    await secrets.set('user-ref', Buffer.from(JSON.stringify(credential())))
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes('/contact/users/me')
      ? response({ unionId: 'union-1' }) : response({ todoCards: [] })) as unknown as typeof fetch
    const runtime = new ManagedDingTalkRuntime(config, secrets, undefined, fetcher, () => Date.parse('2026-11-10T00:00:00Z'))

    const state = await runtime.initialize()

    expect(state).toMatchObject({ available: true, credentialState: 'valid', identityVerified: true, scopes })
    expect(runtime.toolProvider()?.tools.map(tool => tool.name)).toEqual(['dingtalk_list_tasks', 'dingtalk_get_task', 'dingtalk_complete_task'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(state)).not.toContain('private-access-token')
  })

  it('does not advertise tools for expired or identity-mismatched credentials', async () => {
    const secrets = new MemorySecrets()
    await secrets.set('user-ref', Buffer.from(JSON.stringify(credential({ expiresAt: '2020-01-01T00:00:00Z' }))))
    const fetcher = vi.fn(async () => response({ unionId: 'union-1' })) as unknown as typeof fetch
    const expired = new ManagedDingTalkRuntime(config, secrets, undefined, fetcher, () => Date.parse('2026-11-10T00:00:00Z'))
    expect(await expired.initialize()).toMatchObject({ available: false, credentialState: 'invalid' })
    expect(expired.toolProvider()).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()

    await secrets.set('user-ref', Buffer.from(JSON.stringify(credential())))
    const mismatch = new ManagedDingTalkRuntime(config, secrets, undefined, vi.fn(async () => response({ unionId: 'other-user' })) as unknown as typeof fetch,
      () => Date.parse('2026-11-10T00:00:00Z'))
    expect(await mismatch.initialize()).toMatchObject({ available: false, identityVerified: false })
    expect(mismatch.toolProvider()).toBeUndefined()
  })

  it('returns actionable preflight states and requires write scopes before creating a task turn', async () => {
    const secrets = new MemorySecrets()
    await secrets.set('user-ref', Buffer.from(JSON.stringify(credential({ scopes: ['Todo.Todo.Read'] }))))
    const runtime = new ManagedDingTalkRuntime(config, secrets, undefined, vi.fn(async (input: string | URL | Request) => String(input).includes('/contact/users/me')
      ? response({ unionId: 'union-1' }) : response({ todoCards: [] })) as unknown as typeof fetch,
      () => Date.parse('2026-11-10T00:00:00Z'))
    await runtime.initialize()

    expect(await runtime.preflight('帮我查询钉钉待办')).toMatchObject({ status: 'available', credentialState: 'valid' })
    expect(await runtime.preflight('帮我完成钉钉待办')).toMatchObject({ status: 'needs_authorization', errorCode: 'connector_scope_missing' })
    expect(await runtime.preflight('帮我发送钉钉消息')).toMatchObject({ status: 'unsupported' })
    expect(await runtime.preflight('如何使用钉钉审批')).toBeNull()
  })

  it('keeps internal workflow scopes separate from integrated approval inbox scopes', async () => {
    const secrets = new MemorySecrets()
    const appScopes = ['Workflow.Instance.Read', 'Workflow.Instance.Write']
    await secrets.set('app-ref', Buffer.from(JSON.stringify(credential({ kind: 'internal-app', userId: 'user-1', scopes: appScopes }))))
    const appConfig = DingTalkCapabilityConfig.parse({ enabled: true, workflowCredentialRef: 'app-ref', unionId: 'union-1', userId: 'user-1',
      scopes: appScopes, allowedWriteUserIds: ['user-1'] })
    const runtime = new ManagedDingTalkRuntime(appConfig, secrets, undefined, fetch, () => Date.parse('2026-11-10T00:00:00Z'))

    const state = await runtime.initialize()

    expect(state).toMatchObject({ available: true, identityVerified: true, scopes: appScopes })
    expect(runtime.toolProvider()?.tools.map(tool => tool.name)).toEqual(['dingtalk_get_approval', 'dingtalk_approve', 'dingtalk_reject', 'dingtalk_transfer'])
    expect(await runtime.preflight('同意钉钉审批')).toMatchObject({ status: 'available', approvalState: 'required' })
    expect(await runtime.preflight('同意钉钉审批并完成待办 A')).toMatchObject({ status: 'needs_authorization', errorCode: 'connector_scope_missing' })
    expect(await runtime.preflight('同意钉钉审批并上传文件')).toMatchObject({ status: 'unsupported' })
  })

  it('stores the application secret outside config and completes OAuth into an encrypted credential reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-dingtalk-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({ capabilities: {} }), { mode: 0o600 })
    const secrets = new MemorySecrets()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1.0/oauth2/userAccessToken')) return response({ accessToken: 'new-token', expireIn: 3600 })
      if (url.includes('/todo/users/')) return response({ todoCards: [] })
      return response({ unionId: 'union-1' })
    }) as unknown as typeof fetch
    const runtime = new ManagedDingTalkRuntime(DingTalkCapabilityConfig.parse({}), secrets, configPath, fetcher, () => Date.parse('2026-11-10T00:00:00Z'))

    await runtime.configure({ clientId: 'client-1', clientSecret: 'do-not-store-in-config', redirectUri: 'http://127.0.0.1:4321/callback', userScopes: ['Todo.Todo.Read'] })
    const storedConfig = await readFile(configPath, 'utf8')
    expect(storedConfig).not.toContain('do-not-store-in-config')
    expect(JSON.parse(storedConfig).capabilities.dingtalk.clientSecretRef).toBeTruthy()
    const start = await runtime.beginOAuth()
    const state = new URL(start.authorizationUrl).searchParams.get('state')!
    const completed = await runtime.completeOAuth(`http://127.0.0.1:4321/callback?authCode=auth-code&state=${state}`)

    expect(completed).toMatchObject({ unionId: 'union-1', status: { available: true, identityVerified: true } })
    expect(runtime.toolProvider()?.tools.map(tool => tool.name)).toEqual(['dingtalk_list_tasks', 'dingtalk_get_task'])
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(await runtime.preflight('查询钉钉待办')).toMatchObject({ status: 'available' })
  })
})
