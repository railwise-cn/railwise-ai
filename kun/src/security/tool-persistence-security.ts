import { isAbsolute, relative, resolve } from 'node:path'
import type { RuntimeEvent } from '../contracts/events.js'
import type { TurnItem } from '../contracts/items.js'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'

const MAX_ARGUMENT_SUMMARY_CHARS = 1_000
const MAX_TOOL_NAME_CHARS = 120
const MAX_SAFE_PATH_CHARS = 320
const SENSITIVE_OUTPUT_KEY = /^(?:arguments?|args?|authorization|cookie|cookies|headers?|request_?body|prompt|recipient|recipient_?id|chat_?id|channel_?id|conversation_?id|message_?body)$/i
const COMMUNICATION_OUTPUT_KEY = /^(?:contents?|texts?|messages?|body|bodies|prompts?|inputs?|payloads?|echoed|recipients?|recipient_?ids?|chat_?ids?|channel_?ids?|conversation_?ids?|destinations?)$/i
const COMMUNICATION_TOOL = /(?:^|[_-])(?:message|send|mail|email|wechat|weixin|feishu|lark|slack|discord|telegram|teams|im|echo)(?:$|[_-])/i
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
  return sanitizeOutputValue(redactSecrets(output), {
    communicationTool: COMMUNICATION_TOOL.test(toolName),
    seen: new WeakSet<object>()
  })
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
  if (!summary?.trim()) {
    return buildToolArgumentSummary({ toolName, arguments: {} })
  }
  const lines = [`Run ${safeToolName(toolName)}`]
  for (const rawLine of summary.split(/\r?\n/).slice(1, 12)) {
    const line = rawLine.trim()
    if (/^Target: <(?:workspace|outside-workspace|absolute-path|relative-path-outside-workspace)>/i.test(line)) {
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
