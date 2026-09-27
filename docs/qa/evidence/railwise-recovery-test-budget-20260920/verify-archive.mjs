import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--write-manifest', 'Usage: node verify-archive.mjs [--write-manifest]')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = readdirSync(root).filter(file => file !== 'archive-manifest.json').sort().map(file => {
  const bytes = readFileSync(join(root, file))
  const text = bytes.toString('utf8')
  assert(!/\/(?:Users|home)\/[^/\s"']+/.test(text), `Absolute home path in ${file}`)
  assert(!/https:\/\/127\.0\.0\.1:\d+\/private-[a-f0-9]+/.test(text), `Private feed in ${file}`)
  assert(!/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `Potential credential in ${file}`)
  assert(!/https?:\/\/[^\s/:]+:[^\s/@]+@/.test(text), `Credential URL in ${file}`)
  assert(!/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{30,}/.test(text), `Authorization in ${file}`)
  return { file, bytes: bytes.length, sha256: sha(bytes) }
})
const provenance = JSON.parse(readFileSync(join(root, 'source-provenance.json'), 'utf8'))
assert.equal(provenance.entries.length, 6)
for (const entry of provenance.entries) {
  const actual = files.find(item => item.file === entry.file)
  assert(actual, `Missing retained log: ${entry.file}`)
  assert.equal(actual.bytes, entry.archivedBytes)
  assert.equal(actual.sha256, entry.archivedSha256)
  assert(/^[a-f0-9]{64}$/.test(entry.sourceSha256), `Invalid original digest: ${entry.file}`)
}
const manifest = { schemaVersion: 1, productHead: '7d4f454feecb09028007ae9b436a318db6856201', testBudgetCommit: '1f07e929825427481134dc3c12f25e9ca333a3db', excludedSelf: 'archive-manifest.json', fileCount: files.length, files }
const path = join(root, 'archive-manifest.json')
if (process.argv[2] === '--write-manifest') {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'generated', files: files.length, next: 'Run without arguments for read-only verification.' }))
} else {
  const original = readFileSync(path)
  assert.deepEqual(JSON.parse(original), manifest, 'Archive entry set, sizes or hashes changed')
  assert(readFileSync(path).equals(original), 'Read-only verification changed manifest')
  console.log(JSON.stringify({ status: 'passed', readOnly: true, files: files.length, manifestSha256: sha(original) }))
}
