import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--write-manifest', 'Usage: node verify-archive.mjs [--write-manifest]')
const writeManifest = process.argv[2] === '--write-manifest'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function walk(folder = '') {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)]).sort()
}
const files = walk().filter(file => file !== 'archive-manifest.json').map(file => {
  const bytes = readFileSync(join(root, file))
  if (!/\.(png|pdf|docx|xlsx)$/.test(file)) {
    const text = bytes.toString('utf8')
    assert(!/\/Users\/[^/\s"']+/.test(text), `Personal path in ${file}`)
    assert(!/https:\/\/127\.0\.0\.1:\d+\/private-[a-f0-9]+/.test(text), `Private feed in ${file}`)
    assert(!/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `Potential credential in ${file}`)
  }
  return { file, bytes: bytes.length, sha256: sha(bytes) }
})
const manifest = { schemaVersion: 1, sourceHead: '53213de739d0b1f3f173f883dcdac21cdc4fdfc9', files, fileCount: files.length, excludedSelf: 'archive-manifest.json', acceptance: 'partial; computation and persistence passed, reviewed package UI failure remains open', scan: 'No personal absolute source path, private loopback feed or credential pattern detected in archived text; screenshots manually reviewed.' }
const manifestPath = join(root, 'archive-manifest.json')
if (writeManifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'generated', files: files.length, manifestSha256: sha(readFileSync(manifestPath)), next: 'Run without arguments for read-only verification.' }))
} else {
  const existingBytes = readFileSync(manifestPath), existing = JSON.parse(existingBytes)
  assert.equal(existing.schemaVersion, manifest.schemaVersion)
  assert.equal(existing.sourceHead, manifest.sourceHead)
  assert.equal(existing.excludedSelf, 'archive-manifest.json')
  assert.equal(existing.fileCount, files.length, 'archive file count differs from retained manifest')
  assert.deepEqual(existing.files, files, 'archive entry set, byte size or hash differs from retained manifest')
  assert(readFileSync(manifestPath).equals(existingBytes), 'manifest changed during read-only verification')
  console.log(JSON.stringify({ status: 'passed', readOnly: true, files: files.length, manifestSha256: sha(existingBytes) }))
}
