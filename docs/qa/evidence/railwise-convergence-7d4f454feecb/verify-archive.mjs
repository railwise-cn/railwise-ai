import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--write-manifest')
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
const manifest = { schemaVersion: 1, sourceHead: '7d4f454feecb09028007ae9b436a318db6856201', files, fileCount: files.length, excludedSelf: 'archive-manifest.json', acceptance: 'partial; XLSX blank numeric cell failure preserved; final package acceptance not passed' }
const path = join(root, 'archive-manifest.json')
if (process.argv[2] === '--write-manifest') {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'generated', files: files.length, manifestSha256: sha(readFileSync(path)) }))
} else {
  const bytes = readFileSync(path)
  assert.deepEqual(JSON.parse(bytes), manifest, 'Archive differs from retained manifest')
  assert(readFileSync(path).equals(bytes), 'Manifest changed during read-only verification')
  console.log(JSON.stringify({ status: 'passed', readOnly: true, files: files.length, manifestSha256: sha(bytes) }))
}
