import { createHash } from 'node:crypto'
import { constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync,
  mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { COLLECTION_LIMITS, SurveyProductionCollection, validateCollection } from './survey-production-collection-contract.mjs'

const digest = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length })
function canonicalFile(path) {
  const absolute = resolve(path), stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not-regular-file')
  // Resolve parent aliases once, including macOS /var and /tmp.
  return join(realpathSync(dirname(absolute)), basename(absolute))
}
function readBounded(path, maximum, expectedSize) {
  const canonical = canonicalFile(path)
  // NONBLOCK prevents a regular-file-to-FIFO race from hanging open().
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > maximum || (expectedSize !== undefined && before.size !== expectedSize)) throw new Error('file-size-invalid')
    const bytes = Buffer.alloc(before.size), extra = Buffer.alloc(1)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset)
      if (!read) throw new Error('file-truncated')
      offset += read
    }
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new Error('file-grew')
    const after = fstatSync(fd), named = lstatSync(canonical)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) throw new Error('file-changed')
    return bytes
  } finally { closeSync(fd) }
}
function noSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(path + suffix) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('snapshot-sidecar-present')
  }
}
function evidenceDirectory(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('evidence-directory-invalid')
  return realpathSync(path)
}
const equal = (a, b) => a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes
const options = { schema: { type: 'boolean' }, contract: { type: 'string' }, 'evidence-dir': { type: 'string' },
  'engineering-db': { type: 'string' }, 'survey-db': { type: 'string' }, python: { type: 'string', default: 'python3' } }
let privateDirectory
try {
  const { values } = parseArgs({ options, strict: true })
  if (values.schema) {
    process.stdout.write(`${JSON.stringify(z.toJSONSchema(SurveyProductionCollection), null, 2)}\n`)
  } else {
    for (const key of ['contract', 'evidence-dir', 'engineering-db', 'survey-db']) if (!values[key]) throw new Error('argument-missing')
    const bytes = readBounded(values.contract, COLLECTION_LIMITS.contractBytes)
    const value = JSON.parse(bytes.toString('utf8'))
    // One canonical representation also rejects duplicate keys hidden by JSON.parse.
    if (bytes.toString('utf8') !== `${JSON.stringify(value, null, 2)}\n`) throw new Error('noncanonical-contract')
    const { contract: c, report } = validateCollection(value)
    // Evidence objects are content addressed. No caller-supplied relative paths or URLs are followed.
    const evidenceRoot = evidenceDirectory(values['evidence-dir'])
    for (const item of c.evidence) {
      if (!equal(digest(readBounded(join(evidenceRoot, item.sha256), COLLECTION_LIMITS.evidenceFileBytes, item.sizeBytes)), item)) throw new Error('evidence-bytes-invalid')
    }
    const databases = { engineering: canonicalFile(values['engineering-db']), survey: canonicalFile(values['survey-db']) }
    if (databases.engineering === databases.survey) throw new Error('snapshots-not-distinct')
    privateDirectory = mkdtempSync(join(tmpdir(), 'survey-collection-read-'))
    chmodSync(privateDirectory, 0o700)
    const copies = {}
    for (const [kind, path] of Object.entries(databases)) {
      noSidecars(path)
      const data = readBounded(path, COLLECTION_LIMITS.snapshotBytes, c.extraction.snapshots[kind].sizeBytes)
      if (!equal(digest(data), c.extraction.snapshots[kind])) throw new Error('snapshot-binding-invalid')
      copies[kind] = join(privateDirectory, `${kind}.sqlite3`)
      writeFileSync(copies[kind], data, { flag: 'wx', mode: 0o600 })
    }
    // SQLite mode=ro can create SHM/WAL; the unchanged collector opens only copies.
    const collector = join(dirname(fileURLToPath(import.meta.url)), 'measure-survey-workflows.py')
    const collectorBytes = readBounded(collector, 4 * 1024 * 1024)
    const result = spawnSync(values.python, [collector, '--engineering-db', copies.engineering,
      '--survey-db', copies.survey, '--cohort', c.cohort,
      '--start', c.period.startInclusive, '--end', c.period.endExclusive],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    if (result.status !== 0 || result.error) throw new Error('existing-collector-failed')
    const metrics = JSON.parse(result.stdout)
    for (const [kind, path] of Object.entries(databases)) {
      noSidecars(path)
      if (!equal(digest(readBounded(path, COLLECTION_LIMITS.snapshotBytes, c.extraction.snapshots[kind].sizeBytes)), c.extraction.snapshots[kind])) throw new Error('snapshot-changed-during-read')
      if (!equal(digest(readBounded(copies[kind], COLLECTION_LIMITS.snapshotBytes)), c.extraction.snapshots[kind])) throw new Error('collector-copy-changed')
    }
    if (!equal(digest(readBounded(collector, 4 * 1024 * 1024)), digest(collectorBytes))) throw new Error('collector-changed')
    report.evidenceByteIntegrity = 'matched-declared-digests'
    report.contractSha256 = createHash('sha256').update(bytes).digest('hex')
    report.existingCollectorSha256 = digest(collectorBytes).sha256
    report.existingMetrics = metrics
    report.databaseReadIsolation = 'byte-verified-private-copies; originals-not-opened-by-sqlite'
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
} catch {
  // Never echo source paths, identifiers, private evidence, parser excerpts or subprocess output.
  process.stderr.write('Collection validation failed: check schema, references, event order, evidence bytes and stopped-app snapshot bindings.\n')
  process.exitCode = 1
} finally {
  if (privateDirectory) rmSync(privateDirectory, { recursive: true, force: true })
}
