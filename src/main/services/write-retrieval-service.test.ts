import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WriteInlineCompletionRequest } from '../../shared/write-inline-completion'
import {
  clearWriteRetrievalCache,
  retrieveWriteInlineCompletionContext,
  tokenizeWriteRetrievalText
} from './write-retrieval-service'

function createRequest(workspaceRoot: string): WriteInlineCompletionRequest {
  return {
    workspaceRoot,
    currentFilePath: join(workspaceRoot, 'draft.md'),
    prefix: '# Draft\n\nBM25 关键词',
    suffix: '',
    cursor: {
      line: 3,
      column: 9
    },
    context: {
      language: 'markdown',
      currentLinePrefix: 'BM25 关键词',
      currentLineSuffix: '',
      previousLine: '',
      previousNonEmptyLine: '# Draft',
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
      name: 'precision-inline-v2',
      instruction: 'Return only inserted text.',
      acceptanceCriteria: ['Keep it short.'],
      rejectionCriteria: ['Do not ramble.']
    },
    preview: {
      local: 'BM25 关键词',
      documentTail: '# Draft BM25 关键词'
    },
    model: 'deepseek-v4-flash'
  }
}

afterEach(() => {
  clearWriteRetrievalCache()
})

describe('write retrieval service', () => {
  it('tokenizes latin terms and CJK keyword ngrams', () => {
    const tokens = tokenizeWriteRetrievalText('BM25 关键词检索 RAG')

    expect(tokens).toContain('bm25')
    expect(tokens).toContain('rag')
    expect(tokens).toContain('关键词')
    expect(tokens).toContain('检索')
  })

  it('retrieves relevant cross-document snippets and excludes the active file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-rag-'))
    await mkdir(join(workspaceRoot, 'research'), { recursive: true })
    await writeFile(
      join(workspaceRoot, 'draft.md'),
      '# Draft\n\nBM25 关键词',
      'utf8'
    )
    await writeFile(
      join(workspaceRoot, 'research', 'rag.md'),
      [
        '# 检索方案',
        '',
        'BM25 关键词检索用于在写作空间中找到相关片段。',
        '这些片段会作为 RAG 上下文帮助补全保持术语一致。'
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      join(workspaceRoot, 'unrelated.md'),
      '# Shopping',
      'utf8'
    )

    const result = await retrieveWriteInlineCompletionContext(createRequest(workspaceRoot))

    expect(result?.source).toBe('bm25-keyword')
    expect(result?.snippets[0].path).toBe('research/rag.md')
    expect(result?.snippets[0].text).toContain('BM25 关键词检索')
    expect(result?.snippets.some((snippet) => snippet.path === 'draft.md')).toBe(false)
  })

  it('ignores unsupported large data files while scanning the workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-rag-'))
    await writeFile(join(workspaceRoot, 'draft.md'), '# Draft\n\nembedding cache', 'utf8')
    await writeFile(
      join(workspaceRoot, 'notes.md'),
      '# Notes\n\nEmbedding cache notes help the inline completion stay consistent.',
      'utf8'
    )
    await writeFile(join(workspaceRoot, 'output.jsonl'), `${'x'.repeat(10_000)}\n`, 'utf8')

    const result = await retrieveWriteInlineCompletionContext({
      ...createRequest(workspaceRoot),
      prefix: '# Draft\n\nembedding cache',
      context: {
        ...createRequest(workspaceRoot).context,
        currentLinePrefix: 'embedding cache',
        previousNonEmptyLine: '# Draft'
      },
      preview: {
        local: 'embedding cache',
        documentTail: '# Draft embedding cache'
      }
    })

    expect(result?.snippets.some((snippet) => snippet.path === 'output.jsonl')).toBe(false)
    expect(result?.snippets.some((snippet) => snippet.path === 'notes.md')).toBe(true)
  })

  it('retrieves a final-file Chinese source beyond 160 files and 720 chunks with explicit index limits', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-rag-large-'))
    await Promise.all(Array.from({ length: 180 }, (_, index) => writeFile(
      join(workspaceRoot, `${String(index).padStart(3, '0')}.md`),
      Array.from({ length: 5 }, (_, part) => `# Part ${part}\n${'Ordinary reference text for engineering documentation and stable measurements. '.repeat(2)}`).join('\n\n')
    )))
    await writeFile(join(workspaceRoot, 'zz-last.md'), `# 遥远站点专用依据\n${'遥远站点专用依据用于核查独特阈值和监测结论，文档末尾的资料也必须被检索。'.repeat(4)}`)
    const base = createRequest(workspaceRoot)
    const result = await retrieveWriteInlineCompletionContext({
      ...base, prefix: '遥远站点专用依据', context: { ...base.context, currentLinePrefix: '遥远站点专用依据' },
      preview: { local: '遥远站点专用依据', documentTail: '遥远站点专用依据' }
    })
    expect(result?.indexedFiles).toBe(181)
    expect(result!.indexedChunks).toBeGreaterThan(720)
    expect(result?.snippets[0].path).toBe('zz-last.md')
    expect(result?.truncated).toBe(false)
    expect(result?.limits).toMatchObject({ maxFiles: 20_000, maxFileBytes: 2_000_000, maxChunks: 20_000, maxTokens: 2_000_000 })
  })

  it('retrieves a long paragraph tail and short factual document without prefix truncation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-rag-long-'))
    await writeFile(join(workspaceRoot, 'long.md'), '# Reference\n' + 'ordinary words '.repeat(200) + 'unique_station_threshold is 6 mm.')
    await writeFile(join(workspaceRoot, 'short.md'), 'unique_station_threshold: 6 mm')
    const base = createRequest(workspaceRoot)
    const result = await retrieveWriteInlineCompletionContext({
      ...base, prefix: 'unique_station_threshold', context: { ...base.context, currentLinePrefix: 'unique_station_threshold' },
      preview: { local: 'unique_station_threshold', documentTail: 'unique_station_threshold' }
    })
    expect(result?.snippets.map((snippet) => snippet.path)).toEqual(expect.arrayContaining(['long.md', 'short.md']))
    expect(result?.snippets.find((snippet) => snippet.path === 'long.md')).toMatchObject({ lineStart: 2, lineEnd: 2 })
  })

})
