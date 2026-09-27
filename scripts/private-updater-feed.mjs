import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:https'
import { basename } from 'node:path'
import { stringify } from 'yaml'

/** Real HTTPS file transport. It never implements or substitutes an updater. */
export async function startPrivateUpdaterFeed({ key, cert, zipPath, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid private target version.')
  const filename = basename(zipPath)
  if (!/^WorkWise-Candidate-[a-f0-9]{12}-[\d.]+-mac-(arm64|x64)\.zip$/.test(filename)) {
    throw new Error('Private updater accepts only an isolated candidate ZIP.')
  }
  const file = await stat(zipPath)
  if (!file.isFile()) throw new Error('Private updater ZIP must be a regular file.')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(zipPath)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const manifest = Buffer.from(stringify({ version, files: [{ url: filename, sha512, size: file.size }], path: filename, sha512 }))
  const prefix = `/private-${randomBytes(32).toString('hex')}/`
  const requests = { manifest: 0, zip: 0, rejected: 0, bytesServed: 0 }
  const server = createServer({ key: await readFile(key), cert: await readFile(cert), minVersion: 'TLSv1.2' }, (request, response) => {
    const pathname = new URL(request.url, 'https://127.0.0.1').pathname
    response.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(request.method) || ![`${prefix}latest-mac.yml`, `${prefix}${filename}`].includes(pathname)) {
      requests.rejected += 1
      response.writeHead(404).end()
      return
    }
    if (pathname === `${prefix}latest-mac.yml`) {
      requests.manifest += 1
      response.writeHead(200, { 'Content-Type': 'application/yaml', 'Content-Length': manifest.length })
      response.end(request.method === 'HEAD' ? undefined : manifest)
      return
    }
    requests.zip += 1
    let start = 0; let end = file.size - 1
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range)
      if (!range) { response.writeHead(416).end(); return }
      start = Number(range[1]); end = range[2] ? Number(range[2]) : end
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || end >= file.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); return
      }
      response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`)
    }
    response.writeHead(request.headers.range ? 206 : 200, { 'Content-Type': 'application/zip', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 })
    if (request.method === 'HEAD') { response.end(); return }
    const stream = createReadStream(zipPath, { start, end })
    stream.on('data', chunk => { requests.bytesServed += chunk.length })
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  return {
    url: `https://127.0.0.1:${server.address().port}${prefix}`,
    requests,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
