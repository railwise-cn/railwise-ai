import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { assessmentFixture } from '/private/tmp/railwise-quality-assessment/kun/dist/engineering/survey-quality-assessment-test-helpers.js'

// Development test of the read-only inspector, never packaged GUI evidence.
const here = dirname(fileURLToPath(import.meta.url)), f = await assessmentFixture(2)
const raw = value => Buffer.from(JSON.stringify(value))
const run = extra => spawnSync('python3', [join(here, 'verify_records.py'), '--root', f.runtime, '--project', f.project.id, '--plan', plan.id, ...extra], { encoding: 'utf8' })
let plan
try {
  f.completeRetention()
  f.planRequest.unitMaterials.forEach(u => { u.requirements[0].reference = 'synthetic-linkage' })
  plan = f.assessment.createPlan(f.project.id, raw(f.planRequest))
  const baseline = run(['--capture-baseline']); assert.equal(baseline.status, 0, baseline.stderr)
  const baselinePath = join(f.root, 'baseline.json'); writeFileSync(baselinePath, baseline.stdout)
  const scores = []
  for (const [filename, unit] of [['score-full-link01', f.unitIds[0]], ['score-full-link02', f.unitIds[1]], ['score-veto-link01', f.unitIds[0]]]) {
    const input = JSON.parse(readFileSync(join(here, 'inputs', `${filename}.json`), 'utf8')); input.unitId = unit
    scores.push(f.score(unit, declaration => Object.assign(declaration, input)))
  }
  let key = 0
  const create = unitScores => { f.advance(); return f.assessment.createAssessment(f.project.id, raw({ schemaVersion: 1, acknowledged: true, expectedProjectRevision: 1, idempotencyKey: `verifier-test-${++key}`, assessmentPlanId: plan.id, expectedPlanHash: plan.planHash, unitScores })) }
  create([])
  const full = create(f.unitIds.map((unitId, i) => ({ unitId, scoringRecordId: scores[i].id })))
  create([{ unitId: f.unitIds[0], scoringRecordId: scores[2].id }])
  const exportPath = join(f.root, 'export.json'); writeFileSync(exportPath, JSON.stringify(full))
  const verified = run(['--baseline', baselinePath, '--require-cases', '--export', exportPath]); assert.equal(verified.status, 0, verified.stderr)
  f.append('artifact-bytes')
  const appended = run(['--baseline', baselinePath, '--require-cases']); assert.equal(appended.status, 0, appended.stderr)
  assert(JSON.parse(appended.stdout).records.every(record => record.currentSourceChanged))
  const changed = JSON.parse(baseline.stdout); changed.snapshot.verificationAuditCount++
  writeFileSync(baselinePath, JSON.stringify(changed))
  const rejectBaseline = run(['--baseline', baselinePath, '--require-cases']); assert.equal(rejectBaseline.status, 1)
  writeFileSync(baselinePath, baseline.stdout)
  const forged = structuredClone(full); forged.result.overallLinkage = 'incomplete-declared-linkage'; writeFileSync(exportPath, JSON.stringify(forged))
  const rejectExport = run(['--baseline', baselinePath, '--export', exportPath]); assert.equal(rejectExport.status, 1)
  writeFileSync(join(here, 'verifier-development-test.json'), JSON.stringify({ guiExecuted: false, scope: 'read-only-verifier-development-fixture-only', passed: true, checks: ['baseline snapshot', 'three-case independent linkage and Fraction scoring', 'export equals saved record', 'historical prefix remains independently verifiable after GUI-equivalent append', 'changed baseline rejected', 'changed export rejected'], verified: JSON.parse(verified.stdout), afterAppend: JSON.parse(appended.stdout), rejectedBaseline: JSON.parse(rejectBaseline.stderr), rejectedExport: JSON.parse(rejectExport.stderr) }, null, 2))
  console.log('Inspector development tests: 6 checks passed; GUI not executed.')
} finally { await f.close() }
