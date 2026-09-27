import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert(process.argv.length === 4 && process.argv[2] === '--source-dir', 'Usage: node archive-evidence.mjs --source-dir <retained-local-log-directory>')
const root = dirname(fileURLToPath(import.meta.url))
const sourceDir = process.argv[3]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = [
  ['ci-35502052038-failed', '527b555caa8fa046ffbb97856be9a7d7212f075a6f9fa37fdc040e052e14b0bb'],
  ['ci-35502054402-success', '2e4616fa8a5fe5b08f306b7a24f9f194f712942bf0dfe05978a6dc71479ffeb4'],
  ['completion-gate-independent', '983ba387c47d4d18254bdd251b74cfa3a3109e9a5841520a9820968d6e433c92'],
  ['completion-gate-budget-fixed', 'd7fe88995cc316072ce768b79cacc340c4a9f05bcd2eb7e380b78c43dbb9ad05'],
  ['completion-gate-budget-typecheck', 'ab88ecae7431e42c873a6f9f73f86603bb96042ae5a0bd6236f92877aa8dfb1b'],
  ['completion-gate-budget-lint', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']
]
function scan(text) {
  const patterns = {
    personalPath: /\/(?:Users|home)\/[^/\s"']+/g,
    privateFeed: /https:\/\/127\.0\.0\.1:\d+\/private-[a-f0-9]+/g,
    credential: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    credentialUrl: /https?:\/\/[^\s/:]+:[^\s/@]+@/g,
    authorization: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{30,}/g
  }
  const counts = Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [name, [...text.matchAll(pattern)].length]))
  assert(Object.values(counts).every(count => count === 0), 'Restricted data detected; do not archive')
  return counts
}
function retain(name, bytes) {
  const path = join(root, name)
  if (existsSync(path)) assert(readFileSync(path).equals(bytes), `Existing archive differs: ${name}`)
  else writeFileSync(path, bytes, { flag: 'wx' })
}
const entries = sources.map(([label, expectedSha256]) => {
  const sourceLabel = `railwise-7d4f454-${label}.log`
  const original = readFileSync(join(sourceDir, sourceLabel))
  assert.equal(sha(original), expectedSha256, `Original evidence changed: ${sourceLabel}`)
  const redacted = original.toString('utf8').replace(/\/Users\/[^/\s"']+\/Documents\/WorkWise/g, '<repository>')
    .replace(/\/Users\/[^/\s"']+/g, '<user-home>')
    .replace(/\/home\/[^/\s"']+/g, '<ci-home>')
  const bytes = Buffer.from(redacted)
  const credentialScan = scan(redacted)
  const file = `${label}.txt`
  retain(file, bytes)
  return { file, sourceLabel, sourceBytes: original.length, sourceSha256: sha(original), archivedBytes: bytes.length, archivedSha256: sha(bytes), originalBytesPreserved: bytes.equals(original), transformation: bytes.equals(original) ? 'none' : 'Personal repository/home and CI home prefixes replaced with placeholders; other bytes, including ANSI and timestamps, preserved.', credentialScan }
})
retain('source-provenance.json', Buffer.from(JSON.stringify({ schemaVersion: 1, productHead: '7d4f454feecb09028007ae9b436a318db6856201', testBudgetCommit: '1f07e929825427481134dc3c12f25e9ca333a3db', sourcePathsExcluded: true, entries }, null, 2) + '\n'))
console.log(JSON.stringify({ status: 'archived', logs: entries.length }))
