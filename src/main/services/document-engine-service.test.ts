import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import {
  assessDocumentQuality,
  DocumentEngineError,
  DocumentEngineService,
  sanitizeDocumentDiagnostic,
  type DocumentEngineRunner,
  type DocumentSidecarResponse
} from './document-engine-service'
import { UnlimitedOcrService } from './unlimited-ocr-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(extension = '.pdf'): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-document-engine-'))
  roots.push(root)
  const path = join(root, `source${extension}`)
  await writeFile(path, extension === '.pdf' ? '%PDF-1.7\n%%EOF' : 'office fixture')
  return { root, path }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function runner(
  markdown = '# Parsed\n\n| A | B |\n|---|---|\n| 1 | 2 |',
  headings: DocumentSidecarResponse['headings'] = [{ level: 1, text: 'Parsed' }]
) {
  return vi.fn<DocumentEngineRunner>(async (input) => {
    await mkdir(input.outputDirectory, { recursive: true })
    const markdownPath = join(input.outputDirectory, 'document.md')
    await writeFile(markdownPath, markdown)
    const payload = {
      ok: true,
      engine: input.engine,
      engineVersion: 'fixture-1',
      sourceSha256: createHash('sha256').update(await readFile(input.inputPath)).digest('hex'),
      markdownPath: relative(input.workspaceRoot, markdownPath),
      headings,
      tables: [],
      media: [],
      references: [],
      warnings: [],
      durationMs: 5
    } satisfies DocumentSidecarResponse
    await writeFile(join(input.outputDirectory, 'result.json'), JSON.stringify(payload))
    return payload
  })
}

describe('DocumentEngineService', () => {
  it('detects low-density and garbled PDFs for explainable auto routing', () => {
    expect(assessDocumentQuality({ extension: '.pdf', markdown: 'tiny', sourceBytes: 8 * 1024 * 1024 })).toEqual({
      needsAccurateEngine: true,
      reasons: ['low_text_density']
    })
    expect(assessDocumentQuality({ extension: '.docx', markdown: 'tiny', sourceBytes: 8 * 1024 * 1024 }).needsAccurateEngine).toBe(false)
    expect(assessDocumentQuality({ extension: '.pdf', markdown: `${'正文'.repeat(200)}${'�'.repeat(12)}`, sourceBytes: 1024 }).reasons).toContain('garbled_text')
  })

  it('distinguishes weak text layers, scans, formulas, tables, and complex layouts', () => {
    expect(assessDocumentQuality({
      extension: '.pdf',
      markdown: '可读正文'.repeat(200),
      sourceBytes: 1024,
      pageCount: 10,
      pageTextCharacters: 120
    }).reasons).toContain('weak_text_layer')
    expect(assessDocumentQuality({
      extension: '.pdf',
      markdown: '',
      sourceBytes: 1024,
      pageCount: 10,
      pageTextCharacters: 0,
      warnings: ['OCR recommended for scanned pages.']
    }).reasons).toContain('scanned_document')
    expect(assessDocumentQuality({
      extension: '.pdf',
      markdown: '可读正文'.repeat(200),
      sourceBytes: 1024,
      warnings: ['Formula-dense document detected.', 'Cross-page table detected.', 'Multi-column layout detected.']
    }).reasons).toEqual(expect.arrayContaining(['formula_dense', 'table_dense', 'complex_layout']))

    const markdownWithoutParserWarnings = [
      '可读正文'.repeat(200),
      '',
      '$$ \\frac{a}{b} = \\sum_{i=1}^{n} x_i $$',
      '$$ \\sqrt{x^2 + y^2} $$',
      '',
      '| 条款 | 金额 | 说明 |',
      '| --- | --- | --- |',
      '| A | 100 | 跨页 1 |',
      '| B | 200 | 跨页 2 |',
      '| C | 300 | 跨页 3 |',
      '',
      '左栏内容\t中栏内容\t右栏内容',
      '左栏续文\t中栏续文\t右栏续文'
    ].join('\n')
    expect(assessDocumentQuality({
      extension: '.pdf',
      markdown: markdownWithoutParserWarnings,
      sourceBytes: 1024
    }).reasons).toEqual(expect.arrayContaining(['formula_dense', 'table_dense', 'complex_layout']))
  })

  it('parses locally and reuses the SHA/version cache', async () => {
    const { root } = await fixture()
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast' as const,
      idempotencyKey: 'parse-one'
    }
    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'parse-two' })
    expect(first.markdown).toContain('# Parsed')
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('invalidates the Unlimited-OCR cache when the observed service identity changes', async () => {
    const { root } = await fixture()
    const bridge = runner('observed OCR output')
    const identities = ['model-a', 'model-b']
    const healthFetch = vi.fn(async () => new Response(JSON.stringify({
      service: 'Unlimited-OCR',
      model: identities.shift()
    }), { status: 200 })) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'ocr-identity-cache'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'ocr-identity-cache-2' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'service=Unlimited-OCR;model=model-a' })
    expect(second).toMatchObject({ cacheHit: false, engineVersion: 'service=Unlimited-OCR;model=model-b' })
    expect(bridge).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('reuses the Unlimited-OCR cache when the URL and observed identity are unchanged', async () => {
    const { root } = await fixture()
    const bridge = runner('stable OCR output')
    const healthFetch = vi.fn(async () => new Response(JSON.stringify({
      service: 'Unlimited-OCR',
      model: 'stable-model'
    }), { status: 200 })) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'stable-ocr-identity-cache'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'stable-ocr-identity-cache-2' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'service=Unlimited-OCR;model=stable-model' })
    expect(second).toMatchObject({ cacheHit: true, engineVersion: 'service=Unlimited-OCR;model=stable-model' })
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('uses a stable unversioned identity when a healthy OCR server reports no metadata', async () => {
    const { root } = await fixture()
    const bridge = runner('unversioned OCR output')
    const healthFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'unversioned-ocr-identity-cache'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'unversioned-ocr-identity-cache-2' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unversioned' })
    expect(second).toMatchObject({ cacheHit: true, engineVersion: 'unlimited-ocr-api-v1-unversioned' })
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('does not reuse an unversioned OCR cache when the current health probe fails', async () => {
    const { root } = await fixture()
    const bridge = runner('OCR output after health failure')
    let healthProbeCount = 0
    const healthFetch = vi.fn(async () => {
      healthProbeCount += 1
      if (healthProbeCount === 1) return new Response('ok', { status: 200 })
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'failed-ocr-health-cache'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'failed-ocr-health-cache-2' })
    const third = await service.parse({ ...request, parseId: 'failed-ocr-health-cache-3' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unversioned' })
    expect(second).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(third).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(bridge).toHaveBeenCalledTimes(3)
    const cacheRoot = join(root, '.workwise', 'cache', 'documents')
    const metadataFiles = await Promise.all((await readdir(cacheRoot)).map((directory) => (
      fileExists(join(cacheRoot, directory, 'workwise-result.json'))
    )))
    expect(metadataFiles.filter(Boolean)).toHaveLength(1)
  }, 15_000)

  it('does not reuse an unversioned OCR cache when the current health identity exceeds its limit', async () => {
    const { root } = await fixture()
    const bridge = runner('OCR output after oversized health identity')
    let healthProbeCount = 0
    const healthFetch = vi.fn(async () => {
      healthProbeCount += 1
      return new Response(healthProbeCount === 1 ? 'ok' : 'x'.repeat(16 * 1024 + 1), { status: 200 })
    }) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'oversized-ocr-health-cache'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'oversized-ocr-health-cache-2' })
    const third = await service.parse({ ...request, parseId: 'oversized-ocr-health-cache-3' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unversioned' })
    expect(second).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(third).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(bridge).toHaveBeenCalledTimes(3)
    const cacheRoot = join(root, '.workwise', 'cache', 'documents')
    const metadataFiles = await Promise.all((await readdir(cacheRoot)).map((directory) => (
      fileExists(join(cacheRoot, directory, 'workwise-result.json'))
    )))
    expect(metadataFiles.filter(Boolean)).toHaveLength(1)
  }, 15_000)

  it('does not cache a partial OCR identity when any advertised field is rejected', async () => {
    const { root } = await fixture()
    const bridge = runner('OCR output after rejected health identity')
    let healthProbeCount = 0
    const healthFetch = vi.fn(async () => {
      healthProbeCount += 1
      return new Response(JSON.stringify(healthProbeCount === 1
        ? { service: 'Unlimited-OCR', model: 'model-a' }
        : { service: 'Unlimited-OCR', model: '/private/rejected-model' }), { status: 200 })
    }) as unknown as typeof fetch
    const service = new DocumentEngineService({
      runner: bridge,
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'rejected-ocr-health-identity'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'rejected-ocr-health-identity-2' })
    const third = await service.parse({ ...request, parseId: 'rejected-ocr-health-identity-3' })

    expect(first).toMatchObject({ cacheHit: false, engineVersion: 'service=Unlimited-OCR;model=model-a' })
    expect(second).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(third).toMatchObject({ cacheHit: false, engineVersion: 'unlimited-ocr-api-v1-unverified' })
    expect(bridge).toHaveBeenCalledTimes(3)
    const cacheRoot = join(root, '.workwise', 'cache', 'documents')
    const metadataFiles = await Promise.all((await readdir(cacheRoot)).map((directory) => (
      fileExists(join(cacheRoot, directory, 'workwise-result.json'))
    )))
    expect(metadataFiles.filter(Boolean)).toHaveLength(1)
  }, 15_000)

  it('continues OCR without caching when the health identity probe times out', async () => {
    vi.useFakeTimers()
    try {
      const { root } = await fixture()
      const bridge = runner('OCR output after health timeout')
      let markProbeStarted!: () => void
      const probeStarted = new Promise<void>((resolve) => {
        markProbeStarted = resolve
      })
      const healthFetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => {
        markProbeStarted()
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })) as unknown as typeof fetch
      const service = new DocumentEngineService({
        runner: bridge,
        unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
      })
      const pending = service.parse({
        workspaceRoot: root,
        relativePath: 'source.pdf',
        mode: 'accurate',
        unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
        idempotencyKey: 'timed-out-ocr-health-cache'
      })

      await probeStarted
      await vi.advanceTimersByTimeAsync(2_001)
      await expect(pending).resolves.toMatchObject({
        cacheHit: false,
        engineVersion: 'unlimited-ocr-api-v1-unverified'
      })
      expect(bridge).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }, 15_000)

  it('rejects a current cache entry written before the document result revision', async () => {
    const { root } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'revision-upgrade')
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast' as const,
      idempotencyKey: 'cache-revision-upgrade'
    }
    await service.parse(request)
    const metadataPath = join(outputDirectory, 'workwise-result.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { revision?: string }
    delete metadata.revision
    await writeFile(metadataPath, JSON.stringify(metadata))

    await expect(service.parse({ ...request, parseId: 'cache-revision-upgrade-retry' }))
      .resolves.toMatchObject({ cacheHit: false })
    expect(bridge).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('backfills PDF switch reasons when reading an older current cache entry', async () => {
    const { root } = await fixture()
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast' as const,
      idempotencyKey: 'cache-switch-reason'
    }
    await service.parse(request)
    const [cacheName] = await readdir(join(root, '.workwise', 'cache', 'documents'))
    const metadataPath = join(root, '.workwise', 'cache', 'documents', cacheName!, 'workwise-result.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      result: { quality: { reasons: string[] }; route: { switchReason?: string[] } }
    }
    delete metadata.result.route.switchReason
    metadata.result.quality.reasons = ['low_text_density']
    await writeFile(metadataPath, JSON.stringify(metadata))

    await expect(service.parse({ ...request, parseId: 'cache-switch-reason-hit' })).resolves.toMatchObject({
      cacheHit: true,
      route: { switchReason: ['low_text_density'] }
    })
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('rejects oversized Markdown from the current cache', async () => {
    const { root } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'oversized-current')
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast' as const,
      idempotencyKey: 'oversized-current-cache'
    }
    await service.parse(request)
    const metadata = JSON.parse(await readFile(join(outputDirectory, 'workwise-result.json'), 'utf8')) as {
      markdownPath: string
    }
    await writeFile(join(root, metadata.markdownPath), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))

    await expect(service.parse({ ...request, parseId: 'oversized-current-cache-hit' }))
      .rejects.toMatchObject({ code: 'resource_limit' })
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('rejects oversized Markdown from a legacy sidecar cache', async () => {
    const { root } = await fixture()
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast' as const,
      idempotencyKey: 'oversized-legacy-cache'
    }
    await service.parse(request)
    const [cacheName] = await readdir(join(root, '.workwise', 'cache', 'documents'))
    const outputDirectory = join(root, '.workwise', 'cache', 'documents', cacheName)
    await rm(join(outputDirectory, 'workwise-result.json'))
    const legacyMarkdownPath = join(outputDirectory, 'document.md')
    await writeFile(legacyMarkdownPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))
    const legacyPayload = JSON.parse(await readFile(join(outputDirectory, '.attempts', (await readdir(join(outputDirectory, '.attempts')))[0]!, 'result.json'), 'utf8')) as {
      markdownPath?: string
    }
    legacyPayload.markdownPath = relative(root, legacyMarkdownPath)
    await writeFile(join(outputDirectory, 'result.json'), JSON.stringify(legacyPayload))

    await expect(service.parse({ ...request, parseId: 'oversized-legacy-cache-hit' }))
      .rejects.toMatchObject({ code: 'resource_limit' })
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('keeps late timed-out parser artifacts away from an immediate retry', async () => {
    const { root } = await fixture()
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      return { promise, resolve }
    }
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const firstWritten = deferred()
    let attempts = 0
    const bridge = vi.fn<DocumentEngineRunner>(async (input) => {
      const attempt = ++attempts
      await mkdir(input.outputDirectory, { recursive: true })
      const markdown = attempt === 1 ? 'late old result' : 'retry result'
      if (attempt === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      const markdownPath = join(input.outputDirectory, 'document.md')
      await writeFile(markdownPath, markdown)
      if (attempt === 1) firstWritten.resolve()
      return {
        ok: true,
        engine: input.engine,
        engineVersion: 'fixture-1',
        markdownPath: relative(input.workspaceRoot, markdownPath),
        warnings: [],
        durationMs: 1
      }
    })
    const service = new DocumentEngineService({ parseTimeoutMs: 100, runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast' as const,
      idempotencyKey: 'late-output-retry'
    }

    // Advance only the first deadline; real disk I/O must not race a 100 ms CI budget.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const timedOut = expect(service.parse(request)).rejects.toMatchObject({ code: 'document_parse_timeout' })
      await firstStarted.promise
      await vi.advanceTimersByTimeAsync(100)
      await timedOut
      const retry = await service.parse({ ...request, parseId: 'late-output-retry-2' })
      releaseFirst.resolve()
      await firstWritten.promise
      expect(retry.markdown).toBe('retry result')
      await expect(service.parse({ ...request, parseId: 'late-output-retry-cache' })).resolves.toMatchObject({
        cacheHit: true,
        markdown: 'retry result'
      })
      expect(bridge).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirst.resolve()
      vi.useRealTimers()
    }
  }, 15_000)

  it('rejects oversized cache metadata before parsing JSON', async () => {
    const { root } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'oversized-metadata')
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast' as const,
      idempotencyKey: 'oversized-cache-metadata'
    }
    await service.parse(request)
    await writeFile(join(outputDirectory, 'workwise-result.json'), Buffer.alloc(1024 * 1024 + 1, 0x61))

    await expect(service.parse({ ...request, parseId: 'oversized-cache-metadata-hit' }))
      .rejects.toMatchObject({ code: 'resource_limit' })
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('ignores cache metadata whose arrays exceed the runtime schema bounds', async () => {
    const { root } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'invalid-array-metadata')
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast' as const,
      idempotencyKey: 'invalid-array-cache-metadata'
    }
    await service.parse(request)
    const metadataPath = join(outputDirectory, 'workwise-result.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      result: { warnings: string[] }
    }
    metadata.result.warnings = Array.from({ length: 1_001 }, () => 'warning')
    await writeFile(metadataPath, JSON.stringify(metadata))

    await expect(service.parse({ ...request, parseId: 'invalid-array-cache-metadata-hit' }))
      .resolves.toMatchObject({ cacheHit: false })
    expect(bridge).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a custom output directory after the source changes', async () => {
    const { root, path } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'shared-output')
    const bridge = runner('first source')
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast' as const,
      idempotencyKey: 'custom-output-source-change'
    }

    const first = await service.parse(request)
    await writeFile(path, '%PDF-1.7\nchanged source\n%%EOF')
    bridge.mockImplementationOnce(runner('second source'))

    const second = await service.parse({ ...request, parseId: 'custom-output-source-change-2' })

    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(false)
    expect(second.markdown).toContain('second source')
    expect(bridge).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('does not permanently cache a degraded high-accuracy result', async () => {
    const { root } = await fixture()
    let mineruAttempts = 0
    const bridge = vi.fn<DocumentEngineRunner>(async (input) => {
      if (input.engine === 'mineru-local') {
        mineruAttempts += 1
        if (mineruAttempts === 1) throw new Error('MinerU temporarily unavailable')
        return runner('accurate result')(input)
      }
      return runner('degraded result')(input)
    })
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate' as const,
      idempotencyKey: 'retry-accurate'
    }

    const degraded = await service.parse(request)
    const recovered = await service.parse({ ...request, parseId: 'retry-accurate-2' })

    expect(degraded).toMatchObject({ engine: 'markitdown', degradedFrom: 'mineru-local', cacheHit: false })
    expect(recovered).toMatchObject({ engine: 'mineru-local', cacheHit: false })
    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual([
      'mineru-local',
      'markitdown',
      'mineru-local'
    ])
  }, 15_000)

  it('ignores an invalid optional Unlimited-OCR URL on MarkItDown-only routes', async () => {
    const { root } = await fixture()
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })

    await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      unlimitedOcrServerUrl: 'not a URL',
      idempotencyKey: 'invalid-ocr-fast'
    })
    await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'auto',
      unlimitedOcrServerUrl: 'not a URL',
      idempotencyKey: 'invalid-ocr-auto'
    })

    const spreadsheet = await officeFixture('.xlsx', {
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>'
    })
    await service.parse({
      workspaceRoot: spreadsheet.root,
      relativePath: 'source.xlsx',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'not a URL',
      idempotencyKey: 'invalid-ocr-office'
    })

    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual([
      'markitdown',
      'markitdown',
      'markitdown'
    ])
  })

  it('only reports Unlimited-OCR as available after a successful health probe', async () => {
    const unreachable = new DocumentEngineService({
      runner: runner(),
      unlimitedOcr: new UnlimitedOcrService({ fetch: vi.fn(async () => { throw new Error('connection refused') }) as unknown as typeof fetch })
    })
    await expect(unreachable.listEngines(undefined, 'http://127.0.0.1:3000')).resolves.toContainEqual(expect.objectContaining({
      id: 'unlimited-ocr-local',
      state: 'error',
      version: 'unlimited-ocr-api-v1-unverified'
    }))

    const reachable = new DocumentEngineService({
      runner: runner(),
      unlimitedOcr: new UnlimitedOcrService({ fetch: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch })
    })
    await expect(reachable.listEngines(undefined, 'http://127.0.0.1:3000')).resolves.toContainEqual(expect.objectContaining({
      id: 'unlimited-ocr-local',
      state: 'available',
      version: 'unlimited-ocr-api-v1-unversioned'
    }))

    await expect(reachable.listEngines(undefined, 'not a URL')).resolves.toContainEqual(expect.objectContaining({
      id: 'unlimited-ocr-local',
      state: 'error',
      version: 'unlimited-ocr-api-v1-unverified'
    }))
  })

  it('surfaces the observed Unlimited-OCR service and model identity', async () => {
    const service = new DocumentEngineService({
      runner: runner(),
      unlimitedOcr: new UnlimitedOcrService({
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: 'Unlimited-OCR',
          version: '1.4.0',
          model: 'PP-StructureV3',
          model_version: '2026.08'
        }), { status: 200 })) as unknown as typeof fetch
      })
    })

    await expect(service.listEngines(undefined, 'http://127.0.0.1:3000')).resolves.toContainEqual(expect.objectContaining({
      id: 'unlimited-ocr-local',
      state: 'available',
      version: 'service=Unlimited-OCR;version=1.4.0;model=PP-StructureV3;model_version=2026.08'
    }))
  })

  it('reports an available OCR server with an oversized health identity as unverified', async () => {
    const service = new DocumentEngineService({
      runner: runner(),
      unlimitedOcr: new UnlimitedOcrService({
        fetch: vi.fn(async () => new Response('x'.repeat(16 * 1024 + 1), {
          status: 200
        })) as unknown as typeof fetch
      })
    })

    await expect(service.listEngines(undefined, 'http://127.0.0.1:3000')).resolves.toContainEqual(expect.objectContaining({
      id: 'unlimited-ocr-local',
      state: 'available',
      version: 'unlimited-ocr-api-v1-unverified'
    }))
  })

  it('does not advertise the unimplemented private MinerU transport as available', async () => {
    const service = new DocumentEngineService({ runner: runner() })

    await expect(service.listEngines('https://mineru.example.test')).resolves.toContainEqual(expect.objectContaining({
      id: 'mineru-private',
      state: 'error',
      message: expect.stringMatching(/transport.*not configured/i)
    }))
  })

  it('falls back to MinerU for an invalid optional OCR URL but rejects explicit Unlimited-OCR selection', async () => {
    const { root } = await fixture()
    const bridge = runner()
    const service = new DocumentEngineService({ runner: bridge })

    await expect(service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'not a URL',
      idempotencyKey: 'invalid-ocr-accurate'
    })).resolves.toMatchObject({
      engine: 'mineru-local',
      route: { requestedMode: 'accurate', selectedEngine: 'mineru-local' }
    })
    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual(['mineru-local'])

    await expect(service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      preferredEngine: 'unlimited-ocr-local',
      idempotencyKey: 'missing-ocr-preferred'
    })).rejects.toMatchObject({
      code: 'document_engine_unavailable',
      message: 'The local Unlimited-OCR server is not configured.'
    })
  })

  it('rejects workspace escape and unsupported formats', async () => {
    const { root } = await fixture('.txt')
    const outside = await mkdtemp(join(tmpdir(), 'workwise-document-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'outside.pdf'), '%PDF-1.7\n%%EOF')
    const service = new DocumentEngineService({ runner: runner() })
    await expect(service.parse({
      workspaceRoot: root,
      relativePath: join(outside, 'outside.pdf'),
      mode: 'fast',
      idempotencyKey: 'escape'
    })).rejects.toMatchObject({ code: 'unsafe_path' })
    await expect(service.parse({
      workspaceRoot: root,
      relativePath: 'source.txt',
      mode: 'fast',
      idempotencyKey: 'format'
    })).rejects.toBeInstanceOf(DocumentEngineError)
  })

  it('never uses a private MinerU endpoint without explicit upload permission', async () => {
    const { root } = await fixture()
    const service = new DocumentEngineService({ runner: runner() })
    await expect(service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      preferredEngine: 'mineru-private',
      idempotencyKey: 'private-denied'
    })).rejects.toMatchObject({ code: 'document_upload_not_allowed' })
  })

  it('cancels an active local parse', async () => {
    const { root } = await fixture()
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const service = new DocumentEngineService({
      runner: async (input) => new Promise((resolve, reject) => {
        started()
        if (input.signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        void resolve
      })
    })
    const pending = service.parse({
      parseId: 'cancel-me',
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'cancel-me'
    })
    await didStart
    expect(service.cancel('cancel-me')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'document_parse_cancelled' })
  })

  it('cancels the Unlimited-OCR identity probe with the document parse', async () => {
    const { root } = await fixture()
    let healthSignal: AbortSignal | undefined
    let releaseHealth = (): void => undefined
    const healthFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve) => {
      healthSignal = init?.signal as AbortSignal
      releaseHealth = () => resolve(new Response('ok', { status: 200 }))
    })) as unknown as typeof fetch
    const requestController = new AbortController()
    const service = new DocumentEngineService({
      runner: runner(),
      unlimitedOcr: new UnlimitedOcrService({ fetch: healthFetch })
    })
    const pending = service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      signal: requestController.signal,
      idempotencyKey: 'cancel-ocr-identity-probe'
    })
    const settled = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(healthFetch).toHaveBeenCalledTimes(1))

    requestController.abort()
    try {
      expect(healthSignal?.aborted).toBe(true)
    } finally {
      releaseHealth()
    }
    await expect(settled).resolves.toMatchObject({ code: 'document_parse_cancelled' })
  })

  it('applies one total deadline even when a custom engine ignores cancellation', async () => {
    const { root } = await fixture()
    let engineSignal: AbortSignal | undefined
    let markEngineStarted = (): void => undefined
    const engineStarted = new Promise<void>((resolve) => { markEngineStarted = resolve })
    vi.useFakeTimers()
    const service = new DocumentEngineService({
      parseTimeoutMs: 30,
      runner: async (input) => {
        engineSignal = input.signal
        markEngineStarted()
        return new Promise<DocumentSidecarResponse>(() => undefined)
      }
    })
    const pending = service.parse({
      parseId: 'deadline-parse',
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'deadline-parse'
    })
    const settled = pending.catch((error: unknown) => error)
    try {
      // The deadline covers validation and hashing as well as the engine. Wait
      // until the engine actually owns the signal before advancing the clock;
      // otherwise full-suite I/O contention can expire 30 ms before the runner
      // starts and make this cancellation assertion timing-dependent.
      await engineStarted
      await vi.advanceTimersByTimeAsync(30)
      await expect(settled).resolves.toMatchObject({ code: 'document_parse_timeout' })
    } finally {
      vi.useRealTimers()
    }
    expect(engineSignal?.aborted).toBe(true)
    expect(service.cancel('deadline-parse')).toBe(false)
  })

  it('does not write the current cache when an engine resolves after the deadline', async () => {
    const { root } = await fixture()
    const outputDirectory = join(root, '.workwise', 'cache', 'late-engine-result')
    const service = new DocumentEngineService({
      parseTimeoutMs: 20,
      runner: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return runner()(input)
      }
    })

    await expect(service.parse({
      parseId: 'late-engine-result',
      workspaceRoot: root,
      relativePath: 'source.pdf',
      outputDirectory: relative(root, outputDirectory),
      mode: 'fast',
      idempotencyKey: 'late-engine-result'
    })).rejects.toMatchObject({ code: 'document_parse_timeout' })

    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect(readFile(join(outputDirectory, 'workwise-result.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('redacts URLs plus macOS and Windows paths, including spaces', () => {
    const message = [
      'failed at /Users/test/Private Documents/client secret.pdf',
      'and C:\\Users\\test\\Private Documents\\token.json',
      'via https://ocr.example.test/jobs/1?token=secret'
    ].join(' ')

    const sanitized = sanitizeDocumentDiagnostic(message)

    expect(sanitized).not.toContain('client secret.pdf')
    expect(sanitized).not.toContain('token.json')
    expect(sanitized).not.toContain('ocr.example.test')
    expect(sanitized).toContain('[path]')
    expect(sanitized).toContain('[url]')
  })

  it('keeps the lightweight result when accurate MinerU parsing fails', async () => {
    const { root } = await fixture()
    const bridge = vi.fn<DocumentEngineRunner>(async (input) => {
      if (input.engine === 'mineru-local') throw new Error('/Users/test/private/model failed')
      return runner('fallback')(input)
    })
    const service = new DocumentEngineService({ runner: bridge })
    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      idempotencyKey: 'fallback'
    })
    expect(result.engine).toBe('markitdown')
    expect(result.degradedFrom).toBe('mineru-local')
    expect(result.quality).toMatchObject({
      status: 'degraded',
      reasons: expect.arrayContaining(['low_text_density', 'engine_fallback'])
    })
    expect(result.warnings.join(' ')).toContain('[path]')
    const cached = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      parseId: 'fallback-cached',
      idempotencyKey: 'fallback'
    })
    expect(cached).toMatchObject({ cacheHit: false, degradedFrom: 'mineru-local' })
    expect(cached.warnings.join(' ')).toContain('[path]')
    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual([
      'mineru-local',
      'markitdown',
      'mineru-local',
      'markitdown'
    ])
  })

  it('uses PDF.js text-layer evidence to map MarkItDown headings back to pages', async () => {
    const { root, path } = await fixture()
    await writeFile(path, minimalPdf('Parsed heading content'))
    const service = new DocumentEngineService({ runner: runner('# Parsed heading content\n\nBody') })
    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'page-map'
    })
    expect(result.headings[0]).toMatchObject({ text: 'Parsed', page: 1 })
    expect(result.references).toContainEqual({ page: 1, blockId: 'heading-1', kind: 'text' })
    expect(result.sourceStructure).toEqual({ pageCount: 1 })
    expect(result.route).toMatchObject({
      requestedMode: 'fast',
      selectedEngine: 'markitdown',
      switchReason: expect.arrayContaining(['low_text_density', 'weak_text_layer'])
    })
  })

  it('maps MarkItDown form-feed page boundaries to bounded PDF references', async () => {
    const { root, path } = await fixture()
    await writeFile(path, twoPagePdf('First page body', 'Second page body'))
    const service = new DocumentEngineService({
      runner: runner('# First page\n\nFirst page body\f# Second page\n\nSecond page body')
    })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'form-feed-page-map'
    })

    expect(result.sourceStructure).toEqual({ pageCount: 2 })
    expect(result.references).toEqual(expect.arrayContaining([
      { page: 1, blockId: 'page-1', kind: 'text' },
      { page: 2, blockId: 'page-2', kind: 'text' }
    ]))
    expect(result.headings).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'First page', page: 1 }),
      expect.objectContaining({ text: 'Second page', page: 2 })
    ]))
  })

  it('does not infer PDF pages when MarkItDown form-feed boundaries do not match the source page count', async () => {
    const { root, path } = await fixture()
    await writeFile(path, twoPagePdf('First page body', 'Second page body'))
    const service = new DocumentEngineService({
      runner: runner('# First page\n\nFirst page body\f# Unexpected extra page\f# Second page\n\nSecond page body')
    })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'mismatched-form-feed-page-map'
    })

    expect(result.sourceStructure).toEqual({ pageCount: 2 })
    expect(result.references).not.toContainEqual(expect.objectContaining({ blockId: 'page-1' }))
    expect(result.references).not.toContainEqual(expect.objectContaining({ blockId: 'page-2' }))
    expect(result.headings.filter((heading) => heading.text !== 'Parsed')).toEqual([])
  })

  it('uses structural MarkItDown form-feed boundaries instead of untrusted page-marker text', async () => {
    const { root, path } = await fixture()
    await writeFile(path, twoPagePdf('First page body', 'Second page body'))
    const service = new DocumentEngineService({
      runner: runner('# First page <!-- page:2 -->\f# Second page')
    })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'form-feed-priority'
    })

    expect(result.references).toContainEqual({ page: 1, blockId: 'page-1', kind: 'text' })
    expect(result.references).toContainEqual({ page: 2, blockId: 'page-2', kind: 'text' })
    expect(result.headings).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'First page <!-- page:2 -->', page: 1 }),
      expect.objectContaining({ text: 'Second page', page: 2 })
    ]))
  })

  it('assigns MarkItDown page provenance to sidecar headings without duplicating them', async () => {
    const { root, path } = await fixture()
    await writeFile(path, twoPagePdf('First page body', 'Second page body'))
    const service = new DocumentEngineService({
      runner: runner(
        '# First page\n\nFirst page body\f# Second page\n\nSecond page body',
        [
          { level: 1, text: 'First page' },
          { level: 1, text: 'Second page' }
        ]
      )
    })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'deduplicate-sidecar-headings'
    })

    expect(result.headings).toEqual([
      { level: 1, text: 'First page', page: 1 },
      { level: 1, text: 'Second page', page: 2 }
    ])
  })

  it('bounds form-feed PDF provenance and reuses its validated cache', async () => {
    const pageCount = 1_001
    const pages = Array.from({ length: pageCount }, (_, index) => `Page ${index + 1}`)
    const { root, path } = await fixture()
    await writeFile(path, pdfWithPages(pages))
    const bridge = runner(pages.join('\f'), [])
    const service = new DocumentEngineService({ runner: bridge })
    const request = {
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast' as const,
      idempotencyKey: 'bounded-page-provenance'
    }

    const first = await service.parse(request)
    const second = await service.parse({ ...request, parseId: 'bounded-page-provenance-cache' })

    expect(first.sourceStructure).toEqual({ pageCount })
    expect(first.references).toHaveLength(1_000)
    expect(first.references.at(-1)).toMatchObject({ page: 1_000, blockId: 'page-1000' })
    expect(second).toMatchObject({ cacheHit: true })
    expect(second.references).toHaveLength(1_000)
    expect(bridge).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('drops parser-provided PDF provenance pages outside the analyzed document', async () => {
    const { root, path } = await fixture()
    await writeFile(path, minimalPdf('Bounded parser provenance'))
    const service = new DocumentEngineService({ runner: async (input) => {
      const output = join(input.outputDirectory, 'document.md')
      await mkdir(input.outputDirectory, { recursive: true })
      await writeFile(output, '# Valid heading\n\nBody')
      return {
        ok: true,
        engine: 'markitdown',
        engineVersion: 'fixture',
        sourceSha256: 'hash',
        markdownPath: relative(input.workspaceRoot, output),
        headings: [
          { level: 1, text: 'Valid heading', page: 1 },
          { level: 1, text: 'Invalid heading', page: 999 }
        ],
        tables: [{ markdown: '| Valid |', page: 999 }],
        references: [{ page: 999, blockId: 'invalid', kind: 'text' }],
        durationMs: 1
      }
    } })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'bounded-parser-provenance'
    })

    expect(result.headings).toEqual([{ level: 1, text: 'Valid heading', page: 1 }])
    expect(result.tables).toEqual([])
    expect(result.references).not.toContainEqual(expect.objectContaining({ page: 999 }))
  })

  it('turns Unlimited-OCR page markers into bounded references and heading pages', async () => {
    const { root, path } = await fixture()
    await writeFile(path, minimalPdf(''))
    const bridge = runner([
      '<!-- page:1 -->',
      '# 第一页标题',
      '第一页正文',
      '<!-- page:2 -->',
      '## 第二页标题',
      '第二页正文',
      '<!-- page:999 -->',
      '# 越界标题'
    ].join('\n\n'))
    const service = new DocumentEngineService({ runner: bridge })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'ocr-page-markers'
    })

    expect(result.headings).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '第一页标题', page: 1 })
    ]))
    expect(result.references).toContainEqual({ page: 1, blockId: 'page-1', kind: 'text' })
    expect(result.references.some((reference) => reference.page === 999)).toBe(false)
  })

  it('preserves worksheet names and slide counts from validated Office packages', async () => {
    const spreadsheet = await officeFixture('.xlsx', {
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="投标&amp;报价"/><sheet name="风险清单"/></sheets></workbook>'
    })
    const spreadsheetResult = await new DocumentEngineService({ runner: runner('# 投标&报价\n\n内容') }).parse({
      workspaceRoot: spreadsheet.root, relativePath: 'source.xlsx', mode: 'fast', idempotencyKey: 'xlsx-structure'
    })
    expect(spreadsheetResult.sourceStructure).toEqual({ worksheets: ['投标&报价', '风险清单'] })

    const presentation = await officeFixture('.pptx', {
      '[Content_Types].xml': '<Types/>',
      'ppt/presentation.xml': '<presentation/>',
      'ppt/slides/slide1.xml': '<slide/>',
      'ppt/slides/slide2.xml': '<slide/>'
    })
    const presentationResult = await new DocumentEngineService({ runner: runner('<!-- Slide number: 1 -->\n内容') }).parse({
      workspaceRoot: presentation.root, relativePath: 'source.pptx', mode: 'fast', idempotencyKey: 'pptx-structure'
    })
    expect(presentationResult.sourceStructure).toEqual({ slideCount: 2 })
  })

  it('keeps low-quality auto parsing on MarkItDown and recommends an explicit high-accuracy retry', async () => {
    const { root } = await fixture()
    const bridge = runner('tiny')
    const service = new DocumentEngineService({ runner: bridge })
    const automatic = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'auto',
      idempotencyKey: 'auto-route'
    })
    expect(automatic).toMatchObject({
      engine: 'markitdown',
      quality: { status: 'degraded', reasons: expect.arrayContaining(['low_text_density', 'scanned_document']) },
      route: {
        requestedMode: 'auto',
        selectedEngine: 'markitdown',
        switchReason: expect.arrayContaining(['low_text_density', 'scanned_document'])
      }
    })
    expect(automatic.warnings.join(' ')).toContain('choose high-accuracy parsing')
    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual(['markitdown'])

    const fastBridge = runner('tiny')
    const fast = new DocumentEngineService({ runner: fastBridge })
    await fast.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'fast',
      idempotencyKey: 'fast-route'
    })
    expect(fastBridge.mock.calls.map(([input]) => input.engine)).toEqual(['markitdown'])
  })

  it('detects complex layout signals through the real document parse path', async () => {
    const { root, path } = await fixture()
    await writeFile(path, minimalPdf('Layout quality fixture'))
    const markdown = [
      '可读正文'.repeat(200),
      '$$ \\frac{a}{b} = \\sum_{i=1}^{n} x_i $$',
      '$$ \\sqrt{x^2 + y^2} $$',
      '| 条款 | 金额 | 说明 |',
      '| --- | --- | --- |',
      '| A | 100 | 跨页 1 |',
      '| B | 200 | 跨页 2 |',
      '| C | 300 | 跨页 3 |',
      '左栏内容\t中栏内容\t右栏内容',
      '左栏续文\t中栏续文\t右栏续文'
    ].join('\n')
    const result = await new DocumentEngineService({ runner: runner(markdown) }).parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'auto',
      idempotencyKey: 'complex-layout-production-path'
    })

    expect(result.quality.reasons).toEqual(expect.arrayContaining([
      'formula_dense',
      'table_dense',
      'complex_layout'
    ]))
    expect(result.route.switchReason).toEqual(expect.arrayContaining([
      'formula_dense',
      'table_dense',
      'complex_layout'
    ]))
  })

  it('prefers configured Unlimited-OCR and falls back to MinerU without losing diagnostics', async () => {
    const { root } = await fixture()
    const accurateBridge = runner('unlimited result')
    const accurateService = new DocumentEngineService({ runner: accurateBridge })
    const accurate = await accurateService.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'unlimited-accurate'
    })
    expect(accurate).toMatchObject({
      engine: 'unlimited-ocr-local',
      quality: { status: 'enhanced' }
    })
    expect(accurateBridge.mock.calls.map(([input]) => input.engine)).toEqual(['unlimited-ocr-local'])

    const fallbackBridge = vi.fn<DocumentEngineRunner>(async (input) => {
      if (input.engine === 'unlimited-ocr-local') throw new Error('/private/model unavailable')
      return runner(input.engine === 'markitdown' ? 'tiny' : 'mineru result')(input)
    })
    const fallbackService = new DocumentEngineService({ runner: fallbackBridge })
    const fallback = await fallbackService.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      outputDirectory: '.workwise/cache/unlimited-fallback',
      idempotencyKey: 'unlimited-fallback'
    })
    expect(fallback.engine).toBe('mineru-local')
    expect(fallback.quality.status).toBe('enhanced')
    expect(fallback.route).toEqual({
      requestedMode: 'accurate',
      selectedEngine: 'mineru-local',
      fallbackFrom: 'unlimited-ocr-local',
      switchReason: ['engine_fallback']
    })
    expect(fallback.degradedFrom).toBeUndefined()
    expect(fallback.warnings.join(' ')).toContain('Unlimited-OCR failed: [path]')
    expect(fallbackBridge.mock.calls.map(([input]) => input.engine)).toEqual([
      'unlimited-ocr-local',
      'mineru-local'
    ])
  })

  it('returns a degraded MarkItDown result when every high-accuracy engine fails', async () => {
    const { root } = await fixture()
    const bridge = vi.fn<DocumentEngineRunner>(async (input) => {
      if (input.engine === 'unlimited-ocr-local') throw new Error('/private/unlimited unavailable')
      if (input.engine === 'mineru-local') throw new Error('/private/mineru unavailable')
      return runner('usable fallback')(input)
    })
    const service = new DocumentEngineService({ runner: bridge })

    const result = await service.parse({
      workspaceRoot: root,
      relativePath: 'source.pdf',
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000',
      idempotencyKey: 'all-accurate-engines-failed'
    })

    expect(result).toMatchObject({
      engine: 'markitdown',
      degradedFrom: 'mineru-local',
      quality: {
        status: 'degraded',
        reasons: expect.arrayContaining(['low_text_density', 'scanned_document', 'engine_fallback'])
      },
      route: {
        requestedMode: 'accurate',
        selectedEngine: 'markitdown',
        fallbackFrom: 'mineru-local'
      }
    })
    expect(result.warnings.join(' ')).toContain('Unlimited-OCR failed: [path]')
    expect(result.warnings.join(' ')).toContain('MinerU failed: [path]')
    expect(bridge.mock.calls.map(([input]) => input.engine)).toEqual([
      'unlimited-ocr-local',
      'mineru-local',
      'markitdown'
    ])
  })
})

async function officeFixture(extension: '.xlsx' | '.pptx', files: Record<string, string>): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-office-structure-'))
  roots.push(root)
  const path = join(root, `source${extension}`)
  const archive = new JSZip()
  Object.entries(files).forEach(([name, contents]) => archive.file(name, contents))
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }))
  return { root, path }
}

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function twoPagePdf(first: string, second: string): Buffer {
  return pdfWithPages([first, second])
}

function pdfWithPages(pages: string[]): Buffer {
  const streams = pages.map((text) => (
    `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  ))
  const fontObject = 3 + pages.length * 2
  const pageObjects = pages.flatMap((_, index) => {
    const pageObject = 3 + index * 2
    const streamObject = pageObject + 1
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${streamObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(streams[index])} >>\nstream\n${streams[index]}\nendstream`
    ]
  })
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    ...pageObjects,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
