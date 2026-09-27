import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
const run = promisify(execFile)
const [artifactId, sizeText, destinationArg, expectedZip] = process.argv.slice(2)
assert(/^\d+$/.test(artifactId) && /^\d+$/.test(sizeText) && /^[a-f0-9]{64}$/.test(expectedZip))
const size = Number(sizeText), destination = resolve(destinationArg)
assert(destination.startsWith('/private/tmp/') && destination.includes('/artifacts/'))
mkdirSync(destination, { recursive: true, mode: 0o700 })
const endpoint = `repos/wangjiawei508/WorkWise/actions/artifacts/${artifactId}/zip`
async function range(start, end) {
  const result = await run('gh', ['api', '-H', `Range: bytes=${start}-${end}`, endpoint], { encoding: 'buffer', maxBuffer: end - start + 65536, timeout: 180000 })
  assert.equal(result.stdout.length, end - start + 1, 'Range response length mismatch')
  return result.stdout
}
const tail = await range(Math.max(0, size - 65536), size - 1), eocd = tail.lastIndexOf(Buffer.from([80,75,5,6]))
assert(eocd >= 0)
const directorySize = tail.readUInt32LE(eocd + 12), directoryOffset = tail.readUInt32LE(eocd + 16)
assert(directoryOffset !== 0xffffffff && directorySize < 1024 * 1024, 'Unexpected ZIP64 or large central directory')
const directory = await range(directoryOffset, directoryOffset + directorySize - 1), entries = []
for (let offset = 0; offset < directory.length;) {
  assert.equal(directory.readUInt32LE(offset), 0x02014b50)
  const nameLength = directory.readUInt16LE(offset + 28), extraLength = directory.readUInt16LE(offset + 30), commentLength = directory.readUInt16LE(offset + 32)
  entries.push({ name: directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), method: directory.readUInt16LE(offset + 10), compressed: directory.readUInt32LE(offset + 20), uncompressed: directory.readUInt32LE(offset + 24), offset: directory.readUInt32LE(offset + 42) })
  offset += 46 + nameLength + extraLength + commentLength
}
const targets = entries.filter(e => e.name.endsWith('-mac-arm64.zip'))
assert.equal(targets.length, 1)
const target = targets[0]
assert([0,8].includes(target.method) && target.compressed > 0 && target.compressed < 1024 * 1024 * 1024)
const local = await range(target.offset, target.offset + 29)
assert.equal(local.readUInt32LE(0), 0x04034b50)
const start = target.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
const chunksDirectory = join(destination, `.range-${artifactId}`)
mkdirSync(chunksDirectory, { recursive: true, mode: 0o700 })
const chunkSize = 2 * 1024 * 1024, count = Math.ceil(target.compressed / chunkSize)
let cursor = 0, completed = 0
console.log(JSON.stringify({ phase: 'download-target-entry', target, outerArtifactSize: size, savedDownloadBytes: size - target.compressed, chunks: count }))
async function worker() {
  while (cursor < count) {
    const i = cursor++, length = Math.min(chunkSize, target.compressed - i * chunkSize), path = join(chunksDirectory, String(i))
    if (existsSync(path)) assert.equal(readFileSync(path).length, length)
    else {
      let bytes, failure
      for (let attempt = 0; attempt < 3; attempt++) try { bytes = await range(start + i * chunkSize, start + i * chunkSize + length - 1); break } catch (e) { failure = e }
      if (!bytes) throw failure
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
    }
    completed++
    if (completed % 10 === 0 || completed === count) console.log(JSON.stringify({ phase: 'progress', completed, count }))
  }
}
await Promise.all(Array.from({ length: 32 }, worker))
const compressed = Buffer.concat(Array.from({ length: count }, (_, i) => readFileSync(join(chunksDirectory, String(i)))))
const output = target.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: target.uncompressed })
assert.equal(output.length, target.uncompressed)
assert.equal(createHash('sha256').update(output).digest('hex'), expectedZip, 'Inner target ZIP differs from native updater acceptance report')
const path = join(destination, basename(target.name)); assert(!existsSync(path), 'Never overwrite an existing target ZIP')
writeFileSync(path, output, { flag: 'wx', mode: 0o600 })
writeFileSync(join(destination, 'range-download-receipt.json'), JSON.stringify({ artifactId, outerArtifactSize: size, target, targetZipSha256: expectedZip, path, outcome: 'passed', fullOuterArtifactDownloaded: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ outcome: 'passed', path }))
