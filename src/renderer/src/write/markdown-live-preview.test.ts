import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadWriteMarkdownImage } from './markdown-image'
import { markdownLivePreviewTestInternals } from './markdown-live-preview'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markdown live preview', () => {
  it('keeps markdown concealment stable while text is selected', () => {
    const state = EditorState.create({
      doc: '**Bold** text',
      selection: EditorSelection.range(2, 6)
    })

    const lines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, true)

    expect(lines.size).toBe(0)
  })

  it('reveals source marks on the caret line only when the editor is focused', () => {
    const state = EditorState.create({
      doc: '**Bold** text',
      selection: EditorSelection.cursor(4)
    })

    const focusedLines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, true)
    const blurredLines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, false)

    expect([...focusedLines]).toEqual([1])
    expect(blurredLines.size).toBe(0)
  })

  it('does not treat a visible closing fence as a new code block opener', () => {
    const state = EditorState.create({
      doc: [
        '```python',
        'python("hello world")',
        '```',
        '',
        '呀',
        'nihao'
      ].join('\n')
    })
    const closingFence = state.doc.line(3)

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      closingFence.from,
      state.doc.length,
      new Set()
    )

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toMatchObject({
      from: state.doc.line(1).from,
      to: closingFence.to,
      block: {
        language: 'python',
        code: 'python("hello world")'
      }
    })
  })

  it('does not leak code block ranges into following prose', () => {
    const state = EditorState.create({
      doc: [
        '```python',
        'python("hello world")',
        '```',
        '',
        '呀',
        'nihao'
      ].join('\n')
    })
    const proseLine = state.doc.line(5)

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      proseLine.from,
      state.doc.length,
      new Set()
    )

    expect(ranges).toHaveLength(0)
  })

  it('keeps prose between adjacent language-less fences out of code blocks', () => {
    const state = EditorState.create({
      doc: [
        '现代文本补全几乎全部基于**自回归语言模型**。',
        '',
        '```',
        'P(w1, w2, ..., wn) = ∏ P(wt | w1, w2, ..., wt-1)',
        '```',
        '',
        '你好',
        '',
        '```',
        '输入: [我] [爱] [深] [度] [学] [习]',
        '掩码: 1 0 0 0 0 0',
        '```'
      ].join('\n')
    })
    const firstClosingFence = state.doc.line(5)

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      firstClosingFence.from,
      state.doc.length,
      new Set()
    )

    expect(ranges).toHaveLength(2)
    expect(ranges.map((range) => range.block)).toEqual([
      {
        language: '',
        code: 'P(w1, w2, ..., wn) = ∏ P(wt | w1, w2, ..., wt-1)'
      },
      {
        language: '',
        code: '输入: [我] [爱] [深] [度] [学] [习]\n掩码: 1 0 0 0 0 0'
      }
    ])
  })

  it('indexes long tilde/backtick fences and an unclosed fence through EOF', () => {
    const state = EditorState.create({
      doc: [
        '````````ts',
        'const marker = "```"',
        '````````',
        '',
        '~~~~~text',
        'still fenced'
      ].join('\n')
    })

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      0,
      state.doc.length,
      new Set()
    )

    expect(ranges.map((range) => range.block)).toEqual([
      { language: 'ts', code: 'const marker = "```"' },
      { language: 'text', code: 'still fenced' }
    ])
  })

  it('maps closed display formulas to visual widgets without treating formula text inside code as math', () => {
    const source = ['$$', '\\frac{x}{2}', '$$', '', '\\[y^2\\]', '', '```ts', '$$literal$$', '```', '', '$$unclosed'].join('\n')
    const state = EditorState.create({ doc: source })
    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(state, 0, state.doc.length, new Set())
    expect(ranges.map((range) => range.block)).toEqual([
      { language: 'math', code: '\\frac{x}{2}' },
      { language: 'math', code: 'y^2' },
      { language: 'ts', code: '$$literal$$' }
    ])
  })

  it('resolves root-level document images through the workspace image bridge', () => {
    vi.stubGlobal('window', {
      workwise: {
        readWorkspaceImage: vi.fn()
      }
    })

    const parsed = markdownLivePreviewTestInternals.markdownImageFromSource(
      '![信息图](img/infographic-20260611012250-00f1.png)',
      '/tmp/write_workspace/doc.md'
    )

    expect(parsed).toEqual({
      alt: '信息图',
      src: '',
      localPath: '/tmp/write_workspace/img/infographic-20260611012250-00f1.png'
    })
  })

  it('parses bracketed image paths that contain spaces', () => {
    vi.stubGlobal('window', {
      workwise: {
        readWorkspaceImage: vi.fn()
      }
    })

    const parsed = markdownLivePreviewTestInternals.markdownImageFromSource(
      '![Hero](<../assets/hero image.png>)',
      '/tmp/write_workspace/docs/draft.md'
    )

    expect(parsed).toEqual({
      alt: 'Hero',
      src: '',
      localPath: '/tmp/write_workspace/assets/hero image.png'
    })
  })

  it('loads local markdown images as data URLs', async () => {
    const readWorkspaceImage = vi.fn(async () => ({
      ok: true as const,
      path: '/tmp/write_workspace/img/hero.png',
      dataUrl: 'data:image/png;base64,aGVybw==',
      mimeType: 'image/png',
      size: 4
    }))
    vi.stubGlobal('window', {
      workwise: {
        readWorkspaceImage
      }
    })

    const result = await loadWriteMarkdownImage(
      'img/hero.png',
      '/tmp/write_workspace/doc.md'
    )

    expect(readWorkspaceImage).toHaveBeenCalledWith({
      path: '/tmp/write_workspace/img/hero.png'
    })
    expect(result).toEqual({
      ok: true,
      src: 'data:image/png;base64,aGVybw==',
      localPath: '/tmp/write_workspace/img/hero.png'
    })
  })
})
