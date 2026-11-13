import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { WorkWiseApi } from '../shared/workwise-api'
import { createNotificationOpenThreadBuffer } from './notification-open-thread-buffer'
import {
  parseWindowAppearanceArguments,
  parseWindowLocaleArgument
} from '../shared/window-appearance'
import {
  RUNTIME_TASKS_PATH,
  RUNTIME_SHELL_SESSIONS_PATH,
  runtimeShellSessionTerminatePath,
  runtimeTaskCancelPath,
  runtimeTaskPath,
  runtimeTaskResumePath,
  runtimeTaskRetryPath,
  runtimeTaskDiagnosticsPath,
  runtimeTaskPausePath,
  runtimeTaskInputsPath,
  runtimeTaskEventsPath,
  runtimeTaskReceiptsPath,
  runtimeTaskPermissionsPath,
  runtimeTaskReceiptVerifyPath,
  runtimeTaskTemplateStartPath,
  runtimeTaskTemplateSavePath,
  runtimeThreadAgentPath,
  runtimeThreadPath
} from '../shared/runtime-endpoints'

const notificationOpenTaskBuffer = createNotificationOpenThreadBuffer()
const notificationOpenFlowBuffer = createNotificationOpenThreadBuffer()
ipcRenderer.on('notification:open-flow',(_event,reference:unknown)=>{if(reference && typeof reference==='object' && 'flowRunId' in reference && typeof reference.flowRunId==='string')notificationOpenFlowBuffer.push(JSON.stringify(reference))})
ipcRenderer.on('notification:open-task',(_event,taskId:unknown)=>{if(typeof taskId==='string')notificationOpenTaskBuffer.push(taskId)})
const notificationOpenThreadBuffer = createNotificationOpenThreadBuffer()
ipcRenderer.on('notification:open-thread', (_event, threadId: unknown) => {
  if (typeof threadId === 'string') notificationOpenThreadBuffer.push(threadId)
})

async function runtimeJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke('runtime:request', {
    path,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }) as { ok: boolean; status: number; body: string }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.body)
  } catch {
    parsed = null
  }
  if (!result.ok) {
    const code = parsed && typeof parsed === 'object' && 'code' in parsed
      ? String(parsed.code)
      : undefined
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String(parsed.message)
      : `Runtime request failed (${result.status}).`
    throw Object.assign(new Error(code ? `[${code}] ${message}` : message), {
      code,
      status: result.status
    })
  }
  return parsed as T
}

const api = {
  platform: process.platform,
  initialLocale: parseWindowLocaleArgument(process.argv),
  windowAppearance: parseWindowAppearanceArguments(process.argv),
  onWindowAppearanceChanged: (handler) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      appearance: Parameters<typeof handler>[0]
    ): void => handler(appearance)
    ipcRenderer.on('window:appearance-changed', wrapped)
    return () => ipcRenderer.removeListener('window:appearance-changed', wrapped)
  },
  onApplicationMenuAction: (handler) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      action: Parameters<typeof handler>[0]
    ): void => handler(action)
    ipcRenderer.on('app:menu-action', wrapped)
    return () => ipcRenderer.removeListener('app:menu-action', wrapped)
  },
  notifyTask: (payload) => ipcRenderer.invoke('notification:task',payload),
  onNotificationOpenTask: (handler) => notificationOpenTaskBuffer.subscribe(handler),
  onNotificationOpenFlow: (handler) => notificationOpenFlowBuffer.subscribe(value=>handler(JSON.parse(value))),
  onNotificationOpenThread: (handler) => {
    return notificationOpenThreadBuffer.subscribe(handler)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial, expectedRevision) =>
    ipcRenderer.invoke('settings:set', { patch: partial, expectedRevision }),
  runtimeRequest: (path, method, body) =>
    ipcRenderer.invoke('runtime:request', { path, method, body }),
  cancelOperation: (request) => ipcRenderer.invoke('operation:cancel', request),
  coordinateTaskCommand: (request) => runtimeJson('/v1/task-commands','POST',request),
  getTaskRun: (taskId) => runtimeJson(runtimeTaskPath(taskId)),
  listTaskOperationReceipts: (taskId) => runtimeJson(runtimeTaskReceiptsPath(taskId)),
  getTaskPermissions: (taskId) => runtimeJson(runtimeTaskPermissionsPath(taskId)),
  confirmTaskPermissions: (taskId, request) => runtimeJson(runtimeTaskPermissionsPath(taskId), 'POST', request),
  verifyTaskOperationReceipt: (taskId, receiptId, request) => runtimeJson(runtimeTaskReceiptVerifyPath(taskId, receiptId), 'POST', request),
  readDocumentCandidate: (payload) => ipcRenderer.invoke('write:read-candidate', payload),
  decideDocumentCandidate: (payload) => ipcRenderer.invoke('write:decide-candidate',payload),
  startTaskSse: (sinceSeq,streamId) => ipcRenderer.invoke('runtime:sse:start',{scope:'tasks',sinceSeq,streamId}),
  listTaskPage: (query) => {
    const params = new URLSearchParams({pagination:'cursor'})
    for(const [key,value] of Object.entries(query ?? {})) if(value !== undefined) params.set(key,String(value))
    return runtimeJson(`/v1/tasks?${params}`)
  },
  listTaskRuns: (query) => {
    const params = new URLSearchParams()
    if (query?.threadId) params.set('threadId', query.threadId)
    if (query?.status) params.set('status', query.status)
    if (query?.workspaceRoot) params.set('workspaceRoot', query.workspaceRoot)
    if (query?.search) params.set('search', query.search)
    if (query?.offset) params.set('offset', String(query.offset))
    if (query?.limit) params.set('limit', String(query.limit))
    if (query?.cursor) params.set('cursor', query.cursor)
    return runtimeJson(`${RUNTIME_TASKS_PATH}${params.size ? `?${params}` : ''}`)
  },
  resumeTask: (taskId, request) => runtimeJson(runtimeTaskResumePath(taskId), 'POST', request),
  retryTask: (taskId, request) => runtimeJson(runtimeTaskRetryPath(taskId), 'POST', request),
  cancelTask: (taskId, request) => runtimeJson(runtimeTaskCancelPath(taskId), 'POST', request),
  pauseTask: (taskId, request) => runtimeJson(runtimeTaskPausePath(taskId), 'POST', request),
  listTaskInputs: (taskId) => runtimeJson(runtimeTaskInputsPath(taskId)),
  appendTaskInput: (taskId, request) => runtimeJson(runtimeTaskInputsPath(taskId), 'POST', request),
  listTaskEvents: (taskId, afterSequence) => runtimeJson(`${runtimeTaskEventsPath(taskId)}${afterSequence ? `?afterSequence=${afterSequence}` : ''}`),
  listTaskInbox: (workspaceRoot) => runtimeJson(`/v1/inbox${workspaceRoot ? `?workspaceRoot=${encodeURIComponent(workspaceRoot)}` : ''}`),
  listTaskTemplates: () => runtimeJson('/v1/task-templates'),
  startTaskTemplate: (templateId, request) => runtimeJson(runtimeTaskTemplateStartPath(templateId), 'POST', request),
  saveTaskTemplate: (templateId, request) => runtimeJson(runtimeTaskTemplateSavePath(templateId), 'POST', request),
  getTaskDiagnostics: (taskId) => runtimeJson(runtimeTaskDiagnosticsPath(taskId)),
  exportTaskDiagnostics: (taskId) => ipcRenderer.invoke('diagnostics:export-task', { taskId }),
  listShellSessions: (taskId) => {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
    return runtimeJson(`${RUNTIME_SHELL_SESSIONS_PATH}${query}`)
  },
  terminateShellSession: (sessionId, request) =>
    runtimeJson(runtimeShellSessionTerminatePath(sessionId), 'POST', request),
  fetchUpstreamModels: () => ipcRenderer.invoke('upstream:models'),
  getClawStatus: () => ipcRenderer.invoke('claw:status'),
  runClawTask: (taskId) =>
    ipcRenderer.invoke('claw:task:run', taskId),
  getScheduleStatus: () => ipcRenderer.invoke('schedule:status'),
  runScheduleTask: (taskId) =>
    ipcRenderer.invoke('schedule:task:run', taskId),
  startClawImInstallQr: (provider, options) =>
    ipcRenderer.invoke('claw:im-install:qrcode', { provider, isLark: options?.isLark }),
  pollClawImInstall: (provider, deviceCode) =>
    ipcRenderer.invoke('claw:im-install:poll', { provider, deviceCode }),
  getWeixinBridgeStatus: (accountId) =>
    ipcRenderer.invoke('claw:weixin-status', { accountId }),
  getImHealth: (channelId) => ipcRenderer.invoke('claw:im:health', { channelId }),
  startIm: (channelId) => ipcRenderer.invoke('claw:im:start', { channelId }),
  reconnectIm: (channelId) => ipcRenderer.invoke('claw:im:reconnect', { channelId }),
  stopIm: (channelId) => ipcRenderer.invoke('claw:im:stop', { channelId }),
  disconnectIm: (channelId) => ipcRenderer.invoke('claw:im:disconnect', { channelId }),
  selfCheckIm: (channelId) => ipcRenderer.invoke('claw:im:self-check', { channelId }),
  getImDiagnostics: () => ipcRenderer.invoke('claw:im:diagnostics'),
  pickWorkspaceDirectory: (defaultPath) =>
    ipcRenderer.invoke('workspace:pick-directory', defaultPath),
  pickPluginPackage: (mode) => ipcRenderer.invoke('plugin:pick-package', { mode }),
  confirmDialog: (options) =>
    ipcRenderer.invoke('dialog:confirm', options),
  listCatalogSources: () => ipcRenderer.invoke('catalog:list-sources'),
  listCatalogPackages: () => ipcRenderer.invoke('catalog:list-packages'),
  getCatalogSnapshot: (sourceId) => ipcRenderer.invoke('catalog:get-snapshot', { sourceId }),
  upsertCatalogSource: (source) => ipcRenderer.invoke('catalog:upsert-source', source),
  listCatalogCredentialStatuses: () => ipcRenderer.invoke('catalog:list-credential-statuses'),
  setCatalogSourceCredential: (sourceId, accessToken) =>
    ipcRenderer.invoke('catalog:set-credential', { sourceId, accessToken }),
  clearCatalogSourceCredential: (sourceId) =>
    ipcRenderer.invoke('catalog:clear-credential', { sourceId }),
  removeCatalogSource: (sourceId) => ipcRenderer.invoke('catalog:remove-source', { sourceId }),
  syncCatalogSource: (sourceId) => ipcRenderer.invoke('catalog:sync-source', { sourceId }),
  listInstalledPlugins: () => ipcRenderer.invoke('plugin:list-installed'),
  listPluginUpdateDiagnostics: () => ipcRenderer.invoke('plugin:list-update-diagnostics'),
  preparePluginImport: (request) => ipcRenderer.invoke('plugin:prepare-import', request),
  prepareCatalogPlugin: (request) => ipcRenderer.invoke('plugin:prepare-catalog', request),
  cancelPluginImport: (preparedId) => ipcRenderer.invoke('plugin:cancel-import', { preparedId }),
  installPreparedPlugin: (request) => ipcRenderer.invoke('plugin:install', request),
  rollbackPlugin: (request) => ipcRenderer.invoke('plugin:rollback', request),
  updatePluginPermissions: (request) => ipcRenderer.invoke('plugin:update-permissions', request),
  listSkills: (workspaceRoot) =>
    ipcRenderer.invoke('skill:list', { workspaceRoot }),
  refreshSkills: (workspaceRoot) =>
    ipcRenderer.invoke('skill:refresh', { workspaceRoot }),
  onSkillsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, generation: number): void => listener(generation)
    ipcRenderer.on('skills:changed', wrapped)
    return () => ipcRenderer.removeListener('skills:changed', wrapped)
  },
  saveSkillFile: (rootPath, skillName, content) =>
    ipcRenderer.invoke('skill:save-file', { rootPath, skillName, content }),
  installGithubSkill: (rootPath, source) =>
    ipcRenderer.invoke('skill:install-github', { rootPath, source }),
  installBundledSkill: (rootPath, source) =>
    ipcRenderer.invoke('skill:install-bundled', { rootPath, source }),
  installBundledAgentPack: (source) =>
    ipcRenderer.invoke('agent-pack:install-bundled', { source }),
  syncGithubSkills: (workspaceRoot) =>
    ipcRenderer.invoke('skill:sync-github', { workspaceRoot }),
  listManagedTools: () => ipcRenderer.invoke('tool:list-managed'),
  installManagedTool: (id) => ipcRenderer.invoke('tool:install-managed', id),
  updateManagedTool: (id) => ipcRenderer.invoke('tool:update-managed', id),
  diagnoseManagedTool: (id) => ipcRenderer.invoke('tool:diagnose-managed', id),
  beginManagedLarkLogin: (input) => ipcRenderer.invoke('tool:lark-login:begin', input),
  completeManagedLarkLogin: () => ipcRenderer.invoke('tool:lark-login:complete'),
  beginManagedLarkAppSetup: () => ipcRenderer.invoke('tool:lark-app-setup:begin'),
  checkManagedLarkAppSetup: () => ipcRenderer.invoke('tool:lark-app-setup:check'),
  cancelManagedLarkAppSetup: () => ipcRenderer.invoke('tool:lark-app-setup:cancel'),
  diagnoseManagedDingTalk: () => ipcRenderer.invoke('tool:dingtalk:diagnose'),
  checkManagedDingTalkTaskAccess: () => ipcRenderer.invoke('tool:dingtalk:check-task-access'),
  installManagedDingTalk: () => ipcRenderer.invoke('tool:dingtalk:install'),
  beginManagedDingTalkLogin: () => ipcRenderer.invoke('tool:dingtalk:login-begin'),
  checkManagedDingTalkLogin: () => ipcRenderer.invoke('tool:dingtalk:login-check'),
  cancelManagedDingTalkLogin: () => ipcRenderer.invoke('tool:dingtalk:login-cancel'),
  setManagedDingTalkEnabled: (enabled) => ipcRenderer.invoke('tool:dingtalk:set-enabled', enabled),
  removeManagedTool: (id) => ipcRenderer.invoke('tool:remove-managed', id),
  listAgentProfiles: (workspaceRoot) => ipcRenderer.invoke('agent-profile:list', { workspaceRoot }),
  saveAgentProfile: (request) => ipcRenderer.invoke('agent-profile:save', request),
  setThreadAgent: async (threadId, request) => {
    const thread = await runtimeJson<{ workspace: string }>(runtimeThreadPath(threadId))
    const snapshot = await ipcRenderer.invoke('agent-profile:list', {
      workspaceRoot: thread.workspace
    }) as Awaited<ReturnType<WorkWiseApi['listAgentProfiles']>>
    const selected = snapshot.profiles.find((profile) => profile.id === request.agentId)
    if (!selected) throw new Error(`Agent profile not found: ${request.agentId}`)
    const { builtIn: _builtIn, source: _source, path: _path, ...profile } = selected
    return runtimeJson<Awaited<ReturnType<WorkWiseApi['setThreadAgent']>>>(runtimeThreadAgentPath(threadId), 'POST', {
      agentId: request.agentId,
      profile,
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey
    })
  },
  getWorkspaceTrust: (workspaceRoot) => ipcRenderer.invoke('workspace-trust:get', { workspaceRoot }),
  scanLegacyWorkspaces: () => ipcRenderer.invoke('workspace-migration:scan'),
  getLegacyWorkspaceAliases: () => ipcRenderer.invoke('workspace-migration:aliases'),
  importLegacyWorkspaceSnapshot: (request) => ipcRenderer.invoke('workspace-migration:import-snapshot', request),
  setWorkspaceTrust: (request) => ipcRenderer.invoke('workspace-trust:set', request),
  listMcpServers: (workspaceRoot) => ipcRenderer.invoke('mcp-server:list', { workspaceRoot }),
  saveMcpServer: (request) => {
    const config = { ...request.config }
    delete config.connectionCheck
    return ipcRenderer.invoke('mcp-server:save', { ...request, config })
  },
  testMcpServer: (serverId, workspaceRoot) => ipcRenderer.invoke('mcp-server:test', { serverId, workspaceRoot }),
  authorizeMcpServer: (request) => ipcRenderer.invoke('mcp-server:authorize', request),
  waitForMcpAuthorization: (serverId, state) =>
    ipcRenderer.invoke('mcp-server:wait-authorization', { serverId, state }),
  cancelMcpAuthorization: (serverId, state) =>
    ipcRenderer.invoke('mcp-server:cancel-authorization', { serverId, state }),
  setMcpServerCredential: (request) => ipcRenderer.invoke('mcp-server:set-credential', request),
  openTaskArtifact: (request) => ipcRenderer.invoke('task-artifact:open', request),
  previewTaskArtifact: (request) => ipcRenderer.invoke('task-artifact:preview', request),
  listDocumentEngines: () => ipcRenderer.invoke('document-engine:list'),
  installDocumentEngine: (id) => ipcRenderer.invoke('document-engine:install', id),
  diagnoseDocumentEngine: (id) => ipcRenderer.invoke('document-engine:diagnose', id),
  parseDocument: (request) => ipcRenderer.invoke('document-engine:parse', request),
  importChatAttachment: (request) => ipcRenderer.invoke('attachment:import-file', request),
  cancelChatAttachmentImport: (importId) => ipcRenderer.invoke('attachment:cancel-import', importId),
  openChatAttachmentOriginal: (managedPath) => ipcRenderer.invoke('attachment:open-original', managedPath),
  cancelDocumentParse: (parseId) => ipcRenderer.invoke('document-engine:cancel', parseId),
  previewWorkspaceFile: (request) => ipcRenderer.invoke('file:preview-workspace', request),
  openSkillRoot: (rootPath) =>
    ipcRenderer.invoke('skill:open-root', rootPath),
  getRuntimeConfigFile: () =>
    ipcRenderer.invoke('runtime:config:read'),
  setRuntimeConfigFile: (content) =>
    ipcRenderer.invoke('runtime:config:write', content),
  openRuntimeConfigDir: () =>
    ipcRenderer.invoke('runtime:config:open-dir'),
  getGitBranches: (workspaceRoot) =>
    ipcRenderer.invoke('git:branches', workspaceRoot),
  switchGitBranch: (workspaceRoot, branch) =>
    ipcRenderer.invoke('git:switch-branch', { workspaceRoot, branch }),
  createAndSwitchGitBranch: (workspaceRoot, branch) =>
    ipcRenderer.invoke('git:create-and-switch-branch', { workspaceRoot, branch }),
  createGitCheckpoint: (request) => ipcRenderer.invoke('git:checkpoint:create', request),
  previewGitRollback: (request) => ipcRenderer.invoke('git:rollback:preview', request),
  applyGitRollback: (request) => ipcRenderer.invoke('git:rollback:apply', request),
  buildRepoMap: (request) => ipcRenderer.invoke('repo-map:build', request),
  queryRepoMap: (request) => ipcRenderer.invoke('repo-map:query', request),
  lspRequest: (request) => ipcRenderer.invoke('lsp:request', request),
  listEditors: () => ipcRenderer.invoke('editor:list'),
  openEditorPath: (options) =>
    ipcRenderer.invoke('editor:open-path', options),
  listWorkspaceDirectory: (options) =>
    ipcRenderer.invoke('file:list-workspace-directory', options),
  resolveWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:resolve-workspace', options),
  readWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:read-workspace', options),
  readWorkspaceImage: (options) =>
    ipcRenderer.invoke('file:read-workspace-image', options),
  openWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:open-workspace', options),
  revealWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:reveal-workspace', options),
  saveWorkspaceFileAs: (payload) =>
    ipcRenderer.invoke('file:save-as', payload),
  writeWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:write-workspace', payload),
  readDocumentSnapshot: (payload) =>
    ipcRenderer.invoke('file:read-document-snapshot', payload),
  searchWorkspaceDocuments: (payload) =>
    ipcRenderer.invoke('file:search-workspace-documents', payload),
  writeDocumentChecked: (payload) =>
    ipcRenderer.invoke('file:write-document-checked', payload),
  listDocumentHistory: (payload) =>
    ipcRenderer.invoke('file:list-document-history', payload),
  getDocumentHistoryEntry: (payload) =>
    ipcRenderer.invoke('file:get-document-history', payload),
  restoreDocumentHistory: (payload) =>
    ipcRenderer.invoke('file:restore-document-history', payload),
  listDocumentComments: (payload) =>
    ipcRenderer.invoke('file:list-document-comments', payload),
  createDocumentComment: (payload) =>
    ipcRenderer.invoke('file:create-document-comment', payload),
  updateDocumentComment: (payload) =>
    ipcRenderer.invoke('file:update-document-comment', payload),
  getDocumentSemantics: (payload) =>
    ipcRenderer.invoke('file:get-document-semantics', payload),
  createWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:create-workspace', payload),
  createWorkspaceDirectory: (payload) =>
    ipcRenderer.invoke('file:create-workspace-directory', payload),
  saveWorkspaceClipboardImage: (payload) =>
    ipcRenderer.invoke('file:save-workspace-clipboard-image', payload),
  readClipboardImage: () =>
    ipcRenderer.invoke('clipboard:read-image'),
  verifyPptMasterDeliverable: (payload) =>
    ipcRenderer.invoke('ppt:deliverable:verify', payload),
  pptMasterPythonEnvStatus: () =>
    ipcRenderer.invoke('ppt:python-env:status'),
  pptMasterPythonEnsure: () =>
    ipcRenderer.invoke('ppt:python-env:ensure'),
  onPptMasterPythonEnvProgress: (callback) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      progress: Parameters<typeof callback>[0]
    ) => callback(progress)
    ipcRenderer.on('ppt:python-env:progress', wrapped)
    return () => ipcRenderer.removeListener('ppt:python-env:progress', wrapped)
  },
  renameWorkspaceEntry: (payload) =>
    ipcRenderer.invoke('file:rename-workspace-entry', payload),
  deleteWorkspaceEntry: (payload) =>
    ipcRenderer.invoke('file:delete-workspace-entry', payload),
  watchWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:watch-workspace', payload),
  unwatchWorkspaceFile: (watchId) =>
    ipcRenderer.invoke('file:unwatch-workspace', watchId),
  onWorkspaceFileChanged: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('file:workspace-changed', wrapped)
    return () => ipcRenderer.removeListener('file:workspace-changed', wrapped)
  },
  exportWriteDocument: (payload) =>
    ipcRenderer.invoke('write:export', payload),
  renderWriteMermaidPreview: (payload) =>
    ipcRenderer.invoke('write:mermaid-preview', payload),
  copyWriteDocumentAsRichText: (payload) =>
    ipcRenderer.invoke('write:copy-rich-text', payload),
  exportDesignToPptx: (payload) =>
    ipcRenderer.invoke('design:export-pptx', payload),
  listDesignDocuments: (payload) =>
    ipcRenderer.invoke('design:document:list', payload),
  loadDesignDocument: (payload) =>
    ipcRenderer.invoke('design:document:load', payload),
  saveDesignDocument: (payload) =>
    ipcRenderer.invoke('design:document:save', payload),
  importDesignImageAsset: (payload) =>
    ipcRenderer.invoke('design:asset:import-image', payload),
  readDesignAsset: (payload) =>
    ipcRenderer.invoke('design:asset:read', payload),
  importPptxToDesign: (payload) =>
    ipcRenderer.invoke('design:import-pptx', payload),
  readDesignPptxRevision: (payload) =>
    ipcRenderer.invoke('design:pptx-revision:read', payload),
  saveDesignPptxRevision: (payload) =>
    ipcRenderer.invoke('design:pptx-revision:save', payload),
  exportDesignPptxBytes: (payload) =>
    ipcRenderer.invoke('design:export-pptx-bytes', payload),
  saveDesignAssetToWrite: (payload) =>
    ipcRenderer.invoke('design:save-to-write', payload),
  renderPresetShape: (payload) =>
    ipcRenderer.invoke('design:render-preset', payload),
  listPresetShapes: () =>
    ipcRenderer.invoke('design:list-presets'),
  generateAgnesImage: (payload) =>
    ipcRenderer.invoke('write:agnes-image-generate', payload),
  requestWriteInlineCompletion: (payload) =>
    ipcRenderer.invoke('write:inline-completion', payload),
  generateWriteInfographic: (payload) =>
    ipcRenderer.invoke('write:generate-infographic', payload),
  listWriteInlineCompletionDebugEntries: () =>
    ipcRenderer.invoke('write:inline-completion-debug:list'),
  clearWriteInlineCompletionDebugEntries: () =>
    ipcRenderer.invoke('write:inline-completion-debug:clear'),
  getWriteKnowledgeBaseStatus: () => ipcRenderer.invoke('write:knowledge-base:status'),
  refreshWriteKnowledgeBase: () => ipcRenderer.invoke('write:knowledge-base:refresh'),
  searchWriteKnowledge: (query) => ipcRenderer.invoke('write:knowledge-base:search', { query }),
  startSse: (threadId, sinceSeq, streamId) =>
    ipcRenderer.invoke('runtime:sse:start', { threadId, sinceSeq, streamId }),
  stopSse: (streamId) => ipcRenderer.invoke('runtime:sse:stop', streamId),
  onSseEvent: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-event', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-event', wrapped)
  },
  onSseEnd: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-end', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-end', wrapped)
  },
  onSseError: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-error', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-error', wrapped)
  },
  onClawChannelActivity: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('claw:channel-activity', wrapped)
    return () => ipcRenderer.removeListener('claw:channel-activity', wrapped)
  },
  onImHealthChanged: (handler) => {
    const wrapped = (_: Electron.IpcRendererEvent, payload: Parameters<typeof handler>[0]) => handler(payload)
    ipcRenderer.on('claw:im:health-changed', wrapped)
    return () => ipcRenderer.removeListener('claw:im:health-changed', wrapped)
  },
  mirrorClawChannelMessage: (threadId, text, direction, options) =>
    ipcRenderer.invoke('claw:channel:mirror', { threadId, text, direction, ...options }),
  mirrorClawChannelMessageToFeishu: (threadId, text, direction, options) =>
    ipcRenderer.invoke('claw:channel:mirror-to-feishu', { threadId, text, direction, ...options }),
  createClawTaskFromText: (text, options) =>
    ipcRenderer.invoke('claw:task:create-from-text', {
      text,
      channelId: options?.channelId,
      modelHint: options?.modelHint,
      mode: options?.mode
    }),
  createScheduleTaskFromText: (text, options) =>
    ipcRenderer.invoke('schedule:task:create-from-text', {
      text,
      workspaceRoot: options?.workspaceRoot,
      modelHint: options?.modelHint,
      mode: options?.mode
    }),
  runDesktopCommand: (command) =>
    ipcRenderer.invoke('desktop:command', command),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDingTalkDesktop: () => ipcRenderer.invoke('shell:open-dingtalk-desktop'),
  showTurnCompleteNotification: (payload) => ipcRenderer.invoke('notification:turn-complete', payload),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getGuiUpdateState: () => ipcRenderer.invoke('gui:update-state'),
  checkGuiUpdate: (channel) =>
    ipcRenderer.invoke('gui:update-check', channel),
  downloadGuiUpdate: (channel) =>
    ipcRenderer.invoke('gui:update-download', channel),
  preflightGuiUpdateInstall: () => ipcRenderer.invoke('gui:update-install-preflight'),
  installGuiUpdate: (request) => ipcRenderer.invoke('gui:update-install', request),
  onGuiUpdateState: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('gui:update-state', wrapped)
    return () => ipcRenderer.removeListener('gui:update-state', wrapped)
  },
  logError: (category, message, detail) =>
    ipcRenderer.invoke('log:error', { category, message, detail }),
  getLogPath: () => ipcRenderer.invoke('log:get-path'),
  openLogDir: () => ipcRenderer.invoke('log:open-dir'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
} satisfies WorkWiseApi

contextBridge.exposeInMainWorld('workwise', api)
// Deprecated compatibility boundary for 0.2.x renderers. Remove after 0.3.x.
contextBridge.exposeInMainWorld('kunGui', api)
