import type { WriteMermaidPreviewRequest, WriteMermaidPreviewResult } from '../../shared/write-mermaid-preview'
import { validateWriteMermaidSource } from '../../shared/write-mermaid-policy'
import { renderWriteMermaidDiagrams } from './write-advanced-renderer'

const MAX_PENDING = 32
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const MAX_CACHE_ENTRIES = 32
const cache = new Map<string, Extract<WriteMermaidPreviewResult, { ok: true }>>()
const pending = new Map<string, Promise<WriteMermaidPreviewResult>>()
let cacheBytes = 0
let tail: Promise<unknown> = Promise.resolve()

/** One isolated Chromium renderer at a time; no document text is persisted. */
export function renderWriteMermaidPreview(request: WriteMermaidPreviewRequest): Promise<WriteMermaidPreviewResult> {
  const { source } = request
  const policy = validateWriteMermaidSource(source)
  if (!policy.ok) return Promise.resolve(policy)
  const cached = cache.get(source)
  if (cached) {
    cache.delete(source)
    cache.set(source, cached)
    return Promise.resolve(cached)
  }
  const existing = pending.get(source)
  if (existing) return existing
  if (pending.size >= MAX_PENDING) return Promise.resolve({ ok: false, message: 'The local diagram renderer is busy. Try again shortly.' })
  const operation = tail.then(async (): Promise<WriteMermaidPreviewResult> => {
    try {
      const diagram = (await renderWriteMermaidDiagrams([source])).get(source)
      if (!diagram) return { ok: false, message: 'Unable to render this Mermaid diagram.' }
      const result = { ok: true as const, svg: diagram.svg, width: diagram.width, height: diagram.height }
      const bytes = Buffer.byteLength(source) + Buffer.byteLength(result.svg)
      if (bytes <= MAX_CACHE_BYTES) {
        while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
          const oldest = cache.entries().next().value
          if (!oldest) break
          cacheBytes -= Buffer.byteLength(oldest[0]) + Buffer.byteLength(oldest[1].svg)
          cache.delete(oldest[0])
        }
        cache.set(source, result)
        cacheBytes += bytes
      }
      return result
    } catch {
      return { ok: false, message: 'The local diagram renderer is unavailable. Try again shortly.' }
    }
  }).finally(() => { pending.delete(source) })
  pending.set(source, operation)
  tail = operation
  return operation
}
