import { randomUUID } from 'node:crypto'
import {
  DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS,
  modelEndpointPath,
  resolveWriteInlineCompletionEndpointFormat,
  resolveWriteInlineCompletionApiKey,
  resolveWriteInlineCompletionBaseUrl,
  resolveWriteInlineCompletionModel,
  type ModelEndpointFormat,
  type AppSettingsV1
} from '../../shared/app-settings'
import {
  upstreamDeepSeekFimCompletionsUrl,
  upstreamOpenAiChatCompletionsUrl
} from '../../shared/openai-compat-url'
import type {
  WriteInlineCompletionAction,
  WriteInlineCompletionMode,
  WriteInlineCompletionDebugEntry,
  WriteInlineCompletionRequest,
  WriteInlineCompletionResult
} from '../../shared/write-inline-completion'
import type { WriteInlineEditRecentEdit } from '../../shared/write-inline-edit'
import {
  retrieveWriteInlineCompletionContext,
  type WriteRetrievalContext
} from './write-retrieval-service'
import {
  retrieveWriteKnowledgeContext,
  type WriteKnowledgeContext
} from './write-knowledge-service'

const INLINE_COMPLETION_TIMEOUT_MS = 12_000
// Explicit document edits can replace or expand a complete paragraph/document.
// Their output budget must not inherit the small, latency-oriented ghost-text
// preferences. Keep both output and request duration bounded independently.
const DOCUMENT_EDIT_TIMEOUT_MS = 120_000
const DOCUMENT_EDIT_MIN_OUTPUT_TOKENS = 4_096
const DOCUMENT_EDIT_MAX_OUTPUT_TOKENS = 16_384
const KNOWLEDGE_LOOKUP_BUDGET_MS = 1_500
const MAX_INLINE_COMPLETION_DEBUG_ENTRIES = 120
const MAX_DEBUG_TEXT_CHARS = 80_000
const INPUT_BOUNDARY_MARKERS = ['PREFIX', 'SUFFIX', 'EDIT_SCOPE'] as const
const OUTPUT_ACTION_MARKERS = ['SHORT', 'LONG', 'EDIT'] as const

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
    text?: string
  }>
}

type ResponsesApiResponse = {
  status?: string | null
  incomplete_details?: unknown
  error?: unknown
  output_text?: string
  output?: Array<Record<string, unknown>>
}

type AnthropicMessageResponse = {
  stop_reason?: string | null
  content?: Array<Record<string, unknown>>
}

type ChatCompletionMessage = {
  role: 'system' | 'user'
  content: string
}

type WriteInlineProviderResponseFormat = ModelEndpointFormat | 'fim_completions'

function shouldDisableThinkingForInlineCompletion(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized.startsWith('deepseek-v4') || normalized === 'deepseek-reasoner'
}

const inlineCompletionDebugEntries: WriteInlineCompletionDebugEntry[] = []

function clipDebugText(text = ''): string {
  const source = String(text || '')
  if (source.length <= MAX_DEBUG_TEXT_CHARS) return source
  const head = Math.floor(MAX_DEBUG_TEXT_CHARS * 0.62)
  const tail = MAX_DEBUG_TEXT_CHARS - head - 24
  return `${source.slice(0, head)}\n\n... debug text clipped ...\n\n${source.slice(source.length - tail)}`
}

function appendInlineCompletionDebugEntry(entry: WriteInlineCompletionDebugEntry): void {
  inlineCompletionDebugEntries.push({
    ...entry,
    prompt: clipDebugText(entry.prompt),
    suffix: clipDebugText(entry.suffix),
    rawResponse: clipDebugText(entry.rawResponse),
    completion: clipDebugText(entry.completion)
  })
  if (inlineCompletionDebugEntries.length > MAX_INLINE_COMPLETION_DEBUG_ENTRIES) {
    inlineCompletionDebugEntries.splice(0, inlineCompletionDebugEntries.length - MAX_INLINE_COMPLETION_DEBUG_ENTRIES)
  }
}

export function listWriteInlineCompletionDebugEntries(): WriteInlineCompletionDebugEntry[] {
  return [...inlineCompletionDebugEntries].reverse()
}

export function clearWriteInlineCompletionDebugEntries(): void {
  inlineCompletionDebugEntries.length = 0
}

function appendInlineCompletionPreflightFailure(
  startedAt: number,
  settings: AppSettingsV1,
  request: WriteInlineCompletionRequest,
  message: string
): void {
  const model = resolveModel(request, settings)
  const mode = resolveMode(request)
  const prompt = buildWriteInlineCompletionPrompt(request, null)
  appendInlineCompletionDebugEntry({
    id: randomUUID(),
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    ok: false,
    model,
    mode,
    currentFilePath: request.currentFilePath,
    prompt,
    suffix: request.suffix,
    rawResponse: '',
    completion: '',
    actionKind: undefined,
    errorMessage: message,
    referenceCount: 0,
    recentEditCount: request.recentEdits?.length ?? 0,
    promptChars: prompt.length,
    suffixChars: request.suffix.length,
    responseChars: 0
  })
}

function resolveModel(request: WriteInlineCompletionRequest, settings: AppSettingsV1): string {
  return resolveWriteInlineCompletionModel(settings, request.model)
}

function resolveMode(request: WriteInlineCompletionRequest): WriteInlineCompletionMode {
  if (request.mode === 'edit') return 'edit'
  return request.mode === 'long' ? 'long' : 'short'
}

async function withinKnowledgeBudget(
  request: WriteInlineCompletionRequest,
  settings: AppSettingsV1['write']['knowledgeBase']
): Promise<WriteKnowledgeContext | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      retrieveWriteKnowledgeContext(request, settings).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), KNOWLEDGE_LOOKUP_BUDGET_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function flattenMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' || part?.text ? part?.text ?? '' : ''))
    .join('')
}

function cleanCompletionText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0), '')
  const trimmed = normalized.trim()
  if (!trimmed) return ''

  const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/)
  if (fenced) return fenced[1]
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return normalized
}

function trimMarkerPadding(text = ''): string {
  return String(text || '').replace(/\n$/, '')
}

function markerBlock(marker: string, text = ''): string {
  return `<<<${marker}\n${sanitizePromptLine(text)}\n>>>`
}

function sanitizePromptLine(text = ''): string {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/-->/g, '--\\>')
}

function compactText(text = ''): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function clipPromptText(text = '', maxChars = 0): string {
  const source = sanitizePromptLine(text)
  if (!maxChars || source.length <= maxChars) return source
  const head = Math.max(1, Math.floor(maxChars * 0.58))
  const tail = Math.max(1, maxChars - head - 13)
  return `${source.slice(0, head)}\n... omitted ...\n${source.slice(source.length - tail)}`
}

function formatRecentEditAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function buildRecentEditsPromptBlock(edits: WriteInlineEditRecentEdit[] | undefined): string[] {
  const recentEdits = (edits ?? [])
    .filter((edit) => edit.deletedText || edit.insertedText || edit.instruction)
    .slice(-8)
  if (recentEdits.length === 0) return []

  const lines = [
    '',
    'Recent local edits in this file. Treat these as intent signals. If they clearly imply that the user is continuing a local rewrite, you may choose EDIT. If they only show ordinary typing, choose COMPLETION or return an empty completion.'
  ]

  recentEdits.forEach((edit, index) => {
    lines.push('')
    lines.push(`[${index + 1}] ${formatRecentEditAge(edit.ageMs)}; source=${edit.source}; range=${edit.from}-${edit.to}${edit.scopeKind ? `; scope=${edit.scopeKind}` : ''}`)
    if (edit.instruction) lines.push(`Instruction: ${clipPromptText(edit.instruction, 420)}`)
    if (edit.deletedText) lines.push(`Deleted: ${clipPromptText(edit.deletedText, 520)}`)
    if (edit.insertedText) lines.push(`Inserted: ${clipPromptText(edit.insertedText, 520)}`)
    const around = compactText(`${edit.beforeContext} [[edit]] ${edit.afterContext}`)
    if (around) lines.push(`Around: ${clipPromptText(around, 520)}`)
  })

  return lines
}

function buildEditCandidatePromptBlock(request: WriteInlineCompletionRequest): string[] {
  const candidate = request.editCandidate
  if (!candidate) return []
  const scopeLines = candidate.startLine === candidate.endLine
    ? `line ${candidate.startLine}`
    : `lines ${candidate.startLine}-${candidate.endLine}`
  return [
    '',
    'Editable local scope if EDIT is the best action.',
    'Choose EDIT when the user instruction or recent user changes make a replacement more useful than cursor completion.',
    `Edit candidate: ${candidate.kind}; ${scopeLines}; offsets ${candidate.from}-${candidate.to}.`,
    'Original editable scope boundary:',
    markerBlock('EDIT_SCOPE', candidate.original)
  ]
}

function buildEditActionGuidanceBlock(request: WriteInlineCompletionRequest): string[] {
  if (!request.editCandidate) return []
  return [
    '',
    'Edit action guidance:',
    'An editable scope is available in <<<EDIT_SCOPE ... >>>. Return <<<EDIT ... >>> only when replacing that exact scope is the best local action.',
    'If the user is simply continuing at the cursor, return <<<SHORT ... >>> or <<<LONG ... >>> instead.'
  ]
}

function buildResponseProtocolPromptBlock(): string[] {
  return [
    'Return exactly one TextIDE-style action block and nothing else:',
    '<<<SHORT',
    'short text to insert at the cursor',
    '>>>',
    '<<<LONG',
    'longer continuation to insert at the cursor',
    '>>>',
    '<<<EDIT',
    'replacement text for the editable local scope',
    '>>>'
  ]
}

function buildMarkedContextBlocks(request: WriteInlineCompletionRequest): string[] {
  return [
    '',
    'Boundary-marked cursor context:',
    markerBlock('PREFIX', request.prefix),
    markerBlock('SUFFIX', request.suffix)
  ]
}

function buildRetrievalPromptBlock(
  retrieval: WriteRetrievalContext,
  mode: WriteInlineCompletionMode
): string[] {
  const lines = [
    '',
    'Reference snippets from the same writing workspace.',
    'Use these snippets only for local terminology, factual continuity, and style. Do not mention them in the returned action.',
    `Completion mode: ${mode}.`,
    `Retrieval: ${retrieval.source}; indexed ${retrieval.indexedFiles} files / ${retrieval.indexedChunks} chunks.`,
    `Query keywords: ${retrieval.keywords.join(', ')}`
  ]

  retrieval.snippets.forEach((snippet, index) => {
    const location = snippet.lineStart === snippet.lineEnd
      ? `${snippet.path}:${snippet.lineStart}`
      : `${snippet.path}:${snippet.lineStart}-${snippet.lineEnd}`
    lines.push('')
    lines.push(`[${index + 1}] ${location}`)
    if (snippet.title) lines.push(`Title: ${sanitizePromptLine(snippet.title)}`)
    lines.push(`Matched: ${snippet.keywords.join(', ')}`)
    lines.push(sanitizePromptLine(snippet.text))
  })

  return lines
}

function buildKnowledgePromptBlock(knowledge: WriteKnowledgeContext): string[] {
  const lines = [
    '',
    'Public RailWise knowledge references.',
    'Use these references only when relevant. When using a factual claim, preserve its Markdown source link.',
    'Standards, thresholds, and monitoring frequencies require human verification.',
    `Knowledge source: ${knowledge.source}; query keywords: ${knowledge.keywords.join(', ')}.`
  ]
  knowledge.snippets.forEach((snippet, index) => {
    lines.push('')
    lines.push(`[RailWise ${index + 1}] ${sanitizePromptLine(snippet.title)}`)
    lines.push(`Source: [${sanitizePromptLine(snippet.title)}](${sanitizePromptLine(snippet.url)})`)
    lines.push(sanitizePromptLine(snippet.text))
  })
  return lines
}

export function buildWriteInlineCompletionPrompt(
  request: WriteInlineCompletionRequest,
  retrieval: WriteRetrievalContext | null = null,
  knowledge: WriteKnowledgeContext | null = null
): string {
  const mode = resolveMode(request)
  const lines = [
    '<!-- WorkWise Runtime inline completion.',
    'Complete the text at the cursor.',
    'The boundary blocks below identify local context, but the response must be plain insertable text only.',
    'Return only the text to insert at the cursor.',
    'Do not wrap the answer in quotes, Markdown fences, XML, JSON, or action markers.',
    'Do not echo <<<PREFIX ... >>>, <<<SUFFIX ... >>>, or these instructions.',
    mode === 'long'
      ? 'The user has paused for inspiration. Suggest one compact, grounded continuation only when it clearly fits.'
      : 'Prefer a short, precise continuation that looks like the next few keystrokes.',
    'Return an empty response only when there is no sensible local continuation.',
    `Trigger hint: ${mode}.`,
    `Cursor: line ${request.cursor.line}, column ${request.cursor.column}.`,
    `Language: ${sanitizePromptLine(request.context.language)}.`,
    `Policy: ${sanitizePromptLine(request.policy.name)}.`,
    sanitizePromptLine(request.policy.instruction),
    '',
    'Cursor context:',
    `Current line prefix: ${sanitizePromptLine(request.context.currentLinePrefix)}`,
    `Current line suffix: ${sanitizePromptLine(request.context.currentLineSuffix)}`,
    `Previous non-empty line: ${sanitizePromptLine(request.context.previousNonEmptyLine)}`,
    `Next line: ${sanitizePromptLine(request.context.nextLine)}`,
    `Signals: ${JSON.stringify(request.context.signals)}`,
    ...buildRecentEditsPromptBlock(request.recentEdits),
    ...(retrieval?.snippets.length ? buildRetrievalPromptBlock(retrieval, mode) : []),
    ...(knowledge?.snippets.length ? buildKnowledgePromptBlock(knowledge) : []),
    ...buildMarkedContextBlocks(request),
    'For the FIM engine, the raw prefix also follows this instruction block.',
    '-->',
    ''
  ]
  return `${lines.join('\n')}${request.prefix}`
}

function buildChatPromptSection(marker: string, text = ''): string {
  return markerBlock(marker, text)
}

export function buildWriteInlineCompletionChatMessages(
  request: WriteInlineCompletionRequest,
  retrieval: WriteRetrievalContext | null = null,
  knowledge: WriteKnowledgeContext | null = null
): ChatCompletionMessage[] {
  const mode = resolveMode(request)
  const userLines = [
    `Trigger hint: ${mode}. The model must decide whether the returned type is short, long, or edit.`,
    `Cursor: line ${request.cursor.line}, column ${request.cursor.column}.`,
    `Language: ${sanitizePromptLine(request.context.language)}.`,
    `Policy: ${sanitizePromptLine(request.policy.name)}.`,
    sanitizePromptLine(request.policy.instruction),
    '',
    ...buildResponseProtocolPromptBlock(),
    '',
    'Choose SHORT for normal next-keystroke writing, sentence continuation, or list continuation.',
    'Choose LONG when the local context clearly needs a fuller next thought or paragraph.',
    'Choose EDIT when the user instruction or recent local edits imply an existing nearby scope should be rewritten.',
    'If neither action is useful, return an empty <<<SHORT ... >>> block.',
    'Do not echo <<<PREFIX ... >>>, <<<SUFFIX ... >>>, or <<<EDIT_SCOPE ... >>> in the response.',
    '',
    'Cursor context:',
    `Current line prefix: ${sanitizePromptLine(request.context.currentLinePrefix)}`,
    `Current line suffix: ${sanitizePromptLine(request.context.currentLineSuffix)}`,
    `Previous non-empty line: ${sanitizePromptLine(request.context.previousNonEmptyLine)}`,
    `Next line: ${sanitizePromptLine(request.context.nextLine)}`,
    `Signals: ${JSON.stringify(request.context.signals)}`,
    ...buildEditActionGuidanceBlock(request),
    ...buildRecentEditsPromptBlock(request.recentEdits),
    ...buildEditCandidatePromptBlock(request),
    ...(retrieval?.snippets.length ? buildRetrievalPromptBlock(retrieval, mode) : []),
    ...(knowledge?.snippets.length ? buildKnowledgePromptBlock(knowledge) : []),
    '',
    buildChatPromptSection('PREFIX', request.prefix),
    buildChatPromptSection('SUFFIX', request.suffix)
  ]

  return [
    {
      role: 'system',
      content: [
        'You are WorkWise Runtime inline writing. You perform local writing completion and in-place text edits.',
        'For edit tasks, reason from <<<PREFIX ... >>>, <<<EDIT_SCOPE ... >>>, and <<<SUFFIX ... >>>, then return only the replacement inside <<<EDIT ... >>>.',
        'Do not include explanations, markdown fences outside the marked action, before/after labels, or unchanged surrounding text outside the chosen action.'
      ].join('\n')
    },
    {
      role: 'user',
      content: userLines.join('\n')
    }
  ]
}

function debugPromptFromMessages(messages: ChatCompletionMessage[]): string {
  return messages
    .map((message) => `## ${message.role}\n${message.content}`)
    .join('\n\n')
}

function compatibleModelEndpointUrl(baseUrl: string, endpointFormat: ModelEndpointFormat): string {
  if (endpointFormat === 'chat_completions') return upstreamOpenAiChatCompletionsUrl(baseUrl)
  const path = modelEndpointPath(endpointFormat)
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) return `/v1/${path}`
  if (normalized.toLowerCase().endsWith(`/${path}`)) return normalized
  const withoutEndpoint = stripKnownModelEndpointPath(normalized)
  const lastSegment = withoutEndpoint.split('/').pop()?.toLowerCase() ?? ''
  if (lastSegment === 'beta') {
    return `${withoutEndpoint.slice(0, -'/beta'.length)}/v1/${path}`
  }
  if (/^v\d+$/.test(lastSegment)) {
    return `${withoutEndpoint}/${path}`
  }
  return `${withoutEndpoint}/v1/${path}`
}

function stripKnownModelEndpointPath(baseUrl: string): string {
  const lower = baseUrl.toLowerCase()
  for (const path of ['chat/completions', 'responses', 'messages']) {
    if (lower.endsWith(`/${path}`)) {
      return baseUrl.slice(0, -path.length).replace(/\/+$/, '')
    }
  }
  return baseUrl
}

function isDeepSeekInlineCompletionBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl)
    return parsed.hostname.toLowerCase().endsWith('deepseek.com')
  } catch {
    return baseUrl.toLowerCase().includes('deepseek.com')
  }
}

function buildProviderHeaders(apiKey: string, responseFormat: WriteInlineProviderResponseFormat): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
  if (responseFormat === 'messages') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function buildAnthropicMessages(messages: ChatCompletionMessage[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const system: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content)
      continue
    }
    out.push({ role: 'user', content: message.content })
  }
  return { system: system.join('\n\n'), messages: out }
}

function buildProviderRequestBody(input: {
  responseFormat: WriteInlineProviderResponseFormat
  model: string
  messages: ChatCompletionMessage[] | null
  prompt: string
  suffix: string
  maxTokens: number
}): Record<string, unknown> {
  if (input.responseFormat === 'fim_completions') {
    return {
      model: input.model,
      prompt: input.prompt,
      suffix: input.suffix,
      max_tokens: input.maxTokens
    }
  }
  const messages = input.messages ?? [
    { role: 'user' as const, content: input.prompt }
  ]
  if (input.responseFormat === 'messages') {
    const converted = buildAnthropicMessages(messages)
    return {
      model: input.model,
      messages: converted.messages,
      max_tokens: input.maxTokens,
      ...(converted.system ? { system: converted.system } : {})
    }
  }
  if (input.responseFormat === 'responses') {
    return {
      model: input.model,
      input: messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      max_output_tokens: input.maxTokens
    }
  }
  return {
    model: input.model,
    messages,
    max_tokens: input.maxTokens,
    ...(shouldDisableThinkingForInlineCompletion(input.model)
      ? { thinking: { type: 'disabled' } }
      : {})
  }
}

function providerTextFromResponse(
  responseText: string,
  format: WriteInlineProviderResponseFormat = 'chat_completions',
  requireComplete = false
): { text: string; completed: boolean } {
  let parsed: ChatCompletionResponse | ResponsesApiResponse | AnthropicMessageResponse
  try {
    parsed = JSON.parse(responseText) as ChatCompletionResponse | ResponsesApiResponse | AnthropicMessageResponse
  } catch {
    throw new Error('Inline completion provider returned non-JSON data.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Inline completion provider returned an invalid response.')
  }
  const completed = requireComplete ? assertProviderResponseComplete(parsed, format) : false
  if (format === 'responses') {
    return { text: textFromResponsesPayload(parsed as ResponsesApiResponse), completed }
  }
  if (format === 'messages') {
    return { text: textFromAnthropicPayload(parsed as AnthropicMessageResponse), completed }
  }
  const chatPayload = parsed as ChatCompletionResponse
  const firstChoice = chatPayload.choices?.[0]
  if (typeof firstChoice?.text === 'string') return { text: firstChoice.text, completed }
  const first = firstChoice?.message?.content
  return { text: flattenMessageContent(first), completed }
}

function assertProviderResponseComplete(
  payload: ChatCompletionResponse | ResponsesApiResponse | AnthropicMessageResponse,
  format: WriteInlineProviderResponseFormat
): boolean {
  // Missing metadata remains compatible with local OpenAI-compatible servers.
  // An explicit unfinished/filtered/tool response must never become a document
  // replacement, even if its partial text contains a syntactically closed block.
  if (format === 'responses') {
    const response = payload as ResponsesApiResponse
    if (response.error || response.incomplete_details ||
      (response.status !== undefined && response.status !== 'completed') ||
      response.output?.some((item) => item.status !== undefined && item.status !== 'completed')) {
      throw new Error('AI edit response is incomplete. Please try again; the document was not changed.')
    }
    return response.status === 'completed'
  }
  const reason = format === 'messages'
    ? (payload as AnthropicMessageResponse).stop_reason
    : (payload as ChatCompletionResponse).choices?.[0]?.finish_reason
  const completedReasons = format === 'messages' ? ['end_turn', 'stop_sequence'] : ['stop']
  if (reason !== undefined && !completedReasons.includes(String(reason))) {
    throw new Error('AI edit response is incomplete. Please try again; the document was not changed.')
  }
  return reason !== undefined
}

function textFromResponsesPayload(payload: ResponsesApiResponse): string {
  if (typeof payload.output_text === 'string') return payload.output_text
  const parts: string[] = []
  for (const item of payload.output ?? []) {
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      const text = record.text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

function textFromAnthropicPayload(payload: AnthropicMessageResponse): string {
  const parts: string[] = []
  for (const block of payload.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

export type WriteInlineActionEditTarget = {
  from: number
  to: number
  original: string
  scopeKind?: 'selection' | 'paragraph'
}

function completionAction(
  text: string,
  kind: Extract<WriteInlineCompletionMode, 'short' | 'long'> = 'short'
): WriteInlineCompletionAction {
  return { kind, text: cleanCompletionText(text) }
}

function editAction(
  replacement: string,
  target: WriteInlineActionEditTarget | undefined
): WriteInlineCompletionAction {
  const cleaned = cleanCompletionText(replacement)
  if (!target) return completionAction(cleaned)
  return {
    kind: 'edit',
    replacement: cleaned,
    from: target.from,
    to: target.to,
    original: target.original,
    scopeKind: target.scopeKind
  }
}

function actionFromJsonValue(
  value: unknown,
  options: { editTarget?: WriteInlineActionEditTarget }
): WriteInlineCompletionAction | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rawKind = String(record.kind ?? record.action ?? record.type ?? '').trim().toLowerCase()
  const rawText = record.text ?? record.completion ?? record.insert ?? record.replacement ?? record.edit
  if (['short', 'completion', 'insert', 'long', 'edit', 'replacement', 'replace'].includes(rawKind) &&
    typeof rawText !== 'string') {
    throw new Error('Incomplete AI action protocol: replacement text is missing.')
  }
  const text = typeof rawText === 'string' ? rawText : ''
  if (rawKind === 'short' || rawKind === 'completion' || rawKind === 'insert') return completionAction(text, 'short')
  if (rawKind === 'long') return completionAction(text, 'long')
  if (rawKind === 'edit' || rawKind === 'replacement' || rawKind === 'replace') {
    return editAction(text, options.editTarget)
  }
  return null
}

function containsJsonAction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsJsonAction)
  if (!value || typeof value !== 'object') return false
  return ['kind', 'action', 'type'].some((key) => key in value) ||
    Object.values(value).some(containsJsonAction)
}

function containsInputBoundaryEcho(text: string): boolean {
  return INPUT_BOUNDARY_MARKERS.some((marker) => new RegExp(`<<<\\s*${marker}\\b`, 'i').test(text)) ||
    text.includes('Return only the text to insert at the cursor.')
}

function parseMarkedActionBlock(
  text: string,
  options: { editTarget?: WriteInlineActionEditTarget }
): WriteInlineCompletionAction | null {
  const hasMarker = /<<<[ \t]*(?:SHORT|LONG|EDIT)\b/i.test(text)
  if (!hasMarker) return null
  for (const marker of OUTPUT_ACTION_MARKERS) {
    const exact = new RegExp(`^<<<[ \\t]*${marker}[ \\t]*\\n([\\s\\S]*?)\\n?>>>$`, 'i').exec(text)
    if (!exact || /<<<[ \t]*(?:SHORT|LONG|EDIT)\b/i.test(exact[1]) ||
      /(?:^|\n)[ \t]*>>>[ \t]*(?:\n|$)/.test(exact[1])) continue
    const body = trimMarkerPadding(exact[1])
    if (marker === 'SHORT') return completionAction(body, 'short')
    if (marker === 'LONG') return completionAction(body, 'long')
    return editAction(body, options.editTarget)
  }
  throw new Error('Incomplete or malformed AI action protocol. Please generate the edit again.')
}

export function parseWriteInlineAction(
  raw: string,
  options: {
    fallbackKind?: WriteInlineCompletionAction['kind']
    editTarget?: WriteInlineActionEditTarget
    requireStructured?: boolean
  } = {}
): WriteInlineCompletionAction {
  const fallbackKind = options.fallbackKind ?? 'short'
  const normalized = raw.replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0), '')
  const trimmed = normalized.trim()
  if (!trimmed) {
    return fallbackKind === 'edit'
      ? editAction('', options.editTarget)
      : completionAction('', fallbackKind === 'long' ? 'long' : 'short')
  }

  if (containsInputBoundaryEcho(trimmed)) {
    return fallbackKind === 'edit'
      ? editAction('', options.editTarget)
      : completionAction('', fallbackKind === 'long' ? 'long' : 'short')
  }

  const protocolText = cleanCompletionText(trimmed).trim()
  const marked = parseMarkedActionBlock(protocolText, { editTarget: options.editTarget })
  if (marked) return marked
  if (/<<</.test(protocolText) || /(?:^|\n)[ \t]*>>>[ \t]*(?:\n|$)/.test(protocolText)) {
    throw new Error('Incomplete or malformed AI action protocol. Please generate the edit again.')
  }

  let jsonValue: unknown
  try {
    jsonValue = JSON.parse(protocolText) as unknown
  } catch {
    const jsonStart = protocolText.replace(/^```(?:json)?[ \t]*\n/i, '')
    // An unfinished object may stop in its very first key or put explanatory
    // fields before the action. Never treat that JSON-shaped protocol as prose.
    if (/^```json\b/i.test(protocolText) || /^(?:\[\s*)*\{\s*["']/.test(jsonStart)) {
      throw new Error('Incomplete or malformed AI action protocol. Please generate the edit again.')
    }
  }
  const jsonAction = actionFromJsonValue(jsonValue, { editTarget: options.editTarget })
  if (jsonAction) return jsonAction
  if (containsJsonAction(jsonValue)) {
    throw new Error('Incomplete or malformed AI action protocol. Please generate the edit again.')
  }

  const xml = protocolText.match(/^<(short|long|completion|edit)(?:\s[^>]*)?>([\s\S]*?)<\/\1>$/i)
  if (xml && !/<\/?(?:short|long|completion|edit)(?:\s|>|$)/i.test(xml[2])) {
    const kind = xml[1].toLowerCase()
    if (kind === 'edit') return editAction(xml[2], options.editTarget)
    return completionAction(xml[2], kind === 'long' || (kind === 'completion' && fallbackKind === 'long') ? 'long' : 'short')
  }
  if (/<\/?(?:short|long|completion|edit)(?:\s|>|$)/i.test(protocolText)) {
    throw new Error('Incomplete or malformed AI action protocol. Please generate the edit again.')
  }
  if (options.requireStructured) {
    throw new Error('AI edit response has no complete action protocol. Please generate the edit again.')
  }

  const labeledCompletion = trimmed.match(/^(?:completion|insert)[:：]\s*([\s\S]*)$/i)
  if (labeledCompletion) return completionAction(labeledCompletion[1], fallbackKind === 'long' ? 'long' : 'short')
  const labeledShort = trimmed.match(/^(?:short)[:：]\s*([\s\S]*)$/i)
  if (labeledShort) return completionAction(labeledShort[1], 'short')
  const labeledLong = trimmed.match(/^(?:long)[:：]\s*([\s\S]*)$/i)
  if (labeledLong) return completionAction(labeledLong[1], 'long')
  const labeledEdit = trimmed.match(/^(?:edit|replacement|replace|new text|edited text|替换文本|修改后|修改|替换)[:：]\s*([\s\S]*)$/i)
  if (labeledEdit) return editAction(labeledEdit[1], options.editTarget)

  return fallbackKind === 'edit'
    ? editAction(normalized, options.editTarget)
    : completionAction(normalized, fallbackKind === 'long' ? 'long' : 'short')
}

export function extractWriteInlineAction(
  responseText: string,
  options: {
    fallbackKind?: WriteInlineCompletionAction['kind']
    editTarget?: WriteInlineActionEditTarget
    responseFormat?: WriteInlineProviderResponseFormat
    requireComplete?: boolean
  } = {}
): WriteInlineCompletionAction {
  const requireComplete = options.requireComplete ?? (options.fallbackKind === 'edit' || Boolean(options.editTarget))
  const { text, completed } = providerTextFromResponse(responseText, options.responseFormat, requireComplete)
  if (requireComplete && !text.trim()) {
    throw new Error('AI edit response has no complete replacement text. Please try again.')
  }
  if (requireComplete && containsInputBoundaryEcho(text)) {
    throw new Error('AI edit response contains echoed input protocol. Please generate the edit again.')
  }
  const action = parseWriteInlineAction(text, { ...options, requireStructured: requireComplete && !completed })
  // A provider may choose EDIT for a background request as well. Validate the
  // actual replacement even when the caller expected ordinary ghost text.
  if (!requireComplete && action.kind === 'edit') {
    const editResponse = providerTextFromResponse(responseText, options.responseFormat, true)
    return parseWriteInlineAction(editResponse.text, {
      ...options,
      requireStructured: !editResponse.completed
    })
  }
  return action
}

export async function requestWriteInlineCompletion(
  settings: AppSettingsV1,
  request: WriteInlineCompletionRequest
): Promise<WriteInlineCompletionResult> {
  const startedAt = Date.now()
  // The preference disables automatic suggestions. Explicit AI writing actions
  // use edit mode with a known scope, including empty scopes for append actions.
  // Background suggestions may also carry edit candidates/recent edits, so
  // those signals alone must never bypass the automatic-suggestions switch.
  const explicitEdit = request.mode === 'edit' && (
    request.editCandidate?.kind === 'selection' || request.editCandidate?.kind === 'paragraph'
  )
  if (settings.write.inlineCompletion.enabled === false && !explicitEdit) {
    appendInlineCompletionPreflightFailure(startedAt, settings, request, 'Inline completion is disabled.')
    return { ok: false, message: 'Inline completion is disabled.' }
  }

  const apiKey = resolveWriteInlineCompletionApiKey(settings)
  if (!apiKey) {
    appendInlineCompletionPreflightFailure(startedAt, settings, request, 'Missing API key for inline completion.')
    return { ok: false, message: 'Missing API key for inline completion.' }
  }

  const model = resolveModel(request, settings)
  const mode = resolveMode(request)
  const actionMayEdit = Boolean(request.editCandidate && request.recentEdits?.length)
  const useChatCompletions = mode === 'edit' || actionMayEdit
  const baseUrl = resolveWriteInlineCompletionBaseUrl(settings)
  const endpointFormat = resolveWriteInlineCompletionEndpointFormat(settings)
  const useFimCompletions =
    !useChatCompletions &&
    endpointFormat === 'chat_completions' &&
    isDeepSeekInlineCompletionBaseUrl(baseUrl)
  const responseFormat: WriteInlineProviderResponseFormat = useFimCompletions
    ? 'fim_completions'
    : endpointFormat
  const url = useFimCompletions
    ? upstreamDeepSeekFimCompletionsUrl(baseUrl)
    : compatibleModelEndpointUrl(baseUrl, endpointFormat)
  const maxTokens = explicitEdit
    ? Math.min(DOCUMENT_EDIT_MAX_OUTPUT_TOKENS, Math.max(
        DOCUMENT_EDIT_MIN_OUTPUT_TOKENS,
        Math.ceil((request.editCandidate?.original.length ?? 0) * 4 + 1_024)
      ))
    : mode === 'long' || mode === 'edit' || actionMayEdit
    ? settings.write.inlineCompletion.longMaxTokens || settings.write.inlineCompletion.maxTokens || DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS
    : settings.write.inlineCompletion.maxTokens || DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS
  const [retrieval, knowledge] = await Promise.all([
    settings.write.inlineCompletion.retrievalEnabled === false
      ? Promise.resolve(null)
      : retrieveWriteInlineCompletionContext(request, {
          maxSnippets: mode === 'long' || mode === 'edit' || actionMayEdit ? 5 : 3
        }).catch(() => null),
    settings.write.knowledgeBase.enabled === false
      ? Promise.resolve(null)
      : withinKnowledgeBudget(request, settings.write.knowledgeBase)
  ])
  const messages = useFimCompletions
    ? null
    : buildWriteInlineCompletionChatMessages(request, retrieval, knowledge)
  const prompt = messages
    ? debugPromptFromMessages(messages)
    : buildWriteInlineCompletionPrompt(request, retrieval, knowledge)
  const debugBase = {
    id: randomUUID(),
    createdAt: new Date(startedAt).toISOString(),
    model,
    mode,
    currentFilePath: request.currentFilePath,
    prompt,
    suffix: request.suffix,
    referenceCount: (retrieval?.snippets.length ?? 0) + (knowledge?.snippets.length ?? 0),
    recentEditCount: request.recentEdits?.length ?? 0,
    promptChars: prompt.length,
    suffixChars: request.suffix.length
  }

  let responseText = ''
  try {
    const body = buildProviderRequestBody({
      responseFormat,
      model,
      messages,
      prompt,
      suffix: request.suffix,
      maxTokens
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: buildProviderHeaders(apiKey, responseFormat),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(explicitEdit ? DOCUMENT_EDIT_TIMEOUT_MS : INLINE_COMPLETION_TIMEOUT_MS)
    })
    const text = await response.text()
    responseText = text
    if (!response.ok) {
      appendInlineCompletionDebugEntry({
        ...debugBase,
        durationMs: Date.now() - startedAt,
        ok: false,
        rawResponse: text,
        completion: '',
        responseChars: text.length,
        errorMessage: `Inline completion request failed (${response.status})`
      })
      return {
        ok: false,
        message: `Inline completion request failed (${response.status}): ${text.slice(0, 300)}`
      }
    }

    const action = extractWriteInlineAction(text, {
      fallbackKind: mode,
      responseFormat,
      requireComplete: useChatCompletions,
      editTarget: request.editCandidate
        ? {
            from: request.editCandidate.from,
            to: request.editCandidate.to,
            original: request.editCandidate.original,
            scopeKind: request.editCandidate.kind
          }
        : undefined
    })
    const completion = action.kind === 'edit' ? action.replacement : action.text
    const finalMode = action.kind
    appendInlineCompletionDebugEntry({
      ...debugBase,
      mode: finalMode,
      durationMs: Date.now() - startedAt,
      ok: true,
      rawResponse: text,
      completion,
      actionKind: finalMode,
      responseChars: text.length
    })

    return {
      ok: true,
      completion,
      action,
      model,
      mode: finalMode
    }
  } catch (error) {
    appendInlineCompletionDebugEntry({
      ...debugBase,
      durationMs: Date.now() - startedAt,
      ok: false,
      rawResponse: responseText,
      completion: '',
      responseChars: responseText.length,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
