import { readOptionalKunConfigFile } from '../config/kun-config.js'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { CapabilityPreflight } from '../contracts/harness.js'
import { DingTalkCapabilityConfig, type DingTalkCapabilityConfig as DingTalkConfig, type DingTalkCredential } from '../contracts/dingtalk.js'
import { DingTalkAuthService, type ConnectorSecretStore } from '../connectors/dingtalk-auth.js'
import { buildDingTalkToolProvider, DINGTALK_SCOPES, dingtalkOpenapiIdentity } from '../adapters/tool/dingtalk-tool-provider.js'
import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import { externalTaskIntent } from './external-task-capability.js'

const API = 'https://api.dingtalk.com'
const SetupInput = z.object({
  clientId: z.string().trim().min(1).max(200), clientSecret: z.string().min(1).max(4096),
  redirectUri: z.string().url(), userScopes: z.array(z.enum(['Contact.User.Read', 'Todo.Todo.Read', 'Todo.Todo.Write'])).default(['Todo.Todo.Read']),
  userId: z.string().trim().min(1).max(200).optional(), allowedWriteUserIds: z.array(z.string().trim().min(1).max(200)).max(100).default([])
}).strict()
const WorkflowAuthorizationInput = z.object({ confirmed: z.literal(true), userId: z.string().trim().min(1).max(200), unionId: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(['qyapi_aflow', 'Workflow.Instance.Read', 'Workflow.Instance.Write'])).min(1).max(3) }).strict()
type IdentityCheck = { credential: DingTalkCredential | null; credentialState: 'missing' | 'invalid' | 'valid'; scopes: string[]; identityVerified: boolean; errorCode?: string }
export type ManagedDingTalkState = {
  enabled: boolean
  available: boolean
  credentialState: 'missing' | 'invalid' | 'valid'
  identityVerified: boolean
  scopes: string[]
  reason?: string
  checkedAt: string
}

/** Reads credentials from the existing encrypted local store and trusts only the local config file. */
export class ManagedDingTalkRuntime {
  private config: DingTalkConfig
  private provider?: CapabilityToolProvider
  private status: ManagedDingTalkState
  private lastCheckAt = 0
  private apply?: (provider?: CapabilityToolProvider) => void
  private expiryTimer?: ReturnType<typeof setTimeout>

  constructor(initial: DingTalkConfig | undefined, private readonly secrets: ConnectorSecretStore,
    private readonly configPath?: string, private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now, apply?: (provider?: CapabilityToolProvider) => void) {
    this.config = DingTalkCapabilityConfig.parse(initial ?? {})
    this.apply = apply
    this.status = { enabled: this.config.enabled, available: false, credentialState: 'missing', identityVerified: false,
      scopes: [], reason: '钉钉尚未完成配置和授权。', checkedAt: new Date(this.now()).toISOString() }
  }

  setApply(apply: (provider?: CapabilityToolProvider) => void): void { this.apply = apply }
  state(): ManagedDingTalkState { return structuredClone(this.status) }
  toolProvider(): CapabilityToolProvider | undefined { return this.provider }
  scope(externalTargets: readonly string[] = []) {
    return { networkAllowlist: [API], connectorScopes: [...this.status.scopes], externalTargets: [...externalTargets],
      connectorBackends: { dingtalk: 'openapi' as const }, connectorIdentityFingerprints: { dingtalk: dingtalkOpenapiIdentity(this.config) } }
  }
  close(): void { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined }

  async configure(input: unknown): Promise<{ configured: true; userScopes: string[] }> {
    const parsed = SetupInput.parse(input)
    if (!this.configPath) throw Object.assign(new Error('Managed connector configuration is unavailable.'), { code: 'connector_configuration_unavailable' })
    const secretRef = `dingtalk_client_${randomUUID().replace(/-/g, '')}`
    await this.secrets.set(secretRef, Buffer.from(parsed.clientSecret, 'utf8'))
    const next = DingTalkCapabilityConfig.parse({ ...this.config, enabled: true, clientId: parsed.clientId, clientSecretRef: secretRef,
      redirectUri: parsed.redirectUri, userScopes: parsed.userScopes, userId: parsed.userId ?? this.config.userId,
      allowedWriteUserIds: parsed.allowedWriteUserIds })
    await this.writeConfig(next)
    await this.verifyAndApply(next)
    return { configured: true, userScopes: [...next.userScopes] }
  }

  async beginOAuth(): Promise<{ authorizationUrl: string; expiresAt: string }> {
    return this.authService().begin()
  }

  async completeOAuth(callbackUrl: string): Promise<{ unionId: string; expiresAt: string; status: ManagedDingTalkState }> {
    if (typeof callbackUrl !== 'string' || callbackUrl.length > 4096) throw Object.assign(new Error('invalid OAuth callback URL'), { code: 'connector_oauth_callback_invalid' })
    const result = await this.authService().complete(callbackUrl)
    const next = DingTalkCapabilityConfig.parse({ ...this.config, credentialRef: result.credentialRef, unionId: result.unionId })
    await this.writeConfig(next)
    return { unionId: result.unionId, expiresAt: result.expiresAt, status: await this.verifyAndApply(next) }
  }

  async authorizeWorkflow(input: unknown): Promise<{ expiresAt: string; status: ManagedDingTalkState }> {
    const parsed = WorkflowAuthorizationInput.parse(input)
    const next = DingTalkCapabilityConfig.parse({ ...this.config, userId: parsed.userId, unionId: parsed.unionId, scopes: parsed.scopes })
    const result = await new DingTalkAuthService({ config: next, secrets: this.secrets, fetch: this.fetcher, now: this.now }).connectInternalApp(parsed)
    const configured = DingTalkCapabilityConfig.parse({ ...next, workflowCredentialRef: result.credentialRef })
    await this.writeConfig(configured)
    return { expiresAt: result.expiresAt, status: await this.verifyAndApply(configured) }
  }

  async initialize(): Promise<ManagedDingTalkState> { return this.verifyAndApply(this.config) }

  async preflight(text: string): Promise<CapabilityPreflight | null> {
    const intent = externalTaskIntent(text)
    if (intent?.provider !== 'dingtalk') return null
    if (this.now() - this.lastCheckAt > 30_000) await this.verifyAndApply(this.config)
    const base = { provider: 'dingtalk' as const, networkState: this.status.available ? 'available' as const : 'unknown' as const,
      workspaceState: 'unknown' as const, sandboxState: 'allowed' as const,
      approvalState: intent.mutation ? 'required' as const : 'not_required' as const, checkedAt: this.status.checkedAt }
    const connect = { kind: 'connect' as const, route: 'settings', label: '配置钉钉连接器' }
    if (intent.operation === 'send') return { ...base, status: 'unsupported', credentialState: this.status.credentialState,
      errorCode: 'connector_operation_unsupported', message: '当前钉钉连接器尚不支持发送消息。请使用待办或审批能力。', action: connect, resolution: connect }
    if (!this.config.enabled) return { ...base, status: 'blocked', credentialState: 'missing', errorCode: 'connector_disabled',
      message: '钉钉连接器尚未启用，请先完成配置。', action: connect, resolution: connect }
    if (intent.kind === 'connect_provider') return { ...base, status: 'needs_authorization', credentialState: this.status.credentialState,
      errorCode: 'connector_authorization_required', message: '请先在钉钉连接器设置中完成应用配置和授权。', action: connect, resolution: connect }
    const approval = /审批|approval|workflow/i.test(text) || ['approve', 'reject', 'transfer'].includes(intent.operation ?? '')
    const required = approval
      ? [...(intent.operation === 'detail' || intent.mutation ? [] : [DINGTALK_SCOPES.integratedRead]), ...(intent.operation === 'detail' || intent.mutation ? [DINGTALK_SCOPES.workflowRead] : []), ...(intent.mutation ? [DINGTALK_SCOPES.workflowWrite] : [])]
      : [DINGTALK_SCOPES.todoRead, ...(intent.mutation ? [DINGTALK_SCOPES.todoWrite] : [])]
    const configScopes = approval ? this.config.scopes : this.config.userScopes
    const credentialRef = approval ? this.config.workflowCredentialRef : this.config.credentialRef
    const credentialCheck = approval ? await this.readCredential(credentialRef, 'internal-app', required, true) : await this.readCredential(credentialRef, 'user', required, false)
    if (credentialCheck.credentialState !== 'valid' || !credentialCheck.identityVerified) {
      const state = credentialCheck.credentialState
      const status = state === 'missing' ? 'needs_authorization' as const : 'needs_authorization' as const
      return { ...base, status, credentialState: state, errorCode: credentialCheck.errorCode ?? 'connector_authorization_required',
        message: approval ? '钉钉企业应用凭据、审批人身份或审批权限未通过验证。' : '钉钉用户授权、身份或待办权限未通过验证。', action: connect, resolution: connect }
    }
    if (required.some(scope => !configScopes.includes(scope) || !credentialCheck.scopes.includes(scope))) {
      return { ...base, status: 'needs_authorization', credentialState: 'valid', errorCode: 'connector_scope_missing',
        message: '钉钉授权缺少此操作所需权限，请在钉钉连接器设置中更新授权范围。', action: connect, resolution: connect }
    }
    if (intent.mutation && (!this.config.userId || !this.config.allowedWriteUserIds.includes(this.config.userId))) {
      return { ...base, status: 'blocked', credentialState: 'valid', errorCode: 'connector_write_user_blocked',
        message: '当前钉钉连接器未将已验证用户列入允许写入范围。', action: connect, resolution: connect }
    }
    if (!this.status.available) return { ...base, status: 'blocked', credentialState: this.status.credentialState,
      errorCode: 'connector_identity_unverified', message: this.status.reason ?? '钉钉连接器当前不可用。', action: { kind: 'retry', route: 'settings', label: '重新检查连接' } }
    return { ...base, status: 'available', credentialState: 'valid', toolId: 'dingtalk',
      message: '钉钉凭据、身份和所需读取权限已验证；写操作仍须逐次确认并回读验证。' }
  }

  async refresh(): Promise<ManagedDingTalkState> {
    if (!this.configPath) throw Object.assign(new Error('Managed connector configuration is unavailable.'), { code: 'connector_configuration_unavailable' })
    const next = readOptionalKunConfigFile(this.configPath)?.config.capabilities.dingtalk ?? this.config
    return this.verifyAndApply(next)
  }

  private authService(): DingTalkAuthService {
    return new DingTalkAuthService({ config: this.config, secrets: this.secrets, fetch: this.fetcher, now: this.now })
  }

  private async writeConfig(next: DingTalkConfig): Promise<void> {
    if (!this.configPath) throw Object.assign(new Error('Managed connector configuration is unavailable.'), { code: 'connector_configuration_unavailable' })
    const path = readOptionalKunConfigFile(this.configPath)?.path ?? this.configPath
    let fileInfo: Awaited<ReturnType<typeof lstat>> | undefined
    try { fileInfo = await lstat(path) } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
    if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink())) throw Object.assign(new Error('connector config must be a regular file'), { code: 'connector_configuration_invalid' })
    const originalText = fileInfo ? await readFile(path, 'utf8') : undefined
    const document = originalText ? JSON.parse(originalText) as Record<string, unknown> : {}
    const capabilities = document.capabilities && typeof document.capabilities === 'object' && !Array.isArray(document.capabilities)
      ? document.capabilities as Record<string, unknown> : {}
    const updated = { ...document, capabilities: { ...capabilities, dingtalk: next } }
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: fileInfo ? Number(fileInfo.mode) & 0o777 : 0o600 })
      if (originalText !== undefined) {
        const currentText = await readFile(path, 'utf8')
        if (createHash('sha256').update(currentText).digest('hex') !== createHash('sha256').update(originalText).digest('hex')) {
          throw Object.assign(new Error('connector config changed during update'), { code: 'connector_configuration_conflict' })
        }
        await rename(temporary, path)
      } else {
        await (await import('node:fs/promises')).link(temporary, path)
        await (await import('node:fs/promises')).unlink(temporary)
      }
    } catch (error) {
      await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined)
      throw error
    }
  }

  private async verifyAndApply(config: DingTalkConfig): Promise<ManagedDingTalkState> {
    const next = DingTalkCapabilityConfig.parse(config)
    const user = await this.readCredential(next.credentialRef, 'user', [DINGTALK_SCOPES.todoRead], false, next)
    const app = await this.readCredential(next.workflowCredentialRef, 'internal-app', [], true, next)
    const appRead = app.credentialState === 'valid' && app.identityVerified && next.scopes.includes(DINGTALK_SCOPES.integratedRead)
      ? await this.readCredential(next.workflowCredentialRef, 'internal-app', [DINGTALK_SCOPES.integratedRead], true, next)
      : app
    const availableUserScopes = user.credentialState === 'valid' && user.identityVerified ? user.scopes.filter(scope => new Set<string>(next.userScopes).has(scope)) : []
    const availableAppScopes = app.credentialState === 'valid' && app.identityVerified ? app.scopes.filter(scope =>
      next.scopes.includes(scope) && (scope !== DINGTALK_SCOPES.integratedRead || appRead.credentialState === 'valid' && appRead.identityVerified && appRead.scopes.includes(scope))) : []
    const tools = new Set<string>()
    if (next.enabled && availableUserScopes.includes(DINGTALK_SCOPES.todoRead)) {
      tools.add('dingtalk_list_tasks'); tools.add('dingtalk_get_task')
      if (availableUserScopes.includes(DINGTALK_SCOPES.todoWrite) && next.userId && next.allowedWriteUserIds.includes(next.userId)) tools.add('dingtalk_complete_task')
    }
    if (next.enabled && availableAppScopes.includes(DINGTALK_SCOPES.integratedRead)) tools.add('dingtalk_list_approvals')
    if (next.enabled && app.credentialState === 'valid' && app.identityVerified && next.scopes.includes(DINGTALK_SCOPES.workflowRead) && app.scopes.includes(DINGTALK_SCOPES.workflowRead)) {
      tools.add('dingtalk_get_approval')
      if (next.scopes.includes(DINGTALK_SCOPES.workflowWrite) && app.scopes.includes(DINGTALK_SCOPES.workflowWrite) && next.userId && next.allowedWriteUserIds.includes(next.userId)) {
        tools.add('dingtalk_approve'); tools.add('dingtalk_reject'); tools.add('dingtalk_transfer')
      }
    }
    const baseProvider = next.enabled ? buildDingTalkToolProvider({ config: next, getCredential: reference => this.getCredential(reference), fetch: this.fetcher, nowIso: () => new Date(this.now()).toISOString() }) : undefined
    const provider = baseProvider && tools.size ? { ...baseProvider, tools: baseProvider.tools.filter(tool => tools.has(tool.name)), available: true,
      reason: undefined } : undefined
    const aggregate = user.credentialState === 'valid' || app.credentialState === 'valid' ? 'valid' : user.credentialState === 'invalid' || app.credentialState === 'invalid' ? 'invalid' : 'missing'
    const identityVerified = Boolean(user.identityVerified || app.identityVerified)
    const reason = !next.enabled ? '钉钉连接器已关闭。' : tools.size ? undefined
      : !next.credentialRef && !next.workflowCredentialRef ? '钉钉尚未完成授权。'
      : user.errorCode || app.errorCode || '钉钉凭据、身份或授权范围未通过验证。'
    this.apply?.(provider)
    this.config = next
    this.provider = provider
    this.lastCheckAt = this.now()
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    const expiry = [user.credential, app.credential].map(value => value?.expiresAt ? Date.parse(value.expiresAt) : Number.NaN)
      .filter(value => Number.isFinite(value) && value > this.now()).sort((a, b) => a - b)[0]
    if (expiry !== undefined) {
      this.expiryTimer = setTimeout(() => { void this.verifyAndApply(this.config).catch(() => undefined) }, Math.min(2_147_000_000, Math.max(1, expiry - this.now())))
      this.expiryTimer.unref?.()
    }
    this.status = { enabled: next.enabled, available: Boolean(provider?.available), credentialState: aggregate,
      identityVerified, scopes: [...new Set([...availableUserScopes, ...availableAppScopes])].sort(), ...(reason ? { reason } : {}),
      checkedAt: new Date(this.now()).toISOString() }
    return this.state()
  }

  private async getCredential(reference: string): Promise<DingTalkCredential | null> {
    const raw = await this.secrets.get(reference)
    if (!raw) return null
    try {
      const value = JSON.parse(raw.toString('utf8')) as Partial<DingTalkCredential>
      if (typeof value.accessToken !== 'string' || !value.accessToken || typeof value.unionId !== 'string' || !value.unionId ||
        typeof value.expiresAt !== 'string' || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string') ||
        (value.kind !== 'user' && value.kind !== 'internal-app')) return null
      return value as DingTalkCredential
    } catch { return null }
  }

  private async readCredential(reference: string | undefined, kind: DingTalkCredential['kind'], requiredScopes: string[], workflow: boolean,
    config = this.config): Promise<IdentityCheck> {
    if (!config.enabled || !reference) return { credential: null, credentialState: 'missing', scopes: [], identityVerified: false, errorCode: 'connector_authorization_required' }
    const credential = await this.getCredential(reference)
    if (!credential) return { credential: null, credentialState: 'missing', scopes: [], identityVerified: false, errorCode: 'connector_credential_missing' }
    const expires = Date.parse(credential.expiresAt)
    if (!Number.isFinite(expires) || expires <= this.now() || credential.kind !== kind) return { credential, credentialState: 'invalid', scopes: [], identityVerified: false, errorCode: 'connector_credential_invalid' }
    const scopes = credential.scopes.filter(scope => requiredScopes.includes(scope))
    if (requiredScopes.some(scope => !scopes.includes(scope))) return { credential, credentialState: 'valid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_scope_missing' }
    if (!config.unionId || credential.unionId !== config.unionId || (workflow && (!config.userId || credential.userId !== config.userId))) {
      return { credential, credentialState: 'invalid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_identity_mismatch' }
    }
    if (workflow && !requiredScopes.includes(DINGTALK_SCOPES.integratedRead)) {
      // This credential was minted locally only after explicit admin confirmation of the bound identity.
      return { credential, credentialState: 'valid', scopes: credential.scopes, identityVerified: true }
    }
    try {
      const headers = { 'x-acs-dingtalk-access-token': credential.accessToken }
      const url = workflow
        ? `${API}/v1.0/workflow/processCentres/todoTasks?userId=${encodeURIComponent(config.userId!)}&pageNumber=1&pageSize=1`
        : `${API}/v1.0/contact/users/me`
      const response = await this.fetcher(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(8_000) })
      if (!response.ok) return { credential, credentialState: response.status === 401 ? 'invalid' : 'valid',
        scopes: workflow && response.status === 403 ? credential.scopes.filter(scope => scope !== DINGTALK_SCOPES.integratedRead) : credential.scopes,
        identityVerified: workflow && response.status !== 401, errorCode: response.status === 403 ? 'connector_scope_missing' : 'connector_identity_unverified' }
      const text = await response.text()
      if (Buffer.byteLength(text) > 256 * 1024) return { credential, credentialState: 'invalid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_invalid_response' }
      const body = JSON.parse(text) as Record<string, unknown>
      if (workflow) {
        const result = body.result && typeof body.result === 'object' ? body.result as Record<string, unknown> : undefined
        if (!Array.isArray(result?.list)) return { credential, credentialState: 'invalid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_identity_unverified' }
      } else {
        if (body.unionId !== config.unionId) return { credential, credentialState: 'invalid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_identity_mismatch' }
        if (credential.scopes.includes(DINGTALK_SCOPES.todoRead)) {
          const probe = await this.fetcher(`${API}/v1.0/todo/users/${encodeURIComponent(credential.unionId)}/tasks/list`, {
            method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ isDone: false }), signal: AbortSignal.timeout(8_000)
          })
          if (!probe.ok) return { credential, credentialState: 'valid', scopes: credential.scopes.filter(scope => scope !== DINGTALK_SCOPES.todoRead),
            identityVerified: true, errorCode: probe.status === 403 ? 'connector_scope_missing' : 'connector_read_probe_failed' }
          const probeText = await probe.text()
          if (Buffer.byteLength(probeText) > 256 * 1024) return { credential, credentialState: 'valid', scopes: credential.scopes.filter(scope => scope !== DINGTALK_SCOPES.todoRead), identityVerified: true, errorCode: 'connector_invalid_response' }
          const probeBody = JSON.parse(probeText) as Record<string, unknown>
          if (!Array.isArray(probeBody.todoCards)) return { credential, credentialState: 'valid', scopes: credential.scopes.filter(scope => scope !== DINGTALK_SCOPES.todoRead), identityVerified: true, errorCode: 'connector_invalid_response' }
        }
      }
      return { credential, credentialState: 'valid', scopes: credential.scopes, identityVerified: true }
    } catch {
      return { credential, credentialState: 'valid', scopes: credential.scopes, identityVerified: false, errorCode: 'connector_network_failed' }
    }
  }
}
