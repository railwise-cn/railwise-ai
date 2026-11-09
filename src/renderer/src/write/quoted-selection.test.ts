import { describe, expect, it, vi } from 'vitest'
import { harden } from 'rehype-harden'
import {
  resolveWriteMarkdownResource,
  resolveWriteMarkdownResourcePath,
  writePathToFileUrl,
  writeMarkdownHardenOptions
} from '../components/write/WriteMarkdownPreview'
import {
  WRITE_QUOTE_ORIGINAL_END,
  WRITE_QUOTE_ORIGINAL_START,
  WRITE_USER_REQUEST_HEADING,
  composeWritePrompt,
  formatWriteQuotedSelectionForPrompt,
  formatWriteKnowledgeForPrompt,
  parseWritePromptForDisplay,
  quotedSelectionFromEditor
} from './quoted-selection'

describe('write quoted selections', () => {
  it('formats selected text with file and line context', () => {
    const quote = {
      id: 'quote-1',
      text: 'Selected paragraph',
      sourceTitle: 'notes/draft.md',
      sourceFilePath: '/tmp/workspace/notes/draft.md',
      lineStart: 3,
      lineEnd: 5,
      charCount: 18,
      createdAt: '2026-05-24T00:00:00.000Z'
    }

    expect(formatWriteQuotedSelectionForPrompt(quote)).toContain('第3-5行')
    expect(formatWriteQuotedSelectionForPrompt(quote)).toContain(WRITE_QUOTE_ORIGINAL_START)
    expect(formatWriteQuotedSelectionForPrompt(quote)).toContain(WRITE_QUOTE_ORIGINAL_END)
  })

  it('does not create a quote for empty selections', () => {
    expect(quotedSelectionFromEditor({
      text: '   ',
      ranges: [],
      charCount: 0
    }, '/tmp/workspace/notes.md', '/tmp/workspace')).toBeNull()
  })

  it('composes prompt with committed quote context first', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1)
    const quote = quotedSelectionFromEditor({
      text: 'A useful quote',
      ranges: [{
        from: 0,
        to: 14,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 14,
        text: 'A useful quote',
        charCount: 14
      }],
      charCount: 14
    }, '/tmp/workspace/a.md', '/tmp/workspace', Date.parse('2026-05-24T00:00:00.000Z'))

    expect(quote).not.toBeNull()
    const prompt = composeWritePrompt('Please revise it.', quote ? [quote] : [])
    expect(prompt.startsWith('[写作上下文]')).toBe(true)
    expect(prompt).toContain('不要调用 request_user_input')
    expect(prompt).toContain(`${WRITE_USER_REQUEST_HEADING}\nPlease revise it.`)
    expect(prompt.indexOf('[引用片段] a.md')).toBeGreaterThan(prompt.indexOf('[写作上下文]'))
    expect(prompt.endsWith('Please revise it.')).toBe(true)
    vi.restoreAllMocks()
  })

  it('parses write prompt metadata for compact timeline display', () => {
    const prompt = composeWritePrompt(
      '帮我改成中文',
      [{
        id: 'quote-1',
        text: "Hi, I'm zxy. Glad to meet you.",
        sourceTitle: 'welcome.md',
        sourceFilePath: '/tmp/workspace/welcome.md',
        lineStart: 10,
        lineEnd: 10,
        charCount: 31,
        createdAt: '2026-05-24T00:00:00.000Z'
      }],
      {
        workspaceRoot: '/tmp/workspace',
        activeFilePath: '/tmp/workspace/welcome.md'
      }
    )

    const parsed = parseWritePromptForDisplay(prompt)

    expect(parsed?.userInput).toBe('帮我改成中文')
    expect(parsed?.context?.workspaceRoot).toBe('/tmp/workspace')
    expect(parsed?.context?.activeFile).toBe('welcome.md')
    expect(parsed?.context?.lines.some((line) => line.includes('不要调用 request_user_input'))).toBe(true)
    expect(parsed?.quotes).toHaveLength(1)
    expect(parsed?.quotes[0]).toMatchObject({
      sourceTitle: 'welcome.md',
      sourceFilePath: '/tmp/workspace/welcome.md',
      lineStart: 10,
      lineEnd: 10,
      charCount: 31,
      text: "Hi, I'm zxy. Glad to meet you."
    })
  })

  it('keeps injected knowledge and file context out of the displayed user request', () => {
    const prompt = composeWritePrompt(
      '不要生成文件，只在对话中给出清单。',
      [],
      {
        workspaceRoot: '/tmp/workspace',
        activeFilePath: '/tmp/workspace/current.md'
      },
      {
        source: 'static',
        keywords: ['报告'],
        snippets: [{
          title: 'AI 监测报告生成工具',
          url: 'https://kb.railwise.cn/ai/tool-report-generator/',
          text: '生成报告的参考资料。',
          score: 1,
          source: 'railwise-static'
        }]
      }
    )

    expect(parseWritePromptForDisplay(prompt)?.userInput)
      .toBe('不要生成文件，只在对话中给出清单。')
  })

  it('injects RailWise results with source links and path suppression guidance', () => {
    const prompt = composeWritePrompt('RailWise KB 中有哪些知识库？', [], {}, {
      source: 'static',
      keywords: ['railwise', '知识库'],
      totalEntries: 2,
      categories: [{ name: '工程监测', count: 2 }],
      snippets: [{
        title: '工程监测知识库',
        url: 'https://kb.railwise.cn/monitoring',
        text: '沉降、位移和预警处置。',
        score: 1,
        source: 'railwise-static'
      }]
    })

    expect(prompt).toContain('[RailWise 知识库检索结果]')
    expect(prompt).toContain('[工程监测知识库](https://kb.railwise.cn/monitoring)')
    expect(prompt).toContain('不要复述 RailWise AI 内部绝对路径')
    expect(formatWriteKnowledgeForPrompt({ source: 'unavailable', keywords: [], snippets: [] }))
      .toContain('检索暂时不可用')
  })
})

describe('write markdown preview resources', () => {
  it('uses a rehype-harden config that can initialize without crashing preview', () => {
    expect(() => harden(writeMarkdownHardenOptions)).not.toThrow()
  })

  it('resolves relative image paths from the current markdown file', () => {
    const resolved = resolveWriteMarkdownResource('../assets/hero image.png', '/tmp/workspace/docs/draft.md')
    expect(resolved).toBe('file:///tmp/workspace/assets/hero%20image.png')
    expect(resolveWriteMarkdownResourcePath('../assets/hero image.png', '/tmp/workspace/docs/draft.md')).toBe(
      '/tmp/workspace/assets/hero image.png'
    )
  })

  it('keeps explicit external URLs unchanged', () => {
    expect(resolveWriteMarkdownResource('https://example.com/a.png', '/tmp/workspace/docs/draft.md')).toBe('https://example.com/a.png')
    expect(resolveWriteMarkdownResourcePath('https://example.com/a.png', '/tmp/workspace/docs/draft.md')).toBeUndefined()
  })

  it('does not pass through explicit file URLs from markdown content', () => {
    expect(resolveWriteMarkdownResource('file:///tmp/secret.png', '/tmp/workspace/docs/draft.md')).toBeUndefined()
    expect(writePathToFileUrl('/tmp/workspace/assets/hero image.png')).toBe('file:///tmp/workspace/assets/hero%20image.png')
  })
})
