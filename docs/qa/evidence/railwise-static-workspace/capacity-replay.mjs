import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const evidence = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.argv[2] ?? '.')
const { SurveyAdvancedTrialsWorkspaceService } = await import(pathToFileURL(join(checkout, 'kun/dist/engineering/survey-advanced-trials-workspace.js')).href)
const { hashSurveyStaticIncrementalBaseV1 } = await import(pathToFileURL(join(checkout, 'kun/dist/engineering/survey-static-incremental.js')).href)
const model = JSON.parse(readFileSync(join(checkout, 'src/shared/survey-static-incremental-example.ts'), 'utf8').split('export const staticIncrementalExample = ')[1].replace(/ as const\s*$/, ''))
model.base.parameterIds = Array.from({ length: 16 }, (_, i) => `参数${i}`)
const rows = Array.from({ length: 256 }, (_, i) => ({ id: `观测${i}-` + '测'.repeat(80), value: (i % 16) + (i % 3) * .125,
  coefficients: Array.from({ length: 16 }, (_, j) => i % 16 === j ? 1 : 0), aprioriVariance: 1, sourceAnchor: '声明来源-' + '未验真'.repeat(23) }))
model.base.observations = rows.slice(0, 128); model.append.observations = rows.slice(128)
model.expectedBaseFingerprint = hashSurveyStaticIncrementalBaseV1(model.base)
const root = mkdtempSync(join(tmpdir(), 'static-capacity-'))
let clock = Date.parse('2026-09-20T00:00:00Z')
const service = new SurveyAdvancedTrialsWorkspaceService({ rootDir: root, nowIso: () => new Date(clock).toISOString(), clockMs: () => clock,
  getProject: id => ({ id, revision: 1, workspace: join(root, 'workspace') }) })
try {
  const pid = 'static-capacity-project'; let maximumRecordBytes = 0, maximumRequestBytes = 0
  let lastRecord
  for (let i = 0; i < 10; i++) {
    clock += 60001
    const request = { kind: 'static-incremental', acknowledged: true, expectedProjectRevision: 1, idempotencyKey: `static-capacity-${i}`,
      declarationJson: JSON.stringify(model), modelBasisStatement: 'Original synthetic maximum-dimension trial. Caller source declaration is not authenticated provenance.' }
    const raw = Buffer.from(JSON.stringify(request)); maximumRequestBytes = Math.max(maximumRequestBytes, raw.byteLength)
    const summary = service.createTrial(pid, raw)
    lastRecord = service.getTrial(pid, summary.id)
    maximumRecordBytes = Math.max(maximumRecordBytes, Buffer.byteLength(JSON.stringify(lastRecord)))
  }
  clock += 60001
  const start = performance.now(), page = service.listTrials(pid), elapsed = performance.now() - start
  if (page.trials.length !== 10 || page.unavailable.length || page.trials.some(t => t.baseObservationCount !== 128 || t.appendedObservationCount !== 128 || t.observationCount !== 256)) throw new Error('Capacity history failed')
  service.getTrial(pid, page.trials[0].id); service.getTrial(pid, page.trials[1].id)
  let limited = false
  try { service.getTrial(pid, page.trials[2].id) } catch (e) { if (e.reason !== 'rate-limit') throw e; limited = true }
  if (!limited) throw new Error('Expected bounded remaining budget')
  const result = { node: process.version, status: 'pass', observations: 256, base: 128, appended: 128, parameters: 16,
    declarationBytes: Buffer.byteLength(JSON.stringify(model)), maximumRequestBytes, maximumRecordBytes, pageRows: 10,
    modelWorkUnits: 16, pageWorkUnits: 191, workBudget: 240, twoSubsequentDetailsPass: true, thirdDetailRateLimited: true,
    observedPageMilliseconds: elapsed, timingMeaning: 'single local observation; not SLA or benchmark', declarationTrust: 'caller-declared-not-authenticated' }
  writeFileSync(join(evidence, 'capacity-result.json'), JSON.stringify(result, null, 2) + '\n')
  writeFileSync(join(evidence, 'maximum-declaration.json'), JSON.stringify(model, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { service.close(); rmSync(root, { recursive: true, force: true }) }
