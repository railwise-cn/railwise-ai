import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type WebContents } from 'electron'
import brand from '../../shared/product-brand.json'
import { watch, type FSWatcher } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import {
  type AppSettingsPatch,
  type AppSettingsV1,
  type ClawRunResult,
  type ClawTaskFromTextResult,
  type ClawRuntimeStatus,
  type ScheduleRunResult,
  type ScheduleRuntimeStatus,
  type ScheduleTaskFromTextResult
} from '../../shared/app-settings'
import type {
  ClawImInstallPollResult,
  ClawImInstallQrResult,
  DesktopCommand,
  RuntimeRequestResult,
  SystemNotificationResult,
  TurnCompleteNotificationPayload,
  UpstreamModelsResult,
  WorkspacePickResult
} from '../../shared/workwise-api'
import type { WorkspaceFileSaveAsResult } from '../../shared/workspace-file'
import type {
  GuiUpdateActiveWorkItem,
  GuiUpdateDownloadResult,
  GuiUpdateInfo,
  GuiUpdateInstallPreflight,
  GuiUpdateInstallResult,
  GuiUpdateState
} from '../../shared/gui-update'
import { isCandidateImProviderConnectionAllowed } from '../candidate-runtime'
import type { DesignAsset } from '../../shared/design-document'
import { canonicalizeContainmentRoot, isCanonicalPathContained } from '../services/canonical-containment'
import {
  agentProfileListPayloadSchema,
  agentProfileSavePayloadSchema,
  clawMirrorPayloadSchema,
  clawImInstallPollPayloadSchema,
  confirmDialogPayloadSchema,
  clawTaskFromTextPayloadSchema,
  bundledAgentPackInstallPayloadSchema,
  cancelOperationPayloadSchema,
  bundledSkillInstallPayloadSchema,
  runtimeConfigContentSchema,
  desktopCommandSchema,
  documentEngineIdSchema,
  diagnosticsExportPayloadSchema,
  documentParsePayloadSchema,
  defaultPathSchema,
  gitBranchPayloadSchema,
  gitCheckpointCreatePayloadSchema,
  gitRollbackApplyPayloadSchema,
  gitRollbackPreviewPayloadSchema,
  githubSkillInstallPayloadSchema,
  githubSkillSyncPayloadSchema,
  guiUpdateChannelSchema,
  logErrorPayloadSchema,
  lspRequestPayloadSchema,
  managedToolIdSchema,
  catalogSourceCredentialPayloadSchema,
  catalogSourceIdPayloadSchema,
  catalogSourcePayloadSchema,
  pluginInstallPayloadSchema,
  pluginPackagePickerPayloadSchema,
  pluginPrepareCatalogPayloadSchema,
  pluginPreparedIdPayloadSchema,
  pluginPrepareImportPayloadSchema,
  pluginRollbackPayloadSchema,
  pluginPermissionsUpdatePayloadSchema,
  mcpServerActionPayloadSchema,
  mcpServerAuthorizationStatePayloadSchema,
  mcpServerAuthorizePayloadSchema,
  mcpServerCredentialPayloadSchema,
  mcpServerListPayloadSchema,
  mcpServerSavePayloadSchema,
  notificationPayloadSchema,
  openEditorPathPayloadSchema,
  rootPathSchema,
  repoMapBuildPayloadSchema,
  repoMapQueryPayloadSchema,
  runtimeRequestPayloadSchema,
  scheduleTaskFromTextPayloadSchema,
  shellOpenExternalUrlSchema,
  skillListPayloadSchema,
  skillSaveFilePayloadSchema,
  settingsSetPayloadSchema,
  streamIdSchema,
  workspaceDirectoryCreatePayloadSchema,
  workspaceClipboardImageSavePayloadSchema,
  workspaceDirectoryTargetPayloadSchema,
  workspaceEntryDeletePayloadSchema,
  workspaceEntryRenamePayloadSchema,
  workspaceFileCreatePayloadSchema,
  workspaceFileSaveAsPayloadSchema,
  workspaceFileTargetPayloadSchema,
  workspaceFileWatchPayloadSchema,
  workspaceFileWritePayloadSchema,
  workspacePreviewPayloadSchema,
  workspaceTrustGetPayloadSchema,
  workspaceTrustSetPayloadSchema,
  writeAgnesImageGenerationPayloadSchema,
  writeExportPayloadSchema,
  writeRichClipboardPayloadSchema,
  designExportPayloadSchema,
  designDocumentListPayloadSchema,
  designDocumentLoadPayloadSchema,
  designDocumentSavePayloadSchema,
  designImageImportPayloadSchema,
  designAssetReadPayloadSchema,
  designPptxImportPayloadSchema,
  designPresetRenderSchema,
  designWriteAssetPayloadSchema,
  writeInfographicPayloadSchema,
  writeInlineCompletionPayloadSchema,
  writeKnowledgeSearchPayloadSchema,
  workspaceRootSchema,
  pptMasterDeliverableVerifyPayloadSchema
} from './app-ipc-schemas'
import type { JsonSettingsStore } from '../settings-store'
import type { ClawRuntime } from '../claw-runtime'
import type { ScheduleRuntime } from '../schedule-runtime'
import { assertGitWorkspaceAllowed, createAndSwitchGitBranch, getGitBranches, switchGitBranch } from '../services/git-service'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  expandHomePath,
  listEditorsResult,
  listWorkspaceDirectory,
  normalizeSkillFolderName,
  openEditorPath,
  openPathWithShell,
  readClipboardImage,
  readWorkspaceImage,
  readWorkspaceFile,
  renameWorkspaceEntry,
  resolveOpenTargetPath,
  resolveWorkspaceFile,
  saveWorkspaceClipboardImage,
  writeWorkspaceFile
} from '../services/workspace-service'
import {
  clearWriteInlineCompletionDebugEntries,
  listWriteInlineCompletionDebugEntries,
  requestWriteInlineCompletion
} from '../services/write-inline-completion-service'
import { requestWriteInfographic } from '../services/write-infographic-service'
import { verifyPptMasterDeliverable } from '../services/ppt-master-deliverable-verify'
import {
  ensurePptMasterPythonEnv,
  getPptMasterPythonEnvStatus
} from '../services/ppt-master-python-env'
import { refreshWriteKnowledgeBase, searchWriteKnowledge } from '../services/write-knowledge-service'
import { copyWriteDocumentAsRichText, exportWriteDocument } from '../services/write-export-service'
import { exportDesignToPptx } from '../services/design-export-service'
import { importPptxToDesign } from '../services/design-import-service'
import { renderPresetShape, listPresetShapes } from '../services/design-preset-service'
import { saveDesignAssetToWrite } from '../services/design-write-service'
import {
  listDesignDocuments,
  loadDesignDocument,
  readDesignAsset,
  readSafeDesignImageSource,
  saveDesignDocument,
  storeDesignImageAsset
} from '../services/design-document-service'
import { normalizeDesignDocument } from '../../shared/design-document'
import { generateAgnesImage } from '../services/write-agnes-image-service'
import {
  installBundledSkill,
  installGithubSkill,
  listGuiSkills,
  syncGithubManagedSkills
} from '../services/skill-service'
import { installBundledAgentPack } from '../services/agent-pack-service'
import {
  diagnoseManagedTool,
  installManagedTool,
  listManagedTools,
  removeManagedTool,
  updateManagedTool
} from '../services/managed-tool-service'
import { appCancellationRegistry } from '../cancellation-registry'
import { runtimeThreadInterruptPath } from '../../shared/runtime-endpoints'
import { atomicWriteFile as durableWriteFile } from '../services/durable-file'
import { AgentProfileService } from '../services/agent-profile-service'
import { WorkspaceTrustService } from '../services/workspace-trust-service'
import { DocumentEngineService } from '../services/document-engine-service'
import { ChatAttachmentImportService } from '../services/chat-attachment-import-service'
import { WorkspacePreviewService } from '../services/workspace-preview-service'
import { GitCheckpointService } from '../services/git-checkpoint-service'
import { RepoMapService } from '../services/repo-map-service'
import { McpConfigService } from '../services/mcp-config-service'
import { CatalogCredentialService } from '../services/catalog-credential-service'
import { activatePluginPackage } from '../services/plugin-activation-service'
import { MarketplaceCatalogService } from '../services/marketplace-catalog-service'
import { PluginManagementService } from '../services/plugin-management-service'
import type { CatalogSourceV1 } from '../../shared/marketplace'
import type { DocumentEngineId } from '../../shared/agent-workbench'
import {
  hasLegacyImChannelCredential,
  protectImChannelCredentials,
  sanitizeImChannelCredentials,
  type ImCredentialService
} from '../services/im-credential-service'
import type { ImDeliveryLedger } from '../services/im-delivery-ledger'
import type { ImHealthService } from '../services/im-health-service'

type GuiUpdaterModule = typeof import('../gui-updater')

function stableGitIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  if (code === 'workspace_not_allowed' || /active workspace/i.test(message)) {
    return 'Git workspace must stay within the active workspace.'
  }
  return 'Git operation is temporarily unavailable.'
}

function stableGitIpcReason(error: unknown): 'workspace_not_allowed' | 'error' {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  return code === 'workspace_not_allowed' || /active workspace/i.test(message)
    ? 'workspace_not_allowed'
    : 'error'
}

type WorkspaceFileWatchRecord = {
  watcher: FSWatcher
  sender: WebContents
  path: string
  workspaceRoot: string
  timer: ReturnType<typeof setTimeout> | null
}

type RegisterAppIpcHandlersOptions = {
  store: JsonSettingsStore
  getMainWindow: () => BrowserWindow | null
  applySettingsPatch: (partial: AppSettingsPatch, expectedRevision?: number) => Promise<AppSettingsV1>
  runtimeRequest: (
    path: string,
    method?: string,
    body?: string
  ) => Promise<RuntimeRequestResult>
  runtimeFileRequest?: (path: string, filePath: string, headers: Record<string, string>) => Promise<RuntimeRequestResult>
  fetchUpstreamModels: () => Promise<UpstreamModelsResult>
  getClawRuntime: () => ClawRuntime | null
  getScheduleRuntime: () => ScheduleRuntime | null
  startFeishuInstallQrcode: (isLark: boolean) => Promise<ClawImInstallQrResult>
  pollFeishuInstall: (deviceCode: string) => Promise<ClawImInstallPollResult>
  startWeixinInstallQrcode: (weixinBridgeUrl?: string) => Promise<ClawImInstallQrResult>
  pollWeixinInstall: (deviceCode: string, weixinBridgeUrl?: string) => Promise<ClawImInstallPollResult>
  getWeixinBridgeAccountStatuses: (accountId?: string) => Promise<import('../../shared/workwise-api').WeixinBridgeAccountStatusV1[]>
  isWeixinBridgeAccountConfigured: (accountId: string) => Promise<boolean>
  getImHealthService?: () => ImHealthService | null
  getImCredentialService?: () => ImCredentialService | null
  getImDeliveryLedger?: () => ImDeliveryLedger | null
  getUserDataPath?: () => string
  resolveRuntimeConfigPath: () => string
  onRuntimeMcpConfigWritten?: (path: string, content: string) => Promise<void> | void
  showTurnCompleteNotification: (
    payload: TurnCompleteNotificationPayload
  ) => Promise<SystemNotificationResult>
  getAppVersion: () => string
  readGuiUpdateState: () => Promise<GuiUpdateState>
  loadGuiUpdaterModule: () => Promise<GuiUpdaterModule>
  resolveLogDirectory: () => string
  logError: (category: string, message: string, detail?: unknown) => void
  marketplaceCatalogService?: MarketplaceCatalogService
  catalogCredentialService?: CatalogCredentialService
  pluginManagementService?: PluginManagementService
  mcpConfigService?: McpConfigService
}

function parseIpcPayload<T>(channel: string, schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw new Error(`Invalid payload for ${channel}: ${issue?.message ?? 'Bad request.'}`)
}

function safeSaveAsFileName(input: string | undefined, fallback = 'generated-file'): string {
  const candidate = (input ?? '').trim().replace(/\0/g, '')
  const name = basename(candidate) || fallback
  if (name === '.' || name === '..') return fallback
  return name
}

async function collectGuiUpdateActiveWork(
  runtimeRequest: RegisterAppIpcHandlersOptions['runtimeRequest']
): Promise<GuiUpdateInstallPreflight> {
  const active: GuiUpdateActiveWorkItem[] = []
  try {
    const tasks = await runtimeRequest('/v1/tasks?limit=500', 'GET')
    if (tasks.ok) {
      const values = JSON.parse(tasks.body) as Array<Record<string, unknown>>
      for (const task of Array.isArray(values) ? values : []) {
        const status = typeof task.status === 'string' ? task.status : ''
        if (['completed', 'failed', 'cancelled'].includes(status)) continue
        active.push({
          kind: 'agent',
          id: String(task.id ?? ''),
          label: String(task.goal ?? task.id ?? 'Agent task'),
          status,
          recoverable: true
        })
      }
    }

    const flowsResponse = await runtimeRequest('/v1/flows', 'GET')
    if (flowsResponse.ok) {
      const payload = JSON.parse(flowsResponse.body) as { flows?: Array<Record<string, unknown>> }
      for (const flow of payload.flows ?? []) {
        const flowId = String(flow.id ?? '')
        if (!flowId) continue
        const history = await runtimeRequest(`/v1/flows/${encodeURIComponent(flowId)}/history?limit=20`, 'GET')
        if (!history.ok) continue
        const historyPayload = JSON.parse(history.body) as { runs?: Array<Record<string, unknown>> }
        const nodes = Array.isArray(flow.nodes) ? flow.nodes as Array<Record<string, unknown>> : []
        const scheduled = nodes.some((node) => node.type === 'schedule_trigger')
        for (const run of historyPayload.runs ?? []) {
          const status = typeof run.status === 'string' ? run.status : ''
          if (!['queued', 'running', 'waiting_approval', 'paused'].includes(status)) continue
          active.push({
            kind: scheduled ? 'schedule' : 'flow',
            id: String(run.id ?? flowId),
            label: String(flow.name ?? flowId),
            status,
            recoverable: status !== 'running' || nodes.every((node) => {
              const policy = node.policy as Record<string, unknown> | undefined
              return policy?.resumable !== false
            })
          })
        }
      }
    }
    return { ok: true, activeWork: active }
  } catch (error) {
    return {
      ok: false,
      activeWork: active,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function runtimeResponseMessage(result: RuntimeRequestResult): string {
  try { const value = JSON.parse(result.body) as { message?: unknown }; if (typeof value.message === 'string') return value.message } catch { /* use status */ }
  return `Runtime request failed (${result.status})`
}

export function buildAttachmentSections(attachmentId: string, text: string, document?: {
  headings: Array<{ text: string; page?: number }>
  tables: Array<{ markdown: string; page?: number }>
  sourceStructure?: { pageCount?: number; worksheets?: string[]; slideCount?: number }
}): Array<{
  id: string; attachmentId: string; ordinal: number; text: string; tokenEstimate: number;
  provenance: { heading?: string; page?: number; table?: string; worksheet?: string; slide?: number }; createdAt: string
}> {
  const pageMarkerPattern = /<!--\s*page\s*:\s*(\d+)\s*-->/gi
  const pageAnchors: Array<{ token: number; page: number }> = []
  let cleanText = ''
  let sourceOffset = 0
  for (const marker of text.matchAll(pageMarkerPattern)) {
    cleanText += text.slice(sourceOffset, marker.index)
    const page = Number(marker[1])
    if (Number.isSafeInteger(page) && page > 0 && page <= (document?.sourceStructure?.pageCount ?? 0)) {
      pageAnchors.push({ token: tokenizeAttachmentText(cleanText).length, page })
    }
    cleanText += ' '
    sourceOffset = marker.index + marker[0].length
  }
  cleanText += text.slice(sourceOffset)
  const tokens = tokenizeAttachmentText(cleanText)
  const tokenOffset = (characterOffset: number): number => tokenizeAttachmentText(cleanText.slice(0, characterOffset)).length
  type ProvenanceAnchor = { token: number; heading?: string; page?: number; worksheet?: string; slide?: number }
  const anchors: ProvenanceAnchor[] = [
    ...(document?.headings ?? []).flatMap((heading) => { const offset = cleanText.indexOf(heading.text); return offset < 0 ? [] : [{ token: tokenOffset(offset), heading: heading.text, page: heading.page }] }),
    ...(document?.sourceStructure?.worksheets ?? []).flatMap((worksheet) => { const offset = cleanText.indexOf(worksheet); return offset < 0 ? [] : [{ token: tokenOffset(offset), worksheet }] }),
    ...[...cleanText.matchAll(/(?:<!--\s*)?slide(?:\s+number)?\s*[:#-]?\s*(\d+)(?:\s*-->)?/gi)].map((match) => ({ token: tokenOffset(match.index), slide: Number(match[1]) }))
  ].sort((left, right) => left.token - right.token)
  const tableAnchors = (document?.tables ?? []).flatMap((table, index) => {
    const probes = [table.markdown, ...table.markdown.split(/[|\n]/)].map((value) => value.trim()).filter((value) => value && !/^[-:]+$/.test(value))
    const offset = probes.map((probe) => cleanText.indexOf(probe)).find((candidate) => candidate >= 0) ?? -1
    return offset < 0 ? [] : [{ token: tokenOffset(offset), table: `table-${index + 1}`, page: table.page }]
  })
  const sections: Array<{ id: string; attachmentId: string; ordinal: number; text: string; tokenEstimate: number; provenance: { heading?: string; page?: number; table?: string; worksheet?: string; slide?: number }; createdAt: string }> = []; const createdAt = new Date().toISOString(); const target = 1200; const stride = 1050
  for (let cursor = 0; cursor < tokens.length; cursor += stride) {
    const chunk = tokens.slice(cursor, cursor + target); const sectionText = chunk.join(' '); if (!sectionText) break
    const ordinal: number = sections.length
    const activeAnchors = anchors.filter((item) => item.token <= cursor + target)
    const headingAnchor = [...activeAnchors].reverse().find((item) => item.heading)
    const worksheetAnchor = [...activeAnchors].reverse().find((item) => item.worksheet)
    const slideAnchor = [...activeAnchors].reverse().find((item) => item.slide)
    const table = tableAnchors.find((item) => item.token >= cursor && item.token < cursor + target)
    const pageAnchor = [...pageAnchors].reverse().find((item) => item.token <= cursor)
      ?? pageAnchors.find((item) => item.token < cursor + target)
    const provenance = {
      ...(headingAnchor?.heading ? { heading: headingAnchor.heading } : {}), ...(worksheetAnchor?.worksheet ? { worksheet: worksheetAnchor.worksheet } : {}),
      ...(slideAnchor?.slide ? { slide: slideAnchor.slide } : {}), ...(table?.table ? { table: table.table } : {}),
      ...((table?.page ?? headingAnchor?.page ?? pageAnchor?.page) ? { page: table?.page ?? headingAnchor?.page ?? pageAnchor?.page } : {})
    }
    sections.push({ id: `sec_${createHash('sha256').update(`${attachmentId}\0${ordinal}\0${sectionText}`).digest('hex').slice(0, 24)}`, attachmentId, ordinal, text: sectionText, tokenEstimate: chunk.length, provenance, createdAt })
    if (cursor + target >= tokens.length) break
  }
  return sections
}

function tokenizeAttachmentText(text: string): string[] {
  return text.normalize('NFC').match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,4}/gu) ?? []
}

export function buildAttachmentParserProvenance(document: {
  engine: DocumentEngineId
  engineVersion: string
}): {
  engine: DocumentEngineId
  version: string
  local: boolean
  parsedAt: string
} {
  return {
    engine: document.engine,
    version: document.engineVersion,
    local: document.engine !== 'mineru-private',
    parsedAt: new Date().toISOString()
  }
}

function saveDialogFilters(fileName: string, mimeType: string | undefined, locale: AppSettingsV1['locale']): Electron.FileFilter[] {
  const ext = extname(fileName).replace(/^\./, '').trim()
  const mime = mimeType?.toLowerCase().trim() ?? ''
  const filters: Electron.FileFilter[] = []
  if (mime.startsWith('image/')) {
    filters.push({ name: locale === 'zh' ? '图片' : 'Images', extensions: ext ? [ext] : ['png', 'jpg', 'jpeg', 'webp', 'gif'] })
  } else if (mime.startsWith('video/')) {
    filters.push({ name: locale === 'zh' ? '视频' : 'Videos', extensions: ext ? [ext] : ['mp4', 'webm', 'mov', 'm4v'] })
  } else if (ext) {
    filters.push({ name: `${ext.toUpperCase()} ${locale === 'zh' ? '文件' : 'file'}`, extensions: [ext] })
  }
  filters.push({ name: locale === 'zh' ? '所有文件' : 'All Files', extensions: ['*'] })
  return filters
}

async function rasterizeImportedDesignSvg(input: {
  bytes: Uint8Array
  width: number
  height: number
}): Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number }> {
  const sourceWidth = Math.max(1, Math.round(input.width))
  const sourceHeight = Math.max(1, Math.round(input.height))
  if (sourceWidth > 32_768 || sourceHeight > 32_768 || input.bytes.byteLength > 32 * 1024 * 1024) {
    throw new Error('The imported slide exceeds the safe rendering limit.')
  }
  const scale = Math.min(1, 4096 / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const directory = await mkdtemp(join(tmpdir(), 'workwise-design-slide-'))
  const sourcePath = join(directory, 'slide.svg')
  let renderer: BrowserWindow | null = null
  try {
    await writeFile(sourcePath, input.bytes)
    renderer = new BrowserWindow({
      show: false,
      width,
      height,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true,
        images: true,
        offscreen: true,
        backgroundThrottling: false,
        partition: `design-pptx-raster-${randomUUID()}`
      }
    })
    renderer.webContents.session.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      (details, callback) => callback({
        cancel: !(details.url.startsWith('file:') || details.url.startsWith('data:'))
      })
    )
    await renderer.loadFile(sourcePath)
    const captured = await renderer.webContents.capturePage({ x: 0, y: 0, width, height })
    if (captured.isEmpty()) throw new Error('The imported slide could not be rendered.')
    // capturePage uses the physical display scale on Retina screens. Normalize the
    // persisted image to the logical slide size so results are deterministic and
    // stay within the asset byte limit on every machine.
    const normalized = captured.getSize().width === width && captured.getSize().height === height
      ? captured
      : captured.resize({ width, height, quality: 'best' })
    const png = normalized.toPNG()
    if (png.byteLength <= 12 * 1024 * 1024) {
      return { bytes: png, mimeType: 'image/png', width, height }
    }
    const jpeg = normalized.toJPEG(95)
    if (jpeg.byteLength <= 12 * 1024 * 1024) {
      return { bytes: jpeg, mimeType: 'image/jpeg', width, height }
    }
    throw new Error('The rendered slide exceeds the 12 MiB image limit.')
  } finally {
    renderer?.destroy()
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function saveWorkspaceFileAs(
  payload: unknown,
  getMainWindow: () => BrowserWindow | null,
  store: JsonSettingsStore
): Promise<WorkspaceFileSaveAsResult> {
  const request = parseIpcPayload('file:save-as', workspaceFileSaveAsPayloadSchema, payload)
  try {
    const sourcePath = request.sourcePath
      ? await resolveOpenTargetPath(request.sourcePath, request.workspaceRoot, { allowBasenameFallback: false })
      : ''
    const fileName = safeSaveAsFileName(request.suggestedName || (sourcePath ? basename(sourcePath) : undefined))
    const defaultPath = request.workspaceRoot?.trim()
      ? join(expandHomePath(request.workspaceRoot), fileName)
      : fileName
    const { locale } = await store.load()
    const options: Electron.SaveDialogOptions = {
      title: locale === 'zh' ? '保存生成的文件' : 'Save generated file',
      defaultPath,
      filters: saveDialogFilters(fileName, request.mimeType, locale)
    }
    const mainWindow = getMainWindow()
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, message: 'Save cancelled.' }
    }

    const targetPath = resolve(result.filePath)
    await mkdir(dirname(targetPath), { recursive: true })
    if (sourcePath) {
      if (resolve(sourcePath) !== targetPath) {
        await durableWriteFile(targetPath, await readFile(sourcePath))
      }
    } else if (request.dataBase64) {
      await durableWriteFile(targetPath, Buffer.from(request.dataBase64, 'base64'))
    } else {
      return { ok: false, message: 'No file data was available to save.' }
    }
    return { ok: true, path: targetPath }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function validateMcpConfigContent(content: string): void {
  const trimmed = content.trim()
  if (!trimmed) return
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`MCP config must be JSON: ${message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config must be a JSON object.')
  }
}

function runDesktopCommand(
  command: DesktopCommand,
  sender: WebContents,
  getMainWindow: () => BrowserWindow | null
): void {
  const mainWindow = getMainWindow()
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : sender

  switch (command) {
    case 'undo':
      contents.undo()
      return
    case 'redo':
      contents.redo()
      return
    case 'cut':
      contents.cut()
      return
    case 'copy':
      contents.copy()
      return
    case 'paste':
      contents.paste()
      return
    case 'selectAll':
      contents.selectAll()
      return
    case 'reload':
      contents.reload()
      return
    case 'zoomIn':
      contents.setZoomLevel(contents.getZoomLevel() + 1)
      return
    case 'zoomOut':
      contents.setZoomLevel(contents.getZoomLevel() - 1)
      return
    case 'resetZoom':
      contents.setZoomLevel(0)
      return
    case 'toggleDevTools':
      contents.toggleDevTools()
      return
    case 'minimize':
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
      return
    case 'toggleMaximize':
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
      return
    case 'close':
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
      return
    case 'quit':
      app.quit()
      return
  }
}

export function registerAppIpcHandlers(options: RegisterAppIpcHandlersOptions): void {
  const {
    store,
    getMainWindow,
    applySettingsPatch,
    runtimeRequest,
    runtimeFileRequest,
    fetchUpstreamModels,
    getClawRuntime,
    getScheduleRuntime,
    startFeishuInstallQrcode,
    pollFeishuInstall,
    startWeixinInstallQrcode,
    pollWeixinInstall,
    getWeixinBridgeAccountStatuses,
    isWeixinBridgeAccountConfigured,
    getImHealthService,
    getImCredentialService,
    getImDeliveryLedger,
    getUserDataPath,
    resolveRuntimeConfigPath,
    onRuntimeMcpConfigWritten,
    showTurnCompleteNotification,
    getAppVersion,
    readGuiUpdateState,
    loadGuiUpdaterModule,
    resolveLogDirectory,
    logError
  } = options
  const workspaceFileWatchers = new Map<string, WorkspaceFileWatchRecord>()
  const agentProfileService = new AgentProfileService()
  const workspaceTrustService = new WorkspaceTrustService()
  const documentEngineService = new DocumentEngineService({
    resourcesPath: process.resourcesPath,
    developmentRoot: process.cwd()
  })
  const workspacePreviewService = new WorkspacePreviewService(documentEngineService)
  const chatAttachmentImportService = new ChatAttachmentImportService({
    managedRoot: join(app.getPath('userData'), 'chat-attachments'),
    documentEngine: documentEngineService
  })
  const gitCheckpointService = new GitCheckpointService()
  const repoMapService = new RepoMapService()
  const mcpConfigService = options.mcpConfigService ?? new McpConfigService()
  const catalogCredentialService = options.catalogCredentialService ?? new CatalogCredentialService()
  const marketplaceCatalogService = options.marketplaceCatalogService ?? new MarketplaceCatalogService({
    resolveWorkspaceRoot: async () => (await store.load()).workspaceRoot,
    resolveSecret: async (secretKey) => (await catalogCredentialService.resolve(secretKey)) ?? null
  })
  const pluginManagementService = options.pluginManagementService ?? new PluginManagementService()
  ;(app as typeof app & { once?: typeof app.once }).once?.('before-quit', () => mcpConfigService.dispose())
  let skillCatalogGeneration = 1

  const notifySkillsChanged = (): number => {
    skillCatalogGeneration += 1
    getMainWindow()?.webContents.send('skills:changed', skillCatalogGeneration)
    return skillCatalogGeneration
  }

  const loadSkillCatalog = async (workspaceRoot?: string) => {
    const settings = await store.load()
    const result = await listGuiSkills(settings, workspaceRoot)
    return result.ok ? { ...result, generation: skillCatalogGeneration } : result
  }

  const disposeWorkspaceFileWatch = (watchId: string): boolean => {
    const record = workspaceFileWatchers.get(watchId)
    if (!record) return false
    if (record.timer) clearTimeout(record.timer)
    try {
      record.watcher.close()
    } catch (error) {
      logError('workspace-watch', 'Failed to close workspace file watcher', {
        watchId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    workspaceFileWatchers.delete(watchId)
    return true
  }

  const disposeWorkspaceFileWatchesForSender = (sender: WebContents): void => {
    for (const [watchId, record] of workspaceFileWatchers) {
      if (record.sender.id === sender.id) {
        disposeWorkspaceFileWatch(watchId)
      }
    }
  }

  const emitWorkspaceFileChange = async (watchId: string): Promise<void> => {
    const record = workspaceFileWatchers.get(watchId)
    if (!record) return
    const changedAt = new Date().toISOString()
    try {
      const result = await readWorkspaceFile({
        path: record.path,
        workspaceRoot: record.workspaceRoot
      })
      const latest = workspaceFileWatchers.get(watchId)
      if (!latest || latest.sender.isDestroyed()) return
      if (result.ok) {
        latest.sender.send('file:workspace-changed', {
          ok: true,
          watchId,
          workspaceRoot: latest.workspaceRoot,
          path: result.path,
          content: result.content,
          size: result.size,
          truncated: result.truncated,
          changedAt
        })
        return
      }
      latest.sender.send('file:workspace-changed', {
        ok: false,
        watchId,
        workspaceRoot: latest.workspaceRoot,
        path: latest.path,
        message: result.message,
        changedAt
      })
    } catch (error) {
      const latest = workspaceFileWatchers.get(watchId)
      if (!latest || latest.sender.isDestroyed()) return
      latest.sender.send('file:workspace-changed', {
        ok: false,
        watchId,
        workspaceRoot: latest.workspaceRoot,
        path: latest.path,
        message: error instanceof Error ? error.message : String(error),
        changedAt
      })
    }
  }

  const scheduleWorkspaceFileChange = (watchId: string): void => {
    const record = workspaceFileWatchers.get(watchId)
    if (!record) return
    if (record.timer) clearTimeout(record.timer)
    record.timer = setTimeout(() => {
      const latest = workspaceFileWatchers.get(watchId)
      if (!latest) return
      latest.timer = null
      void emitWorkspaceFileChange(watchId)
    }, 90)
  }

  ipcMain.handle('settings:get', async () => {
    const settings = await store.load()
    return {
      ...settings,
      claw: {
        ...settings.claw,
        // The main process retains legacy values only to retry a durable
        // migration. Renderer settings must never receive those secrets.
        im: { ...settings.claw.im, secret: '' },
        channels: sanitizeImChannelCredentials(settings.claw.channels)
      }
    }
  })
  ipcMain.handle('settings:set', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('settings:set', settingsSetPayloadSchema, payload)
    return parsed.expectedRevision === undefined
      ? applySettingsPatch(parsed.patch as AppSettingsPatch)
      : applySettingsPatch(parsed.patch as AppSettingsPatch, parsed.expectedRevision)
  })

  ipcMain.handle('runtime:request', async (_, payload: unknown) => {
    const request = parseIpcPayload('runtime:request', runtimeRequestPayloadSchema, payload)
    const method = (request.method ?? 'GET').toUpperCase()
    const deleteThread = method === 'DELETE'
      ? /^\/v1\/threads\/([^/?]+)$/.exec(request.path)
      : null
    if (deleteThread?.[1]) {
      await appCancellationRegistry.cancel(
        { scope: 'thread', id: decodeURIComponent(deleteThread[1]) },
        'thread_deleted'
      )
    }
    const result = await runtimeRequest(request.path, request.method, request.body)
    const startMatch = method === 'POST'
      ? /^\/v1\/threads\/([^/?]+)\/(?:turns|review)$/.exec(request.path)
      : null
    if (result.ok && startMatch?.[1]) {
      try {
        const body = JSON.parse(result.body) as { threadId?: unknown; turnId?: unknown }
        const threadId = typeof body.threadId === 'string'
          ? body.threadId
          : decodeURIComponent(startMatch[1])
        const turnId = typeof body.turnId === 'string' ? body.turnId : ''
        if (threadId && turnId) {
          appCancellationRegistry.register(
            { scope: 'thread', id: threadId },
            { parent: { scope: 'app', id: 'app' } }
          )
          appCancellationRegistry.register(
            { scope: 'turn', id: turnId },
            {
              parent: { scope: 'thread', id: threadId },
              cleanup: async () => {
                await runtimeRequest(
                  runtimeThreadInterruptPath(threadId, turnId),
                  'POST',
                  JSON.stringify({ discard: false })
                ).catch(() => undefined)
              }
            }
          )
        }
      } catch {
        // Invalid successful responses are handled by the renderer contract parser.
      }
    }
    return result
  })
  ipcMain.handle('diagnostics:export-task', async (_, payload: unknown) => {
    const request = parseIpcPayload('diagnostics:export-task', diagnosticsExportPayloadSchema, payload)
    const response = await runtimeRequest(`/v1/tasks/${encodeURIComponent(request.taskId)}/diagnostics`, 'GET')
    if (!response.ok) {
      return { ok: false, message: `Unable to collect diagnostics (${response.status}).` }
    }
    let normalized: string
    try {
      normalized = `${JSON.stringify(JSON.parse(response.body), null, 2)}\n`
    } catch {
      return { ok: false, message: 'The runtime returned an invalid diagnostics response.' }
    }
    const { locale } = await store.load()
    const options: Electron.SaveDialogOptions = {
      title: locale === 'zh' ? `导出 ${brand.platform} 任务诊断包` : `Export ${brand.platform} task diagnostics`,
      defaultPath: `WorkWise-task-diagnostics-${request.taskId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const mainWindow = getMainWindow()
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await durableWriteFile(result.filePath, normalized)
    return { ok: true, path: result.filePath }
  })
  ipcMain.handle('operation:cancel', async (_, payload: unknown) => {
    const request = parseIpcPayload('operation:cancel', cancelOperationPayloadSchema, payload)
    const cancelled = await appCancellationRegistry.cancel(
      { scope: request.scope, id: request.id },
      request.reason
    )
    return { ok: true as const, cancelled }
  })

  ipcMain.handle('agent-profile:list', async (_, payload: unknown) => {
    const request = parseIpcPayload('agent-profile:list', agentProfileListPayloadSchema, payload)
    return agentProfileService.list(request.workspaceRoot)
  })
  ipcMain.handle('agent-profile:save', async (_, payload: unknown) => {
    const request = parseIpcPayload('agent-profile:save', agentProfileSavePayloadSchema, payload)
    return agentProfileService.save({
      scope: request.scope,
      workspaceRoot: request.workspaceRoot,
      profile: request.profile,
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey
    })
  })
  ipcMain.handle('workspace-trust:get', async (_, payload: unknown) => {
    const request = parseIpcPayload('workspace-trust:get', workspaceTrustGetPayloadSchema, payload)
    return workspaceTrustService.get(request.workspaceRoot)
  })
  ipcMain.handle('workspace-trust:set', async (_, payload: unknown) => {
    const request = parseIpcPayload('workspace-trust:set', workspaceTrustSetPayloadSchema, payload)
    return workspaceTrustService.set({
      workspaceRoot: request.workspaceRoot,
      level: request.level,
      expectedRevision: request.expectedRevision,
      confirmed: request.confirmed,
      idempotencyKey: request.idempotencyKey
    })
  })
  ipcMain.handle('mcp-server:list', async (_, payload: unknown) => {
    const request = parseIpcPayload('mcp-server:list', mcpServerListPayloadSchema, payload)
    return mcpConfigService.list(request.workspaceRoot)
  })
  ipcMain.handle('mcp-server:save', async (_, payload: unknown) => {
    const request = parseIpcPayload('mcp-server:save', mcpServerSavePayloadSchema, payload)
    return mcpConfigService.save(request)
  })
  ipcMain.handle('mcp-server:test', async (_, payload: unknown) => {
    const request = parseIpcPayload('mcp-server:test', mcpServerActionPayloadSchema, payload)
    return mcpConfigService.test(request.serverId, request.workspaceRoot)
  })
  ipcMain.handle('mcp-server:authorize', async (_, payload: unknown) => {
    const request = parseIpcPayload('mcp-server:authorize', mcpServerAuthorizePayloadSchema, payload)
    return mcpConfigService.authorize(request)
  })
  ipcMain.handle('mcp-server:wait-authorization', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'mcp-server:wait-authorization',
      mcpServerAuthorizationStatePayloadSchema,
      payload
    )
    return mcpConfigService.waitForAuthorization(request)
  })
  ipcMain.handle('mcp-server:cancel-authorization', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'mcp-server:cancel-authorization',
      mcpServerAuthorizationStatePayloadSchema,
      payload
    )
    return mcpConfigService.cancelAuthorization(request)
  })
  ipcMain.handle('mcp-server:set-credential', async (_, payload: unknown) => {
    const request = parseIpcPayload('mcp-server:set-credential', mcpServerCredentialPayloadSchema, payload)
    return mcpConfigService.setCredential(request)
  })
  ipcMain.handle('catalog:list-sources', async () => marketplaceCatalogService.listSources())
  ipcMain.handle('catalog:list-packages', async () => marketplaceCatalogService.listPackages())
  ipcMain.handle('catalog:get-snapshot', async (_, payload: unknown) => {
    const request = parseIpcPayload('catalog:get-snapshot', catalogSourceIdPayloadSchema, payload)
    return marketplaceCatalogService.getSnapshot(request.sourceId)
  })
  ipcMain.handle('catalog:upsert-source', async (_, payload: unknown) => {
    const source = parseIpcPayload('catalog:upsert-source', catalogSourcePayloadSchema, payload)
    const previous = (await marketplaceCatalogService.listSources())
      .find((candidate) => candidate.id === source.id)
    const saved = await marketplaceCatalogService.upsertSource(source as CatalogSourceV1)
    if (previous?.auth.type === 'token' &&
        (saved.auth.type !== 'token' || saved.auth.secretKey !== previous.auth.secretKey)) {
      await catalogCredentialService.remove(previous.auth.secretKey)
    }
    return saved
  })
  ipcMain.handle('catalog:list-credential-statuses', async () => {
    const sources = await marketplaceCatalogService.listSources()
    return Promise.all(sources
      .filter((source) => source.auth.type === 'token')
      .map((source) => catalogCredentialService.status(source.id, source.auth.type === 'token'
        ? source.auth.secretKey
        : '')))
  })
  ipcMain.handle('catalog:set-credential', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'catalog:set-credential',
      catalogSourceCredentialPayloadSchema,
      payload
    )
    const source = (await marketplaceCatalogService.listSources())
      .find((candidate) => candidate.id === request.sourceId)
    if (!source) throw new Error('Catalog source was not found.')
    if (source.auth.type !== 'token') throw new Error('Catalog source does not use token authentication.')
    const storage = await catalogCredentialService.set(source.auth.secretKey, request.accessToken)
    return { sourceId: source.id, configured: true, storage }
  })
  ipcMain.handle('catalog:clear-credential', async (_, payload: unknown) => {
    const request = parseIpcPayload('catalog:clear-credential', catalogSourceIdPayloadSchema, payload)
    const source = (await marketplaceCatalogService.listSources())
      .find((candidate) => candidate.id === request.sourceId)
    if (!source) throw new Error('Catalog source was not found.')
    if (source.auth.type === 'token') await catalogCredentialService.remove(source.auth.secretKey)
    return { sourceId: source.id, configured: false }
  })
  ipcMain.handle('catalog:remove-source', async (_, payload: unknown) => {
    const request = parseIpcPayload('catalog:remove-source', catalogSourceIdPayloadSchema, payload)
    const source = (await marketplaceCatalogService.listSources())
      .find((candidate) => candidate.id === request.sourceId)
    await marketplaceCatalogService.removeSource(request.sourceId)
    if (source?.auth.type === 'token') await catalogCredentialService.remove(source.auth.secretKey)
  })
  ipcMain.handle('catalog:sync-source', async (_, payload: unknown) => {
    const request = parseIpcPayload('catalog:sync-source', catalogSourceIdPayloadSchema, payload)
    return marketplaceCatalogService.syncSource(request.sourceId)
  })
  ipcMain.handle('plugin:list-installed', async () => pluginManagementService.listInstalled())
  ipcMain.handle('plugin:pick-package', async (_, payload: unknown): Promise<WorkspacePickResult> => {
    const request = parseIpcPayload('plugin:pick-package', pluginPackagePickerPayloadSchema, payload)
    const { locale } = await store.load()
    const options: Electron.OpenDialogOptions = request.mode === 'file'
      ? {
          title: locale === 'zh' ? `导入 ${brand.platform} 插件包` : `Import ${brand.platform} plugin package`,
          filters: [{ name: locale === 'zh' ? '插件包' : 'Plugin packages', extensions: ['wwx', 'mcpb', 'zip'] }],
          properties: ['openFile', 'dontAddToRecent']
        }
      : {
          title: locale === 'zh' ? '导入 Codex 插件目录' : 'Import Codex plugin directory',
          properties: ['openDirectory', 'dontAddToRecent']
        }
    const mainWindow = getMainWindow()
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return {
      canceled: result.canceled,
      path: result.canceled ? null : (result.filePaths[0] ?? null)
    }
  })
  ipcMain.handle('plugin:prepare-import', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:prepare-import', pluginPrepareImportPayloadSchema, payload)
    return pluginManagementService.prepareImport(request)
  })
  ipcMain.handle('plugin:prepare-catalog', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:prepare-catalog', pluginPrepareCatalogPayloadSchema, payload)
    const catalog = await marketplaceCatalogService.listPackages()
    const entry = catalog.packages.find((candidate) =>
      candidate.sourceId === request.sourceId && candidate.package.id === request.packageId
    )
    if (!entry) throw new Error('Catalog package was not found.')
    return pluginManagementService.prepareCatalogPackage(entry.package)
  })
  ipcMain.handle('plugin:cancel-import', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:cancel-import', pluginPreparedIdPayloadSchema, payload)
    return pluginManagementService.cancelPrepared(request.preparedId)
  })
  ipcMain.handle('plugin:install', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:install', pluginInstallPayloadSchema, payload)
    const installed = await pluginManagementService.installPrepared(
      request,
      async (record, item) => activatePluginPackage({
        item,
        installed: record,
        workspaceRoot: record.workspaceRoot,
        mcpConfigService,
        idempotencyKey: request.idempotencyKey
      })
    )
    notifySkillsChanged()
    return installed
  })
  ipcMain.handle('plugin:rollback', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:rollback', pluginRollbackPayloadSchema, payload)
    const installed = await pluginManagementService.rollback(
      request,
      async (record, item) => activatePluginPackage({
        item,
        installed: record,
        workspaceRoot: record.workspaceRoot,
        mcpConfigService,
        idempotencyKey: `${request.idempotencyKey}:activate`
      })
    )
    notifySkillsChanged()
    return installed
  })
  ipcMain.handle('plugin:update-permissions', async (_, payload: unknown) => {
    const request = parseIpcPayload('plugin:update-permissions', pluginPermissionsUpdatePayloadSchema, payload)
    const installed = (await pluginManagementService.listInstalled())
      .find((record) => record.packageId === request.packageId)
    if (!installed) throw new Error('Package is not installed.')
    const catalog = await marketplaceCatalogService.listPackages()
    const entry = catalog.packages.find((candidate) =>
      candidate.package.id === request.packageId && candidate.package.source.id === installed.source.id
    )
    if (!entry) throw new Error('Installed package is not available in the current catalog.')
    return pluginManagementService.updatePermissions(
      entry.package,
      request,
      async (record, item) => activatePluginPackage({
        item,
        installed: record,
        workspaceRoot: record.workspaceRoot,
        mcpConfigService,
        idempotencyKey: `${request.idempotencyKey}:activate`
      })
    )
  })
  ipcMain.handle('document-engine:list', async () => {
    const settings = await store.load()
    return documentEngineService.listEngines(
      settings.documents.privateMineruServerUrl,
      settings.documents.unlimitedOcrServerUrl
    )
  })
  ipcMain.handle('document-engine:diagnose', async (_, payload: unknown) => {
    const id = parseIpcPayload('document-engine:diagnose', documentEngineIdSchema, payload)
    const settings = await store.load()
    const status = await documentEngineService.listEngines(
      settings.documents.privateMineruServerUrl,
      settings.documents.unlimitedOcrServerUrl
    )
    return status.find((entry) => entry.id === id)!
  })
  ipcMain.handle('document-engine:install', async (_, payload: unknown) => {
    const id = parseIpcPayload('document-engine:install', documentEngineIdSchema, payload)
    const settings = await store.load()
    const status = await documentEngineService.listEngines(
      settings.documents.privateMineruServerUrl,
      settings.documents.unlimitedOcrServerUrl
    )
    const current = status.find((entry) => entry.id === id)!
    if (id === 'mineru-local' && current.state === 'not_installed') {
      return documentEngineService.installMineru()
    }
    return current
  })
  ipcMain.handle('document-engine:parse', async (_, payload: unknown) => {
    const request = parseIpcPayload('document-engine:parse', documentParsePayloadSchema, payload)
    const settings = await store.load()
    const allowed = settings.documents.allowPrivateServerUploadByWorkspace[request.workspaceRoot] === true
    return documentEngineService.parse({
      ...request,
      unlimitedOcrServerUrl: settings.documents.unlimitedOcrServerUrl,
      allowPrivateServerUpload: request.allowPrivateServerUpload === true && allowed
    })
  })
  ipcMain.handle('document-engine:cancel', async (_, payload: unknown) => {
    const parseId = parseIpcPayload('document-engine:cancel', streamIdSchema, payload)
    const previewCancelled = workspacePreviewService.cancel(parseId)
    const documentCancelled = documentEngineService.cancel(parseId)
    return previewCancelled || documentCancelled
  })
  ipcMain.handle('attachment:import-file', async (_, payload: unknown) => {
    const request = parseIpcPayload('attachment:import-file', z.object({
      importId: z.string().min(1).optional(), sourcePath: z.string().min(1), declaredMimeType: z.string().optional(),
      threadId: z.string().min(1).optional(), workspace: z.string().min(1).optional()
    }).strict().refine((value) => Boolean(value.threadId || value.workspace), { message: 'threadId or workspace is required' }), payload)
    const staged = await chatAttachmentImportService.stage(request)
    try {
      if (!runtimeFileRequest) throw new Error('streamed Runtime attachment import is unavailable')
      const imported = await runtimeFileRequest('/v1/attachments/documents', staged.absolutePath, {
        'Content-Type': staged.mimeType,
        'X-Workwise-File-Name': encodeURIComponent(staged.originalFileName),
        'X-Workwise-Attachment-Kind': staged.kind,
        ...(request.threadId ? { 'X-Workwise-Thread-Id': request.threadId } : {}),
        ...(request.workspace ? { 'X-Workwise-Workspace': encodeURIComponent(request.workspace) } : {})
      })
      if (!imported.ok) throw new Error(runtimeResponseMessage(imported))
      const attachment = (JSON.parse(imported.body) as { attachment: { id: string } }).attachment
      const settings = await store.load()
      const parsed = await chatAttachmentImportService.parse(staged, {
        mode: settings.documents.parsingMode,
        unlimitedOcrServerUrl: settings.documents.unlimitedOcrServerUrl
      })
      const sections = buildAttachmentSections(attachment.id, parsed.document?.markdown ?? parsed.text ?? '', parsed.document)
      for (let offset = 0; offset < sections.length || offset === 0; offset += 32) {
        const batch = sections.slice(offset, offset + 32)
        const final = offset + 32 >= sections.length
        const result = await runtimeRequest(`/v1/attachments/${encodeURIComponent(attachment.id)}/parsed`, 'POST', JSON.stringify({
          replace: offset === 0, sections: batch, final,
          ...(final ? { metadata: {
            state: parsed.state,
            parser: parsed.document ? buildAttachmentParserProvenance(parsed.document) : { engine: 'safe-text', local: true, parsedAt: new Date().toISOString() },
            sourceStructure: parsed.sourceStructure ?? {},
            degradationReasons: parsed.degradationReasons, parserWarnings: parsed.warnings,
            summary: (parsed.document?.markdown ?? parsed.text ?? '').replace(/\s+/g, ' ').slice(0, 1200)
          } } : {})
        }))
        if (!result.ok) throw new Error(runtimeResponseMessage(result))
        if (final) return { attachment: (JSON.parse(result.body) as { attachment: unknown }).attachment, managedPath: staged.absolutePath }
      }
      throw new Error('attachment parsing produced no final result')
    } catch (error) {
      await chatAttachmentImportService.remove(staged).catch(() => undefined)
      throw error
    }
  })
  ipcMain.handle('attachment:cancel-import', async (_, payload: unknown) => {
    const id = parseIpcPayload('attachment:cancel-import', z.string().min(1), payload)
    return chatAttachmentImportService.cancel(id) || documentEngineService.cancel(id)
  })
  ipcMain.handle('attachment:open-original', async (_, payload: unknown) => {
    const path = parseIpcPayload('attachment:open-original', z.string().min(1), payload)
    const root = await canonicalizeContainmentRoot(join(app.getPath('userData'), 'chat-attachments'))
    const target = await realpath(path)
    if (!isCanonicalPathContained(root, target)) throw new Error('attachment path is outside managed storage')
    shell.showItemInFolder(target)
  })
  ipcMain.handle('file:preview-workspace', async (_, payload: unknown) => {
    const request = parseIpcPayload('file:preview-workspace', workspacePreviewPayloadSchema, payload)
    const settings = await store.load()
    return workspacePreviewService.preview({
      ...request,
      parsingMode: request.parsingMode ?? settings.documents.parsingMode,
      unlimitedOcrServerUrl: settings.documents.unlimitedOcrServerUrl
    })
  })

  ipcMain.handle('upstream:models', async () => fetchUpstreamModels())

  ipcMain.handle('claw:status', async (): Promise<ClawRuntimeStatus> =>
    getClawRuntime()?.status() ?? {
      imServerRunning: false,
      imUrl: '',
      runningTaskIds: []
    }
  )

  ipcMain.handle('claw:task:run', async (_, taskId: unknown): Promise<ClawRunResult> => {
    const normalizedTaskId = parseIpcPayload('claw:task:run', streamIdSchema, taskId)
    const scheduleRuntime = getScheduleRuntime()
    if (!scheduleRuntime) {
      return { ok: false, reason: 'failed', message: 'Schedule runtime is not initialized.' }
    }
    const result = await scheduleRuntime.runTask(normalizedTaskId)
    return result.ok ? result : { ...result, reason: 'failed' }
  })

  ipcMain.handle('schedule:status', async (): Promise<ScheduleRuntimeStatus> =>
    getScheduleRuntime()?.status() ?? {
      internalServerRunning: false,
      internalUrl: '',
      runningTaskIds: [],
      powerSaveBlockerActive: false
    }
  )

  ipcMain.handle('schedule:task:run', async (_, taskId: unknown): Promise<ScheduleRunResult> => {
    const normalizedTaskId = parseIpcPayload('schedule:task:run', streamIdSchema, taskId)
    const scheduleRuntime = getScheduleRuntime()
    if (!scheduleRuntime) return { ok: false, message: 'Schedule runtime is not initialized.' }
    return scheduleRuntime.runTask(normalizedTaskId)
  })

  ipcMain.handle(
    'claw:channel:mirror',
    async (_, payload: unknown) => {
      const request = parseIpcPayload('claw:channel:mirror', clawMirrorPayloadSchema, payload)
      const clawRuntime = getClawRuntime()
      if (!clawRuntime) return { ok: false as const, message: 'Claw runtime is not initialized.' }
      return clawRuntime.mirrorThreadMessageToIm(
        request.threadId,
        request.text,
        request.direction,
        { turnId: request.turnId, requestText: request.requestText }
      )
    }
  )

  ipcMain.handle(
    'claw:channel:mirror-to-feishu',
    async (_, payload: unknown) => {
      const request = parseIpcPayload('claw:channel:mirror-to-feishu', clawMirrorPayloadSchema, payload)
      const clawRuntime = getClawRuntime()
      if (!clawRuntime) return { ok: false as const, message: 'Claw runtime is not initialized.' }
      return clawRuntime.mirrorThreadMessageToIm(
        request.threadId,
        request.text,
        request.direction,
        { turnId: request.turnId, requestText: request.requestText }
      )
    }
  )

  ipcMain.handle(
    'claw:task:create-from-text',
    async (_, payload: unknown): Promise<ClawTaskFromTextResult> => {
      const request = parseIpcPayload(
        'claw:task:create-from-text',
        clawTaskFromTextPayloadSchema,
        payload
      )
      const scheduleRuntime = getScheduleRuntime()
      if (!scheduleRuntime) return { kind: 'error', message: 'Schedule runtime is not initialized.' }
      const settings = await store.load()
      const channel = request.channelId
        ? settings.claw.channels.find((item) => item.id === request.channelId)
        : undefined
      return scheduleRuntime.createScheduledTaskFromText(request.text, {
        workspaceRoot: channel?.workspaceRoot || settings.schedule.defaultWorkspaceRoot || settings.workspaceRoot,
        modelHint: request.modelHint,
        mode: request.mode
      })
    }
  )

  ipcMain.handle(
    'schedule:task:create-from-text',
    async (_, payload: unknown): Promise<ScheduleTaskFromTextResult> => {
      const request = parseIpcPayload(
        'schedule:task:create-from-text',
        scheduleTaskFromTextPayloadSchema,
        payload
      )
      const scheduleRuntime = getScheduleRuntime()
      if (!scheduleRuntime) return { kind: 'error', message: 'Schedule runtime is not initialized.' }
      return scheduleRuntime.createScheduledTaskFromText(request.text, {
        workspaceRoot: request.workspaceRoot,
        modelHint: request.modelHint,
        mode: request.mode
      })
    }
  )

  ipcMain.handle(
    'claw:im-install:qrcode',
    async (_, payload: unknown) => {
      const request = parseIpcPayload(
        'claw:im-install:qrcode',
        z.object({ provider: z.enum(['feishu', 'weixin']), isLark: z.boolean().optional() }).strict(),
        payload
      )
      if (request.provider === 'weixin') {
        return startWeixinInstallQrcode()
      }
      return startFeishuInstallQrcode(request.isLark === true)
    }
  )

  ipcMain.handle(
    'claw:im-install:poll',
    async (_, payload: unknown) => {
      const request = parseIpcPayload('claw:im-install:poll', clawImInstallPollPayloadSchema, payload)
      if (request.provider === 'weixin') {
        return pollWeixinInstall(request.deviceCode)
      }
      return pollFeishuInstall(request.deviceCode)
    }
  )

  ipcMain.handle('claw:weixin-status', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'claw:weixin-status',
      z.object({ accountId: z.string().trim().max(512).optional() }).strict(),
      payload
    )
    return getWeixinBridgeAccountStatuses(request.accountId)
  })

  const imChannelIdSchema = z.object({ channelId: z.string().trim().max(512).optional() }).strict()
  const imLifecycleChannelIdSchema = z.object({ channelId: z.string().trim().min(1).max(512) }).strict()
  const resolveImHealth = (channelId?: string) => {
    const service = getImHealthService?.()
    if (!service) return []
    const health = channelId ? service.get(channelId) : undefined
    return health ? [health] : service.list()
  }
  const resolveImChannel = async (channelId?: string) => {
    const settings = await store.load()
    return channelId
      ? settings.claw.channels.find((channel) => channel.id === channelId)
      : settings.claw.channels.find((channel) => channel.enabled)
  }
  const migrateLegacyImCredentials = async (): Promise<void> => {
    const credentialService = getImCredentialService?.()
    if (!credentialService) return
    const latest = await store.load()
    const migratableChannels = latest.claw.channels.filter((channel) =>
      process.env.WORKWISE_CANDIDATE !== '1' || isCandidateImProviderConnectionAllowed(channel.provider)
    )
    if (!migratableChannels.some(hasLegacyImChannelCredential)) return
    const migratedChannels = await protectImChannelCredentials(migratableChannels, credentialService, {
      requirePersistent: true
    })
    const migratedById = new Map(migratedChannels.map((channel) => [channel.id, channel]))
    const nextChannels = latest.claw.channels.map((channel) => migratedById.get(channel.id) ?? channel)
    if (nextChannels.some((item, index) => item !== latest.claw.channels[index])) {
      await applySettingsPatch({ claw: { channels: nextChannels } })
    }
  }
  const lifecycle = async (kind: 'start' | 'reconnect' | 'stop' | 'disconnect', channelId?: string) => {
    const service = getImHealthService?.()
    if (!service) return { ok: false as const, code: 'health_unavailable', message: 'IM health service is unavailable.' }
    let channel: Awaited<ReturnType<typeof resolveImChannel>>
    try {
      channel = await resolveImChannel(channelId)
    } catch {
      return { ok: false as const, code: 'settings_unavailable', message: 'IM settings are temporarily unavailable.' }
    }
    if (!channel) return { ok: false as const, code: 'channel_missing', message: 'IM channel was not found.' }
    const clawRuntime = getClawRuntime()
    if (!clawRuntime) {
      return {
        ok: false as const,
        code: 'runtime_unavailable',
        message: 'IM Runtime is unavailable.',
        health: service.get(channel.id)
      }
    }
    const credential = channel.platformCredential
    const accountId = credential?.kind === 'weixin' ? credential.accountId : credential?.kind === 'feishu' ? credential.appId : channel.id
    const stopHealth = (message?: string) => {
      const existing = service.stop(channel.id, message)
      if (existing) return existing
      service.start({
        channelId: channel.id,
        provider: channel.provider,
        accountId,
        credentialStorage: channel.credentialRef?.storage
      })
      return service.stop(channel.id, message)!
    }
    const persistChannelEnabled = async (enabled: boolean): Promise<void> => {
      const latest = await store.load()
      const current = latest.claw.channels.find((item) => item.id === channel.id)
      if (!current || current.enabled === enabled) return
      const updatedAt = new Date().toISOString()
      await applySettingsPatch({
        claw: {
          channels: latest.claw.channels.map((item) =>
            item.id === channel.id ? { ...item, enabled, updatedAt } : item
          )
        }
      })
    }
    try {
      if (kind === 'stop') {
        await clawRuntime.stopChannel(channel.id)
        await persistChannelEnabled(false)
        return { ok: true as const, health: stopHealth() }
      }
      if (kind === 'disconnect') {
        await clawRuntime.disconnectChannel(channel.id)
        const latest = await store.load()
        await applySettingsPatch({
          claw: { channels: latest.claw.channels.filter((item) => item.id !== channel.id) }
        })
        return {
          ok: true as const,
          health: stopHealth('连接已断开，凭据已清除。')
        }
      }
      if (kind === 'reconnect') {
        await getImCredentialService?.()?.retryProtectedStorage()
        await migrateLegacyImCredentials()
        await persistChannelEnabled(true)
        await clawRuntime.reconnectChannel(channel.id)
      }
      else {
        await migrateLegacyImCredentials()
        await persistChannelEnabled(true)
        if (clawRuntime.startChannel) await clawRuntime.startChannel(channel.id)
        else clawRuntime.sync(await store.load())
      }
      const health = service.get(channel.id) ?? service.start({ channelId: channel.id, provider: channel.provider, accountId, credentialStorage: channel.credentialRef?.storage })
      return { ok: true as const, health }
    } catch (error) {
      return {
        ok: false as const,
        code: `${kind}_failed`,
        message: error instanceof Error ? error.message : `IM ${kind} failed.`,
        health: service.get(channel.id)
      }
    }
  }
  ipcMain.handle('claw:im:health', async (_, payload: unknown) => {
    const request = parseIpcPayload('claw:im:health', imChannelIdSchema, payload)
    return resolveImHealth(request.channelId)
  })
  for (const [channelName, kind] of [['claw:im:start', 'start'], ['claw:im:reconnect', 'reconnect'], ['claw:im:stop', 'stop'], ['claw:im:disconnect', 'disconnect'] ] as const) {
    ipcMain.handle(channelName, async (_, payload: unknown) => {
      const request = parseIpcPayload(channelName, imLifecycleChannelIdSchema, payload)
      return lifecycle(kind, request.channelId)
    })
  }
  ipcMain.handle('claw:im:self-check', async (_, payload: unknown) => {
    const request = parseIpcPayload('claw:im:self-check', z.object({ channelId: z.string().trim().min(1).max(512) }).strict(), payload)
    const service = getImHealthService?.()
    const health = service?.get(request.channelId)
    if (!service || !health) return { schema: 'workwise.im-self-check', version: 1, overall: 'FAIL', checkedAt: new Date().toISOString(), runId: '', checks: [{ id: 'channel', pass: false, code: 'channel_missing', summary: '未找到连接。' }] }
    if (health.status === 'stopped') {
      let runtimeAvailable = false
      try {
        runtimeAvailable = (await runtimeRequest('/health', 'GET')).ok
      } catch {
        runtimeAvailable = false
      }
      const ledgerHealthy = getImDeliveryLedger?.()?.integrityCheck() ?? false
      return {
        schema: 'workwise.im-self-check' as const,
        version: 1 as const,
        overall: runtimeAvailable && ledgerHealthy ? 'PASS' as const : 'FAIL' as const,
        checkedAt: new Date().toISOString(),
        runId: health.runId,
        checks: [
          { id: 'connection_state', pass: true, code: 'user_paused', summary: '连接已由用户暂停；未执行凭据、桥接和心跳在线检查。' },
          { id: 'runtime', pass: runtimeAvailable, code: runtimeAvailable ? 'runtime_available' : 'runtime_unavailable', summary: runtimeAvailable ? 'WorkWise Runtime 可访问。' : 'WorkWise Runtime 不可访问。' },
          { id: 'ledger', pass: ledgerHealthy, code: ledgerHealthy ? 'ledger_healthy' : 'ledger_unhealthy', summary: ledgerHealthy ? '通信账本完整性检查通过。' : '通信账本完整性检查失败。' }
        ]
      }
    }
    const channel = await resolveImChannel(request.channelId)
    const ref = channel?.credentialRef
    const platformCredential = channel?.platformCredential
    let credentialAvailable = false
    try {
      credentialAvailable = platformCredential?.kind === 'weixin'
        ? await isWeixinBridgeAccountConfigured(platformCredential.accountId)
        : ref
          ? Boolean(await getImCredentialService?.()?.resolve(ref))
          : false
    } catch {
      credentialAvailable = false
    }
    let bridgeAvailable = false
    try {
      bridgeAvailable = await getClawRuntime()?.isChannelBridgeAvailable?.(request.channelId) ?? false
    } catch {
      bridgeAvailable = false
    }
    let runtimeAvailable = false
    try {
      runtimeAvailable = (await runtimeRequest('/health', 'GET')).ok
    } catch {
      runtimeAvailable = false
    }
    return service.selfCheck({ runId: health.runId, channelId: request.channelId, credentialAvailable, bridgeAvailable, runtimeAvailable, ledgerHealthy: getImDeliveryLedger?.()?.integrityCheck() ?? false, userDataFingerprint: getUserDataPath?.() ?? '' })
  })
  ipcMain.handle('claw:im:diagnostics', async () => {
    const service = getImHealthService?.()
    return service?.diagnostics(getAppVersion(), getUserDataPath?.() ?? '') ?? { schema: 'workwise.im-diagnostics', version: 1, generatedAt: new Date().toISOString(), appVersion: getAppVersion(), userDataFingerprint: '', channels: [] }
  })

  ipcMain.handle('workspace:pick-directory', async (_, defaultPath: unknown): Promise<WorkspacePickResult> => {
    const normalizedDefaultPath = parseIpcPayload(
      'workspace:pick-directory',
      z.object({ defaultPath: defaultPathSchema }).strict(),
      { defaultPath }
    ).defaultPath
    const { locale } = await store.load()
    const options: Electron.OpenDialogOptions = {
      title: locale === 'zh' ? '选择工作目录' : 'Select working directory',
      defaultPath: normalizedDefaultPath,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    }
    const mainWindow = getMainWindow()
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return {
      canceled: result.canceled,
      path: result.canceled ? null : (result.filePaths[0] ?? null)
    }
  })

  // Replaces window.confirm in the renderer: the synchronous native confirm
  // leaves the WebContents unable to focus inputs after it closes
  // (electron/electron#19977), which froze the composer after deleting threads.
  ipcMain.handle('dialog:confirm', async (_, payload: unknown): Promise<boolean> => {
    const request = parseIpcPayload('dialog:confirm', confirmDialogPayloadSchema, payload)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [request.confirmLabel ?? 'OK', request.cancelLabel ?? 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: request.message,
      detail: request.detail,
      noLink: true
    }
    const mainWindow = getMainWindow()
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  })

  ipcMain.handle(
    'skill:save-file',
    async (_, payload: unknown) => {
      const request = parseIpcPayload('skill:save-file', skillSaveFilePayloadSchema, payload)
      try {
        const rootPath = expandHomePath(request.rootPath)
        if (!rootPath) {
          return { ok: false as const, message: 'Skill directory is required.' }
        }
        const skillName = normalizeSkillFolderName(request.skillName)
        const skillDir = join(rootPath, skillName)
        const filePath = join(skillDir, 'SKILL.md')
        await mkdir(skillDir, { recursive: true })
        await durableWriteFile(filePath, request.content)
        notifySkillsChanged()
        return { ok: true as const, path: filePath }
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle('skill:list', async (_, payload: unknown) => {
    const request = parseIpcPayload('skill:list', skillListPayloadSchema, payload)
    return loadSkillCatalog(request.workspaceRoot)
  })

  ipcMain.handle('skill:refresh', async (_, payload: unknown) => {
    const request = parseIpcPayload('skill:refresh', skillListPayloadSchema, payload)
    return loadSkillCatalog(request.workspaceRoot)
  })

  ipcMain.handle('skill:install-github', async (_, payload: unknown) => {
    const request = parseIpcPayload('skill:install-github', githubSkillInstallPayloadSchema, payload)
    const result = await installGithubSkill(request.rootPath, request.source)
    if (result.ok) notifySkillsChanged()
    return result
  })

  ipcMain.handle('skill:install-bundled', async (_, payload: unknown) => {
    const request = parseIpcPayload('skill:install-bundled', bundledSkillInstallPayloadSchema, payload)
    const result = await installBundledSkill(request.rootPath, request.source)
    if (result.ok) notifySkillsChanged()
    return result
  })

  ipcMain.handle('agent-pack:install-bundled', async (_, payload: unknown) => {
    const request = parseIpcPayload('agent-pack:install-bundled', bundledAgentPackInstallPayloadSchema, payload)
    return installBundledAgentPack(request.source)
  })

  ipcMain.handle('skill:sync-github', async (_, payload: unknown) => {
    const request = parseIpcPayload('skill:sync-github', githubSkillSyncPayloadSchema, payload)
    const settings = await store.load()
    const result = await syncGithubManagedSkills(settings, request.workspaceRoot)
    if (result.ok && result.updated > 0) notifySkillsChanged()
    return result
  })

  ipcMain.handle('tool:list-managed', async () => listManagedTools())

  ipcMain.handle('tool:install-managed', async (_, payload: unknown) => {
    const id = parseIpcPayload('tool:install-managed', managedToolIdSchema, payload)
    const result = await installManagedTool(id)
    if (result.ok) notifySkillsChanged()
    return result
  })

  ipcMain.handle('tool:update-managed', async (_, payload: unknown) => {
    const id = parseIpcPayload('tool:update-managed', managedToolIdSchema, payload)
    const result = await updateManagedTool(id)
    if (result.ok) notifySkillsChanged()
    return result
  })

  ipcMain.handle('tool:diagnose-managed', async (_, payload: unknown) => {
    const id = parseIpcPayload('tool:diagnose-managed', managedToolIdSchema, payload)
    return diagnoseManagedTool(id)
  })

  ipcMain.handle('tool:remove-managed', async (_, payload: unknown) => {
    const id = parseIpcPayload('tool:remove-managed', managedToolIdSchema, payload)
    const result = await removeManagedTool(id)
    if (result.ok) notifySkillsChanged()
    return result
  })

  ipcMain.handle('skill:open-root', async (_, rootPath: unknown) => {
    const normalizedRootPath = parseIpcPayload('skill:open-root', rootPathSchema, rootPath)
    try {
      const target = expandHomePath(normalizedRootPath)
      if (!target) {
        return { ok: false as const, message: 'Skill directory is required.' }
      }
      await mkdir(target, { recursive: true })
      return openPathWithShell(target)
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('runtime:config:read', async () => {
    const path = resolveRuntimeConfigPath()
    try {
      const content = await readFile(path, 'utf8')
      return { path, content, exists: true as const }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path, content: '', exists: false as const }
      }
      throw error
    }
  })

  ipcMain.handle('runtime:config:write', async (_, content: unknown) => {
    const validatedContent = parseIpcPayload(
      'runtime:config:write',
      runtimeConfigContentSchema,
      content
    )
    const path = resolveRuntimeConfigPath()
    validateMcpConfigContent(validatedContent)
    await mkdir(dirname(path), { recursive: true })
    await durableWriteFile(path, validatedContent)
    try {
      await onRuntimeMcpConfigWritten?.(path, validatedContent)
    } catch (error: unknown) {
      logError('mcp-config', 'Failed to apply MCP config change after write', {
        path,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    return { ok: true as const, path }
  })

  ipcMain.handle('runtime:config:open-dir', async () => {
    try {
      const path = resolveRuntimeConfigPath()
      const dirPath = dirname(path)
      await mkdir(dirPath, { recursive: true })
      return openPathWithShell(dirPath)
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('git:branches', async (_, workspaceRoot: unknown) => {
    const requestedRoot = parseIpcPayload('git:branches', workspaceRootSchema, workspaceRoot)
    try {
      const settings = await store.load()
      await assertGitWorkspaceAllowed(requestedRoot, settings.workspaceRoot)
      return await getGitBranches(requestedRoot)
    } catch (error) {
      return {
        ok: false as const,
        reason: stableGitIpcReason(error),
        message: stableGitIpcError(error)
      }
    }
  })
  ipcMain.handle(
    'git:switch-branch',
    async (_, payload: unknown) => {
        const request = parseIpcPayload('git:switch-branch', gitBranchPayloadSchema, payload)
      try {
        const settings = await store.load()
        return await switchGitBranch(request.workspaceRoot, request.branch, settings.workspaceRoot)
      } catch (error) {
        return {
          ok: false as const,
          reason: stableGitIpcReason(error),
          message: stableGitIpcError(error)
        }
      }
    }
  )
  ipcMain.handle(
    'git:create-and-switch-branch',
    async (_, payload: unknown) => {
      const request = parseIpcPayload(
        'git:create-and-switch-branch',
        gitBranchPayloadSchema,
        payload
      )
      try {
        const settings = await store.load()
        return await createAndSwitchGitBranch(request.workspaceRoot, request.branch, settings.workspaceRoot)
      } catch (error) {
        return {
          ok: false as const,
          reason: stableGitIpcReason(error),
          message: stableGitIpcError(error)
        }
      }
    }
  )
  ipcMain.handle('git:checkpoint:create', async (_, payload: unknown) => {
    const request = parseIpcPayload('git:checkpoint:create', gitCheckpointCreatePayloadSchema, payload)
    const settings = await store.load()
    await assertGitWorkspaceAllowed(request.workspaceRoot, settings.workspaceRoot)
    return gitCheckpointService.create(request, settings.workspaceRoot)
  })
  ipcMain.handle('git:rollback:preview', async (_, payload: unknown) => {
    const request = parseIpcPayload('git:rollback:preview', gitRollbackPreviewPayloadSchema, payload)
    const settings = await store.load()
    return gitCheckpointService.preview(request, settings.workspaceRoot)
  })
  ipcMain.handle('git:rollback:apply', async (_, payload: unknown) => {
    const request = parseIpcPayload('git:rollback:apply', gitRollbackApplyPayloadSchema, payload)
    const settings = await store.load()
    return gitCheckpointService.apply(request, settings.workspaceRoot)
  })
  ipcMain.handle('repo-map:build', async (_, payload: unknown) => {
    const request = parseIpcPayload('repo-map:build', repoMapBuildPayloadSchema, payload)
    return repoMapService.build(request)
  })
  ipcMain.handle('repo-map:query', async (_, payload: unknown) => {
    const request = parseIpcPayload('repo-map:query', repoMapQueryPayloadSchema, payload)
    return repoMapService.query(request)
  })
  ipcMain.handle('lsp:request', async (_, payload: unknown) => {
    const request = parseIpcPayload('lsp:request', lspRequestPayloadSchema, payload)
    return repoMapService.lsp(request)
  })

  ipcMain.handle('editor:list', async () => listEditorsResult())
  ipcMain.handle('editor:open-path', async (_, payload: unknown) =>
    openEditorPath(parseIpcPayload('editor:open-path', openEditorPathPayloadSchema, payload))
  )

  ipcMain.handle('file:resolve-workspace', async (_, payload: unknown) =>
    resolveWorkspaceFile(
      parseIpcPayload('file:resolve-workspace', workspaceFileTargetPayloadSchema, payload)
    )
  )
  ipcMain.handle('file:list-workspace-directory', async (_, payload: unknown) =>
    listWorkspaceDirectory(
      parseIpcPayload('file:list-workspace-directory', workspaceDirectoryTargetPayloadSchema, payload)
    )
  )
  ipcMain.handle('ppt:deliverable:verify', async (_, payload: unknown) =>
    verifyPptMasterDeliverable(
      parseIpcPayload('ppt:deliverable:verify', pptMasterDeliverableVerifyPayloadSchema, payload)
    )
  )
  ipcMain.handle('ppt:python-env:status', () => getPptMasterPythonEnvStatus())
  ipcMain.handle('ppt:python-env:ensure', async (event) =>
    ensurePptMasterPythonEnv({
      onProgress: (progress) => event.sender.send('ppt:python-env:progress', progress)
    })
  )
  ipcMain.handle('file:read-workspace', async (_, payload: unknown) =>
    readWorkspaceFile(
      parseIpcPayload('file:read-workspace', workspaceFileTargetPayloadSchema, payload)
    )
  )
  ipcMain.handle('file:read-workspace-image', async (_, payload: unknown) =>
    readWorkspaceImage(
      parseIpcPayload('file:read-workspace-image', workspaceFileTargetPayloadSchema, payload)
    )
  )
  ipcMain.handle('file:open-workspace', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'file:open-workspace',
      workspaceFileTargetPayloadSchema,
      payload
    )
    try {
      const target = await resolveOpenTargetPath(request.path, request.workspaceRoot, {
        allowBasenameFallback: false
      })
      return openPathWithShell(target)
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('file:reveal-workspace', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'file:reveal-workspace',
      workspaceFileTargetPayloadSchema,
      payload
    )
    try {
      const target = await resolveOpenTargetPath(request.path, request.workspaceRoot, {
        allowBasenameFallback: false
      })
      shell.showItemInFolder(target)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('file:save-as', async (_, payload: unknown) =>
    saveWorkspaceFileAs(payload, getMainWindow, store)
  )
  ipcMain.handle('file:write-workspace', async (_, payload: unknown) =>
    writeWorkspaceFile(
      parseIpcPayload('file:write-workspace', workspaceFileWritePayloadSchema, payload)
    )
  )
  ipcMain.handle('file:create-workspace', async (_, payload: unknown) =>
    createWorkspaceFile(
      parseIpcPayload('file:create-workspace', workspaceFileCreatePayloadSchema, payload)
    )
  )
  ipcMain.handle('file:create-workspace-directory', async (_, payload: unknown) =>
    createWorkspaceDirectory(
      parseIpcPayload('file:create-workspace-directory', workspaceDirectoryCreatePayloadSchema, payload)
    )
  )
  ipcMain.handle('file:save-workspace-clipboard-image', async (_, payload: unknown) =>
    saveWorkspaceClipboardImage(
      parseIpcPayload(
        'file:save-workspace-clipboard-image',
        workspaceClipboardImageSavePayloadSchema,
        payload
      )
    )
  )
  ipcMain.handle('clipboard:read-image', async () => readClipboardImage())
  ipcMain.handle('file:rename-workspace-entry', async (_, payload: unknown) =>
    renameWorkspaceEntry(
      parseIpcPayload('file:rename-workspace-entry', workspaceEntryRenamePayloadSchema, payload)
    )
  )
  ipcMain.handle('file:delete-workspace-entry', async (_, payload: unknown) =>
    deleteWorkspaceEntry(
      parseIpcPayload('file:delete-workspace-entry', workspaceEntryDeletePayloadSchema, payload)
    )
  )
  ipcMain.handle('file:watch-workspace', async (event, payload: unknown) => {
    const request = parseIpcPayload('file:watch-workspace', workspaceFileWatchPayloadSchema, payload)
    const initial = await readWorkspaceFile(request)
    let watchedPath: string
    let initialContent: string
    let initialSize: number
    let initialTruncated: boolean
    if (initial.ok) {
      watchedPath = initial.path
      initialContent = initial.content
      initialSize = initial.size
      initialTruncated = initial.truncated
    } else {
      const initialImage = await readWorkspaceImage(request)
      if (!initialImage.ok) return initial
      watchedPath = initialImage.path
      initialContent = ''
      initialSize = initialImage.size
      initialTruncated = false
    }

    const watchId = randomUUID()
    try {
      const watcher = watch(watchedPath, { persistent: false }, () => {
        scheduleWorkspaceFileChange(watchId)
      })
      workspaceFileWatchers.set(watchId, {
        watcher,
        sender: event.sender,
        path: watchedPath,
        workspaceRoot: request.workspaceRoot,
        timer: null
      })
      event.sender.once('destroyed', () => disposeWorkspaceFileWatchesForSender(event.sender))
      return {
        ok: true as const,
        watchId,
        path: watchedPath,
        content: initialContent,
        size: initialSize,
        truncated: initialTruncated,
        startedAt: new Date().toISOString()
      }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('file:unwatch-workspace', async (_, watchId: unknown) =>
    disposeWorkspaceFileWatch(parseIpcPayload('file:unwatch-workspace', streamIdSchema, watchId))
  )
  ipcMain.handle('write:export', async (_, payload: unknown) => {
    // 读取一次设置，把用户自定义模板和默认模板 id 传给导出服务
    const settings = await store.load()
    return exportWriteDocument(
      parseIpcPayload('write:export', writeExportPayloadSchema, payload),
      {
        parentWindow: getMainWindow(),
        userExportTemplates: settings.write.exportTemplates,
        defaultExportTemplateId: settings.write.defaultExportTemplateId
      }
    )
  })
  ipcMain.handle('write:copy-rich-text', async (_, payload: unknown) =>
    copyWriteDocumentAsRichText(
      parseIpcPayload('write:copy-rich-text', writeRichClipboardPayloadSchema, payload)
    )
  )
  ipcMain.handle('design:export-pptx', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:export-pptx', designExportPayloadSchema, payload)
    const mainWindow = getMainWindow()
    const dialogOptions: Electron.SaveDialogOptions = {
      title: 'Export PPTX',
      defaultPath: `${parsed.name || 'design'}.pptx`,
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }]
    }
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) {
      return { ok: false, message: 'Export canceled.' }
    }
    const normalizedDoc = normalizeDesignDocument(parsed.document as Record<string, unknown>)
    if (!normalizedDoc) {
      return { ok: false, message: 'Invalid design document.' }
    }
    const assetDataUrls: Record<string, string> = {}
    if (parsed.workspaceRoot) {
      for (const asset of normalizedDoc.assets) {
        const assetResult = await readDesignAsset(parsed.workspaceRoot, normalizedDoc.id, asset)
        if (assetResult.ok && assetResult.dataUrl) assetDataUrls[asset.id] = assetResult.dataUrl
      }
    }
    return exportDesignToPptx(normalizedDoc, result.filePath, assetDataUrls)
  })
  ipcMain.handle('design:document:load', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:document:load', designDocumentLoadPayloadSchema, payload)
    return loadDesignDocument(parsed.workspaceRoot, parsed.documentId)
  })
  ipcMain.handle('design:document:list', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:document:list', designDocumentListPayloadSchema, payload)
    return listDesignDocuments(parsed.workspaceRoot)
  })
  ipcMain.handle('design:document:save', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:document:save', designDocumentSavePayloadSchema, payload)
    const normalized = normalizeDesignDocument(parsed.document as Record<string, unknown>)
    if (!normalized) {
      return { ok: false, code: 'invalid_document' as const, message: 'Invalid Design document.' }
    }
    return saveDesignDocument({
      workspaceRoot: parsed.workspaceRoot,
      document: normalized,
      activePageId: parsed.activePageId,
      expectedRevision: parsed.expectedRevision
    })
  })
  ipcMain.handle('design:asset:import-image', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:asset:import-image', designImageImportPayloadSchema, payload)
    const mainWindow = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Import image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const sourcePath = result.filePaths[0]
      const bytes = await readSafeDesignImageSource(sourcePath)
      const image = nativeImage.createFromBuffer(Buffer.from(bytes))
      if (image.isEmpty()) throw new Error('Selected image could not be decoded.')
      const size = image.getSize()
      const mimeType = (() => {
        const extension = extname(sourcePath).toLowerCase()
        if (extension === '.png') return 'image/png'
        if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
        if (extension === '.webp') return 'image/webp'
        if (extension === '.gif') return 'image/gif'
        return ''
      })()
      const stored = await storeDesignImageAsset({
        workspaceRoot: parsed.workspaceRoot,
        documentId: parsed.documentId,
        originalFilename: basename(sourcePath),
        mimeType,
        width: size.width,
        height: size.height,
        bytes
      })
      return { ok: true, ...stored }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('design:asset:read', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:asset:read', designAssetReadPayloadSchema, payload)
    return readDesignAsset(parsed.workspaceRoot, parsed.documentId, parsed.asset)
  })
  ipcMain.handle('design:import-pptx', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:import-pptx', designPptxImportPayloadSchema, payload)
    const mainWindow = getMainWindow()
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Import PPTX',
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      properties: ['openFile']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true, message: 'Import canceled.' }
    }
    const imported = await importPptxToDesign(result.filePaths[0])
    if (!imported.ok) return imported
    try {
      const idMap = new Map<string, string>()
      const assets: DesignAsset[] = []
      for (const image of imported.images) {
        const rendered = image.mimeType === 'image/svg+xml'
          ? await rasterizeImportedDesignSvg({
              bytes: image.bytes,
              width: image.width ?? 1280,
              height: image.height ?? 720
            })
          : (() => {
              const native = nativeImage.createFromBuffer(Buffer.from(image.bytes))
              if (native.isEmpty()) throw new Error(`Imported image ${image.filename} could not be decoded.`)
              const size = native.getSize()
              return {
                bytes: image.bytes,
                mimeType: image.mimeType,
                width: size.width,
                height: size.height
              }
            })()
        const stored = await storeDesignImageAsset({
          workspaceRoot: parsed.workspaceRoot,
          documentId: imported.document.id,
          originalFilename: image.filename,
          mimeType: rendered.mimeType,
          width: rendered.width,
          height: rendered.height,
          bytes: rendered.bytes
        })
        idMap.set(image.provisionalId, stored.asset.id)
        assets.push(stored.asset)
      }
      const document = {
        ...imported.document,
        assets,
        pages: imported.document.pages.map((page) => ({
          ...page,
          ...(page.fidelityImageAssetId
            ? { fidelityImageAssetId: idMap.get(page.fidelityImageAssetId) ?? page.fidelityImageAssetId }
            : {}),
          elements: page.elements
            .map((element) =>
              element.type === 'image' && element.imageAssetId
                ? {
                    ...element,
                    imageAssetId: idMap.get(element.imageAssetId) ?? element.imageAssetId
                  }
                : element
            )
            .filter((element) =>
              element.type !== 'image' ||
              !element.imageAssetId ||
              assets.some((asset) => asset.id === element.imageAssetId)
            )
        }))
      }
      return {
        ok: true,
        document,
        activePageId: document.pages[0]?.id,
        warnings: imported.warnings
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('design:save-to-write', async (_, payload: unknown) =>
    saveDesignAssetToWrite(
      parseIpcPayload('design:save-to-write', designWriteAssetPayloadSchema, payload)
    )
  )
  ipcMain.handle('design:render-preset', async (_, payload: unknown) => {
    const parsed = parseIpcPayload('design:render-preset', designPresetRenderSchema, payload)
    return renderPresetShape(parsed.presetName, {
      x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h
    }, parsed.fill ?? '#1E3A5F')
  })
  ipcMain.handle('design:list-presets', async () => listPresetShapes())
  ipcMain.handle('write:agnes-image-generate', async (_, payload: unknown) =>
    generateAgnesImage(
      await store.load(),
      parseIpcPayload('write:agnes-image-generate', writeAgnesImageGenerationPayloadSchema, payload)
    )
  )
  ipcMain.handle('write:inline-completion', async (_, payload: unknown) =>
    requestWriteInlineCompletion(
      await store.load(),
      parseIpcPayload('write:inline-completion', writeInlineCompletionPayloadSchema, payload)
    )
  )
  ipcMain.handle('write:generate-infographic', async (_, payload: unknown) =>
    requestWriteInfographic(
      await store.load(),
      parseIpcPayload('write:generate-infographic', writeInfographicPayloadSchema, payload)
    )
  )
  ipcMain.handle('write:inline-completion-debug:list', async () => listWriteInlineCompletionDebugEntries())
  ipcMain.handle('write:inline-completion-debug:clear', async () => {
    clearWriteInlineCompletionDebugEntries()
    return true
  })
  ipcMain.handle('write:knowledge-base:status', async () => {
    const settings = await store.load()
    return refreshWriteKnowledgeBase(settings.write.knowledgeBase)
  })
  ipcMain.handle('write:knowledge-base:refresh', async () => {
    const settings = await store.load()
    return refreshWriteKnowledgeBase(settings.write.knowledgeBase)
  })
  ipcMain.handle('write:knowledge-base:search', async (_, payload: unknown) => {
    const settings = await store.load()
    const { query } = parseIpcPayload('write:knowledge-base:search', writeKnowledgeSearchPayloadSchema, payload)
    return searchWriteKnowledge(query, settings.write.knowledgeBase)
  })
  ipcMain.handle('desktop:command', async (event, command: unknown) => {
    runDesktopCommand(
      parseIpcPayload('desktop:command', desktopCommandSchema, command),
      event.sender,
      getMainWindow
    )
  })
  ipcMain.handle('shell:open-external', async (_, url: unknown) => {
    const validatedUrl = parseIpcPayload('shell:open-external', shellOpenExternalUrlSchema, url)
    await shell.openExternal(validatedUrl)
  })
  ipcMain.handle('notification:turn-complete', async (_, payload: unknown) =>
    showTurnCompleteNotification(
      parseIpcPayload('notification:turn-complete', notificationPayloadSchema, payload)
    )
  )
  ipcMain.handle('app:version', async () => getAppVersion())
  ipcMain.handle('gui:update-state', async () => readGuiUpdateState())
  ipcMain.handle('gui:update-check', async (_, channel: unknown): Promise<GuiUpdateInfo> => {
    const module = await loadGuiUpdaterModule()
    return module.checkGuiUpdate(
      parseIpcPayload(
        'gui:update-check',
        z.object({ channel: guiUpdateChannelSchema }).strict(),
        { channel }
      ).channel
    )
  })
  ipcMain.handle('gui:update-download', async (_, channel: unknown): Promise<GuiUpdateDownloadResult> => {
    const module = await loadGuiUpdaterModule()
    return module.downloadGuiUpdate(
      parseIpcPayload(
        'gui:update-download',
        z.object({ channel: guiUpdateChannelSchema }).strict(),
        { channel }
      ).channel
    )
  })
  ipcMain.handle('gui:update-install-preflight', async (): Promise<GuiUpdateInstallPreflight> =>
    collectGuiUpdateActiveWork(runtimeRequest)
  )
  ipcMain.handle('gui:update-install', async (_, payload: unknown): Promise<GuiUpdateInstallResult> => {
    const request = parseIpcPayload(
      'gui:update-install',
      z.object({ confirmActiveWork: z.boolean().optional() }).strict(),
      payload ?? {}
    )
    const preflight = await collectGuiUpdateActiveWork(runtimeRequest)
    if (!preflight.ok) {
      return { ok: false, currentVersion: getAppVersion(), message: preflight.message ?? 'Update preflight failed.', code: 'install_failed' }
    }
    if (preflight.activeWork.length > 0 && request.confirmActiveWork !== true) {
      return { ok: false, currentVersion: getAppVersion(), message: 'Active work must be confirmed before restarting.', code: 'install_failed' }
    }
    const module = await loadGuiUpdaterModule()
    return module.installGuiUpdate()
  })

  ipcMain.handle('log:error', async (_, payload: unknown) => {
    const request = parseIpcPayload('log:error', logErrorPayloadSchema, payload)
    logError(request.category, request.message, request.detail)
  })
  ipcMain.handle('log:get-path', async () => resolveLogDirectory())
  ipcMain.handle('log:open-dir', async () => {
    const dir = resolveLogDirectory()
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
    const error = await shell.openPath(dir)
    if (error) return { ok: false, message: error }
    return { ok: true }
  })
}
