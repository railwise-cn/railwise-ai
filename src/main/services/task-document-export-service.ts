import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { canonicalizeContainmentRoot, recheckContainedParent, resolveContainedPath } from './canonical-containment'
import { atomicWriteFile, runSerialized } from './durable-file'

const requestSchema = z.object({
  workspaceRoot: z.string().min(1).max(4096),
  sourcePath: z.string().min(1).max(4096),
  targetPath: z.string().min(1).max(4096),
  format: z.enum(['docx', 'pdf', 'html']),
  expectedHash: z.string().regex(/^[a-f\d]{64}$/),
  idempotencyKey: z.string().min(1).max(256)
}).strict()
export type TaskDocumentExportRequest = z.infer<typeof requestSchema>
export type TaskDocumentExportResult = { ok: true; path: string; format: TaskDocumentExportRequest['format']; sha256: string; size: number }
const lookupSchema = requestSchema.pick({ workspaceRoot: true, sourcePath: true, idempotencyKey: true })
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function readSafe(path: string, root: string): Promise<Buffer> {
  const safe = await resolveContainedPath({ root, target: path, expect: 'file', mustExist: true, rejectFinalLink: true })
  const handle = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if ((await handle.stat()).size > 32 * 1024 * 1024) throw new Error('Task export input exceeds the read limit.')
    return await handle.readFile()
  } finally { await handle.close() }
}
/** Uses the same Markdown renderer as Write, with an explicit task-owned destination. */
export async function exportTaskDocument(raw: TaskDocumentExportRequest): Promise<TaskDocumentExportResult> {
  const input = requestSchema.parse(raw)
  const root = await canonicalizeContainmentRoot(input.workspaceRoot)
  const canonicalInput = (path: string): string => resolve(root, relative(resolve(input.workspaceRoot), resolve(input.workspaceRoot, path)))
  const source = await resolveContainedPath({ root, target: canonicalInput(input.sourcePath), expect: 'file', mustExist: true, rejectFinalLink: true })
  const sourceRelative = relative(root, source).split(sep).join('/')
  if (!/^\.workwise\/delivery-candidates\/[^/]+\/.+\.(?:md|mdx|markdown)$/i.test(sourceRelative)) throw new Error('Only task document candidates can be exported by this bridge.')
  const taskDirectory = sourceRelative.split('/')[2]
  const target = await resolveContainedPath({ root, target: canonicalInput(input.targetPath), expect: 'file', rejectFinalLink: true })
  const targetRelative = relative(root, target).split(sep).join('/')
  if (!targetRelative.startsWith(`.workwise/delivery-candidates/${taskDirectory}/`) && !targetRelative.startsWith(`.workwise/delivery-exports/${taskDirectory}/`)) throw new Error('Task exports must stay in the candidate task directory.')
  if (extname(target).toLowerCase() !== `.${input.format}`) throw new Error('Export format does not match the destination extension.')
  const content = await readSafe(source, root)
  if (hash(content) !== input.expectedHash) throw new Error('Candidate changed before export; reload it before continuing.')
  const operation = hash(`${source}\0${input.idempotencyKey}`)
  const journalRoot = resolve(root, '.workwise', 'delivery-export-operations')
  await resolveContainedPath({ root, target: journalRoot, expect: 'directory', rejectFinalLink: true })
  await mkdir(journalRoot, { recursive: true })
  await recheckContainedParent(root, resolve(journalRoot, 'entry.json'))
  const journalPath = resolve(journalRoot, `${operation}.json`)
  const fingerprint = hash(JSON.stringify({ source, target, format: input.format, expectedHash: input.expectedHash }))
  return runSerialized(`task-export:${target}`, async () => {
    let journal: { fingerprint: string; result: TaskDocumentExportResult; state: 'prepared' | 'done' } | undefined
    try { journal = JSON.parse((await readSafe(journalPath, root)).toString('utf8')) as typeof journal } catch (error) { if (!missing(error)) throw error }
    if (journal) {
      if (journal.fingerprint !== fingerprint) throw new Error('Export idempotency key belongs to another request.')
      let actual: Buffer
      try { actual = await readSafe(target, root) } catch { throw new Error('The prior export outcome requires verification; its receipt is retained.') }
      if (hash(actual) !== journal.result.sha256) throw new Error('The prior export was modified; its receipt is retained.')
      if (journal.state !== 'done') await atomicWriteFile(journalPath, JSON.stringify({ ...journal, state: 'done' }))
      return journal.result
    }
    const { buildWriteExportHtmlDocument, renderWriteExportHtmlToPdf } = await import('./write-export-service')
    let output: Buffer
    if (input.format === 'docx') {
      const { buildDocxFromMarkdown } = await import('./write-docx-service')
      const { resolveExportTemplate } = await import('./write-docx-styles')
      output = await buildDocxFromMarkdown({ sourcePath: source, workspaceRoot: root, strictImages: true, content: content.toString('utf8'), title: source.split(sep).at(-1)!.replace(/\.[^.]+$/, ''), template: resolveExportTemplate(undefined) })
    } else {
      const html = await buildWriteExportHtmlDocument({ sourcePath: source, workspaceRoot: root, strictImages: true, content: content.toString('utf8'), title: source.split(sep).at(-1)! })
      output = input.format === 'pdf' ? await renderWriteExportHtmlToPdf(html, { strictImages: true }) : Buffer.from(html)
    }
    await mkdir(dirname(target), { recursive: true })
    await recheckContainedParent(root, target)
    const result: TaskDocumentExportResult = { ok: true, path: target, format: input.format, sha256: hash(output), size: output.length }
    // Persist the precise bytes' identity before crossing the filesystem boundary.
    await atomicWriteFile(journalPath, JSON.stringify({ fingerprint, state: 'prepared', result }))
    const temp = resolve(dirname(target), `.railwise-export-${operation}.tmp`)
    await atomicWriteFile(temp, output)
    try {
      // A retry after a lost reply can reconcile only identical output. Never
      // overwrite a target changed by another tool or the user.
      await link(temp, target).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await readSafe(target, root)) !== hash(output)) throw error
      })
    } finally { await unlink(temp).catch(() => undefined) }
    await atomicWriteFile(journalPath, JSON.stringify({ fingerprint, state: 'done', result }))
    return result
  })
}
export async function lookupTaskDocumentExport(raw: z.infer<typeof lookupSchema>): Promise<TaskDocumentExportResult | null> {
  const input = lookupSchema.parse(raw)
  const root = await canonicalizeContainmentRoot(input.workspaceRoot)
  const source = await resolveContainedPath({ root, target: resolve(root, relative(resolve(input.workspaceRoot), resolve(input.workspaceRoot, input.sourcePath))), expect: 'file', mustExist: true, rejectFinalLink: true })
  const sourceRelative = relative(root, source).split(sep).join('/')
  if (!/^\.workwise\/delivery-candidates\/[^/]+\/.+\.(?:md|mdx|markdown)$/i.test(sourceRelative)) throw new Error('Only task candidate receipts are available.')
  const operation = hash(`${source}\0${input.idempotencyKey}`)
  const path = resolve(root, '.workwise', 'delivery-export-operations', `${operation}.json`)
  let journal: { result: TaskDocumentExportResult }
  try { journal = JSON.parse((await readSafe(path, root)).toString('utf8')) as typeof journal } catch (error) { if (missing(error)) return null; throw error }
  const target = journal.result?.path
  if (typeof target !== 'string' || !['docx', 'pdf', 'html'].includes(journal.result.format)) throw new Error('Invalid export receipt; verification is required.')
  const taskDirectory = sourceRelative.split('/')[2]
  const targetRelative = relative(root, target).split(sep).join('/')
  if (!targetRelative.startsWith(`.workwise/delivery-candidates/${taskDirectory}/`) && !targetRelative.startsWith(`.workwise/delivery-exports/${taskDirectory}/`)) throw new Error('Export receipt target is outside its task.')
  let actual: Buffer
  try { actual = await readSafe(target, root) } catch (error) { if (missing(error)) return null; throw error }
  if (actual.length !== journal.result.size || hash(actual) !== journal.result.sha256) throw new Error('Export outcome does not match its saved receipt; verification is required.')
  return journal.result
}
export type TaskDocumentExportBridge = { url: string; token: string; close(): Promise<void> }
/** Ephemeral loopback capability, injected only into this app's KUN child. */
export async function startTaskDocumentExportBridge(): Promise<TaskDocumentExportBridge> {
  const token = randomBytes(32).toString('hex')
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    const provided = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: 'Unauthorized.' })); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!['POST', 'GET'].includes(req.method ?? '') || url.pathname !== '/internal/document/export') { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'Not found.' })); return }
    try {
      if (req.method === 'GET') {
        const result = await lookupTaskDocumentExport(Object.fromEntries(url.searchParams) as z.infer<typeof lookupSchema>)
        if (!result) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'No verified export receipt is available.' })); return }
        res.end(JSON.stringify(result)); return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 32_768) throw new Error('Export request exceeds the size limit.')
        chunks.push(Buffer.from(chunk))
      }
      const result = await exportTaskDocument(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TaskDocumentExportRequest)
      res.end(JSON.stringify(result))
    } catch (error) { res.writeHead(409); res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })) }
  })
  server.requestTimeout = 120_000
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done() }) })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind the task export bridge.')
  return { url: `http://127.0.0.1:${address.port}/internal/document/export`, token, close: () => new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections() }) }
}
