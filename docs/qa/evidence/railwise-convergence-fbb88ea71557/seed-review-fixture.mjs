import { createRequire } from 'node:module'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'

const [rootArg, appArg, sourceHead, expectedAsarHash, mode = 'both', runKey = 'first', projectId, threadId] = process.argv.slice(2)
if (!process.versions.electron || !/^[a-f0-9]{40}$/.test(sourceHead ?? '') || !/^[a-f0-9]{64}$/.test(expectedAsarHash ?? '') || !['both', 'suggestion', 'plan'].includes(mode) || !/^[a-z0-9-]{1,48}$/.test(runKey)) {
  throw new Error('Usage: ELECTRON_RUN_AS_NODE=1 <candidate-executable> helper.mjs <isolated-root> <candidate.app> <source-head> <asar-sha256> [both|suggestion|plan] [run-key] [project-id] [thread-id]')
}
const candidateRoot = realpathSync(rootArg)
if (candidateRoot !== resolve(rootArg) || !/^\/private\/tmp\/railwise-survey-[a-zA-Z0-9-]+$/.test(candidateRoot)) throw new Error('Only a canonical isolated candidate root is permitted')
function contained(path, parent = candidateRoot) {
  const canonical = realpathSync(path)
  const child = relative(parent, canonical)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || resolve(parent, child) !== canonical) throw new Error('Path escapes its isolated parent')
  return canonical
}
function rejectSymlinks(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Fixture data must not contain symbolic links')
  if (stat.isDirectory()) for (const entry of readdirSync(path)) rejectSymlinks(join(path, entry))
}
const appPath = contained(appArg, contained(join(candidateRoot, 'Applications')))
if (basename(appPath) !== `RAILWISE AI Candidate ${sourceHead.slice(0, 12)}.app`) throw new Error('Candidate bundle name does not match source head')
contained(process.execPath, appPath)
const archivePath = contained(join(appPath, 'Contents/Resources/app.asar'), appPath)
const priorNoAsar = process.noAsar
let asarSha256
try {
  process.noAsar = true
  asarSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
} finally {
  process.noAsar = priorNoAsar
}
if (asarSha256 !== expectedAsarHash) throw new Error('Installed candidate archive does not match the reviewed artifact')
const moduleRoot = contained(join(appPath, 'Contents/Resources/app.asar.unpacked/kun'), appPath)
const runtimeRoot = contained(join(candidateRoot, 'home/.workwise/runtime'))
const rootDir = contained(join(runtimeRoot, 'engineering'), runtimeRoot)
const evidenceDir = contained(join(candidateRoot, 'evidence'))
rejectSymlinks(rootDir)
const evidencePath = join(evidenceDir, `gui-review-fixture-${runKey}-${mode}.json`)
if (existsSync(evidencePath)) throw new Error('Use a new run key; existing evidence will not be overwritten')
const req = createRequire(join(moduleRoot, 'package.json'))
const Database = req('better-sqlite3')
const load = name => import(pathToFileURL(contained(join(moduleRoot, `dist/${name}.js`), moduleRoot)))
const { EngineeringService } = await load('engineering/engineering-service')
const { SurveyService } = await load('engineering/survey-service')
const { EngineeringContextService } = await load('engineering/engineering-context-service')
const { EngineeringAiRepository } = await load('engineering/engineering-ai-repository')
const { EngineeringAiOrchestrator } = await load('engineering/engineering-ai-orchestrator')
const { ThreadSchema } = await load('contracts/threads')
const opened = []
function openDatabase(path) {
  const db = new Database(contained(path, runtimeRoot), { readonly: true, fileMustExist: true })
  opened.push(db)
  return db
}
try {
  // Complete read-only scope checks before constructing any writable service.
  const projectDb = openDatabase(join(rootDir, 'engineering.sqlite3'))
  const projects = projectDb.prepare('SELECT data_json FROM engineering_projects').all().map(row => JSON.parse(row.data_json))
    .filter(project => projectId ? project.id === projectId : project.name === '审批卡验收（合成数据）')
  if (projects.length !== 1 || !/^审批卡.*（合成数据）$/.test(projects[0].name)) throw new Error('Create or identify exactly one explicitly named synthetic GUI project first')
  const project = projects[0]
  contained(project.workspace)
  rejectSymlinks(project.workspace)
  const index = openDatabase(join(runtimeRoot, 'index.sqlite3'))
  const rows = index.prepare("SELECT id, metadata_path FROM threads WHERE project_id=? AND domain='engineering'").all(project.id).filter(row => !threadId || row.id === threadId)
  if (rows.length !== 1) throw new Error('Exactly one project-scoped thread is required; supply its ID if ambiguous')
  const row = rows[0]
  if (!/^[a-zA-Z0-9_-]+$/.test(row.id) || row.metadata_path !== join(runtimeRoot, 'threads', row.id, 'metadata.jsonl')) throw new Error('Thread metadata path does not match the current store contract')
  const metadataPath = contained(row.metadata_path, runtimeRoot)
  rejectSymlinks(join(runtimeRoot, 'threads', row.id))
  const entries = readFileSync(metadataPath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  const latest = entries.findLast(entry => entry.kind === 'thread_metadata' && entry.thread?.id === row.id)
  const metadata = ThreadSchema.parse(latest?.thread)
  if (metadata.domain !== 'engineering' || metadata.projectId !== project.id || metadata.workspace !== project.workspace || metadata.turns.some(turn => turn.status === 'running')) throw new Error('The real GUI thread must be correctly scoped and idle; quit the candidate before seeding')
  const surveyDb = openDatabase(join(rootDir, 'survey.sqlite3'))
  if (surveyDb.prepare('SELECT COUNT(*) AS count FROM survey_networks WHERE project_id=?').get(project.id).count !== 1) throw new Error('Import exactly one synthetic survey source through the GUI first')
  contained(join(rootDir, 'engineering-ai.sqlite3'), rootDir)
  const engineering = new EngineeringService({ rootDir }); opened.push(engineering)
  const survey = new SurveyService({ rootDir, getProject: id => engineering.getProject(id) }); opened.push(survey)
  const repository = new EngineeringAiRepository({ rootDir }); opened.push(repository)
  const context = new EngineeringContextService(engineering, undefined, survey)
  const fixtureTurnId = `synthetic-gui-review-fixture-not-a-model-turn-${runKey}-${mode}`
  const orchestrator = new EngineeringAiOrchestrator({ engineering, context, repository,
    threadStore: { get: async id => id === row.id ? { ...metadata, turns: [{ id: fixtureTurnId, status: 'running' }] } : null },
    turns: { recordCompletedTurn: async () => { throw new Error('Fixture must not create a model transcript') }, startTurn: async () => { throw new Error('Fixture must not start an execution turn') } },
    runTurn: () => { throw new Error('Fixture must not execute') }
  })
  const before = context.snapshot(project.id)
  const evidence = { fixtureOnly: true, modelCalled: false, transcriptWritten: false, sourceHead, asarSha256, mode, runKey, projectId: project.id, threadId: row.id, projectRevision: project.revision, contextHash: before.contextHash }
  if (mode !== 'plan') {
    const name = project.name === '审批卡已确认（合成数据）' ? '审批卡再次确认（合成数据）' : '审批卡已确认（合成数据）'
    const suggestion = await orchestrator.proposeProjectChange(row.id, fixtureTurnId, { reason: '合成 GUI 验收 fixture：由本地测试 helper 创建，未调用模型。', patch: { name } })
    Object.assign(evidence, { suggestionId: suggestion.id, suggestionStatus: suggestion.status, proposedName: name })
  }
  if (mode !== 'suggestion') {
    const { plan } = await orchestrator.createPlan({ threadId: row.id, projectId: project.id, goal: 'RAILWISE-SYNTHETIC-ACCEPTANCE 控制网平差与成果（合成 GUI 验收样例）', idempotencyKey: `synthetic-gui-reviewed-plan-${runKey}-${mode}` }, { conversationTurnId: fixtureTurnId })
    Object.assign(evidence, { planId: plan.id, planStatus: plan.status, operations: plan.steps.map(step => step.tool) })
  }
  if (context.snapshot(project.id).contextHash !== before.contextHash) throw new Error('Seeding unexpectedly changed engineering evidence or project revision')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(evidence))
} finally {
  for (const resource of opened.reverse()) resource.close()
}
