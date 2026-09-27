import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = dirname(fileURLToPath(import.meta.url))
const copyPath = '/private/tmp/railwise-survey-9cf70d7/evidence/legacy-completion-copy.json'
const copy = JSON.parse(readFileSync(copyPath, 'utf8'))
assert.equal(copy.syntheticOnly, true)
const sha = value => createHash('sha256').update(value).digest('hex')
function fileHashes(root, directory = root) {
  const result = {}
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name)
    const stat = lstatSync(file)
    assert(!stat.isSymbolicLink(), 'Audit input must not contain symlinks')
    if (stat.isDirectory()) Object.assign(result, fileHashes(root, file))
    else { assert(stat.isFile()); result[relative(root, file)] = sha(readFileSync(file)) }
  }
  return result
}
function query(root, database, sql) {
  const file = join(root, database)
  assert(!existsSync(`${file}-wal`) && !existsSync(`${file}-shm`), 'Only closed checkpointed databases may be read as immutable')
  const text = execFileSync('/usr/bin/sqlite3', ['-json', `file:${file}?mode=ro&immutable=1`, sql], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return text.trim() ? JSON.parse(text) : []
}
const sourceBefore = fileHashes(copy.source)
assert.deepEqual(sourceBefore, copy.sourceHashes, 'Original source files changed since the recorded copy')
const targetBefore = fileHashes(copy.target)
const copiedFileChecks = Object.entries(copy.copiedHashes).map(([file, expected]) => ({ file, expected, actual: targetBefore[file], unchanged: targetBefore[file] === expected }))
const databases = Object.keys(copy.copiedHashes).filter(file => file.endsWith('.sqlite3'))
const tables = []
for (const database of databases) {
  const names = query(copy.source, database, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => row.name)
  for (const name of names) {
    assert(/^[a-zA-Z0-9_]+$/.test(name))
    const normalizedRows = root => query(root, database, `SELECT * FROM "${name}"`).map(row => JSON.stringify(row)).sort()
    const sourceRows = normalizedRows(copy.source)
    const targetRows = normalizedRows(copy.target)
    assert.deepEqual(targetRows, sourceRows, `Historical rows changed: ${database}/${name}`)
    tables.push({ database, table: name, sourceRows: sourceRows.length, targetRows: targetRows.length, rowsSha256: sha(JSON.stringify(sourceRows)), unchanged: true })
  }
}
const planRows = query(copy.target, 'engineering/engineering-ai.sqlite3', 'SELECT data_json FROM engineering_ai_plans')
const projectRows = query(copy.target, 'engineering/engineering.sqlite3', 'SELECT data_json FROM engineering_projects')
assert.equal(planRows.length, 1)
assert.equal(projectRows.length, 1)
assert.equal(sha(planRows[0].data_json), copy.historicalPlanJsonSha256)
assert.equal(sha(projectRows[0].data_json), copy.historicalProjectJsonSha256)
const plan = JSON.parse(planRows[0].data_json)
const task = JSON.parse(query(copy.target, 'tasks.sqlite3', 'SELECT data_json FROM task_runs')[0].data_json)
const threadFile = `threads/${copy.threadId}/thread.json`
const thread = JSON.parse(readFileSync(join(copy.target, threadFile), 'utf8'))
const executionTurn = thread.turns.find(turn => turn.id === plan.executionTurnId)
const receipts = query(copy.target, 'engineering/engineering-ai.sqlite3', 'SELECT COUNT(*) AS n FROM engineering_ai_step_evidence')[0].n
const adjustments = query(copy.target, 'engineering/survey.sqlite3', 'SELECT COUNT(*) AS n FROM survey_adjustments')[0].n
assert.equal(plan.id, copy.planId)
assert.equal(plan.projectId, copy.projectId)
assert.equal(plan.status, 'started')
assert.equal(task.id, plan.taskId)
assert.equal(task.status, 'completed')
assert.equal(executionTurn.status, 'completed')
assert.equal(receipts, 0)
assert.equal(adjustments, 0)
assert.deepEqual(fileHashes(copy.source), sourceBefore, 'Read-only audit modified source files')
assert.deepEqual(fileHashes(copy.target), targetBefore, 'Read-only audit modified candidate files')
const report = {
  schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), syntheticOnly: true,
  method: 'SHA-256 of all source files and copied files; all rows of each copied SQLite database compared using mode=ro&immutable=1 after clean application exit',
  source: copy.source, target: copy.target, copyManifestSha256: sha(readFileSync(copyPath)),
  sourceFileCount: Object.keys(sourceBefore).length, sourceHashes: sourceBefore, originalSourceAllFilesUnchanged: true,
  copiedFileChecks, allCopiedFilesByteIdentical: copiedFileChecks.every(item => item.unchanged),
  historicalPlanJsonSha256: sha(planRows[0].data_json), historicalProjectJsonSha256: sha(projectRows[0].data_json),
  historicalState: { projectId: copy.projectId, threadId: copy.threadId, planId: plan.id, taskId: task.id, planStatus: plan.status, taskStatus: task.status, executionTurnStatus: executionTurn.status, stepReceipts: receipts, adjustments },
  databaseTables: tables, allHistoricalDatabaseRowsUnchanged: true,
  auditCreatedNoWalOrShm: true, auditModifiedNoInputFiles: true,
  limitations: 'Synthetic prior-package records only. The UI displays needs_attention as a projection; persisted legacy completed statuses remain unchanged. No real-project migration or new Resume UI acceptance is claimed.'
}
writeFileSync(join(output, 'legacy-preservation-audit.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ status: report.status, sourceFiles: report.sourceFileCount, tables: tables.length, allCopiedFilesByteIdentical: report.allCopiedFilesByteIdentical, historicalState: report.historicalState }))
