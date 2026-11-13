import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TurnItem } from '../contracts/items.js'
import { externalTaskIntent } from '../services/external-task-capability.js'

const DELIVERABLE_EXTENSIONS = new Set([
  'csv', 'doc', 'docx', 'htm', 'html', 'md', 'markdown', 'odt', 'pdf',
  'ppt', 'pptx', 'rtf', 'txt', 'xls', 'xlsx'
])

const DELIVERY_ACTION_PATTERN =
  /(?:形成|生成|创建|制作|编写|撰写|导出|保存|交付|转换).{0,40}(?:文档|文件|报告|方案|表格|演示|幻灯片|PPT|PDF|Word|Excel|Markdown)|(?:文档|文件|报告|方案|表格|演示|幻灯片|PPT|PDF|Word|Excel|Markdown).{0,40}(?:形成|生成|创建|制作|编写|撰写|导出|保存|交付|转换)|(?:create|write|draft|generate|export|save|deliver|convert).{0,60}(?:document|report|spreadsheet|presentation|markdown|pdf|docx|xlsx|pptx|csv)/i

const WEB_DELIVERY_PATTERN = /(?:生成|制作|创建|保存|导出|交付|汇报|输出).{0,60}(?:网页|html\b)|(?:网页|html\b).{0,60}(?:生成|制作|创建|保存|导出|交付|汇报|报告)|(?:generate|create|save|export|deliver).{0,60}(?:html|web\s*page)/i
const CODE_ONLY_PATTERN = /(?:只|仅).{0,8}(?:要|给|提供|输出|展示).{0,8}(?:示例|源码|代码)|(?:解释|讲解|如何|怎么|怎样).{0,30}(?:html|网页)|(?:show|explain).{0,20}(?:code|example)/i

const WRITE_USER_REQUEST_HEADING = '[用户请求]'

const EXPLICIT_FILE_ACTION_PATTERN =
  /(?:形成|生成|创建|制作|编写|撰写|导出|保存|输出|交付|转换|create|write|draft|generate|export|save|deliver|convert).{0,80}(?:^|[\s"'`/\\])[^\s"'`/\\]+\.(?:md|markdown|txt|docx?|odt|rtf|pdf|xlsx?|csv|pptx?|html?)(?:$|[\s"'`,，。；;:：)）])|(?:^|[\s"'`/\\])[^\s"'`/\\]+\.(?:md|markdown|txt|docx?|odt|rtf|pdf|xlsx?|csv|pptx?|html?)(?:$|[\s"'`,，。；;:：)）]).{0,80}(?:形成|生成|创建|制作|编写|撰写|导出|保存|输出|交付|转换|create|write|draft|generate|export|save|deliver|convert)/i

const NEGATED_FILE_DELIVERY_PATTERN =
  /(?:不要|无需|不用|请勿|禁止|不需要|不必)[^，,；;。！？\n]{0,12}(?:形成|生成|创建|制作|编写|撰写|导出|保存|输出|交付|转换)[^，,；;。！？\n]{0,48}(?:文档|文件|报告|方案|表格|演示|幻灯片|PPT|PDF|Word|Excel|Markdown|CSV|DOCX?|XLSX?|PPTX?)|(?:do\s+not|don't|without|no\s+need\s+to)[^,;.!?\n]{0,12}(?:create|write|draft|generate|export|save|deliver|convert)[^,;.!?\n]{0,48}(?:document|file|report|spreadsheet|presentation|markdown|pdf|docx|xlsx|pptx|csv)/gi

const PROGRESS_ONLY_PATTERN =
  /(?:我(?:先|会|将|来|再|现在|马上|继续|帮你)|让我|接下来|现在开始|继续)(?:.{0,80})(?:抓取|收集|查找|查询|查一下|检索|搜索|搜一下|查看|整理|梳理|汇报|撰写|生成|创建|处理|检查|执行|继续|补充|验证)|(?:i(?:'ll| will)|let me|next[, ]|i am going to|continuing to)(?:.{0,120})(?:fetch|collect|search|look up|review|write|draft|generate|create|process|check|continue|verify)/is

const DELIVERED_RESULT_PATTERN =
  /(?:文档|文件|报告|方案|表格|PPT|PDF|Word|Excel|Markdown).{0,24}(?:已完成|已生成|已创建|已保存|已写入|已导出)|(?:已完成|已生成|已创建|已保存|已写入|已导出).{0,24}(?:文档|文件|报告|方案|表格|PPT|PDF|Word|Excel|Markdown)|(?:document|file|report|spreadsheet|presentation).{0,40}(?:completed|created|generated|saved|written|exported)/i

const EXTERNAL_CAPABILITY_PATTERN =
  /(?:图片生成|图像生成|生图|图片生成提供商|图片生成工具|image generation|image generator|image provider|image tool)/i

const MISSING_CONFIGURATION_PATTERN =
  /(?:未配置|未检测到|不可用|缺少.{0,40}(?:提供商|模型|凭据|密钥)|not configured|not available|unavailable|missing.{0,40}(?:provider|model|credential|api key))/i

const BLOCKED_ACTION_PATTERN =
  /(?:无法继续|不能继续|立即停止|已停止|请到.{0,40}设置|cannot continue|unable to continue|stopped|configure.{0,40}(?:provider|model|credential|api key)|go to.{0,40}settings)/i

const WEB_ACCESS_FAILURE_PATTERN =
  /(?:在线搜索|联网搜索|实时网页|网页访问|网页获取|web[\s_-]+(?:access|search|fetch)).{0,120}(?:失败|不可用|无法|未能|failed|unavailable)|(?:失败|不可用|无法|未能|failed|unavailable).{0,120}(?:在线搜索|联网搜索|实时网页|网页访问|网页获取|web[\s_-]+(?:access|search|fetch))/i

const CURRENT_INFORMATION_UNVERIFIED_PATTERN =
  /(?:无法|未能|不能|暂时无法|unable|could not|cannot).{0,100}(?:(?:核实|核验|验证|确认|获取|verify).{0,100}(?:实时|当前|今天|最新|天气|资讯|信息|current|live|today|latest|weather|news|information)|(?:实时|当前|今天|最新|天气|资讯|信息|current|live|today|latest|weather|news|information).{0,100}(?:核实|核验|验证|确认|获取|verify))/i

const PPT_DELIVERABLE_PATTERN =
  /(?:\bpptx?\b|powerpoint|slide deck|presentation|演示文稿|幻灯片|做\s*PPT|生成\s*PPT|PPT\s*Master)/i

const PPT_SPECIFIC_DELIVERABLE_PATTERN =
  /(?:\bpptx?\b|powerpoint|slide deck|演示文稿|幻灯片|做\s*PPT|生成\s*PPT|PPT\s*Master)/i

const HTML_DELIVERABLE_PATTERN =
  /(?:\bhtml?\b|网页演示|web presentation|browser presentation)/i

// External side effects need a provider/tool receipt before a task can be
// marked complete. A prose answer about an approval, message, or todo is not
// evidence that the remote action happened.
const EXTERNAL_EFFECT_PATTERN =
  /(?:(?:钉钉|飞书|企业微信|微信|dingtalk|feishu|lark|wecom|slack|telegram|邮件|email).{0,120}(?:审批|待办|任务|消息|通知|发送|连接|处理|自动|approve|approval|todo|task|message|notify|send)|(?:审批|待办|任务|消息|通知|发送|连接).{0,120}(?:钉钉|飞书|企业微信|微信|dingtalk|feishu|lark|wecom|slack|telegram|邮件|email))/i

const EXTERNAL_EFFECT_TOOL_PATTERN =
  /(?:钉钉|飞书|企业微信|微信|dingtalk|feishu|lark|wecom|slack|telegram|email|mail|send|message|notify|approval|approve|todo|task|webhook|im)/i

function pathExtension(value: string): string {
  const name = value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
  if (!name.includes('.')) return ''
  return name.split('.').at(-1)?.toLowerCase() ?? ''
}

function absoluteDeliverablePathsFromText(value: string): string[] {
  const paths: string[] = []
  const pattern = /((?:\/|[A-Za-z]:[\\/])[^"'\r\n]*?\.(?:md|markdown|txt|docx?|odt|rtf|pdf|xlsx?|csv|pptx?|html?))(?=$|[\s"'`])/gi
  for (const line of value.split(/\r?\n/)) {
    for (const match of line.matchAll(pattern)) {
      const path = match[1]?.trim()
      if (path) paths.push(path)
    }
  }
  return paths
}

function relativeDeliverablePathsFromText(value: string): string[] {
  const paths: string[] = []
  const pattern = /(?:^|[\s"'`(（])((?:[^\s"'`/\\]+[\\/])*[^\s"'`/\\]+\.(?:md|markdown|txt|docx?|odt|rtf|pdf|xlsx?|csv|pptx?|html?))(?=$|[\s"'`,，。；;:：)）])/gi
  for (const match of value.matchAll(pattern)) {
    const path = match[1]?.trim()
    if (path && !isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path)) paths.push(path)
  }
  return paths
}

export function verifiedShellDeliverablePaths(items: readonly TurnItem[], turnId: string): string[] {
  const claimedPaths = items.flatMap((item) =>
    item.turnId === turnId && item.kind === 'assistant_text' && item.status === 'completed'
      ? relativeDeliverablePathsFromText(item.text)
      : []
  )
  if (claimedPaths.length === 0) return []

  const verified = new Set<string>()
  for (const item of items) {
    if (
      item.turnId !== turnId ||
      item.kind !== 'tool_result' ||
      item.toolKind !== 'command_execution' ||
      item.status !== 'completed' ||
      item.isError === true ||
      !item.output ||
      typeof item.output !== 'object'
    ) continue
    const output = item.output as Record<string, unknown>
    const cwd = typeof output.cwd === 'string' ? output.cwd.trim() : ''
    const startedAt = typeof output.started_at === 'string' ? Date.parse(output.started_at) : Number.NaN
    const finishedAt = typeof output.finished_at === 'string' ? Date.parse(output.finished_at) : Number.NaN
    if (!isAbsolute(cwd) || output.exit_code !== 0 || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
      continue
    }

    for (const claimedPath of claimedPaths) {
      const absolutePath = resolve(cwd, claimedPath)
      const workspacePath = relative(cwd, absolutePath)
      if (!workspacePath || workspacePath === '..' || workspacePath.startsWith(`..${sep}`) || isAbsolute(workspacePath)) {
        continue
      }
      try {
        const stats = statSync(absolutePath)
        if (
          stats.isFile() &&
          stats.mtimeMs >= startedAt - 2_000 &&
          stats.mtimeMs <= finishedAt + 2_000
        ) verified.add(absolutePath)
      } catch {
        // A claimed path that is absent or unreadable is not a deliverable.
      }
    }
  }
  return [...verified]
}

export function fileOutputPaths(output: unknown): string[] {
  if (!output || typeof output !== 'object') return []
  const raw = output as Record<string, unknown>
  const paths: string[] = []
  for (const key of ['path', 'file', 'absolute_path', 'absolutePath', 'relative_path', 'relativePath']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) paths.push(value.trim())
  }
  for (const key of ['files', 'generatedFiles']) {
    const entries = raw[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.trim()) {
        paths.push(entry.trim())
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      paths.push(...fileOutputPaths(entry))
    }
  }
  // Shell tools return verified file paths in stdout instead of structured
  // file metadata. Only inspect result text, never the command itself: a
  // redirection target in an unexecuted or failed command is not a deliverable.
  for (const key of ['stdout', 'text', 'output']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) {
      paths.push(...absoluteDeliverablePathsFromText(value))
    }
  }
  return paths
}

/** Input paths from read/list/search results never constitute a delivered file. */
export function declaredFileOutputPaths(item:TurnItem):string[] {
  if(item.kind!=='tool_result'||item.status!=='completed'||item.isError)return []
  if(/^(?:read(?:_.*)?|ls|find|grep|search(?:_.*)?|list(?:_.*)?|memory_.*|get_.*)$/.test(item.toolName))return []
  const output=item.output&&typeof item.output==='object'?item.output as Record<string,unknown>:undefined
  if(Array.isArray(output?.generatedFiles))return fileOutputPaths({generatedFiles:output.generatedFiles})
  const mutating=item.toolKind==='file_change'||item.toolKind==='command_execution'||['write','edit','propose_document','export_document','analyze_delivery_monitoring'].includes(item.toolName)
  if(mutating)return fileOutputPaths(item.output)
  // Unknown adapters must explicitly declare generated files; a generic `path`
  // or `files` field can equally describe their inputs and is not sufficient.
  return []
}

export function promptRequiresFileDeliverable(prompt: string): boolean {
  const normalized = completionIntentText(prompt)
    .replace(NEGATED_FILE_DELIVERY_PATTERN, ' ')
    .trim()
  if (!normalized) return false
  if (CODE_ONLY_PATTERN.test(normalized)) return false
  return DELIVERY_ACTION_PATTERN.test(normalized) || EXPLICIT_FILE_ACTION_PATTERN.test(normalized) || WEB_DELIVERY_PATTERN.test(normalized)
}

export function promptRequiresExternalEffect(prompt: string): boolean {
  const normalized = completionIntentText(prompt).trim()
  if (/^(?:解释|说明|介绍|什么是|为何|为什么|如何|怎么|怎样|describe|explain|what is|why|how to)/i.test(normalized)) return false
  return externalTaskIntent(normalized) !== null || EXTERNAL_EFFECT_PATTERN.test(normalized)
}

export function toolCanProveExternalEffect(toolName: string): boolean {
  return EXTERNAL_EFFECT_TOOL_PATTERN.test(toolName.trim())
}

export function requiredFileExtensionsForPrompt(prompt: string): readonly string[] | undefined {
  if (!promptRequiresFileDeliverable(prompt)) return undefined
  const normalized = completionIntentText(prompt)
    .replace(NEGATED_FILE_DELIVERY_PATTERN, ' ')
    .trim()
  if (HTML_DELIVERABLE_PATTERN.test(normalized) && !PPT_SPECIFIC_DELIVERABLE_PATTERN.test(normalized)) {
    return ['html', 'htm']
  }
  if (PPT_DELIVERABLE_PATTERN.test(normalized)) return ['ppt', 'pptx']
  return undefined
}

export function completionIntentText(prompt: string): string {
  const normalized = prompt.replace(/\r\n?/g, '\n')
  if (!normalized.includes(WRITE_USER_REQUEST_HEADING)) return normalized.trim()

  const requests: string[] = []
  let cursor = 0
  while (cursor < normalized.length) {
    const markerIndex = normalized.indexOf(WRITE_USER_REQUEST_HEADING, cursor)
    if (markerIndex < 0) break
    const requestStart = markerIndex + WRITE_USER_REQUEST_HEADING.length
    const nextContext = normalized.indexOf('\n[写作上下文]', requestStart)
    const nextRequest = normalized.indexOf(`\n${WRITE_USER_REQUEST_HEADING}`, requestStart)
    const candidates = [nextContext, nextRequest].filter((index) => index >= 0)
    const requestEnd = candidates.length > 0 ? Math.min(...candidates) : normalized.length
    const request = normalized.slice(requestStart, requestEnd).trim()
    if (request) requests.push(request)
    cursor = requestEnd > requestStart ? requestEnd : requestStart
  }
  return requests.join('\n\n').trim()
}

export function hasSuccessfulFileDeliverable(
  items: readonly TurnItem[],
  turnId: string,
  prompt = ''
): boolean {
  const requiredExtensions = requiredFileExtensionsForPrompt(prompt)
  const matchesRequiredExtension = (path: string): boolean => {
    const extension = pathExtension(path)
    return requiredExtensions
      ? requiredExtensions.includes(extension)
      : DELIVERABLE_EXTENSIONS.has(extension)
  }
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.status === 'completed' &&
    item.isError !== true &&
    declaredFileOutputPaths(item).some(matchesRequiredExtension)
  ) || verifiedShellDeliverablePaths(items, turnId).some(matchesRequiredExtension)
}

export function looksLikeProgressOnlyReply(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || normalized.length > 1_200) return false
  if (DELIVERED_RESULT_PATTERN.test(normalized)) return false
  if (looksLikeWebAccessFailureReply(normalized)) return false
  return PROGRESS_ONLY_PATTERN.test(normalized)
}

export function looksLikeExternalCapabilityBlockedReply(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || normalized.length > 4_000) return false
  return EXTERNAL_CAPABILITY_PATTERN.test(normalized) &&
    MISSING_CONFIGURATION_PATTERN.test(normalized) &&
    BLOCKED_ACTION_PATTERN.test(normalized)
}

export function looksLikeWebAccessFailureReply(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || normalized.length > 4_000) return false
  return WEB_ACCESS_FAILURE_PATTERN.test(normalized) &&
    CURRENT_INFORMATION_UNVERIFIED_PATTERN.test(normalized)
}

export function latestTurnAssistantText(items: readonly TurnItem[], turnId: string): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.turnId === turnId && item.kind === 'assistant_text' && item.text.trim()) {
      return item.text.trim()
    }
  }
  return ''
}

export function incompleteTurnContinuationInstruction(input: {
  requiresFileDeliverable: boolean
  hasFileDeliverable: boolean
  previousAssistantText: string
  requiredFileExtensions?: readonly string[]
}): string | null {
  if (input.requiresFileDeliverable && !input.hasFileDeliverable) {
    const requiredTypeInstruction = input.requiredFileExtensions?.length
      ? `The requested deliverable must be a ${input.requiredFileExtensions.map((extension) => `.${extension}`).join(' or ')} file. HTML, an outline, or a preview alone does not satisfy this request.`
      : ''
    return [
      'The user explicitly requested a file deliverable, but this turn has not produced one yet.',
      requiredTypeInstruction,
      'Continue the task now. Use an available file-writing tool to save the completed deliverable inside the workspace.',
      'Do not stop after announcing what you will do. After writing the file, verify it and give its exact path.'
    ].filter(Boolean).join(' ')
  }
  if (looksLikeProgressOnlyReply(input.previousAssistantText)) {
    return [
      'The previous assistant reply was only a progress announcement and did not finish the requested work.',
      'Continue executing the task now. Do not stop at another promise or status update; return a concrete result.'
    ].join(' ')
  }
  return null
}
