import { isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { RuntimeEvent } from '../contracts/events.js'
import type { TurnItem } from '../contracts/items.js'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import { sanitizeBrowserApprovalSummary } from './browser-approval-summary.js'

const MAX_ARGUMENT_SUMMARY_CHARS = 1_000
const MAX_TOOL_NAME_CHARS = 120
const MAX_SAFE_PATH_CHARS = 320
const SENSITIVE_OUTPUT_KEY = /^(?:arguments?|args?|authorization|cookie|cookies|headers?|request_?body|prompt|recipient|recipient_?id|chat_?id|channel_?id|conversation_?id|message_?body)$/i
const COMMUNICATION_OUTPUT_KEY = /^(?:contents?|texts?|messages?|body|bodies|prompts?|inputs?|payloads?|echoed|recipients?|recipient_?ids?|chat_?ids?|channel_?ids?|conversation_?ids?|destinations?)$/i
const COMMUNICATION_TOOL = /(?:^|[_-])(?:message|send|mail|email|wechat|weixin|feishu|lark|slack|discord|telegram|teams|im|echo)(?:$|[_-])/i
const TYPED_CONNECTOR_TOOLS = new Set(['lark_task_list', 'lark_task_get', 'lark_task_complete', 'lark_approval_list', 'lark_approval_get', 'lark_approval_approve', 'lark_approval_reject',
  'lark_mail_send', 'lark_mail_send_status', 'lark_im_send', 'lark_im_get_message', 'lark_drive_upload', 'lark_drive_verify_file'])
const DWS_APPROVAL_ACTIONS = new Map([
  ['dingtalk_approve', 'approve'], ['dingtalk_reject', 'reject'], ['dingtalk_transfer', 'transfer'],
  ['dingtalk_get_approval', 'detail'], ['dingtalk_get_approval_tasks', 'detail']
])
const CONNECTOR_METADATA = new Set(['provider', 'operation', 'target', 'backend', 'accountFingerprint', 'remoteOperationId', 'resultHash', 'verifiedAt', 'kind', 'status'])
function safeConnectorId(value: unknown): string | undefined { return typeof value === 'string' && /^[A-Za-z0-9_.:@+-]{1,512}$/.test(value) && redactSecretText(value) === value ? value : undefined }
const BASH_TOOL = /(?:^|[_-])(?:bash|shell|terminal|command|exec|execute)(?:$|[_-])/i
const URL_KEY = /(?:^|_)(?:url|uri|endpoint)(?:$|_)/i
const PATH_KEYS = ['path', 'file_path', 'target_path', 'destination_path', 'directory', 'cwd'] as const
const CONTENT_KEYS = ['content', 'text', 'patch', 'markdown', 'input', 'body', 'prompt', 'query'] as const
const SUBCOMMAND_EXECUTABLES = new Set([
  'brew',
  'bun',
  'cargo',
  'composer',
  'deno',
  'docker',
  'dotnet',
  'gh',
  'git',
  'glab',
  'go',
  'helm',
  'kubectl',
  'launchctl',
  'npm',
  'pip',
  'pip3',
  'pnpm',
  'podman',
  'poetry',
  'systemctl',
  'terraform',
  'tofu',
  'uv',
  'yarn'
])

export function buildToolArgumentSummary(input: {
  toolName: string
  arguments: Record<string, unknown>
  workspace?: string
}): string {
  const toolName = safeToolName(input.toolName)
  const args = input.arguments
  const lines = [`Run ${toolName}`]
  if (toolName === 'lark_mail_send' || toolName === 'lark_im_send') {
    const target = safeConnectorId(args.recipient ?? args.chatId)
    const content = toolName === 'lark_mail_send' ? args.body : args.text
    if (!target || typeof content !== 'string' || content.length > 64_000) return `${lines[0]}\nParameters: invalid delivery request`
    return [...lines, 'Provider: lark', 'Action: send', `External target: ${target}`,
      ...(typeof args.subject === 'string' ? [`Subject (JSON): ${JSON.stringify(redactSecretText(args.subject))}`] : []),
      `Content (JSON): ${JSON.stringify(redactSecretText(content))}`,
      `Content SHA256: ${createHash('sha256').update(content).digest('hex')}`,
      `Request SHA256: ${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`
    ].join('\n')
  }
  if (toolName === 'request_host_shell') {
    const command = typeof args.command === 'string' && args.command.length <= 1024 ? args.command : ''
    const workspace = typeof input.workspace === 'string' && input.workspace.length <= 2048 ? input.workspace : ''
    if (!command.trim() || !workspace) return [...lines, 'Authority: Invalid command or workspace; authorization cannot be recorded'].join('\n')
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    return [...lines,
      'Authority: Full host access for this exact command only; workspace trust remains unchanged',
      `Workspace (JSON): ${JSON.stringify(redactSecretText(workspace))}`,
      `Workspace SHA256: ${digest(workspace)}`,
      `Command (JSON): ${JSON.stringify(redactSecretText(command))}`,
      `Command SHA256: ${digest(command)}`,
      `Request SHA256: ${digest(JSON.stringify(args))}`,
      `Lifetime seconds: ${Number.isSafeInteger(args.ttl_seconds) ? args.ttl_seconds : 60}`,
      `Timeout seconds: ${Number.isSafeInteger(args.timeout_seconds) ? args.timeout_seconds : 60}`,
      'Session: Read output or stop only; no stdin writes, connector proxy or automatic replay'
    ].join('\n')
  }
  if (toolName === 'confirm_external_effect_scope') {
    const effects = Array.isArray(args.effects) ? args.effects : []
    if (effects.length < 1 || effects.length > 8) return boundSummary([...lines, 'Scope: Invalid action set; no confirmation can be recorded'])
    lines.push(`Scope: Entire task is limited to these ${effects.length} actions`)
    if (Number.isSafeInteger(args.expected_revision) && Number(args.expected_revision) >= 0) lines.push(`Effect scope revision: ${args.expected_revision}`)
    for (const [index, effect] of effects.entries()) {
      const item = effect && typeof effect === 'object' ? effect as Record<string, unknown> : {}
      const name = typeof item.tool_name === 'string' ? item.tool_name : ''
      const provider = name.startsWith('lark_') ? 'lark' : name.startsWith('dingtalk_') ? 'dingtalk' : ''
      const operation = /^(?:lark_(?:task|approval)_get|dingtalk_get_(?:task|approval))$/.test(name) ? 'detail' : name === 'dingtalk_complete_task' ? 'complete' : name.split('_').at(-1)
      const target = safeConnectorId(item.target)
      if (!provider || !operation || !['detail', 'approve', 'reject', 'complete', 'transfer', 'send', 'upload'].includes(operation) || !target || target.length > 320) return boundSummary([lines[0]!, 'Scope: Invalid action set; no confirmation can be recorded'])
      lines.push(`Action ${index + 1}: ${provider} ${operation} ${target}`)
    }
    return boundSummary(lines)
  }
  const dwsApprovalAction = DWS_APPROVAL_ACTIONS.get(toolName)
  if (dwsApprovalAction) {
    lines.push('Provider: dingtalk', `Action: ${dwsApprovalAction}`)
    const target = safeConnectorId(args.taskId ?? args.instanceId)
    const instance = safeConnectorId(args.instanceId)
    const recipient = toolName === 'dingtalk_transfer' ? safeConnectorId(args.toUserId) : undefined
    if (target) lines.push(`External target: ${target}`)
    if (instance && instance !== target) lines.push(`Approval instance: ${instance}`)
    if (recipient) lines.push(`Transfer recipient: ${recipient}`)
    lines.push('Parameters: sensitive contents omitted')
    // All three identifiers are separately bounded. Keep the exact reviewed IDs.
    return lines.join('\n')
  }
  if (TYPED_CONNECTOR_TOOLS.has(toolName)) {
    lines.push('Provider: lark')
    lines.push(`Action: ${toolName.split('_').at(-1)}`)
    const target = safeConnectorId(args.taskId ?? args.instanceCode ?? args.chatId ?? args.folderToken ?? args.fileToken ?? args.messageId)
    if (target) lines.push(`External target: ${target}`)
    const instance = safeConnectorId(args.instanceCode)
    if (instance && instance !== target) lines.push(`Approval instance: ${instance}`)
    if (toolName === 'lark_drive_upload') {
      if (typeof args.path === 'string') lines.push(`Target: ${summarizeWorkspacePath(args.path, input.workspace)}`)
      if (typeof args.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(args.expectedHash)) lines.push(`Content SHA256: ${args.expectedHash}`)
    }
    lines.push('Parameters: sensitive contents omitted')
    return boundSummary(lines)
  }

  if (BASH_TOOL.test(toolName)) {
    const action = safeAction(args.action)
    if (action && action !== 'run') lines.push(`Action: ${action}`)
    if (!action || action === 'run') {
      const command = typeof args.command === 'string' ? summarizeCommand(args.command) : ''
      lines.push(`Command: ${command || 'omitted'}`)
    }
    lines.push('Arguments and sensitive values: omitted')
    return boundSummary(lines)
  }

  if (COMMUNICATION_TOOL.test(toolName)) {
    lines.push('Destination: omitted')
    const contentLength = largestTextLength(args, ['message', 'body', 'content', 'text', 'prompt'])
    if (contentLength > 0) lines.push(`Message content: omitted (${contentLength} chars)`)
  } else {
    const pathValue = firstString(args, PATH_KEYS)
    if (pathValue) lines.push(`Target: ${summarizeWorkspacePath(pathValue, input.workspace)}`)
  }

  const action = safeAction(args.action ?? args.operation)
  if (action) lines.push(`Action: ${action}`)

  const contentLength = largestTextLength(args, CONTENT_KEYS)
  if (contentLength > 0 && !COMMUNICATION_TOOL.test(toolName)) {
    lines.push(`Content: omitted (${contentLength} chars)`)
  }
  if (Object.keys(args).some((key) => URL_KEY.test(key))) {
    lines.push('URL details: omitted (credentials and query values hidden)')
  }
  lines.push(`Parameters: ${Object.keys(args).length} field(s); sensitive values omitted`)
  return boundSummary(lines)
}

export function sanitizeTurnItemForPersistence(item: TurnItem): TurnItem {
  if (item.kind === 'tool_call') {
    const argumentSummary = Object.keys(item.arguments).length > 0
      ? buildToolArgumentSummary({ toolName: item.toolName, arguments: item.arguments })
      : normalizeArgumentSummary(item.toolName, item.argumentSummary)
    return {
      ...item,
      arguments: {},
      argumentSummary
    }
  }
  if (item.kind === 'tool_result') {
    return {
      ...item,
      output: sanitizeToolResultOutput(item.toolName, item.output)
    }
  }
  if (item.kind === 'approval') {
    if (item.taskInputId && item.sourceRequestId) return { ...item, summary: item.status === 'allowed' ? '已允许本次操作' : '本次操作未获授权' }
    return { ...item, summary: sanitizeApprovalSummary(item.toolName, item.summary) }
  }
  return item
}

export function sanitizeRuntimeEventForPersistence(event: RuntimeEvent): RuntimeEvent {
  if ('item' in event && event.item) {
    return {
      ...event,
      item: sanitizeTurnItemForPersistence(event.item)
    } as RuntimeEvent
  }
  if ((event.kind === 'approval_requested' || event.kind === 'approval_resolved') && event.summary) {
    return { ...event, summary: sanitizeApprovalSummary(event.toolName, event.summary) }
  }
  return event
}

export function sanitizeToolResultOutput(toolName: string, output: unknown): unknown {
  const sanitized = sanitizeOutputValue(redactSecrets(output), {
    communicationTool: COMMUNICATION_TOOL.test(toolName),
    seen: new WeakSet<object>()
  })
  if (!TYPED_CONNECTOR_TOOLS.has(toolName) || !output || typeof output !== 'object' || Array.isArray(output)) return sanitized
  const source = output as Record<string, unknown>
  const result = sanitized as Record<string, unknown>
  for (const key of CONNECTOR_METADATA) {
    const value = safeConnectorId(source[key])
    if (value) result[key] = value
  }
  if (source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence)) {
    const evidence = source.evidence as Record<string, unknown>
    const safeEvidence: Record<string, unknown> = { verified: evidence.verified === true }
    for (const key of CONNECTOR_METADATA) {
      const value = safeConnectorId(evidence[key])
      if (value) safeEvidence[key] = value
    }
    result.evidence = safeEvidence
  }
  if (source.verificationLocator && typeof source.verificationLocator === 'object' && !Array.isArray(source.verificationLocator)) {
    const locator = source.verificationLocator as Record<string, unknown>
    const fields = toolName === 'lark_mail_send' ? ['messageId', 'recipient']
      : toolName === 'lark_im_send' ? ['messageId', 'chatId', 'contentHash', 'senderId']
        : toolName === 'lark_drive_upload' ? ['fileToken', 'folderToken', 'expectedHash'] : []
    result.verificationLocator = Object.fromEntries(fields.flatMap(key => {
      const value = safeConnectorId(locator[key])
      return value ? [[key, value]] : []
    }))
  }
  return result
}

function sanitizeOutputValue(
  value: unknown,
  context: { communicationTool: boolean; seen: WeakSet<object> },
  key = ''
): unknown {
  if (typeof value === 'string') {
    if (context.communicationTool) {
      const safeMetadata = /^(?:code|status)$/i.test(key) && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
      return safeMetadata ? value : '<omitted>'
    }
    return sanitizeOutputText(value, key)
  }
  if (!value || typeof value !== 'object') return value
  if (context.seen.has(value)) return '[circular]'
  context.seen.add(value)
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeOutputValue(child, context, key))
  }
  const out: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey.toLowerCase() === 'command') continue
    if (context.communicationTool && COMMUNICATION_OUTPUT_KEY.test(childKey)) {
      out[childKey] = '<omitted>'
      continue
    }
    if (SENSITIVE_OUTPUT_KEY.test(childKey)) {
      if (context.communicationTool || childKey.toLowerCase() !== 'message') {
        out[childKey] = '<omitted>'
        continue
      }
    }
    out[childKey] = sanitizeOutputValue(childValue, context, childKey)
  }
  return out
}

function sanitizeOutputText(value: string, key: string): string {
  const withoutSecrets = redactSecretText(value)
  if (URL_KEY.test(key)) return sanitizeUrl(withoutSecrets)
  return withoutSecrets
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.replace(/([?&])[^\s#]+/g, '$1<omitted>')
  }
}

function summarizeWorkspacePath(value: string, workspace?: string): string {
  const candidate = value.trim()
  if (!candidate) return 'omitted'
  if ([...candidate].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127
  })) return '<unsafe-path>'
  if (workspace?.trim()) {
    const root = resolve(workspace)
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    const within = relative(root, absolute)
    if (!within.startsWith('..') && !isAbsolute(within)) {
      const suffix = within ? `/${within.replaceAll('\\', '/')}` : ''
      return clip(`<workspace>${suffix}`, MAX_SAFE_PATH_CHARS)
    }
    return '<outside-workspace>'
  }
  if (isAbsolute(candidate)) return '<absolute-path>'
  if (candidate.split(/[\\/]/).includes('..')) return '<relative-path-outside-workspace>'
  return clip(`<workspace>/${candidate.replaceAll('\\', '/')}`, MAX_SAFE_PATH_CHARS)
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const tokens = normalized.split(' ')
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1
  const executable = safeCommandToken(tokens[index])
  if (!executable) return 'omitted'
  const executableKey = executable.toLowerCase().replace(/\.exe$/, '')
  const subcommand = SUBCOMMAND_EXECUTABLES.has(executableKey)
    ? safeCommandToken(tokens[index + 1], { rejectFlags: true })
    : ''
  return subcommand ? `${executable} ${subcommand}` : executable
}

export function summarizeBashCommandForPersistence(command: string): string {
  return summarizeCommand(command) || 'omitted'
}

function normalizeArgumentSummary(toolName: string, summary: string | undefined): string {
  if (['browser_click', 'browser_fill', 'browser_press', 'browser_authorize_action'].includes(toolName)) {
    return sanitizeBrowserApprovalSummary(summary ?? '') ?? '浏览器操作详情不可核验，请重新发起操作确认。'
  }
  if (!summary?.trim()) {
    return buildToolArgumentSummary({ toolName, arguments: {} })
  }
  if (toolName === 'lark_mail_send' || toolName === 'lark_im_send') {
    const lines = summary.split(/\r?\n/)
    const fields = lines.slice(1)
    const contentLine = fields.find(line => line.startsWith('Content (JSON): '))
    let contentValid = false
    try {
      const value = JSON.parse(contentLine?.slice('Content (JSON): '.length) ?? 'null')
      contentValid = typeof value === 'string' && value.length <= 64_000
    } catch { /* Legacy summaries cannot authorize a full delivery. */ }
    const valid = summary.length <= 400_000 && lines[0] === `Run ${toolName}` && contentValid &&
      fields.includes('Provider: lark') && fields.includes('Action: send') &&
      fields.some(line => /^External target: [A-Za-z0-9_.:@+-]{1,512}$/.test(line)) &&
      fields.some(line => /^Request SHA256: [a-f0-9]{64}$/.test(line)) &&
      fields.every(line => /^(?:Provider: lark|Action: send|External target: [A-Za-z0-9_.:@+-]{1,512}|(?:Content|Request) SHA256: [a-f0-9]{64})$/.test(line) ||
        /^(?:Subject|Content) \(JSON\): ".*"$/.test(line))
    if (valid) return lines.map(redactSecretText).join('\n')
  }
  if (toolName === 'request_host_shell') {
    const lines = summary.split(/\r?\n/)
    const valid = lines.length === 10 && lines[0] === 'Run request_host_shell'
      && lines[1] === 'Authority: Full host access for this exact command only; workspace trust remains unchanged'
      && /^Workspace \(JSON\): ".*"$/.test(lines[2]!) && /^Workspace SHA256: [a-f0-9]{64}$/.test(lines[3]!)
      && /^Command \(JSON\): ".*"$/.test(lines[4]!) && /^Command SHA256: [a-f0-9]{64}$/.test(lines[5]!)
      && /^Request SHA256: [a-f0-9]{64}$/.test(lines[6]!) && /^Lifetime seconds: [0-9]{1,3}$/.test(lines[7]!)
      && /^Timeout seconds: [0-9]{1,3}$/.test(lines[8]!)
      && lines[9] === 'Session: Read output or stop only; no stdin writes, connector proxy or automatic replay'
      && summary.length <= 32_000
    return valid ? lines.map(redactSecretText).join('\n') : 'Run request_host_shell\nAuthority: Invalid reviewed scope; authorization cannot be recorded'
  }
  const lines = [`Run ${safeToolName(toolName)}`]
  for (const rawLine of summary.split(/\r?\n/).slice(1, 12)) {
    const line = rawLine.trim()
    if (toolName === 'confirm_external_effect_scope' && (/^Scope: Entire task is limited to these [1-8] actions$/.test(line) || /^Effect scope revision: [0-9]+$/.test(line) || /^Action [1-8]: (?:lark|dingtalk) (?:detail|approve|reject|complete|transfer|send|upload) [A-Za-z0-9_.:@+-]{1,320}$/.test(line))) {
      lines.push(redactSecretText(line))
    } else if (TYPED_CONNECTOR_TOOLS.has(toolName) && (/^Provider: lark$/.test(line) || /^Parameters: sensitive contents omitted$/.test(line) || /^(?:External target|Approval instance): [A-Za-z0-9_.:@+-]{1,512}$/.test(line) || /^(?:Content|Request) SHA256: [a-f0-9]{64}$/.test(line))) {
      lines.push(line)
    } else if (DWS_APPROVAL_ACTIONS.has(toolName) && (/^Provider: dingtalk$/.test(line) || /^Parameters: sensitive contents omitted$/.test(line) || /^(?:External target|Approval instance|Transfer recipient): [A-Za-z0-9_.:@+-]{1,512}$/.test(line))) {
      lines.push(redactSecretText(line))
    } else if (/^Target: <(?:workspace|outside-workspace|absolute-path|relative-path-outside-workspace)>/i.test(line)) {
      lines.push(clip(redactSecretText(line), MAX_SAFE_PATH_CHARS + 8))
    } else if (line.startsWith('Command:')) {
      lines.push(`Command: ${summarizeCommand(line.slice('Command:'.length)) || 'omitted'}`)
    } else if (line.startsWith('Action:')) {
      const action = safeAction(line.slice('Action:'.length))
      if (action) lines.push(`Action: ${action}`)
    } else if (/^(?:Arguments and sensitive values: omitted|Destination: omitted|URL details: omitted \(credentials and query values hidden\))$/.test(line)) {
      lines.push(line)
    } else if (/^(?:Message content|Content): omitted \([0-9]+ chars\)$/.test(line)) {
      lines.push(line)
    } else if (/^Parameters: [0-9]+ field\(s\); sensitive values omitted$/.test(line)) {
      lines.push(line)
    }
  }
  if (lines.length === 1) lines.push('Parameters: omitted from persisted history')
  if (DWS_APPROVAL_ACTIONS.has(toolName)) return lines.join('\n')
  return boundSummary(lines)
}

function sanitizeApprovalSummary(toolName: string, summary: string): string {
  if (/^Run\s+[^\r\n(]+\([^\r\n]*\)/.test(summary.trim())) {
    return boundSummary([
      `Run ${safeToolName(toolName)}`,
      'Parameters: omitted from legacy history'
    ])
  }
  return normalizeArgumentSummary(toolName, summary)
}

function safeCommandToken(
  value: string | undefined,
  options: { rejectFlags?: boolean } = {}
): string {
  if (!value || !/^[A-Za-z0-9_.+-]{1,80}$/.test(value)) return ''
  if (options.rejectFlags && (value.startsWith('-') || value.includes('='))) return ''
  return value
}

function safeAction(value: unknown): string {
  if (typeof value !== 'string') return ''
  const action = value.trim()
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(action) ? action : ''
}

function safeToolName(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim()
  return clip(normalized || 'tool', MAX_TOOL_NAME_CHARS)
}

function firstString(
  args: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function largestTextLength(args: Record<string, unknown>, keys: readonly string[]): number {
  let largest = 0
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') largest = Math.max(largest, [...value].length)
  }
  return largest
}

function boundSummary(lines: string[]): string {
  return clip(lines.join('\n'), MAX_ARGUMENT_SUMMARY_CHARS)
}

function clip(value: string, maxChars: number): string {
  const chars = [...value]
  return chars.length <= maxChars ? value : `${chars.slice(0, Math.max(0, maxChars - 3)).join('')}...`
}
