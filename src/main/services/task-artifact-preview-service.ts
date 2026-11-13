import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { extname, relative, sep } from 'node:path'
import { z } from 'zod'
import { readVerifiedTaskArtifact, type TaskArtifactReader } from './task-artifact-open'

const TaskFiles = z.object({ artifacts: z.array(z.object({ id: z.string(), sha256: z.string().optional(), validation: z.string() })) })
const MIME: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2' }
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin"

/** Serves only verified artifact IDs. It never exposes a filesystem directory or Runtime credentials. */
export class TaskArtifactPreviewService {
  private server?: Server
  private starting?: Promise<number>
  private port = 0
  private readonly sessions = new Map<string, { taskId: string; expiresAt: number; files: Map<string, { artifactId: string; sha256: string }> }>()

  constructor(private readonly runtimeRequest: TaskArtifactReader) {}

  async open(request: { taskId: string; artifactId: string }): Promise<{ url: string; title: string }> {
    const primary = await readVerifiedTaskArtifact(request, this.runtimeRequest, 32 * 1024 * 1024)
    if (!/\.html?$/i.test(primary.proof.absolutePath)) throw new Error('当前成果不是 HTML 网页。')
    const response = await this.runtimeRequest(`/v1/tasks/${encodeURIComponent(request.taskId)}`, 'GET')
    if (!response.ok) throw new Error('任务成果暂时无法读取。')
    const task = TaskFiles.parse(JSON.parse(response.body))
    const files = new Map<string, { artifactId: string; sha256: string }>()
    const entry = relative(primary.proof.authorizedRoot, primary.proof.absolutePath).split(sep).join('/')
    if (!task.artifacts.some(item => item.id === request.artifactId && item.validation === 'valid' && item.sha256 === primary.proof.sha256)) throw new Error('当前成果已不在任务的有效交付清单中。')
    files.set(entry, { artifactId: request.artifactId, sha256: primary.proof.sha256 })
    for (const artifact of task.artifacts.filter(item => item.validation === 'valid' && item.id !== request.artifactId).slice(0, 100)) {
      // A file from another authorized directory is not a webpage companion asset.
      try {
        const file = await readVerifiedTaskArtifact({ taskId: request.taskId, artifactId: artifact.id }, this.runtimeRequest, 32 * 1024 * 1024)
        if (file.proof.authorizedRoot !== primary.proof.authorizedRoot || !MIME[extname(file.proof.absolutePath).toLowerCase()]) continue
        files.set(relative(primary.proof.authorizedRoot, file.proof.absolutePath).split(sep).join('/'), { artifactId: artifact.id, sha256: file.proof.sha256 })
      } catch { /* Changed companion assets stay unavailable until revalidated. */ }
    }
    for (const [key, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(key)
    while (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value!)
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, { taskId: request.taskId, expiresAt: Date.now() + 60 * 60 * 1000, files })
    const port = await this.start()
    return { url: `http://127.0.0.1:${port}/task-preview/${token}/${entry.split('/').map(encodeURIComponent).join('/')}`, title: entry.split('/').at(-1)! }
  }

  private start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void (async () => {
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('Content-Security-Policy', CSP)
          response.setHeader('X-Content-Type-Options', 'nosniff')
          response.setHeader('Referrer-Policy', 'no-referrer')
          if (!['GET', 'HEAD'].includes(request.method ?? '') || request.headers.host !== `127.0.0.1:${this.port}`) { response.writeHead(403).end(); return }
          const match = /^\/task-preview\/([a-f0-9]{48})\/([^?#]+)(?:\?[^#]*)?$/.exec(request.url ?? '')
          if (!match) { response.writeHead(404).end(); return }
          const session = this.sessions.get(match[1]!)
          if (!session || session.expiresAt <= Date.now()) { response.writeHead(410).end('预览已过期，请重新打开成果。'); return }
          let path: string
          try { path = decodeURIComponent(match[2]!) } catch { response.writeHead(400).end(); return }
          if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) { response.writeHead(403).end(); return }
          const artifact = session.files.get(path)
          if (!artifact) { response.writeHead(404).end('此资源尚未登记为任务成果。'); return }
          const file = await readVerifiedTaskArtifact({ taskId: session.taskId, artifactId: artifact.artifactId }, this.runtimeRequest, 32 * 1024 * 1024)
          if (file.proof.sha256 !== artifact.sha256) { response.writeHead(409).end('成果已更新，请重新打开。'); return }
          response.setHeader('Content-Type', `${MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'}; charset=utf-8`)
          response.writeHead(200).end(request.method === 'HEAD' ? undefined : file.bytes)
        })().catch(() => { if (!response.headersSent) response.writeHead(409); response.end('成果内容或授权证据已变化，请重新核验。') })
      })
      this.server = server
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('无法启动成果预览。')); return }
        this.port = address.port
        server.unref()
        resolve(this.port)
      })
    }).finally(() => { this.starting = undefined })
    return this.starting
  }

  async dispose(): Promise<void> {
    this.sessions.clear()
    const server = this.server
    this.server = undefined
    this.port = 0
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
