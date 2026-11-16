import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { WebArtifactEvidenceInputSchema, WebArtifactVerificationRequestSchema } from '../../contracts/web-artifact-evidence.js'
import { prepareHtmlArtifact } from '../../services/html-artifact.js'
import { renderStructuredWebReport, StructuredWebReportSchema } from '../../services/structured-web-report.js'
import type { TaskController } from '../../services/task-controller.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { atomicWriteFileLocked, serializeFileOperation } from '../file/atomic-write.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'
import { executionGrantBlock } from './sandbox-policy.js'

const PublishPath = z.string().trim().min(1).max(240).describe('Relative filename, e.g. report.html or assets/chart.svg. Structured report mode accepts only .html or .htm.')
const Input = z.union([
  z.object({ path: PublishPath, content: z.string().max(8 * 1024 * 1024) }).strict(),
  z.object({ path: PublishPath, report: StructuredWebReportSchema }).strict()
]).describe('Provide exactly one of complete content or a structured report. First web-research HTML publication requires report; content remains available for ordinary local files and same-file repairs with trusted existing verification input. Report mode generates HTML and verificationInput from the same literal-evidence manifest; publishing never verifies sources or completes the task.')
const maxReadBytes = 3 * 8 * 1024 * 1024 + Buffer.byteLength(prepareHtmlArtifact(''))
const ReadInput = z.object({ source_task_id: z.string().min(1).max(256).optional(), path: z.string().min(1).max(240), offset_bytes: z.number().int().min(0).max(maxReadBytes).default(0), limit_bytes: z.number().int().min(4).max(256 * 1024).default(64 * 1024) }).strict()
const readError = (code: string, message: string) => Object.assign(new Error(message), { code })
const identity = (info: Stats, file = false) => [info.dev, info.ino, info.birthtimeMs, ...(file ? [info.size, info.mtimeMs, info.ctimeMs] : [])].join(':')
const feedTitleGuidance = '标题须逐字取当前所读 DOM 的完整可见标题，包含真实可见后缀；不要从历史稿摘要或自行截短。report 模式会从 item.title 生成名称展示及待核验的原文声明，仍由同一真实记录核验；短标题需在 fields.title 中显式提供包含完整标题的同记录原文 quote（至少12个字符），不得补写或拼接原文。若标题与界面标签同节点且无法确认，请先通过本任务已授权的 observe 与标准 CSS 读取唯一实际标题或记录区域，再生成 report；不要猜 recordUrl。'
const formats = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.svg', '.csv'])

function inputPath(path: string): string[] {
  const parts = path.split('/')
  // eslint-disable-next-line no-control-regex
  if (path !== path.trim() || isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !formats.has(extname(path).toLowerCase())) {
    throw new Error('成果文件名必须是任务目录内的相对路径，支持 HTML、CSS、JS、JSON、TXT、Markdown、SVG 和 CSV。')
  }
  return parts
}

/** The model never chooses the physical output root or obtains general dataDir access. */
export function buildManagedArtifactToolProviders(tasks: Pick<TaskController, 'managedArtifactRoot' | 'getTask'> & Partial<Pick<TaskController, 'verifyWebArtifact' | 'historicalArtifact' | 'webArtifactPublicationGate' | 'recordWebArtifactPublicationBlock' | 'recordWebArtifactPublicationManifest' | 'resolveWebArtifactPublicationManifest' | 'observedFeedCollectionContext'>>): CapabilityToolProvider[] {
  function rootFor(context: ToolHostContext): string {
    const grant = context.executionGrant
    const expected = grant?.taskId ? tasks.managedArtifactRoot(grant.taskId) : undefined
    if (!expected || grant?.managedArtifactRoot !== expected || grant.turnId !== context.turnId || grant.threadId !== context.threadId) {
      throw Object.assign(new Error('当前执行没有对应的任务成果目录。'), { code: 'execution_grant_scope' })
    }
    return expected
  }

  async function collectionFor(context: ToolHostContext) {
    const grant = context.executionGrant
    if (!grant?.taskId || grant.threadId !== context.threadId || grant.turnId !== context.turnId ||
      tasks.getTask(grant.taskId)?.acceptance.webEvidenceBasis !== 'observed_feed') return null
    return await tasks.observedFeedCollectionContext?.(grant.taskId, context.turnId) ?? null
  }

  async function validateRead(context: ToolHostContext): Promise<string> {
    await context.validateExecutionGrant?.()
    context.abortSignal.throwIfAborted()
    context.assertExecution?.()
    const block = executionGrantBlock(context)
    if (block) throw readError(block.code, block.message)
    const root = rootFor(context), task = tasks.getTask(context.executionGrant!.taskId!)
    if (!task || task.threadId !== context.threadId || task.activeTurnId !== context.turnId || task.status !== 'running') {
      throw readError('execution_grant_scope', '当前成果读取不属于正在执行的任务轮次。')
    }
    return root
  }

  /** Read-only traversal: missing directories stay missing; no path creates authority. */
  async function readSnapshot(root: string, parts: string[]): Promise<string[]> {
    const base = dirname(dirname(root)), paths = [base, join(base, 'task-artifacts'), root]
    for (let index = 1; index <= parts.length; index++) paths.push(join(root, ...parts.slice(0, index)))
    const snapshot: string[] = []
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!, file = index === paths.length - 1, info = await lstat(path)
      if (info.isSymbolicLink() || (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) || await realpath(path) !== resolve(path)) {
        throw readError('artifact_read_blocked', '成果读取路径包含链接、替换目录或非普通文件。')
      }
      snapshot.push(identity(info, file))
    }
    return snapshot
  }

  async function readOwnArtifact(args: Record<string, unknown>, context: ToolHostContext, whole = false) {
      const input = ReadInput.parse(args), parts = inputPath(input.path), ownRoot = await validateRead(context)
      const history = input.source_task_id ? await tasks.historicalArtifact?.(context.executionGrant!.taskId!, input.source_task_id, input.path) : undefined
      if (input.source_task_id && !history) throw readError('artifact_history_scope', '当前任务没有该历史成果的只读引用。')
      const root = history?.root ?? ownRoot, target = join(root, ...parts)
      return serializeFileOperation(target, async () => {
        const before = await readSnapshot(root, parts)
        await validateRead(context)
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.nlink !== 1 || identity(info, true) !== before.at(-1)) throw readError('artifact_read_changed', '成果文件在读取前发生变化。')
          if (info.size > maxReadBytes) throw readError('artifact_read_too_large', '成果文件超过受管理发布内容的最大读取字节数。')
          const bytes = Buffer.alloc(info.size)
          let offset = 0
          while (offset < bytes.length) {
            context.abortSignal.throwIfAborted()
            const result = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset)
            if (!result.bytesRead) break
            offset += result.bytesRead
          }
          await validateRead(context)
          const after = await readSnapshot(root, parts), final = await handle.stat()
          if (offset !== bytes.length || JSON.stringify(before) !== JSON.stringify(after) || identity(final, true) !== identity(info, true)) throw readError('artifact_read_changed', '成果文件或目录在读取期间发生变化，请重新核对。')
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw readError('artifact_read_encoding', '成果文件不是有效的 UTF-8 文本。') }
          const start = input.offset_bytes
          if (start > bytes.length || start < bytes.length && (bytes[start]! & 0xc0) === 0x80) throw readError('artifact_read_range', '读取偏移必须是文件内的 UTF-8 字符边界。')
          let end = whole ? bytes.length : Math.min(bytes.length, start + input.limit_bytes)
          while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
          const selected = bytes.subarray(start, end)
          await validateRead(context)
          if (history) {
            const current = await tasks.historicalArtifact?.(context.executionGrant!.taskId!, input.source_task_id!, input.path)
            if (JSON.stringify(current) !== JSON.stringify(history) || createHash('sha256').update(bytes).digest('hex') !== history.sha256) throw readError('artifact_history_changed', '历史成果已变化，不能作为原始草稿读取。')
          }
          const collectionFreshness = await collectionFor(context)
          return { output: { name: input.path, storage: 'task', ...(collectionFreshness ? { collectionFreshness } : {}), ...(history ? { history: true, source_task_id: history.sourceTaskId, writer_receipt_id: history.writerReceiptId, original_execution_grant_id: history.executionGrantId } : {}), content: selected.toString('utf8'), encoding: 'utf-8', byte_size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), offset_bytes: start, bytes_returned: selected.length,
            truncated: end < bytes.length, next_offset_bytes: end < bytes.length ? end : null } }
        } finally { await handle.close() }
      })
  }

  return [{ id: 'managed-artifacts', kind: 'built-in', enabled: true, available: true, tools: [defineLocalTool({
    name: 'publish_artifact',
    description: 'Save a real deliverable in this task’s application-managed output directory, including HTML webpages and local CSS/JS/SVG assets. Available with a read-only user workspace. Pass a relative filename and exactly one of content or report. Ordinary local HTML/SVG/text creation can use content. The server fixes the evidence basis: observed_feed means only the user-requested subscription list records are verified, never official detail text; legacy/default primary_document keeps its original primary-source requirements. A web-research HTML report MUST first use report: {title, collectedAt?, evidence:{coverage,items,noMatches}} after reading every required source for that basis or an actual query-zero page. For observed_feed, first use the authorized native browser to open the exact requested list URL and read the current collection; historical read_task_context snapshots do not establish this collection. Use the complete visible DOM record title including actual visible suffixes, never a shortened historical summary. If a title shares a node with UI labels and cannot be identified exactly, observe then use a standard CSS selector to read the unique actual title/record region before reporting; never guess recordUrl. Use classification=source, source=discovery pointing to the complete actually read list, and recordUrl equal to the actual record href only when observed; otherwise omit it and retain the no-independent-link notice. A trusted complete single-record element read is allowed only for observed_feed, never as a full primary document. Include an explicit fields entry with field=title, value=item.title and a verbatim same-record quote; item.title alone identifies the row and does not supply its field evidence. Bind title/date and every quote to the same record; a matching reason may use other with literal text from that same record, following the user’s actual engineering-service filters. Do not treat a broad word such as monitoring, equipment, or water-quality testing alone as proof of the company’s business, qualification or bid eligibility; all absent budget/deadline/status/qualification fields stay unverified. Do not open detail links merely to meet a primary-document contract the user did not request. Legacy content can repair only the same file with trusted existing verification input; it cannot bootstrap a web report or reuse another filename’s manifest. Report mode renders the formal HTML data region and returns verificationInput from that same manifest, preventing separate HTML and evidence values from drifting. Each fields[].value must be a literal continuous substring of its verbatim source quote after markup/entity/whitespace normalization: retain raw Chinese dates and currency wording, do not infer status or paraphrase qualifications. Unknown fields belong only in unverifiedFields and render as 待核验; they cannot replace required source records/documents or origins for the server task basis. Call read_artifact with the same relative filename to inspect exact saved bytes, then call verify_web_artifact with returned verificationInput. Publishing remains a draft and does not verify sources or complete the task. No general workspace write permission is granted. Content-mode HTML without author styles receives an offline Chinese stylesheet. Cite only observed sources, label partial coverage and preserve the same filename when repairing evidence.',
    inputSchema: { type: 'object', description: 'Provide exactly one of content or report, never both. Runtime validation enforces this exclusive choice.',
      properties: { path: { type: 'string', minLength: 1, maxLength: 240, description: 'Relative filename; report mode accepts only .html or .htm.' },
        content: { type: 'string', maxLength: 8 * 1024 * 1024, description: 'Complete local file content, or a same-file web report repair with trusted existing verification input. First web-research reports must use report. Omit when report is supplied.' },
        report: z.toJSONSchema(StructuredWebReportSchema) },
      required: ['path'], additionalProperties: false },
    toolKind: 'file_change', policy: 'auto',
    shouldAdvertise: context => Boolean(context.executionGrant?.managedArtifactRoot),
    validateArguments: (args, context) => {
      const input = Input.parse(args); inputPath(input.path); rootFor(context)
      if ('report' in input) {
        if (!/\.html?$/i.test(input.path)) throw new Error('结构化来源报告仅支持 HTML 或 HTM 成果。')
        renderStructuredWebReport(input.path, input.report, tasks.getTask(context.executionGrant!.taskId!)?.acceptance.webEvidenceBasis)
      }
    },
    execute: async (args, context) => {
      const input = Input.parse(args)
      const parts = inputPath(input.path)
      if ('report' in input && !/\.html?$/i.test(input.path)) throw new Error('结构化来源报告仅支持 HTML 或 HTM 成果。')
      const rendered = 'report' in input ? renderStructuredWebReport(input.path, input.report, tasks.getTask(context.executionGrant!.taskId!)?.acceptance.webEvidenceBasis) : undefined
      const rawContent = rendered?.content ?? ('content' in input ? input.content : '')
      const content = /\.html?$/i.test(input.path) ? prepareHtmlArtifact(rawContent) : rawContent
      const root = rootFor(context)
      const feed = tasks.getTask(context.executionGrant!.taskId!)?.acceptance.webEvidenceBasis === 'observed_feed'
      const target = join(root, ...parts)
      const candidate = rendered ? { html: content } : null
      let gate = await tasks.webArtifactPublicationGate?.(context.executionGrant!.taskId!, context.turnId, input.path, rendered?.verificationInput, candidate)
      if (gate && !gate.ready) gate = await tasks.recordWebArtifactPublicationBlock?.(context.executionGrant!.taskId!, context.turnId, input.path, rendered?.verificationInput, candidate) ?? gate
      const collectionFreshness = feed ? gate?.collectionFreshness ?? await collectionFor(context) : null
      if (gate && !gate.ready) return { isError: true, output: { ...gate, ...(collectionFreshness ? { collectionFreshness } : {}),
        message: collectionFreshness?.currentCollectionReady === false ? `订阅列表本轮尚缺实际读取，历史快照仅供参考；${gate.stalled ? '原字段停滞记录仍保留，' : ''}未写入新报告。` : gate.stalled ? '相同来源或字段问题在一次修复后仍未解决，已停止重复发布。已有草稿及原始核验记录保留。' : gate.reportManifestRequired
          ? feed ? '订阅列表首次发布须使用report，声明真实同记录字段及已读列表；未写入新报告。' : '网页采集首次发布须使用现有report结构化模式，声明已读正文或可信零匹配。legacy content仅用于原文件已有可信核验输入的修复；未写入新报告。'
          : feed ? '订阅列表尚缺可信完整读取、同记录字段或真实零匹配，未写入新报告。加载中、空DOM及截断均不代表零条。' : '必需来源尚缺正式正文或可信实际零匹配，未写入新报告。请先读取已观察到的真实来源。',
        nextStep: feed ? `${collectionFreshness?.nextStep ?? '先用本任务已授权原生浏览器实际读取本轮完整列表或唯一记录容器；未读分页不得宣称全量，加载/空DOM/截断不是零结果。'} ${feedTitleGuidance}` : gate.stalled ? '查看原始核验原因；取得新的真实来源证据后再继续，不要重复改写HTML。' : '先使用原授权浏览器读取nextReads中的实际href，或继续针对缺失来源检索并读取正文；真实零匹配用report.evidence.noMatches声明已读query/quote，再发布。' } }
      const verify = async (): Promise<void> => {
        await context.validateExecutionGrant?.()
        if (context.abortSignal.aborted) throw new Error('成果保存已取消。')
        rootFor(context)
        // Check each managed directory before traversing or creating its child.
        const base = dirname(dirname(root))
        if (await realpath(base) !== resolve(base)) throw new Error('任务成果存储位置已变化。')
        let directory = base
        for (const part of ['task-artifacts', root.split(/[\\/]/).at(-1)!, ...parts.slice(0, -1)]) {
          directory = join(directory, part)
          await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
          const info = await lstat(directory)
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('任务成果目录包含链接或已被替换。')
        }
        const existing = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('成果目标必须是普通文件。')
      }
      return serializeFileOperation(target, async () => {
        await verify()
        const sha256 = createHash('sha256').update(content).digest('hex')
        const manifest = rendered ? await tasks.recordWebArtifactPublicationManifest?.(context.executionGrant!.taskId!, context.turnId, input.path, sha256, rendered.verificationInput, args, context.currentToolOperation?.()) : undefined
        await atomicWriteFileLocked(target, content, { beforeReplace: verify })
        return { output: { path: target, name: input.path, storage: 'task', ...(collectionFreshness ? { collectionFreshness } : {}), bytes_written: Buffer.byteLength(content), sha256, read_artifact: { path: input.path },
          ...(rendered ? { ...(manifest ?? { verificationInput: rendered.verificationInput }), nextStep: '已保存为草稿，尚未核验来源，也未完成任务。先用 read_artifact 读回，再原样使用返回的verificationInput调用verify_web_artifact；任务清单引用会恢复准确的原始来源URL，只有真实来源验收通过才可宣称完成。' } : {}) } }
      })
    }
  }), defineLocalTool({
    name: 'read_artifact',
    description: 'Read the exact UTF-8 bytes of this active task’s own application-managed artifact, including HTML and local text assets saved by publish_artifact. Use the same relative filename, never its physical output path or generic read. Works with a read-only user workspace without enlarging workspace permissions. Returns bounded content, complete file byte_size/sha256 and byte paging metadata; continue with next_offset_bytes until truncated=false. This tool only reads existing files and never creates directories, republishes or executes HTML. An explicit Retry may pass source_task_id to inspect its verified ancestor draft with the same relative filename; the server checks the actual retry control lineage, original writer receipt and unchanged hash. Such history is read-only reference, not a new writer receipt or source verification; publish and verify your own corrected version.',
    inputSchema: z.toJSONSchema(ReadInput) as Record<string, unknown>, policy: 'auto',
    shouldAdvertise: context => Boolean(context.executionGrant?.managedArtifactRoot),
    validateArguments: (args, context) => { const input = ReadInput.parse(args); inputPath(input.path); rootFor(context) },
    execute: (args, context) => readOwnArtifact(args, context)
  }), ...(tasks.verifyWebArtifact ? [defineLocalTool({
    name: 'verify_web_artifact', policy: 'auto',
    description: 'Verify an already-saved HTML research report against this task’s actual successful source-read receipts. No network or external action. Prefer the unchanged verificationInput returned by publish_artifact report mode. The server-owned task basis controls verification. For observed_feed, use the real complete list read and its same-record title/date/actual href as recordUrl, classification=source, and source=discovery for that list. Do not claim the destination primary text was read; unknown facts stay unverified. For legacy/default primary_document, first browser_get_html the real result link (discovery HTML with href), navigate to that observed URL, then browser_get_html its complete primary document (truncated=false). For large SVG/iframe or bodyless pages, that same tool may internally return a complete native actual_loaded_response representation; this separate response kind must pass its own identity/byte contract and is never a full-DOM claim. coverage lists exact URL/resultHash pairs for each required source. items bind a unique tr/article/section id in HTML to title, source, discovery, classification and literal field evidence. The three checks are independent: the primary source contains quote; quote contains the complete literal value; the HTML data-evidence-field text equals value after markup/entity/whitespace normalization. ISO dates, reformatted currency, inferred status and paraphrased qualifications cannot replace source wording. Do not repair one representation alone: publish the same structured manifest and use its returned verificationInput. The formal region is main[data-evidence-report], with id=sectionId, data-evidence-item and data-evidence-classification, plus a[data-evidence-source] linking the exact primary URL. Unknown fields must be absent from fields, listed in unverifiedFields, and displayed as 待核验 with data-evidence-unverified. No field may be both verified and unverified. Unknown fields cannot replace title, real discovery or the complete source record/document and origin evidence required by the server task basis. All report rows, items and fields must be declared. Successful verification covers the structured data region, not arbitrary narrative. Only an actual returned query-zero page may support noMatches; a navigation error or unknown result is not zero. Each required origin needs its own relevant source for the server basis: same-record list evidence for observed_feed, primary item for legacy/default primary_document, or actual query-zero evidence. A user-provided exact document URL may be its own discovery reference. Existing valid prior-Turn receipts remain reusable for legacy/default primary_document. For observed_feed, old snapshots are historical reference: first use the authorized native browser to open/read the current requested collection. Report mode proposes literal title evidence from item.title without verifying it; short titles require a real same-record excerpt of at least 12 characters. Explicit fields.title evidence must match the complete literal title. Use the complete actual visible DOM title, including visible suffixes; if title and UI labels share a node, observe and read a unique actual title/record region using standard CSS before reporting. Never guess recordUrl. If incomplete, repair the same artifact; only actual permission/login/network blockers require user attention. Ordinary files without web-research requirements need no extra step.',
    inputSchema: { type: 'object', description: 'Pass the unchanged task-owned {path,manifestRef} returned in publisher.verificationInput, or a complete legacy evidence input. Runtime validates the exclusive alternatives.',
      properties: { ...(z.toJSONSchema(WebArtifactEvidenceInputSchema) as { properties: Record<string, unknown> }).properties,
        manifestRef: { type: 'string', pattern: '^web-manifest:[a-f0-9]{64}$' } }, required: ['path'], additionalProperties: false },
    shouldAdvertise: context => Boolean(context.executionGrant?.managedArtifactRoot),
    validateArguments: (args, context) => { const input = WebArtifactVerificationRequestSchema.parse(args); inputPath(input.path); if (!/\.html?$/i.test(input.path)) throw new Error('来源核验目前用于 HTML 成果。'); rootFor(context) },
    execute: async (args, context) => {
      const request = WebArtifactVerificationRequestSchema.parse(args)
      inputPath(request.path)
      await validateRead(context)
      const feed = tasks.getTask(context.executionGrant!.taskId!)?.acceptance.webEvidenceBasis === 'observed_feed'
      let captured: Awaited<ReturnType<typeof readOwnArtifact>> | undefined
      let input: ReturnType<typeof WebArtifactEvidenceInputSchema.parse>
      if ('manifestRef' in request) {
        if (!tasks.resolveWebArtifactPublicationManifest) throw readError('artifact_manifest_scope', '当前执行不支持可信发布清单引用。')
        captured = await readOwnArtifact({ path: request.path }, context, true)
        input = await tasks.resolveWebArtifactPublicationManifest(context.executionGrant!.taskId!, context.turnId, request.path, request.manifestRef, captured.output.sha256)
      } else input = request
      let gate = await tasks.webArtifactPublicationGate?.(context.executionGrant!.taskId!, context.turnId, input.path, input)
      if (gate && !gate.ready) gate = await tasks.recordWebArtifactPublicationBlock?.(context.executionGrant!.taskId!, context.turnId, input.path, input) ?? gate
      const collectionFreshness = feed ? gate?.collectionFreshness ?? await collectionFor(context) : null
      if (gate && !gate.ready) return { isError: true, output: { ...gate, complete: false, ...(collectionFreshness ? { collectionFreshness } : {}),
        message: collectionFreshness?.currentCollectionReady === false ? `订阅列表本轮尚缺实际读取，历史快照仅供参考；${gate.stalled ? '原字段停滞记录仍保留。' : '尚未核验报告。'}` : gate.stalled ? '相同核验问题未修复，已停止重复核验；草稿和原始错误保留。' : '请先读取必需来源的真实正文或提供已读页面的可信零匹配，再核验报告。',
        ...(feed ? { nextStep: `${collectionFreshness?.nextStep ?? '先用本任务已授权原生浏览器实际读取本轮列表，再核验同一报告。'} ${feedTitleGuidance}` } : {}) } }
      const read = captured ?? await readOwnArtifact({ path: input.path }, context, true)
      await validateRead(context)
      const result = await tasks.verifyWebArtifact!(context.executionGrant!.taskId!, context.turnId, join(rootFor(context), ...inputPath(input.path)), read.output.sha256, read.output.content, input)
      await validateRead(context)
      return { output: { ...result, ...(collectionFreshness ? { collectionFreshness } : {}),
        ...(feed && !result.complete ? { nextStep: `${feedTitleGuidance} 只修正同一 report 的真实原文字段，再 read_artifact 并原样使用 verificationInput 显式核验。` } : {}) }, ...(result.complete ? {} : { isError: true }) }
    }
  })] : [])] }]
}
