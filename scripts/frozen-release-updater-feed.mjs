import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename } from 'node:path'
import { parse } from 'yaml'

export async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}

export async function validateFrozenFeed({ zipPath, manifestPath, version, arch }) {
  if (version !== '0.5.3' || !['arm64', 'x64'].includes(arch)) throw new Error('Only frozen 0.5.3 macOS packages are supported.')
  const filename = basename(zipPath)
  if (filename !== `WorkWise-${version}-mac-${arch}.zip`) throw new Error('Unexpected public ZIP filename.')
  for (const path of [zipPath, manifestPath]) {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Frozen feed assets must be regular files.')
  }
  const manifestBytes = readFileSync(manifestPath)
  const manifest = parse(manifestBytes.toString('utf8'))
  if (manifest?.version !== version || !Array.isArray(manifest.files)) throw new Error('Frozen update manifest version or files are invalid.')
  const entries = manifest.files.filter(entry => entry.url === filename)
  if (entries.length !== 1 || entries[0].size !== lstatSync(zipPath).size
    || entries[0].sha512 !== await hashFile(zipPath, 'sha512', 'base64')) throw new Error('Frozen update manifest does not match the exact ZIP bytes.')
  if (manifest.files.some(entry => !new RegExp(`^WorkWise-${version.replaceAll('.', '\\.')}\\-mac-(arm64|x64)\\.(zip|dmg)$`).test(entry.url))) {
    throw new Error('Frozen manifest contains an unexpected asset URL.')
  }
  return { filename, size: entries[0].size, manifestBytes, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') }
}

export function parseByteRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false }
  const range = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!range) throw new Error('Invalid byte range.')
  const start = Number(range[1]); const end = range[2] ? Number(range[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || end >= size) throw new Error('Unsatisfiable byte range.')
  return { start, end, partial: true }
}

/** A temporary capability origin; TLS is supplied by the separately owned tunnel. */
export async function startFrozenReleaseFeed(options) {
  const { filename, size, manifestBytes, manifestSha256 } = await validateFrozenFeed(options)
  const prefix = `/private-${randomBytes(32).toString('hex')}/`
  const requests = { manifest: 0, zip: 0, rejected: 0, bytesServed: 0 }
  let closed = false
  const server = createServer((request, response) => {
    // Inspect the raw path so encoded traversal/aliases cannot become valid assets.
    const path = request.url?.split('?')[0]
    response.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(request.method) || ![`${prefix}latest-mac.yml`, `${prefix}${filename}`].includes(path)) {
      requests.rejected += 1; response.writeHead(404).end(); return
    }
    if (path === `${prefix}latest-mac.yml`) {
      requests.manifest += 1
      response.writeHead(200, { 'Content-Type': 'application/yaml', 'Content-Length': manifestBytes.length })
      response.end(request.method === 'HEAD' ? undefined : manifestBytes); return
    }
    let range
    try { range = parseByteRange(request.headers.range, size) }
    catch { requests.rejected += 1; response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return }
    requests.zip += 1
    if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    response.writeHead(range.partial ? 206 : 200, { 'Content-Type': 'application/zip', 'Accept-Ranges': 'bytes', 'Content-Length': range.end - range.start + 1 })
    if (request.method === 'HEAD') { response.end(); return }
    const stream = createReadStream(options.zipPath, range)
    stream.on('data', chunk => { requests.bytesServed += chunk.length })
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, prefix, requests, manifestSha256,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve, reject) => {
        server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
        server.closeAllConnections()
      })
    } }
}
