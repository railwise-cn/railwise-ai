import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { SurveyAdvancedTrialsWorkspaceService } from './survey-advanced-trials-workspace.js'
import { sourceFixedFixture } from './survey-source-fixed-model-test-helpers.js'
import { buildSourceTrialDeclaration, sourceStaticBase, declarationMatchesSource } from '../contracts/survey-source-trial-adapter.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture() {
  const f = await sourceFixedFixture()
  const workspace = new SurveyAdvancedTrialsWorkspaceService({ rootDir: join(f.root, 'trials'), getProject: id => id === f.project.id ? f.project : null,
    getSourceModel: (pid, request) => f.service.getSourceFixedModel(pid, request) })
  cleanup.push(async () => { workspace.close(); await f.service.flush(); f.service.close(); await rm(f.root, { recursive: true, force: true }) })
  const source = workspace.getSourceModel(f.project.id, Buffer.from(JSON.stringify({ adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision })))
  return { ...f, workspace, source }
}
const options = { familyId: 'predeclared-source-observations', alpha: .05, externalScale: .002, externalScaleBasis: 'Independent instrument precision declaration; synthetic verification only.', huberK: 1.345,
  appended: [{ id: 'new-dh', from: 'BM', to: 'P', heightDifference: .1005, sigma: .002, sourceAnchor: 'independent-new-field-row' }] }

describe('source-bound advanced trial persistence', () => {
  it.each(['generalized-w','vce','huber','static-incremental'])('replays %s from the exact source without changing formal results or original observations', async kind => {
    const f = await fixture(), before = JSON.stringify(f.service.getAdjustment(f.adjustment.run.id)), networkBefore = JSON.stringify(f.service.getNetwork(f.network.id))
    const declaration = buildSourceTrialDeclaration(f.source, kind, { ...options, staticBaseFingerprint: createHash('sha256').update(JSON.stringify(sourceStaticBase(f.source))).digest('hex') })
    expect(declarationMatchesSource(f.source, kind, declaration)).toBe(true)
    const request = { kind, acknowledged: true, expectedProjectRevision: 1, idempotencyKey: `source-${kind}`, declarationJson: JSON.stringify(declaration),
      modelBasisStatement: 'Fixed datum leveling; source-declared prior precision, assumptions require field review.', sourceModel: f.source.binding }
    const summary = f.workspace.createTrial(f.project.id, Buffer.from(JSON.stringify(request)))
    const record = f.workspace.getTrial(f.project.id, summary.id)
    expect(record.sourceModel).toEqual(f.source.binding)
    expect(f.workspace.reverifyTrial(f.project.id, summary.id)).toMatchObject({ recordIntegrity: 'verified', recomputed: true })
    expect(f.workspace.createTrial(f.project.id, Buffer.from(JSON.stringify(request)))).toEqual(summary)
    expect(JSON.stringify(f.service.getAdjustment(f.adjustment.run.id))).toBe(before)
    expect(JSON.stringify(f.service.getNetwork(f.network.id))).toBe(networkBefore)
    if (record.kind === 'static-incremental' && record.result.outcome === 'calculated') {
      expect(record.result.updatedFit.aprioriParameterCovariance[0]![0]).toBeCloseTo(1e-6, 14)
      expect(record.result.updatedFit.parameters[0]).toBeCloseTo(.000125, 12)
      expect(record.result.sourceRecordsVerified).toBe(false)
    }
  })
  it('refuses a copied binding with altered equations, covariance or observation anchors', async () => {
    const f = await fixture()
    for (const [kind, alter] of [
      ['generalized-w', (d: any) => { d.designMatrix[0][0] = 2 }],
      ['generalized-w', (d: any) => { d.covariance.matrix[0][0] = 1 }],
      ['vce', (d: any) => { d.observations[0].sourceAnchor = 'substitute' }],
      ['huber', (d: any) => { d.initialParameters[0] = 10 }],
      ['static-incremental', (d: any) => { d.base.observations[0].value = 5 }]
    ] as const) {
      const declaration = buildSourceTrialDeclaration(f.source, kind, { ...options, staticBaseFingerprint: '0'.repeat(64) })
      alter(declaration)
      expect(() => f.workspace.createTrial(f.project.id, Buffer.from(JSON.stringify({ kind, acknowledged: true, expectedProjectRevision: 1,
        idempotencyKey: `tamper-${Math.random()}`, declarationJson: JSON.stringify(declaration), modelBasisStatement: 'Tamper test', sourceModel: f.source.binding })))).toThrow(/integrity/)
    }
  })
  it('refuses stale source identity and never substitutes a latest source', async () => {
    const f = await fixture(), declaration = buildSourceTrialDeclaration(f.source, 'vce', options)
    const raw = (sourceModel: unknown) => Buffer.from(JSON.stringify({ kind: 'vce', acknowledged: true, expectedProjectRevision: 1, idempotencyKey: 'stale-test', declarationJson: JSON.stringify(declaration), modelBasisStatement: 'Exact source', sourceModel }))
    expect(() => f.workspace.createTrial(f.project.id, raw({ ...f.source.binding, sourceSha256: '0'.repeat(64) }))).toThrow(/stale/)
    expect(() => f.workspace.createTrial(f.project.id, raw({ ...f.source.binding, networkRevision: 999 }))).toThrow(/stale/)
    expect(() => f.workspace.getSourceModel('other-project', Buffer.from('{}'))).toThrow(/not-found/)
  })
  it.each(['raw-bytes', 'revision', 'parser'] as const)('blocks reuse of stored trials after %s changes while preserving historical record bytes', async alteration => {
    const f = await fixture(), declaration = buildSourceTrialDeclaration(f.source, 'vce', options)
    const request = { kind: 'vce', acknowledged: true, expectedProjectRevision: 1, idempotencyKey: 'history-source', declarationJson: JSON.stringify(declaration), modelBasisStatement: 'Exact immutable source', sourceModel: f.source.binding }
    const summary = f.workspace.createTrial(f.project.id, Buffer.from(JSON.stringify(request)))
    const trialsDb = new Database(join(f.root, 'trials', 'survey-advanced-trials.sqlite3'))
    try {
      const before = trialsDb.prepare('SELECT * FROM advanced_trials WHERE id = ?').get(summary.id)
      if (alteration === 'raw-bytes') await writeFile(join(f.root, 'sources', f.network.sourceFile!.sha256, 'original'), 'changed source')
      else {
        const sourceDb = new Database(join(f.root, 'survey.sqlite3'))
        try {
          const changed = structuredClone(f.network)
          if (alteration === 'revision') changed.revision += 1
          else changed.sourceFile!.parserVersion = 'changed-parser'
          sourceDb.prepare('UPDATE survey_networks SET data_json = ?, revision = ? WHERE id = ?').run(JSON.stringify(changed), changed.revision, changed.id)
        } finally { sourceDb.close() }
      }
      expect(() => f.workspace.getTrial(f.project.id, summary.id)).toThrow()
      expect(() => f.workspace.reverifyTrial(f.project.id, summary.id)).toThrow()
      expect(() => f.workspace.createTrial(f.project.id, Buffer.from(JSON.stringify(request)))).toThrow()
      expect(f.workspace.listTrials(f.project.id)).toMatchObject({ trials: [], unavailable: [{ id: summary.id, reason: expect.stringMatching(/stale|integrity/) }] })
      expect(trialsDb.prepare('SELECT * FROM advanced_trials WHERE id = ?').get(summary.id)).toEqual(before)
    } finally { trialsDb.close() }
  })
})
