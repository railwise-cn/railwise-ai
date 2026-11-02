import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import type { WriteInlineCompletionRequest } from '../../shared/write-inline-completion'
import {
  buildWriteInlineCompletionPrompt,
  clearWriteInlineCompletionDebugEntries,
  listWriteInlineCompletionDebugEntries,
  parseWriteInlineAction,
  requestWriteInlineCompletion
} from './write-inline-completion-service'
import { clearWriteRetrievalCache } from './write-retrieval-service'

function createSettings(patch: Partial<AppSettingsV1['write']['inlineCompletion']> = {}): AppSettingsV1 {
  const write = defaultWriteSettings()
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: {
        ...defaultManagedRuntimeSettings(),
        apiKey: 'sk-test'
      }
    },
    workspaceRoot: '/tmp/workspace',
    log: {
      enabled: true,
      retentionDays: 2
    },
    notifications: {
      turnComplete: true
    },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: {
      ...write,
      knowledgeBase: {
        ...write.knowledgeBase,
        enabled: false
      },
      inlineCompletion: {
        ...write.inlineCompletion,
        ...patch
      }
    },
    schedule: defaultScheduleSettings(),
    guiUpdate: {
      channel: 'stable'
    },
    codePromptPrefix: '',
    claw: defaultClawSettings()
  }
}

function createRequest(): WriteInlineCompletionRequest {
  return {
    prefix: '# Draft\n\nThis is',
    suffix: ' a test.',
    currentFilePath: '/tmp/workspace/draft.md',
    cursor: {
      line: 3,
      column: 7
    },
    context: {
      language: 'markdown',
      currentLinePrefix: 'This is',
      currentLineSuffix: ' a test.',
      previousLine: '',
      previousNonEmptyLine: '# Draft',
      nextLine: '',
      indentation: '',
      signals: {
        list: false,
        quote: false,
        heading: false,
        table: false,
        atLineEnd: false,
        endsWithSentencePunctuation: false,
        previousLineEndsWithSentencePunctuation: false,
        prefersNewLineCompletion: false,
        paragraphBreakOpportunity: false
      }
    },
    policy: {
      name: 'precision-inline-v2',
      instruction: 'Return only inserted text.',
      acceptanceCriteria: ['Keep it short.'],
      rejectionCriteria: ['Do not ramble.']
    },
    preview: {
      local: 'This is',
      documentTail: '# Draft This is'
    },
    model: 'deepseek-v4-flash'
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearWriteRetrievalCache()
  clearWriteInlineCompletionDebugEntries()
})

describe('requestWriteInlineCompletion', () => {
  it('calls DeepSeek FIM completions directly instead of chat completions', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: ' only a test' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestWriteInlineCompletion(createSettings({ maxTokens: 64 }), createRequest())

    expect(result).toEqual({
      ok: true,
      completion: ' only a test',
      action: {
        kind: 'short',
        text: ' only a test'
      },
      model: 'deepseek-v4-flash',
      mode: 'short'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/beta/completions')
    expect(url).not.toContain('/chat/completions')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-test'
    })
    const body = JSON.parse(String(init.body)) as { prompt: string; suffix: string; max_tokens: number }
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      suffix: ' a test.',
      max_tokens: 64
    })
    expect(body.prompt).toContain('WorkWise Runtime inline completion')
    expect(body.prompt).toContain('Return only the text to insert at the cursor')
    expect(body.prompt).not.toContain('<<<SHORT')
    expect(body.prompt).toContain('<<<PREFIX')
    expect(body.prompt).toContain('<<<SUFFIX')
    expect(body.prompt.endsWith('# Draft\n\nThis is')).toBe(true)
    const debugEntries = listWriteInlineCompletionDebugEntries()
    expect(debugEntries).toHaveLength(1)
    expect(debugEntries[0]).toMatchObject({
      ok: true,
      completion: ' only a test',
      mode: 'short',
      model: 'deepseek-v4-flash'
    })
  })

  it.each([undefined, 'short', 'long', 'unknown'])(
    'does not request the API for %s suggestions when automatic completion is disabled, even with edit signals',
    async (mode) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const request = {
        ...createRequest(),
        mode: mode as WriteInlineCompletionRequest['mode'],
        editCandidate: {
          kind: 'paragraph' as const,
          from: 0, to: 7,
          startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
          original: 'A draft'
        },
        recentEdits: [{
          source: 'user' as const, ageMs: 100, from: 0, to: 1,
          deletedText: 'B', insertedText: 'A', beforeContext: '', afterContext: ' draft'
        }]
      }

      const result = await requestWriteInlineCompletion(createSettings({ enabled: false }), request)

      expect(result).toEqual({ ok: false, message: 'Inline completion is disabled.' })
      expect(fetchMock).not.toHaveBeenCalled()
      const debugEntries = listWriteInlineCompletionDebugEntries()
      expect(debugEntries).toHaveLength(1)
      expect(debugEntries[0]).toMatchObject({
        ok: false,
        errorMessage: 'Inline completion is disabled.',
        completion: '',
        responseChars: 0
      })
    }
  )

  it.each([undefined, 'unknown'])(
    'keeps edit requests with %s scopes disabled rather than treating them as manual actions',
    async (kind) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const request: WriteInlineCompletionRequest = { ...createRequest(), mode: 'edit' }
      if (kind) request.editCandidate = {
        kind: kind as 'selection', from: 0, to: 1,
        startLine: 1, startColumn: 1, endLine: 1, endColumn: 2,
        original: 'A'
      }

      const result = await requestWriteInlineCompletion(createSettings({ enabled: false }), request)

      expect(result).toEqual({ ok: false, message: 'Inline completion is disabled.' })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { action: 'selection rewrite', kind: 'selection', original: 'A draft', replacement: 'A clearer draft' },
    { action: 'paragraph rewrite', kind: 'paragraph', original: 'A draft', replacement: 'A clearer draft' },
    { action: 'document append', kind: 'selection', original: '', replacement: '\n\n## Summary\nA synthetic summary.' },
    { action: 'document replace', kind: 'selection', original: '# Draft\n\nA draft', replacement: '# Reviewed\n\nA clearer draft' }
  ] as const)('allows an explicit $action when automatic suggestions are disabled', async ({ kind, original, replacement }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: `<<<EDIT\n${replacement}\n>>>` } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const request: WriteInlineCompletionRequest = {
      ...createRequest(),
      mode: 'edit',
      prefix: '# Surrounding context\n\n',
      policy: { ...createRequest().policy, instruction: 'The user explicitly requested an in-place text edit.' },
      editCandidate: {
        kind, from: 23, to: 23 + original.length,
        startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 + original.length,
        original, selectedText: original
      }
    }

    const result = await requestWriteInlineCompletion(createSettings({ enabled: false, retrievalEnabled: false }), request)

    expect(result).toMatchObject({
      ok: true, mode: 'edit', completion: replacement,
      action: { kind: 'edit', replacement, from: 23, to: 23 + original.length, original, scopeKind: kind }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }>; prompt?: string }
    expect(body.prompt).toBeUndefined()
    expect(body.messages[1].content).toContain('Trigger hint: edit')
    expect(body.messages[1].content).toContain('<<<EDIT_SCOPE')
    expect(body.messages[1].content).toContain(original)
    expect(listWriteInlineCompletionDebugEntries()[0]).toMatchObject({ ok: true, mode: 'edit' })
  })

  it('cleans the reproduced DeepSeek edit tail in the returned proposal and parsed debug output', async () => {
    const replacement = '下一周期按每日一次的频率开展观测，发现异常时复核原始记录。'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { content: `<<<EDIT\n${replacement}\n\n## \n>>>` } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const original = '下一周期继续观测。'
    const request: WriteInlineCompletionRequest = {
      ...createRequest(), mode: 'edit',
      editCandidate: {
        kind: 'selection', from: 0, to: original.length,
        startLine: 1, startColumn: 1, endLine: 1, endColumn: original.length + 1,
        original, selectedText: original
      }
    }

    const result = await requestWriteInlineCompletion(createSettings({ retrievalEnabled: false }), request)

    expect(result).toMatchObject({ ok: true, completion: replacement, action: { kind: 'edit', replacement } })
    expect(listWriteInlineCompletionDebugEntries()[0]).toMatchObject({ ok: true, completion: replacement })
  })

  it('still requires an API key for a manual edit when automatic suggestions are disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const settings = createSettings({ enabled: false })
    settings.agents.kun.apiKey = ''
    const request: WriteInlineCompletionRequest = {
      ...createRequest(), mode: 'edit',
      editCandidate: {
        kind: 'selection', from: 0, to: 7,
        startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
        original: 'A draft'
      }
    }

    const result = await requestWriteInlineCompletion(settings, request)

    expect(result).toEqual({ ok: false, message: 'Missing API key for inline completion.' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(listWriteInlineCompletionDebugEntries()[0]).toMatchObject({
      ok: false, mode: 'edit', errorMessage: 'Missing API key for inline completion.'
    })
  })

  it('records missing API key failures in the debug log', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const settings = createSettings()
    settings.agents.kun.apiKey = ''

    const result = await requestWriteInlineCompletion(settings, createRequest())

    expect(result).toEqual({ ok: false, message: 'Missing API key for inline completion.' })
    expect(fetchMock).not.toHaveBeenCalled()
    const debugEntries = listWriteInlineCompletionDebugEntries()
    expect(debugEntries).toHaveLength(1)
    expect(debugEntries[0]).toMatchObject({
      ok: false,
      errorMessage: 'Missing API key for inline completion.',
      mode: 'short',
      suffix: ' a test.',
      responseChars: 0
    })
    expect(debugEntries[0].prompt).toContain('WorkWise Runtime inline completion')
    expect(debugEntries[0].prompt.endsWith('# Draft\n\nThis is')).toBe(true)
  })

  it('preserves an explicit pro completion model', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: ' flash text' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      model: 'deepseek-v4-pro'
    }
    const result = await requestWriteInlineCompletion(createSettings(), request)

    expect(result).toMatchObject({
      ok: true,
      model: 'deepseek-v4-pro'
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-v4-pro'
    })
  })

  it('falls back to the General baseUrl and WorkWise Runtime model when write keeps defaults', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: ' fallback text' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const settings = createSettings()
    settings.provider.baseUrl = 'https://general.example/v1'
    settings.agents.kun.model = 'deepseek-chat'
    settings.write.inlineCompletion.baseUrl = 'https://api.deepseek.com/beta'
    settings.write.inlineCompletion.model = 'deepseek-v4-flash'

    const result = await requestWriteInlineCompletion(settings, {
      ...createRequest(),
      model: ''
    })

    expect(result).toMatchObject({
      ok: true,
      model: 'deepseek-chat'
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('https://general.example')
    expect(url).toContain('/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-chat'
    })
  })

  it('uses an explicit flash override when write disables model inheritance', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: ' explicit flash' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const settings = createSettings({
      inheritModel: false,
      model: 'deepseek-v4-flash'
    })
    settings.provider.baseUrl = 'https://general.example/v1'
    settings.agents.kun.model = 'deepseek-chat'

    const result = await requestWriteInlineCompletion(settings, {
      ...createRequest(),
      model: ''
    })

    expect(result).toMatchObject({
      ok: true,
      model: 'deepseek-v4-flash'
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('https://general.example')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-v4-flash'
    })
  })

  it('uses the long-completion prompt and token budget for inspiration mode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: '\n\nA longer continuation.' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      mode: 'long' as const,
      suffix: '',
      context: {
        ...createRequest().context,
        currentLineSuffix: ''
      }
    }
    const result = await requestWriteInlineCompletion(
      createSettings({ longMaxTokens: 320 }),
      request
    )

    expect(result).toMatchObject({
      ok: true,
      mode: 'long'
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { prompt: string; max_tokens: number }
    expect(body.max_tokens).toBe(320)
    expect(body.prompt).toContain('Trigger hint: long')
    expect(body.prompt).toContain('paused for inspiration')
    expect(body.prompt.endsWith(request.prefix)).toBe(true)
  })

  it('records plain long completions from the FIM request', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: '\n\nA fuller continuation.' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await requestWriteInlineCompletion(createSettings(), {
      ...createRequest(),
      mode: 'long'
    })

    expect(result).toMatchObject({
      ok: true,
      completion: '\n\nA fuller continuation.',
      action: {
        kind: 'long',
        text: '\n\nA fuller continuation.'
      },
      mode: 'long'
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { prompt: string }
    expect(body.prompt).toContain('Return only the text to insert at the cursor')
    expect(body.prompt).not.toContain('<<<LONG')
  })

  it('adds BM25 retrieval snippets to the FIM prompt when workspace context is available', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-rag-'))
    await mkdir(join(workspaceRoot, 'notes'), { recursive: true })
    await writeFile(
      join(workspaceRoot, 'notes', 'retrieval.md'),
      [
        '# RAG notes',
        '',
        'BM25 keyword retrieval keeps inline completion grounded in project terminology.',
        'Use retrieved snippets as reference-only context for local text completion.'
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      join(workspaceRoot, 'draft.md'),
      '# Draft\n\nBM25 keyword',
      'utf8'
    )

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ text: ' retrieval can improve continuity' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      workspaceRoot,
      currentFilePath: join(workspaceRoot, 'draft.md'),
      prefix: '# Draft\n\nBM25 keyword',
      suffix: '',
      context: {
        ...createRequest().context,
        currentLinePrefix: 'BM25 keyword',
        currentLineSuffix: '',
        previousNonEmptyLine: '# Draft'
      },
      preview: {
        local: 'BM25 keyword',
        documentTail: '# Draft BM25 keyword'
      }
    }

    const result = await requestWriteInlineCompletion(createSettings(), request)

    expect(result).toMatchObject({ ok: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { prompt: string }
    expect(body.prompt).toContain('Reference snippets from the same writing workspace')
    expect(body.prompt).toContain('notes/retrieval.md')
    expect(body.prompt).toContain('BM25 keyword retrieval keeps inline completion grounded')
    expect(body.prompt.endsWith(request.prefix)).toBe(true)
  })

  it('uses chat completions when the unified request may return an edit action', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<<<EDIT\nWrite mode keeps text editing local.\n>>>'
          }
        }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      editCandidate: {
        kind: 'paragraph' as const,
        from: 9,
        to: 47,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 38,
        original: 'WorkWise keeps text editing local.'
      },
      recentEdits: [{
        source: 'user' as const,
        ageMs: 1_200,
        filePath: '/tmp/workspace/draft.md',
        from: 9,
        to: 21,
        deletedText: 'WorkWise',
        insertedText: 'Write mode',
        beforeContext: '',
        afterContext: ' keeps text editing local.'
      }]
    }

    const result = await requestWriteInlineCompletion(createSettings({ longMaxTokens: 320 }), request)

    expect(result).toMatchObject({
      ok: true,
      completion: 'Write mode keeps text editing local.',
      action: {
        kind: 'edit',
        replacement: 'Write mode keeps text editing local.',
        from: 9,
        to: 47,
        original: 'WorkWise keeps text editing local.',
        scopeKind: 'paragraph'
      }
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      prompt?: string
      suffix?: string
      max_tokens: number
      thinking?: { type: string }
    }
    expect(body.max_tokens).toBe(320)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.prompt).toBeUndefined()
    expect(body.suffix).toBeUndefined()
    expect(body.messages[1].content).toContain('Recent local edits in this file')
    expect(body.messages[1].content).toContain('Editable local scope if EDIT is the best action')
    expect(body.messages[1].content).toContain('<<<EDIT_SCOPE')
  })

  it('uses chat completions for explicit edit mode even without recent edit signals', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<<<EDIT\nWrite mode keeps text editing local.\n>>>'
          }
        }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      mode: 'edit' as const,
      editCandidate: {
        kind: 'paragraph' as const,
        from: 9,
        to: 47,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 38,
        original: 'WorkWise keeps text editing local.'
      }
    }

    const result = await requestWriteInlineCompletion(createSettings({ longMaxTokens: 320 }), request)

    expect(result).toMatchObject({
      ok: true,
      mode: 'edit',
      completion: 'Write mode keeps text editing local.'
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      suffix?: string
      thinking?: { type: string }
    }
    expect(body.suffix).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages[1].content).toContain('Trigger hint: edit')
    expect(body.messages[1].content).toContain('<<<PREFIX')
    expect(body.messages[1].content).toContain('<<<SUFFIX')
  })

  it('does not send DeepSeek thinking controls for custom chat completion models', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: '<<<EDIT\nWrite mode keeps text editing local.\n>>>'
          }
        }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      ...createRequest(),
      model: 'gpt-4.1-mini',
      mode: 'edit' as const,
      editCandidate: {
        kind: 'paragraph' as const,
        from: 9,
        to: 47,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 38,
        original: 'WorkWise keeps text editing local.'
      }
    }

    const result = await requestWriteInlineCompletion(createSettings({ longMaxTokens: 320 }), request)

    expect(result).toMatchObject({
      ok: true,
      model: 'gpt-4.1-mini',
      mode: 'edit'
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { thinking?: { type: string } }
    expect(body.thinking).toBeUndefined()
  })

  it('builds the unified action prompt without retrieval snippets when none are supplied', () => {
    const request = createRequest()

    const prompt = buildWriteInlineCompletionPrompt(request, null)
    expect(prompt).toContain('WorkWise Runtime inline completion')
    expect(prompt).toContain('<<<PREFIX')
    expect(prompt).toContain('<<<SUFFIX')
    expect(prompt).not.toContain('<<<SHORT')
    expect(prompt).not.toContain('Reference snippets from the same writing workspace')
    expect(prompt.endsWith(request.prefix)).toBe(true)
  })
})

describe('parseWriteInlineAction', () => {
  it('parses TextIDE-style marked short, long, and edit blocks', () => {
    expect(parseWriteInlineAction('<<<SHORT\n next words\n>>>')).toEqual({
      kind: 'short',
      text: ' next words'
    })
    expect(parseWriteInlineAction('<<<LONG\n\nA fuller continuation.\n>>>')).toEqual({
      kind: 'long',
      text: '\nA fuller continuation.'
    })
    expect(parseWriteInlineAction('<<<EDIT\nWrite mode\n>>>', {
      editTarget: {
        from: 9,
        to: 21,
        original: 'WorkWise',
        scopeKind: 'selection'
      }
    })).toEqual({
      kind: 'edit',
      replacement: 'Write mode',
      from: 9,
      to: 21,
      original: 'WorkWise',
      scopeKind: 'selection'
    })
  })

  it('removes only a trailing empty ATX heading from marked edits', () => {
    const editTarget = {
      from: 9,
      to: 21,
      original: 'WorkWise',
      scopeKind: 'selection' as const
    }

    expect(parseWriteInlineAction('<<<EDIT\nUpdated paragraph.\n\n##\n>>>', { editTarget })).toMatchObject({
      kind: 'edit',
      replacement: 'Updated paragraph.'
    })
    expect(parseWriteInlineAction('<<<EDIT\nText\n## Valid heading ###\n>>>', { editTarget })).toMatchObject({
      replacement: 'Text\n## Valid heading ###'
    })
    expect(parseWriteInlineAction('<<<EDIT\nText\n##\nMore text\n>>>', { editTarget })).toMatchObject({
      replacement: 'Text\n##\nMore text'
    })
    expect(parseWriteInlineAction('<<<EDIT\n```md\n##\n>>>', { editTarget })).toMatchObject({
      replacement: '```md\n##'
    })
    expect(parseWriteInlineAction('<<<EDIT\n~~~md\n##\n~~~\n##\n>>>', { editTarget })).toMatchObject({
      replacement: '~~~md\n##\n~~~'
    })
    expect(parseWriteInlineAction('<<<EDIT\nText\n#######\n>>>', { editTarget })).toMatchObject({
      replacement: 'Text\n#######'
    })
    expect(parseWriteInlineAction('<<<EDIT\n<!-- literal Markdown\n##\n>>>', { editTarget })).toMatchObject({
      replacement: '<!-- literal Markdown\n##'
    })
    expect(parseWriteInlineAction('<<<EDIT\n<pre>\n##\n>>>', { editTarget })).toMatchObject({
      replacement: '<pre>\n##'
    })
    expect(parseWriteInlineAction('<<<LONG\nText\n##\n>>>')).toEqual({ kind: 'long', text: 'Text\n##' })
    expect(parseWriteInlineAction(JSON.stringify({ kind: 'edit', replacement: 'Text\n##' }), { editTarget })).toMatchObject({
      replacement: 'Text\n##'
    })
  })

  it('suppresses echoed boundary-marker prompts', () => {
    expect(parseWriteInlineAction('<<<PREFIX\nThis is\n>>>\n<<<SUFFIX\n a test.\n>>>')).toEqual({
      kind: 'short',
      text: ''
    })
  })

  it('parses JSON action payloads', () => {
    expect(parseWriteInlineAction(JSON.stringify({ kind: 'long', text: 'Continue the paragraph.' }))).toEqual({
      kind: 'long',
      text: 'Continue the paragraph.'
    })
    expect(parseWriteInlineAction(JSON.stringify({ action: 'edit', replacement: 'Rewrite locally.' }), {
      editTarget: {
        from: 3,
        to: 11,
        original: 'Old text',
        scopeKind: 'paragraph'
      }
    })).toEqual({
      kind: 'edit',
      replacement: 'Rewrite locally.',
      from: 3,
      to: 11,
      original: 'Old text',
      scopeKind: 'paragraph'
    })
  })

  it('parses XML-style action wrappers', () => {
    expect(parseWriteInlineAction('<short>next words</short>')).toEqual({
      kind: 'short',
      text: 'next words'
    })
    expect(parseWriteInlineAction('<long>Two sentences.\nMaybe three.</long>')).toEqual({
      kind: 'long',
      text: 'Two sentences.\nMaybe three.'
    })
    expect(parseWriteInlineAction('<edit>Replace this scope</edit>', {
      editTarget: {
        from: 12,
        to: 20,
        original: 'old value',
        scopeKind: 'selection'
      }
    })).toEqual({
      kind: 'edit',
      replacement: 'Replace this scope',
      from: 12,
      to: 20,
      original: 'old value',
      scopeKind: 'selection'
    })
  })

  it('parses labeled plain-text fallbacks', () => {
    expect(parseWriteInlineAction('completion: next sentence')).toEqual({
      kind: 'short',
      text: 'next sentence'
    })
    expect(parseWriteInlineAction('long: A fuller continuation.')).toEqual({
      kind: 'long',
      text: 'A fuller continuation.'
    })
    expect(parseWriteInlineAction('edit: Rewrite this block', {
      editTarget: {
        from: 1,
        to: 4,
        original: 'old',
        scopeKind: 'paragraph'
      }
    })).toEqual({
      kind: 'edit',
      replacement: 'Rewrite this block',
      from: 1,
      to: 4,
      original: 'old',
      scopeKind: 'paragraph'
    })
  })

  it('falls back to the requested mode for unstructured plain text', () => {
    expect(parseWriteInlineAction('Raw continuation text')).toEqual({
      kind: 'short',
      text: 'Raw continuation text'
    })
    expect(parseWriteInlineAction('Raw long continuation', { fallbackKind: 'long' })).toEqual({
      kind: 'long',
      text: 'Raw long continuation'
    })
    expect(parseWriteInlineAction('Raw edit replacement', {
      fallbackKind: 'edit',
      editTarget: {
        from: 8,
        to: 15,
        original: 'old text',
        scopeKind: 'selection'
      }
    })).toEqual({
      kind: 'edit',
      replacement: 'Raw edit replacement',
      from: 8,
      to: 15,
      original: 'old text',
      scopeKind: 'selection'
    })
  })
})
