import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const checkout = resolve(process.argv[2] ?? process.cwd())
const load = path => import(pathToFileURL(join(checkout, path)).href)
const { SurveyAdvancedTrialsWorkspaceService } = await load('kun/dist/engineering/survey-advanced-trials-workspace.js')
const { maximumNewAdvancedTrialRequest } = await load('kun/dist/engineering/survey-advanced-trials-test-helpers.js')
const results = []
for (const kind of ['huber', 'statistical-family']) {
  const root = mkdtempSync(join(tmpdir(), 'advanced-capacity-'))
  const project = { id: 'capacity-project', revision: 1, workspace: join(root, 'workspace') }
  let clock = Date.parse('2026-09-20T00:00:00Z')
  const service = new SurveyAdvancedTrialsWorkspaceService({ rootDir: root, getProject: id => id === project.id ? project : null, nowIso: () => new Date(clock).toISOString(), clockMs: () => clock })
  try {
    const raw = Buffer.from(JSON.stringify(maximumNewAdvancedTrialRequest(kind)))
    const started = performance.now(), summary = service.createTrial(project.id, raw), created = performance.now()
    const record = service.getTrial(project.id, summary.id), restored = performance.now()
    const bytes = Buffer.byteLength(JSON.stringify(record))
    if (bytes > 4 * 1024 * 1024) throw new Error('Record response exceeds cap')
    results.push({ kind, declaredObservations: summary.observationCount, declaredParameters: summary.parameterCount,
      ...(summary.familyMemberCount ? { declaredFamilyMembers: summary.familyMemberCount } : {}), outcome: summary.outcome,
      states: kind === 'huber' ? record.result.states.length : null, requestBytes: raw.length, recordBytes: bytes,
      createAndInitialReplayMs: created - started, restoreAndReplayMs: restored - created,
      perModelWorkUnits: kind === 'huber' ? 20 : 16, maximumTenRecordPageUnits: kind === 'huber' ? 231 : 191,
      workUnitsPerMinute: 240, recordByteCap: 4 * 1024 * 1024, storageByteCap: 64 * 1024 * 1024 })
  } finally { service.close(); rmSync(root, { recursive: true, force: true }) }
}
console.log(JSON.stringify({ schemaVersion: 1, runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  meaning: 'Synthetic single-machine capacity replay; timings are not production SLOs or SLA evidence.', results }, null, 2))
