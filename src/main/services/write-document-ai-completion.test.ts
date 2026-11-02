import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1,
  type ModelEndpointFormat
} from '../../shared/app-settings'
import type { WriteInlineCompletionRequest } from '../../shared/write-inline-completion'
import {
  clearWriteInlineCompletionDebugEntries,
  extractWriteInlineAction,
  listWriteInlineCompletionDebugEntries,
  parseWriteInlineAction,
  requestWriteInlineCompletion
} from './write-inline-completion-service'

const originalParagraph = '2026年10月31日，项目组对地铁保护区内12个沉降监测点完成本期观测，观测周期为7天。沉降采用向下为负的符号约定，本期最大累计沉降为-3.2毫米，最大变化速率为-0.4毫米每天，均未达到累计沉降-10毫米或变化速率绝对值1毫米每天的报警阈值。各点变化总体平稳，现场未发现明显异常，建议继续按原方案开展监测。'
const replacementParagraph = '2026年10月31日，项目组完成地铁保护区内12个沉降监测点的本期观测，观测周期为7天。按向下为负的符号约定，本期最大累计沉降为-3.2毫米，最大变化速率为-0.4毫米每天，均未触及累计沉降-10毫米或变化速率绝对值1毫米每天的报警阈值。各监测点变化总体平稳，现场未见明显异常，建议继续执行原监测方案。'
const editTarget = {
  from: 12,
  to: 12 + originalParagraph.length,
  original: originalParagraph,
  scopeKind: 'selection' as const
}
const completeEdit = `<<<EDIT\n${replacementParagraph}\n>>>`
const formats: ModelEndpointFormat[] = ['chat_completions', 'messages', 'responses']

function createSettings(format: ModelEndpointFormat, enabled = false): AppSettingsV1 {
  const write = defaultWriteSettings()
  return {
    version: 1,
    locale: 'zh',
    theme: 'system',
    uiFontScale: 'small',
    provider: {
      ...defaultModelProviderSettings(),
      providers: [{
        id: 'synthetic-write-provider',
        name: 'Synthetic writing provider',
        apiKey: 'sk-synthetic-writing-test',
        baseUrl: 'https://writing.example/v1',
        endpointFormat: format,
        models: ['deepseek-flash']
      }]
    },
    agents: { kun: defaultManagedRuntimeSettings() },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: true, retentionDays: 2 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: {
      ...write,
      knowledgeBase: { ...write.knowledgeBase, enabled: false },
      inlineCompletion: {
        ...write.inlineCompletion,
        enabled,
        retrievalEnabled: false,
        inheritProvider: false,
        providerId: 'synthetic-write-provider',
        maxTokens: 96,
        longMaxTokens: 256
      }
    },
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: '',
    claw: defaultClawSettings()
  }
}

function createRequest(mode: 'edit' | 'short' | 'long' = 'edit'): WriteInlineCompletionRequest {
  return {
    prefix: '# 合成工程记录\n\n',
    suffix: '\n\n## 后续计划\n维持原观测周期。',
    currentFilePath: '/tmp/workspace/synthetic-monitoring.md',
    mode,
    cursor: { line: 3, column: 1 },
    context: {
      language: 'markdown',
      currentLinePrefix: '',
      currentLineSuffix: '',
      previousLine: '',
      previousNonEmptyLine: '# 合成工程记录',
      nextLine: '',
      indentation: '',
      signals: {
        list: false,
        quote: false,
        heading: false,
        table: false,
        atLineEnd: true,
        endsWithSentencePunctuation: false,
        previousLineEndsWithSentencePunctuation: false,
        prefersNewLineCompletion: false,
        paragraphBreakOpportunity: false
      }
    },
    policy: {
      name: 'manual-document-rewrite',
      instruction: '润色选区，保留日期、点数、观测周期、沉降符号、报警阈值和结论。',
      acceptanceCriteria: ['完整返回改写后的段落，保留所有工程事实。'],
      rejectionCriteria: ['不得截断段落或改写选区以外的内容。']
    },
    preview: { local: originalParagraph, documentTail: '# 合成工程记录' },
    ...(mode === 'edit' ? {
      editCandidate: {
        kind: 'selection' as const,
        from: editTarget.from,
        to: editTarget.to,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: originalParagraph.length + 1,
        original: originalParagraph,
        selectedText: originalParagraph
      }
    } : {}),
    model: 'deepseek-flash'
  }
}

function providerPayload(format: ModelEndpointFormat, text = completeEdit): Record<string, unknown> {
  if (format === 'messages') return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  if (format === 'responses') return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }]
  }
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
}

function mockProvider(payload: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearWriteInlineCompletionDebugEntries()
})

describe('document AI edit token budget', () => {
  it.each(formats)('gives a manual Chinese selection a complete edit budget via %s when suggestions are off', async (format) => {
    expect(originalParagraph.length).toBeGreaterThan(120)
    expect(originalParagraph.length).toBeLessThan(220)
    const fetchMock = mockProvider(providerPayload(format))

    const result = await requestWriteInlineCompletion(createSettings(format), createRequest())

    expect(result).toMatchObject({
      ok: true,
      mode: 'edit',
      completion: replacementParagraph,
      action: { kind: 'edit', replacement: replacementParagraph, ...editTarget }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body[format === 'responses' ? 'max_output_tokens' : 'max_tokens']).toEqual(expect.any(Number))
    expect(Number(body[format === 'responses' ? 'max_output_tokens' : 'max_tokens'])).toBeGreaterThanOrEqual(4_096)
  })

  it.each(formats.flatMap((format) => [
    { format, mode: 'short' as const, budget: 96 },
    { format, mode: 'long' as const, budget: 256 }
  ]))('retains the configured $budget-token automatic $mode budget via $format', async ({ format, mode, budget }) => {
    const text = `<<<${mode.toUpperCase()}\n继续记录。\n>>>`
    const fetchMock = mockProvider(providerPayload(format, text))

    const result = await requestWriteInlineCompletion(createSettings(format, true), createRequest(mode))

    expect(result).toMatchObject({ ok: true, mode, completion: '继续记录。' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body[format === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(budget)
  })
})

const incompleteProviderCases: Array<{
  label: string
  format: ModelEndpointFormat
  payload: Record<string, unknown>
}> = [
  ...['length', 'content_filter', 'tool_calls'].map((reason) => ({
    label: `chat finish_reason=${reason}`,
    format: 'chat_completions' as const,
    payload: { choices: [{ message: { content: completeEdit }, finish_reason: reason }] }
  })),
  ...['max_tokens', 'pause_turn', 'tool_use', 'refusal'].map((reason) => ({
    label: `Anthropic stop_reason=${reason}`,
    format: 'messages' as const,
    payload: { content: [{ type: 'text', text: completeEdit }], stop_reason: reason }
  })),
  ...['incomplete', 'failed', 'cancelled', 'in_progress'].map((status) => ({
    label: `Responses status=${status}`,
    format: 'responses' as const,
    payload: { output_text: completeEdit, status }
  })),
  {
    label: 'Responses completed status with incomplete_details',
    format: 'responses',
    payload: {
      output_text: completeEdit,
      status: 'completed',
      incomplete_details: { reason: 'max_output_tokens' }
    }
  }
]

describe('provider completion metadata protects document edits', () => {
  it.each(formats)('validates a provider-selected background %s EDIT even if ordinary completions are allowed', (format) => {
    const payload = format === 'chat_completions'
      ? { choices: [{ message: { content: completeEdit }, finish_reason: 'length' }] }
      : format === 'messages'
        ? { content: [{ type: 'text', text: completeEdit }], stop_reason: 'max_tokens' }
        : { output_text: completeEdit, status: 'incomplete' }

    expect(() => extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'short',
      editTarget,
      requireComplete: false
    })).toThrow(/incomplete/i)
  })

  it.each(incompleteProviderCases)('does not offer an edit for $label despite complete action markers', async ({ format, payload }) => {
    const fetchMock = mockProvider(payload)

    const result = await requestWriteInlineCompletion(createSettings(format), createRequest())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('action')
    expect(result).not.toHaveProperty('completion')
  })

  it.each(incompleteProviderCases)('rejects $label during direct provider extraction', ({ format, payload }) => {
    expect(() => extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget
    })).toThrow(Error)
  })

  it.each(formats)('accepts a confirmed complete %s response', async (format) => {
    const payload = providerPayload(format)
    mockProvider(payload)

    expect(extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget
    })).toEqual({ kind: 'edit', replacement: replacementParagraph, ...editTarget })
    expect(await requestWriteInlineCompletion(createSettings(format), createRequest())).toMatchObject({
      ok: true,
      completion: replacementParagraph,
      action: { kind: 'edit', replacement: replacementParagraph, ...editTarget }
    })
  })

  it.each(formats)('keeps compatible %s providers with absent status metadata usable when the edit is complete', async (format) => {
    const payload = format === 'chat_completions'
      ? { choices: [{ message: { content: completeEdit } }] }
      : format === 'messages'
        ? { content: [{ type: 'text', text: completeEdit }] }
        : { output_text: completeEdit }
    mockProvider(payload)

    expect(extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget
    })).toEqual({ kind: 'edit', replacement: replacementParagraph, ...editTarget })
    expect(await requestWriteInlineCompletion(createSettings(format), createRequest())).toMatchObject({
      ok: true,
      completion: replacementParagraph
    })
  })
})

describe('incomplete document edit protocol', () => {
  const malformedActions = [
    { label: 'marker opener only', raw: '<<<EDIT' },
    { label: 'partial marker name', raw: '<<<ED' },
    { label: 'missing marker closer', raw: '<<<EDIT\n只生成了半段内容' },
    { label: 'partial marker closer', raw: '<<<EDIT\n只生成了半段内容\n>>' },
    { label: 'missing marker opener', raw: '只生成了半段内容\n>>>' },
    { label: 'complete marker then unfinished marker', raw: `${completeEdit}\n<<<EDIT\n第二段尚未完成` },
    { label: 'XML opener only', raw: '<edit' },
    { label: 'missing XML closer', raw: '<edit>只生成了半段内容' },
    { label: 'partial XML closer', raw: '<edit>只生成了半段内容</edit' },
    { label: 'missing XML opener', raw: '只生成了半段内容</edit>' },
    { label: 'complete XML then unfinished XML', raw: '<edit>完整的第一段。</edit>\n<edit>第二段尚未完成' },
    { label: 'truncated JSON replacement string', raw: '{"kind":"edit","replacement":"只生成了半段内容' },
    { label: 'truncated JSON first key', raw: '{"kind' },
    { label: 'truncated JSON first key inside a fence', raw: '```json\n{"kind' },
    { label: 'truncated JSON fence before first key', raw: '```json\n{' },
    { label: 'truncated JSON fence before first array object', raw: '```json\n[' },
    { label: 'truncated JSON with explanation first', raw: '{"explanation":"保留原意","kind":"edit","replacement":"只生成了半段' },
    { label: 'truncated fenced JSON with explanation first', raw: '```json\n{"explanation":"保留原意","kind":"edit","replacement":"只生成了半段' },
    { label: 'truncated JSON action value', raw: '{"action":"edit","replacement":' },
    { label: 'missing JSON object closer', raw: '{"type":"edit","replacement":"尚未完成"' },
    { label: 'unclosed JSON code fence and string', raw: '```json\n{"kind":"edit","replacement":"尚未完成' },
    { label: 'closed JSON code fence with truncated JSON', raw: '```json\n{"kind":"edit","replacement":"尚未完成\n```' },
    { label: 'multiple JSON actions', raw: '{"kind":"edit","replacement":"第一段"}\n{"kind":"edit","replacement":"第二段"}' },
    { label: 'multiple fenced JSON actions', raw: '```json\n{"kind":"edit","replacement":"第一段"}\n```\n```json\n{"kind":"edit","replacement":"第二段"}\n```' },
    { label: 'truncated action array', raw: '[{"kind":"edit","replacement":"半段' },
    { label: 'truncated action array first key', raw: '[{"kind' },
    { label: 'truncated fenced action array', raw: '```json\n[{"explanation":"保留原意","kind":"edit","replacement":"半段' },
    { label: 'complete array of multiple actions', raw: '[{"kind":"edit","replacement":"第一段"},{"kind":"edit","replacement":"第二段"}]' },
    { label: 'complete single-action array', raw: '[{"kind":"edit","replacement":"第一段"}]' },
    { label: 'complete nested action array', raw: '[[{"kind":"edit","replacement":"第一段"}]]' },
    { label: 'unsupported JSON action envelope', raw: '{"result":{"kind":"edit","replacement":"第一段"}}' },
    { label: 'missing JSON replacement', raw: '{"kind":"edit"}' },
    { label: 'unknown JSON action', raw: '{"kind":"unsupported","replacement":"第一段"}' }
  ]

  it.each(malformedActions)('rejects $label instead of treating its protocol as replacement text', ({ raw }) => {
    expect(() => parseWriteInlineAction(raw, {
      fallbackKind: 'edit',
      editTarget
    })).toThrow(/incomplete|unfinished|complete|protocol|malformed/i)
  })

  it.each(formats)('does not offer an unfinished action from a nominally complete %s provider', async (format) => {
    const payload = providerPayload(format, '<<<EDIT\n只生成了半段内容')
    mockProvider(payload)

    const result = await requestWriteInlineCompletion(createSettings(format), createRequest())

    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('action')
    expect(listWriteInlineCompletionDebugEntries()[0]).toMatchObject({
      ok: false,
      completion: '',
      rawResponse: JSON.stringify(payload)
    })
  })

  it.each([
    `\`\`\`json\n${JSON.stringify({ kind: 'edit', replacement: replacementParagraph })}\n\`\`\``,
    `\`\`\`text\n${completeEdit}\n\`\`\``
  ])('accepts a complete single code-fenced action', (raw) => {
    expect(parseWriteInlineAction(raw, { fallbackKind: 'edit', editTarget })).toEqual({
      kind: 'edit', replacement: replacementParagraph, ...editTarget
    })
  })

  it.each(formats)('does not turn an echoed %s input protocol into an empty deletion', async (format) => {
    mockProvider(providerPayload(format, '<<<EDIT_SCOPE\n原文\n>>>'))

    const result = await requestWriteInlineCompletion(createSettings(format), createRequest())

    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('action')
  })

  it.each(['[项目说明](./project.md)', '[工程记录] 继续按原方案观测。', '- [ ] 复核本期沉降结果。'])(
    'preserves legitimate Markdown bracket/list prose: %s', (text) => {
      expect(extractWriteInlineAction(JSON.stringify(providerPayload('chat_completions', text)), {
        fallbackKind: 'edit', editTarget
      })).toEqual({ kind: 'edit', replacement: text, ...editTarget })
    }
  )
})

describe('explicit completion proof for unstructured document edits', () => {
  it.each(formats)('requires completion metadata or a closed protocol for plain %s text', (format) => {
    const payload = format === 'chat_completions'
      ? { choices: [{ message: { content: replacementParagraph } }] }
      : format === 'messages'
        ? { content: [{ type: 'text', text: replacementParagraph }] }
        : { output_text: replacementParagraph }

    expect(() => extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget,
      requireComplete: true
    })).toThrow(/incomplete|unfinished|complete|protocol|malformed/i)
  })

  it.each(formats)('preserves plain %s replacement compatibility when the provider confirms completion', (format) => {
    expect(extractWriteInlineAction(JSON.stringify(providerPayload(format, replacementParagraph)), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget,
      requireComplete: true
    })).toEqual({ kind: 'edit', replacement: replacementParagraph, ...editTarget })
  })

  it.each([
    {
      label: 'chat finish_reason=null',
      format: 'chat_completions' as const,
      payload: { choices: [{ message: { content: completeEdit }, finish_reason: null }] }
    },
    {
      label: 'Responses status=null',
      format: 'responses' as const,
      payload: { status: null, output_text: completeEdit }
    }
  ])('rejects explicitly unfinished $label even with closed markers', async ({ format, payload }) => {
    expect(() => extractWriteInlineAction(JSON.stringify(payload), {
      responseFormat: format,
      fallbackKind: 'edit',
      editTarget,
      requireComplete: true
    })).toThrow(Error)
    mockProvider(payload)

    const result = await requestWriteInlineCompletion(createSettings(format), createRequest())

    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('action')
  })
})

describe('ambiguous XML document edit actions', () => {
  it.each([
    '<edit>第一处改写。</edit><edit>第二处改写。</edit>',
    '<edit>改写。</edit>\n<short>额外续写。</short>',
    '<short>额外续写。</short>\n<edit>改写。</edit>',
    '<edit>改写中嵌入<short>额外续写。</short></edit>',
    '<edit>改写中嵌入<long>额外完整段落。</long></edit>',
    '<long>完整段落中嵌入<edit>局部改写。</edit></long>'
  ])('rejects multiple or nested actions: %s', (raw) => {
    expect(() => parseWriteInlineAction(raw, {
      fallbackKind: 'edit',
      editTarget
    })).toThrow(/incomplete|unfinished|complete|protocol|malformed/i)
  })
})
