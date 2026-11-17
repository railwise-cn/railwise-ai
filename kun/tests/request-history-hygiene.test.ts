import { describe, expect, it } from 'vitest'
import { applyRequestHistoryHygiene } from '../src/loop/request-history-hygiene.js'
import { makeToolCallItem, makeToolResultItem } from '../src/domain/item.js'
import { createHash } from 'node:crypto'

describe('request history hygiene', () => {
  it.each(['ego_browser_open', 'ego_browser_read', 'ego_browser_next_page', 'browser_get_html'])('retains every ordered %s record and link despite decorative markup and a long single content line', toolName => {
    const entries = Array.from({ length: 20 }, (_, index) => `<article><h2>合成项目-${String(index + 1).padStart(2, '0')}</h2><p>合成地区-${index + 1} 工程服务</p><time datetime="2026-01-01">2026-01-01</time><a href="/record/${index + 1}">原文-${index + 1}</a></article>`).join('')
    const html = `<main><svg>${'<path d="M 0 0 L 10 10"/>\n'.repeat(1500)}</svg>${entries}<script>throw Error('must not run')</script><style>.decorative { color: red }</style></main>`
    const resultHash = createHash('sha256').update(html).digest('hex')
    const original = makeToolResultItem({ id: 'browser-doc', threadId: 'thread', turnId: 'turn', callId: 'browser', toolName,
      output: { sourceUrl: 'https://fixture.test/list', html, resultHash, truncated: false, observationId: 'source-receipt', evidence: { verified: true, readReceiptId: 'source-receipt' },
        data_base64: 'a'.repeat(2000), diagnostics: Array.from({ length: 100 }, (_, index) => index) } })
    const projected = applyRequestHistoryHygiene([original])[0]!
    expect(projected.kind).toBe('tool_result')
    if (projected.kind !== 'tool_result') throw Error('missing tool result')
    const output = projected.output as Record<string, unknown>
    for (let index = 1; index <= 20; index++) {
      const title = `合成项目-${String(index).padStart(2, '0')}`
      expect(output.html).toContain(title)
      if (index > 1) expect(String(output.html).indexOf(title)).toBeGreaterThan(String(output.html).indexOf(`合成项目-${String(index - 1).padStart(2, '0')}`))
      expect(output.html).toContain(`link="https://fixture.test/record/${index}"`)
      expect(output.html).toContain(`合成地区-${index}`)
    }
    expect(output.html).not.toContain('<path')
    expect(output.html).not.toContain('must not run')
    expect(output.data_base64).toContain('omitted base64 data')
    expect(output.diagnostics).toHaveLength(81)
    expect(output).toMatchObject({ resultHash, truncated: false, observationId: 'source-receipt', evidence: { readReceiptId: 'source-receipt' },
      modelDocumentProjection: { representation: 'text-and-links', complete: true, sourceHtmlSha256: resultHash } })
    expect(Buffer.byteLength(String(output.html))).toBeLessThan(32 * 1024)
    if (original.kind !== 'tool_result') throw Error('missing original tool result')
    expect(original.output).toMatchObject({ html, resultHash })
  })

  it('keeps source recall slices contiguous and advances the original byte offset only over text the model actually sees', () => {
    const text = '中文片段与原始空白\n'.repeat(900)
    const original = makeToolResultItem({ id: 'recall', threadId: 'thread', turnId: 'turn', callId: 'recall', toolName: 'read_task_context',
      output: { untrusted: true, text, offset: 81, nextOffset: 81 + Buffer.byteLength(text), totalBytes: 50000, sha256: 'a'.repeat(64) } })
    const result = applyRequestHistoryHygiene([original], { maxToolResultBytes: 1024, maxToolResultTokens: 256, maxToolResultLines: 20 })[0]!
    if (result.kind !== 'tool_result') throw Error('missing tool result')
    const output = result.output as { text: string; nextOffset: number }
    expect(text.startsWith(output.text)).toBe(true)
    expect(output.text.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(1024)
    expect(output.text.split('\n').length - Number(output.text.endsWith('\n'))).toBeLessThanOrEqual(20)
    expect(output.nextOffset).toBe(81 + Buffer.byteLength(output.text))
    expect(output.text + Buffer.from(text).subarray(output.nextOffset - 81).toString('utf8')).toBe(text)
    if (original.kind !== 'tool_result') throw Error('missing original tool result')
    expect(original.output).toMatchObject({ text, nextOffset: 81 + Buffer.byteLength(text) })
  })

  it('does not classify arbitrary nested arrays or non-browser HTML as trusted document projection contracts', () => {
    const rows = Array.from({ length: 100 }, () => ({ html: `<div>${'合成资料'.repeat(3000)}</div>`, sourceUrl: 'https://fixture.test/list' }))
    for (const toolName of ['ego_browser_read', 'custom_tool']) {
      const item = makeToolResultItem({ id: toolName, threadId: 'thread', turnId: 'turn', callId: toolName, toolName, output: { rows } })
      const projected = applyRequestHistoryHygiene([item], { maxArrayItems: 3, maxToolResultBytes: 1024 })[0]!
      if (projected.kind !== 'tool_result') throw Error('missing projection')
      const output = projected.output as { rows: unknown[] }
      expect(output.rows).toHaveLength(4)
      expect(JSON.stringify(output)).not.toContain('modelDocumentProjection')
      expect(output.rows).toContainEqual({ cache_hygiene_omitted_items: 97 })
    }
  })

  it('retains explicit incomplete source status and makes progress across a leading newline under a one-line limit', () => {
    const html = `<main>${'<svg><path d="M0 0"/></svg>\n'.repeat(600)}<p>仅为已读片段</p></main>`
    const partial = makeToolResultItem({ id: 'partial', threadId: 'thread', turnId: 'turn', callId: 'partial', toolName: 'ego_browser_read',
      output: { sourceUrl: 'https://fixture.test/list', html, truncated: true, readScope: 'element' } })
    const projected = applyRequestHistoryHygiene([partial])[0]!
    if (projected.kind !== 'tool_result') throw Error('missing projection')
    expect(projected.output).toMatchObject({ truncated: true, modelDocumentProjection: { complete: false, sourceTruncated: true, sourceReadScope: 'element' } })
    const recall = makeToolResultItem({ id: 'newline', threadId: 'thread', turnId: 'turn', callId: 'newline', toolName: 'read_task_context',
      output: { text: '\n中文原文\n后续', offset: 9, nextOffset: null, totalBytes: 99, sha256: 'a'.repeat(64) } })
    const next = applyRequestHistoryHygiene([recall], { maxToolResultLines: 1 })[0]!
    if (next.kind !== 'tool_result') throw Error('missing recall')
    expect(next.output).toMatchObject({ text: '\n', nextOffset: 10, modelContextSlice: { complete: false, offsetUnit: 'utf8-bytes' } })
  })

  it('shrinks oversized tool results while preserving head, signal lines, and tail', () => {
    const longOutput = Array.from({ length: 500 }, (_, index) => {
      if (index === 240) return 'ERROR failed to compile auth middleware'
      return `plain output line ${index}`
    }).join('\n')
    const result = makeToolResultItem({
      id: 'result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_bash',
      toolName: 'bash',
      output: { output: longOutput }
    })

    const compacted = applyRequestHistoryHygiene([result], {
      maxToolResultLines: 80,
      maxToolResultBytes: 4 * 1024
    })
    const compactedResult = compacted[0]
    const originalText = result.kind === 'tool_result' ? JSON.stringify(result.output) : ''
    const compactedText = compactedResult?.kind === 'tool_result'
      ? JSON.stringify(compactedResult.output)
      : ''

    expect(compactedResult).not.toBe(result)
    expect(originalText).toContain('plain output line 499')
    expect(compactedText.length).toBeLessThan(originalText.length)
    expect(compactedText).toContain('plain output line 0')
    expect(compactedText).toContain('ERROR failed to compile auth middleware')
    expect(compactedText).toContain('plain output line 499')
    expect(compactedText).toContain('cache hygiene')
  })

  it('omits long completed tool-call argument strings only when the result is paired', () => {
    const pairedCall = makeToolCallItem({
      id: 'call_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      arguments: {
        path: 'src/generated.ts',
        content: 'x'.repeat(12_000)
      }
    })
    const result = makeToolResultItem({
      id: 'result_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      output: 'wrote src/generated.ts'
    })
    const unpairedCall = makeToolCallItem({
      id: 'unpaired_call_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_pending',
      toolName: 'write',
      arguments: { content: 'y'.repeat(12_000) }
    })

    const compacted = applyRequestHistoryHygiene([pairedCall, result, unpairedCall])
    const nextPairedCall = compacted[0]
    const nextUnpairedCall = compacted[2]

    expect(nextPairedCall?.kind === 'tool_call' ? String(nextPairedCall.arguments.content) : '')
      .toContain('cache hygiene')
    expect(nextPairedCall?.kind === 'tool_call' ? nextPairedCall.arguments.path : '')
      .toBe('src/generated.ts')
    expect(nextUnpairedCall?.kind === 'tool_call' ? String(nextUnpairedCall.arguments.content).length : 0)
      .toBe(12_000)
  })

  it('shrinks dense text when the approximate token cap is exceeded before the byte cap', () => {
    const denseOutput = '汉'.repeat(9_000)
    const result = makeToolResultItem({
      id: 'dense_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      output: { content: denseOutput }
    })

    const compacted = applyRequestHistoryHygiene([result], {
      maxToolResultBytes: 32 * 1024,
      maxToolResultTokens: 4_000
    })
    const compactedResult = compacted[0]
    const compactedText = compactedResult?.kind === 'tool_result'
      ? String((compactedResult.output as { content?: string }).content ?? '')
      : ''

    expect(Buffer.byteLength(denseOutput, 'utf8')).toBeLessThan(32 * 1024)
    expect(compactedText.length).toBeLessThan(denseOutput.length)
    expect(compactedText).toContain('approx')
    expect(compactedText).toContain('cache hygiene')
  })

  it('shrinks completed tool-call args when only the approximate token cap is exceeded', () => {
    const pairedCall = makeToolCallItem({
      id: 'dense_call',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      arguments: {
        path: 'src/generated.txt',
        content: '汉'.repeat(2_500)
      }
    })
    const result = makeToolResultItem({
      id: 'dense_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      output: 'wrote src/generated.txt'
    })

    const compacted = applyRequestHistoryHygiene([pairedCall, result], {
      maxToolArgumentStringBytes: 8 * 1024,
      maxToolArgumentStringTokens: 2_000
    })
    const nextCall = compacted[0]

    expect(nextCall?.kind === 'tool_call' ? String(nextCall.arguments.content) : '')
      .toContain('approx')
    expect(nextCall?.kind === 'tool_call' ? String(nextCall.arguments.content) : '')
      .toContain('cache hygiene')
  })

  it('replaces base64 payloads in model-bound history', () => {
    const result = makeToolResultItem({
      id: 'image_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      output: { data_base64: 'a'.repeat(2_000), mime: 'image/png' }
    })

    const compacted = applyRequestHistoryHygiene([result])
    const compactedResult = compacted[0]

    expect(compactedResult?.kind === 'tool_result' ? compactedResult.output : {}).toMatchObject({
      data_base64: expect.stringContaining('omitted base64 data'),
      mime: 'image/png'
    })
  })
})
