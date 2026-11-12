import { beforeEach, describe, expect, it, vi } from 'vitest'

const render = vi.hoisted(() => vi.fn())
vi.mock('./write-advanced-renderer', () => ({ renderWriteMermaidDiagrams: render }))

beforeEach(() => { vi.resetModules(); render.mockReset() })

describe('isolated Mermaid preview queue', () => {
  it('rejects active content before creating a rendering window', async () => {
    const { renderWriteMermaidPreview } = await import('./write-mermaid-preview')
    expect((await renderWriteMermaidPreview({ source: 'flowchart LR\nclick A "https://example.com"' })).ok).toBe(false)
    expect((await renderWriteMermaidPreview({ source: 'x'.repeat(30001) })).ok).toBe(false)
    expect(render).not.toHaveBeenCalled()
  })

  it('deduplicates pending work, serializes windows and caches only rendered SVG', async () => {
    const { renderWriteMermaidPreview } = await import('./write-mermaid-preview')
    let finish!: () => void
    render.mockImplementationOnce(async ([source]: string[]) => {
      await new Promise<void>((resolve) => { finish = resolve })
      return new Map([[source, { svg: '<svg/>', png: Buffer.alloc(10), width: 200, height: 100 }]])
    }).mockResolvedValueOnce(new Map([['graph LR; B-->C', null]]))
    const first = renderWriteMermaidPreview({ source: 'graph LR; A-->B' })
    const same = renderWriteMermaidPreview({ source: 'graph LR; A-->B' })
    const second = renderWriteMermaidPreview({ source: 'graph LR; B-->C' })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    expect(first).toBe(same)
    finish()
    const result = await first
    expect(result).toEqual({ ok: true, svg: '<svg/>', width: 200, height: 100 })
    expect(await second).toEqual({ ok: false, message: 'Unable to render this Mermaid diagram.' })
    expect(await renderWriteMermaidPreview({ source: 'graph LR; A-->B' })).toEqual(result)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('returns a stable failure without retaining a failed preview', async () => {
    const { renderWriteMermaidPreview } = await import('./write-mermaid-preview')
    render.mockRejectedValueOnce(new Error('private path')).mockResolvedValueOnce(new Map([['graph LR; A-->B', null]]))
    const result = await renderWriteMermaidPreview({ source: 'graph LR; A-->B' })
    expect(result).toEqual({ ok: false, message: 'The local diagram renderer is unavailable. Try again shortly.' })
    await renderWriteMermaidPreview({ source: 'graph LR; A-->B' })
    expect(render).toHaveBeenCalledTimes(2)
  })
})
