import { createHash } from 'node:crypto'
import { BrowserCapabilityConfig, browserTaskOrigins, browserVerificationPolicy, isBrowserTask, isPublicBrowserQuery, type BrowserExecutionScope, type BrowserTaskBindingConfirmation, type BrowserTaskBindingSnapshot, type BrowserVerificationPolicy, type BrowserPublicQueryAuthorization, type BrowserPublicQueryDuration } from '../contracts/browser-skill.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { ExecutionScope } from '../contracts/permissions.js'
import { scheduleForRequirement } from '../contracts/schedule.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { readOptionalKunConfigFile } from '../config/kun-config.js'
import { buildBrowserSkillToolProvider } from '../adapters/tool/browser-skill-tool-provider.js'
import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { BrowserScheduleResolution } from '../contracts/browser-schedule-actions.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
import { object, runBrowserCommand, parseBrowserStatus, compatibleBrowserProtocol, supportsBrowserTargetPolicy, supportsBrowserNativeRead, type BrowserCommandRunner } from './browser-skill-cli.js'

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
        const owned = { taskId, threadId, config: this.state() }
        this.sessions.set(sessionId, owned)
        signal.addEventListener('abort', () => {
          if (this.sessions.get(sessionId) === owned) void this.stopThread(threadId)
        }, { once: true })
      },
      onSessionRetired: (taskId, sessionId) => {
        if (this.sessions.get(sessionId)?.taskId === taskId) this.sessions.delete(sessionId)
      } })
    this.currentProvider = { ...provider, enabled: this.config.enabled, available: this.config.state === 'ready' }
    return this.currentProvider
  }

  async preflight(text: string, thread?: ThreadRecord, scheduledBrowserScope?: BrowserExecutionScope): Promise<CapabilityPreflight | null> {
    const currentTask = thread ? this.options.repository.findActiveByThread(thread.id) : null
    if (!isBrowserTask(text) && !currentTask?.authority?.browserScope && !scheduledBrowserScope) return null
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
    let targetPolicySupported = false
    let nativeReadSupported = false
    try {
      const response = await (this.options.run ?? runBrowserCommand)(config, ['status'])
      if (!response.ok) throw new Error('browser_connection_unavailable')
      const live = parseBrowserStatus(response.output)
      const browser = live.browsers.find(item => item.id === config.browserInstanceId && item.connected)
      if (!browser || !compatibleBrowserProtocol(live.protocolVersion) || !compatibleBrowserProtocol(browser.protocolVersion)) throw new Error('browser_connection_unavailable')
      targetPolicySupported = supportsBrowserTargetPolicy(config.version, live.protocolVersion, browser.protocolVersion)
      nativeReadSupported = supportsBrowserNativeRead(config.version, live.protocolVersion, browser.protocolVersion)
    } catch {
      return { ...base, status: 'blocked', action, resolution: action, errorCode: 'browser_connection_unavailable',
        message: '当前浏览器连接未通过实时核验。请重新检查扩展和浏览器连接，然后继续原任务。' }
    }
    const bound = currentTask?.authority?.browserScope ?? scheduledBrowserScope
    const requiresNativeRead = bound?.publicQueryAuthorization || bound?.interaction === 'interact' && browserVerificationPolicy(bound.verificationPolicy) === 'public_query_target' || !bound && isPublicBrowserQuery(text)
    if (browserVerificationPolicy(bound?.verificationPolicy) === 'public_query_target' && !targetPolicySupported || requiresNativeRead && !nativeReadSupported) {
      const upgrade = { kind: 'install' as const, route: 'marketplace', label: '升级 CLI 并更新或重新连接扩展' }
      return { ...base, status: 'blocked', action: upgrade, resolution: upgrade, errorCode: 'browser_target_policy_upgrade_required',
        message: '当前公开资料查询范围需要 BrowserSkill CLI 0.5.0 及服务和所选扩展协议 1.9 或以上，以核对实际页面目标。请升级 CLI、更新或重新连接官方扩展，再继续原任务；原授权和待核验操作保持保留。' }
    }
    if (!currentTask && !scheduledBrowserScope && isPublicBrowserQuery(text)) {
      const confirmation = { kind: 'grant' as const, route: 'task/browser-binding', label: '确认公开查询的浏览器范围' }
      return { ...base, status: 'needs_authorization', action: confirmation, resolution: confirmation, errorCode: 'browser_verification_policy_required',
        message: '请先审阅公开查询的浏览器、站点及校验范围。确认后再继续任务。' }
    }
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
      ...(inherited?.verificationPolicy ? { verificationPolicy: inherited.verificationPolicy } : {}),
      ...(inherited?.publicQueryAuthorization ? { publicQueryAuthorization: structuredClone(inherited.publicQueryAuthorization) } : {}),
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
    const verificationPolicy = browserVerificationPolicy(previous?.verificationPolicy)
    const browser = config.browsers.find(item => item.id === config.browserInstanceId)
    const nativeReadSupported = Boolean(browser?.connected && supportsBrowserNativeRead(config.version, config.daemonProtocolVersion, browser.protocolVersion))
    const targetPolicySupported = Boolean(browser?.connected && supportsBrowserTargetPolicy(config.version, config.daemonProtocolVersion, browser.protocolVersion) &&
      (interaction === 'observe' || nativeReadSupported))
    if ((verificationPolicy === 'public_query_target' || previous?.publicQueryAuthorization) && !targetPolicySupported) throw new Error('browser_target_policy_upgrade_required')
    const unresolved = this.hasUnresolvedBrowserOperation(taskId)
    const allowedVerificationPolicies: BrowserVerificationPolicy[] = unresolved ? [verificationPolicy] : ['strict']
    if (!unresolved && targetPolicySupported && isPublicBrowserQuery(task.goal) && (!task.parentTaskId || browserVerificationPolicy(parentScope?.verificationPolicy) === 'public_query_target')) {
      allowedVerificationPolicies.push('public_query_target')
    }
    const allowedPublicQueryAuthorizations: BrowserPublicQueryDuration[] = []
    // A binding confirmation grants scope only for this root purpose. Children
    // and scheduled occurrences remain within their already inherited authority.
    if (!unresolved && nativeReadSupported && !task.parentTaskId && !task.scheduledBy && interaction === 'interact' && isPublicBrowserQuery(task.goal)) {
      allowedPublicQueryAuthorizations.push('task')
      if (task.acceptance.schedule) allowedPublicQueryAuthorizations.push('schedule')
    }
    const schedule = task.acceptance.schedule && !task.scheduledBy ? scheduleForRequirement(task.acceptance.schedule) : undefined
    const scheduleReview = schedule?.kind === 'daily' && task.acceptance.schedule ? {
      ...task.acceptance.schedule, startTimes: schedule.times
    } : undefined
    const recommendedVerificationPolicy = allowedVerificationPolicies.includes('public_query_target') && isPublicBrowserQuery(task.goal)
      ? 'public_query_target' : allowedVerificationPolicies.includes(verificationPolicy) ? verificationPolicy : 'strict'
    return { taskId, taskRevision: task.revision, browserRevision: config.revision, browserInstanceId: config.browserInstanceId,
      browserLabel: browser?.label || browser?.name || config.browserInstanceId, previousBrowserInstanceId: previous?.browserInstanceId,
      origins, interaction, previousInteraction: previous?.interaction, purpose: task.goal, verificationPolicy, recommendedVerificationPolicy,
      allowedVerificationPolicies, allowedPublicQueryAuthorizations,
      ...(previous?.publicQueryAuthorization ? { publicQueryAuthorization: previous.publicQueryAuthorization } : {}),
      ...(scheduleReview ? { scheduleReview } : {}), ...(unresolved ? { policyChangeBlocked: 'browser_unresolved_operation' as const } : {}) }
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
      const verificationPolicy = input.verificationPolicy ?? snapshot.verificationPolicy
      if (!snapshot.allowedVerificationPolicies.includes(verificationPolicy)) throw new Error(snapshot.policyChangeBlocked ?? 'browser_verification_policy_blocked')
      const task = this.options.repository.get(taskId)!
      const priorScope = task.authority?.browserScope
      if (input.publicQueryAuthorization && (interaction !== 'interact' || !snapshot.allowedPublicQueryAuthorizations?.includes(input.publicQueryAuthorization))) {
        throw new Error(snapshot.policyChangeBlocked ?? 'browser_public_query_authorization_blocked')
      }
      // Nothing is granted by a policy selection alone. The explicit duration
      // is the checkbox-backed request, and the resulting receipt is its proof.
      const { receipt } = this.options.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_binding', request: input, nowIso: new Date().toISOString() })
      let publicQueryAuthorization: BrowserPublicQueryAuthorization | undefined
      if (input.publicQueryAuthorization) publicQueryAuthorization = {
        receiptId: receipt.id, purposeHash: operationFingerprint({ purpose: task.goal }), duration: input.publicQueryAuthorization,
        ...(input.publicQueryAuthorization === 'schedule' ? { requirementHash: operationFingerprint({ requirement: task.acceptance.schedule }) } : {})
      }
      else if (priorScope?.publicQueryAuthorization && (snapshot.policyChangeBlocked || task.parentTaskId || task.scheduledBy)) {
        // Preserve only an existing reference. Missing consent never mints new
        // authority; descendants cannot extend its purpose, duration or sites.
        publicQueryAuthorization = priorScope.publicQueryAuthorization
        if (task.parentTaskId) {
          const parent = this.options.repository.get(task.parentTaskId)
          const inherited = parent?.authority?.browserScope?.publicQueryAuthorization
          if (!inherited || operationFingerprint(inherited) !== operationFingerprint(publicQueryAuthorization) ||
            inherited.purposeHash !== operationFingerprint({ purpose: task.goal }) ||
            inherited.duration === 'schedule' && inherited.requirementHash !== operationFingerprint({ requirement: task.acceptance.schedule })) throw new Error('browser_parent_scope_blocked')
        }
      }
      const browserScope: BrowserExecutionScope = { browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction, revision: snapshot.browserRevision,
        ...(priorScope?.verificationPolicy || !snapshot.policyChangeBlocked && input.verificationPolicy ? { verificationPolicy } : {}),
        ...(publicQueryAuthorization ? { publicQueryAuthorization } : {}) }
      if (snapshot.policyChangeBlocked && operationFingerprint(browserScope) !== operationFingerprint(priorScope ?? {})) throw new Error('browser_unresolved_operation')
      const { publicQueryAuthorization: _previousPublicQueryAuthorization, ...reviewed } = snapshot
      const confirmed = { ...reviewed, interaction, verificationPolicy, ...(publicQueryAuthorization ? { publicQueryAuthorization } : {}) }
      this.options.repository.update(taskId, snapshot.taskRevision, task => ({ ...task, authority: {
        ...(task.authority ?? { source: 'user', workspaceRoot: task.workspaceRoot, externalTargets: [], grantedAt: new Date().toISOString() }),
        browserScope
      }, acceptance: { ...task.acceptance,
        ...(task.acceptance.requiresWebEvidence && !task.acceptance.requiredSourceOrigins?.length ? { requiredSourceOrigins: snapshot.origins } : {})
      } }), { key, kind: 'browser_binding_confirmed', payload: { browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, browserRevision: snapshot.browserRevision, interaction, verificationPolicy, ...(publicQueryAuthorization ? { publicQueryAuthorization } : {}) } })
      this.options.repository.finishOperation(taskId, key, { status: 'succeeded', result: confirmed })
      return { binding: confirmed, resumed: false as const }
    })
  }

  private hasUnresolvedBrowserOperation(taskId: string): boolean {
    return this.options.repository.operations(taskId).some(receipt => {
      const relevant = ['browser_session', 'browser_action_dispatch', 'browser_schedule_action_outcome'].includes(receipt.kind) ||
        receipt.kind === 'tool' && ['browser_fill', 'browser_click', 'browser_press'].includes(String(receipt.request?.toolName))
      if (!relevant) return false
      if (receipt.kind === 'browser_action_dispatch' && object(receipt.result).readbackPending === true) return true
      if (receipt.kind === 'tool' && receipt.status === 'prepared' && receipt.request?.dispatchTracking === 'host-v1') return false
      return ['prepared', 'running', 'outcome_unknown'].includes(receipt.status) && !this.options.repository.verifiedOperationResolution(receipt)
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
        const receipt = this.options.repository.operations(owned.taskId, 'browser_session').filter(item => item.status === 'succeeded' && object(item.result).sessionId === sessionId && !object(item.result).stopped).at(-1)
        const response = await runBrowserCommand(owned.config, ['session', 'stop', sessionId])
        const result = object(response.output)
        if (this.sessions.get(sessionId) !== owned || !response.ok || !Array.isArray(result.stopped) || !result.stopped.includes(sessionId)) return
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
