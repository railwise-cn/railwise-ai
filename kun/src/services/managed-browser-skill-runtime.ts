import { createHash } from 'node:crypto'
import { BrowserCapabilityConfig, browserTaskOrigins, isBrowserTask, type BrowserExecutionScope, type BrowserTaskBindingConfirmation, type BrowserTaskBindingSnapshot } from '../contracts/browser-skill.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { ExecutionScope } from '../contracts/permissions.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { readOptionalKunConfigFile } from '../config/kun-config.js'
import { buildBrowserSkillToolProvider } from '../adapters/tool/browser-skill-tool-provider.js'
import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { BrowserScheduleResolution } from '../contracts/browser-schedule-actions.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { object, runBrowserCommand, parseBrowserStatus, compatibleBrowserProtocol, type BrowserCommandRunner } from './browser-skill-cli.js'

export class ManagedBrowserSkillRuntime {
  private config: BrowserCapabilityConfig
  private configurationFingerprint: string
  private providerGeneration = 0
  private appliedGeneration = 0
  private currentProvider?: CapabilityToolProvider
  private readonly sessions = new Map<string, { taskId: string; threadId: string; config: BrowserCapabilityConfig }>()
  constructor(private readonly options: {
    config?: BrowserCapabilityConfig
    configPath: string
    dataDir: string
    repository: TaskRunRepository
    apply: (provider: CapabilityToolProvider) => void
    hasActiveAttempt?: (turnId: string) => boolean
    run?: BrowserCommandRunner
    resolveSchedule?: (context: ToolHostContext, sourceActionId?: string) => Promise<BrowserScheduleResolution | undefined>
  }) {
    this.config = BrowserCapabilityConfig.parse(options.config ?? {})
    this.configurationFingerprint = browserConfigurationFingerprint(this.config)
  }

  state(): BrowserCapabilityConfig { return structuredClone(this.config) }
  identityFingerprint(): string { return this.configurationFingerprint }

  provider(): CapabilityToolProvider {
    if (this.currentProvider) return this.currentProvider
    const generation = this.providerGeneration
    const provider = buildBrowserSkillToolProvider({ config: () => this.config,
      configurationFingerprint: this.configurationFingerprint, isCurrentConfiguration: () => generation === this.providerGeneration,
      repository: this.options.repository, dataDir: this.options.dataDir, run: this.options.run, resolveSchedule: this.options.resolveSchedule,
      onSession: (taskId, sessionId, threadId, signal) => {
        this.sessions.set(sessionId, { taskId, threadId, config: this.state() })
        signal.addEventListener('abort', () => { void this.stopThread(threadId) }, { once: true })
      } })
    this.currentProvider = { ...provider, enabled: this.config.enabled, available: this.config.state === 'ready' }
    return this.currentProvider
  }

  async preflight(text: string, thread?: ThreadRecord): Promise<CapabilityPreflight | null> {
    const currentTask = thread ? this.options.repository.findActiveByThread(thread.id) : null
    if (!isBrowserTask(text) && !currentTask?.authority?.browserScope) return null
    const config = this.config
    const base = { provider: 'browser-skill' as const, checkedAt: new Date().toISOString(), credentialState: 'unknown' as const,
      workspaceRoot: currentTask?.workspaceRoot ?? thread?.workspace,
      networkState: 'unknown' as const, workspaceState: 'allowed' as const, sandboxState: 'allowed' as const, approvalState: 'required' as const }
    const action = { kind: config.state === 'not_installed' ? 'install' as const : 'connect' as const, route: 'marketplace', label: '配置浏览器连接' }
    if (thread?.mode === 'plan') return { ...base, status: 'blocked', errorCode: 'task_mode_blocked', message: '当前任务处于计划模式，请切换到执行模式。',
      action: { kind: 'grant', route: 'settings/agents', label: '检查任务模式' } }
    const allowed = thread?.agentProfile?.toolAllowlist
    if (allowed?.length && !allowed.includes('*') && !['browser_session_start', 'browser_navigate', 'browser_observe'].every(name => allowed.includes(name))) {
      return { ...base, status: 'blocked', errorCode: 'agent_tool_blocked', message: '当前 Agent 的工具范围缺少浏览器能力，请切换或调整 Agent。',
        action: { kind: 'grant', route: 'settings/agents', label: '检查 Agent 工具范围' } }
    }
    if (!config.enabled || config.state !== 'ready') {
      return { ...base, status: config.state === 'not_installed' ? 'not_installed' : 'blocked', action, resolution: action,
        errorCode: !config.enabled ? 'browser_disabled' : `browser_${config.state}`,
        message: !config.enabled ? '请启用 BrowserSkill 并选择已连接的浏览器。' : 'BrowserSkill 尚未就绪。请检查 CLI、浏览器扩展与所选浏览器实例，然后继续原任务。' }
    }
    try {
      const response = await (this.options.run ?? runBrowserCommand)(config, ['status'])
      if (!response.ok) throw new Error('browser_connection_unavailable')
      const live = parseBrowserStatus(response.output)
      const browser = live.browsers.find(item => item.id === config.browserInstanceId && item.connected)
      if (!browser || !compatibleBrowserProtocol(live.protocolVersion) || !compatibleBrowserProtocol(browser.protocolVersion)) throw new Error('browser_connection_unavailable')
    } catch {
      return { ...base, status: 'blocked', action, resolution: action, errorCode: 'browser_connection_unavailable',
        message: '当前浏览器连接未通过实时核验。请重新检查扩展和浏览器连接，然后继续原任务。' }
    }
    const bound = currentTask?.authority?.browserScope
    if (currentTask && !bound && ['paused', 'waiting_user', 'stalled'].includes(currentTask.status)) {
      const confirmation = { kind: 'grant' as const, route: 'task/browser-binding', label: '确认当前任务的浏览器范围' }
      return { ...base, status: 'needs_authorization', action: confirmation, resolution: confirmation, errorCode: 'browser_task_scope_required',
        message: '浏览器已连接。请审阅当前等待任务使用的浏览器、站点和交互范围，确认后再继续原任务。' }
    }
    if (bound && (bound.browserInstanceId !== config.browserInstanceId || bound.revision !== config.revision)) {
      const confirmation = { kind: 'grant' as const, route: 'task/browser-binding', label: '确认当前任务的浏览器范围' }
      return { ...base, status: 'needs_authorization', action: confirmation, resolution: confirmation, errorCode: 'browser_binding_changed',
        message: '浏览器实例或连接配置已变化。请审阅当前任务的浏览器和站点范围，确认后继续原任务。' }
    }
    if (!browserTaskOrigins(text).length && !config.origins.length && !bound?.origins.length) {
      const grant = { kind: 'grant' as const, route: 'marketplace', label: '选择允许访问的站点' }
      return { ...base, status: 'needs_authorization', action: grant, resolution: grant, errorCode: 'browser_origin_scope_required',
        message: '请在浏览器连接中填写允许访问的站点，或补充任务目标网页地址。' }
    }
    return { ...base, status: 'available', toolId: 'browser-skill', executablePath: config.executablePath,
      message: 'BrowserSkill 已连接到指定浏览器。网页交互按任务范围执行，可能修改网站数据的操作需审阅。' }
  }

  scope(text: string, inherited?: BrowserExecutionScope, networkOrigins?: readonly string[]): ExecutionScope {
    const config = this.config
    const origins = inherited ? [...inherited.origins] : [...new Set([...browserTaskOrigins(text), ...config.origins,
      ...(networkOrigins ?? []).filter(value => value !== '*')])]
    const scope = config.browserInstanceId && origins.length ? {
      browserInstanceId: inherited?.browserInstanceId ?? config.browserInstanceId,
      origins, interaction: inherited?.interaction ?? config.interaction,
      revision: inherited?.revision ?? config.revision
    } : undefined
    return { networkAllowlist: origins, connectorScopes: [], externalTargets: [], ...(scope ? {
      browserScope: scope, connectorIdentityFingerprints: { 'browser-skill': this.configurationFingerprint }
    } : {}) }
  }

  bindingSnapshot(taskId: string): BrowserTaskBindingSnapshot {
    const task = this.options.repository.get(taskId)
    if (!task || !['paused', 'waiting_user', 'stalled'].includes(task.status) || task.authority?.revokedAt ||
      (task.activeTurnId && this.options.hasActiveAttempt?.(task.activeTurnId))) throw new Error('browser_task_not_waiting')
    const lease = this.options.repository.getLease(taskId)
    if (lease && Date.parse(lease.expiresAt) > Date.now()) throw new Error('browser_task_not_waiting')
    const config = this.config
    if (!config.enabled || config.state !== 'ready' || !config.browserInstanceId) throw new Error('browser_connection_unavailable')
    const previous = task.authority?.browserScope
    const parent = task.parentTaskId ? this.options.repository.get(task.parentTaskId) : undefined
    const parentScope = parent?.authority?.browserScope
    const requestedOrigins = browserTaskOrigins(task.goal)
    // A previously unbound task reviews the explicitly configured sites here.
    // Existing task authority always retains its original origin boundary.
    const fallbackOrigins = task.parentTaskId ? parentScope?.origins ?? [] : config.origins
    const taskOrigins = previous?.origins ?? (requestedOrigins.length ? requestedOrigins : fallbackOrigins)
    const origins = taskOrigins.filter(origin => !config.origins.length || config.origins.includes(origin))
    if (!origins.length) throw new Error('browser_original_origins_not_allowed')
    if (task.parentTaskId && (!parentScope || parent?.authority?.revokedAt ||
      parentScope.browserInstanceId !== config.browserInstanceId || parentScope.revision !== config.revision ||
      origins.some(origin => !parentScope.origins.includes(origin)))) throw new Error('browser_parent_scope_blocked')
    const interaction = config.interaction === 'interact' && (!task.parentTaskId || parentScope?.interaction === 'interact') ? 'interact' : 'observe'
    const browser = config.browsers.find(item => item.id === config.browserInstanceId)
    return { taskId, taskRevision: task.revision, browserRevision: config.revision, browserInstanceId: config.browserInstanceId,
      browserLabel: browser?.label || browser?.name || config.browserInstanceId, previousBrowserInstanceId: previous?.browserInstanceId,
      origins, interaction, previousInteraction: previous?.interaction }
  }

  confirmBinding(taskId: string, input: BrowserTaskBindingConfirmation): { binding: BrowserTaskBindingSnapshot; resumed: false } {
    const key = `browser-binding:${input.idempotencyKey}`
    const previous = this.options.repository.operation(taskId, key)
    if (previous) {
      this.options.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_binding', request: input, nowIso: new Date().toISOString() })
      if (previous.status !== 'succeeded') throw new Error('browser_binding_outcome_unknown')
      return { binding: previous.result as BrowserTaskBindingSnapshot, resumed: false }
    }
    return this.options.repository.transact(() => {
      const snapshot = this.bindingSnapshot(taskId)
      if (snapshot.taskRevision !== input.expectedTaskRevision || snapshot.browserRevision !== input.expectedBrowserRevision ||
        snapshot.browserInstanceId !== input.browserInstanceId || JSON.stringify(snapshot.origins) !== JSON.stringify(input.origins)) throw new Error('browser_binding_changed')
      // Old clients may rebind the browser, but cannot implicitly widen interaction.
      const interaction = input.interaction ?? snapshot.previousInteraction ?? 'observe'
      if (interaction === 'interact' && snapshot.interaction !== 'interact') throw new Error('browser_interaction_scope_required')
      const confirmed = { ...snapshot, interaction }
      this.options.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_binding', request: input, nowIso: new Date().toISOString() })
      this.options.repository.update(taskId, snapshot.taskRevision, task => ({ ...task, authority: {
        ...(task.authority ?? { source: 'user', workspaceRoot: task.workspaceRoot, externalTargets: [], grantedAt: new Date().toISOString() }),
        browserScope: { browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction, revision: snapshot.browserRevision }
      } }), { key, kind: 'browser_binding_confirmed', payload: { browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, browserRevision: snapshot.browserRevision, interaction } })
      this.options.repository.finishOperation(taskId, key, { status: 'succeeded', result: confirmed })
      return { binding: confirmed, resumed: false as const }
    })
  }

  async refresh(): Promise<BrowserCapabilityConfig> {
    const fresh = readOptionalKunConfigFile(this.options.configPath)?.config.capabilities.browserSkill
    if (!fresh) throw new Error('browser_configuration_unavailable')
    const fingerprint = browserConfigurationFingerprint(fresh)
    const changed = fingerprint !== this.configurationFingerprint
    this.config = fresh
    if (changed) {
      this.configurationFingerprint = fingerprint
      this.providerGeneration += 1
      this.currentProvider = undefined
    }
    if (this.appliedGeneration !== this.providerGeneration) {
      this.options.apply(this.provider())
      this.appliedGeneration = this.providerGeneration
    }
    return this.state()
  }

  async stopThread(threadId: string): Promise<void> {
    await Promise.all([...this.sessions].filter(([, owned]) => owned.threadId === threadId).map(async ([sessionId, owned]) => {
      const task = this.options.repository.get(owned.taskId)
      // Aborting a Turn must not destroy the only readback surface of an
      // in-flight/unknown action. The external browser remains idle across an
      // ordinary Runtime exit; explicit task cancellation still closes it.
      const pending = this.options.repository.operations(owned.taskId, 'browser_action_dispatch').some(receipt =>
        (['running', 'prepared', 'outcome_unknown'].includes(receipt.status) && !this.options.repository.verifiedOperationResolution(receipt) ||
          receipt.status === 'succeeded' && object(receipt.result).readbackPending === true) &&
        (!receipt.request?.sessionId || receipt.request.sessionId === sessionId))
      if (task?.status !== 'cancelled' && pending) return
      try {
        const response = await runBrowserCommand(owned.config, ['session', 'stop', sessionId])
        const result = object(response.output)
        if (!response.ok || !Array.isArray(result.stopped) || !result.stopped.includes(sessionId)) return
        const receipt = this.options.repository.operations(owned.taskId, 'browser_session').find(item => object(item.result).sessionId === sessionId)
        if (receipt) this.options.repository.finishOperation(owned.taskId, receipt.idempotencyKey, { status: 'succeeded', result: { ...object(receipt.result), stopped: true } })
        this.sessions.delete(sessionId)
      } catch { /* Preserve the owned journal for explicit recovery when a stop is unverified. */ }
    }))
  }

  async close(): Promise<void> {
    await Promise.all([...new Set([...this.sessions.values()].map(item => item.threadId))].map(threadId => this.stopThread(threadId)))
  }
}

function browserConfigurationFingerprint(config: BrowserCapabilityConfig): string {
  const selected = config.browsers.find(browser => browser.id === config.browserInstanceId)
  return createHash('sha256').update(JSON.stringify({
    enabled: config.enabled, state: config.state, revision: config.revision,
    browserInstanceId: config.browserInstanceId, origins: [...config.origins].sort(), interaction: config.interaction,
    executablePath: config.executablePath, executableHash: config.executableHash, version: config.version,
    homeDirectory: config.homeDirectory, daemonProtocolVersion: config.daemonProtocolVersion,
    selectedBrowser: selected ? { id: selected.id, connected: selected.connected, extensionVersion: selected.extensionVersion,
      protocolVersion: selected.protocolVersion, versionSkew: selected.versionSkew } : undefined
  })).digest('hex')
}
