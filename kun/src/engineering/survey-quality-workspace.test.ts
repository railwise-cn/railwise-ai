import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { constants, openSync, readSync, renameSync, truncateSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliverableManifestV1 } from '../contracts/engineering.js'
import { SURVEY_QUALITY_WORKSPACE_LIMITS as LIMITS, SurveyQualityWorkspaceRecordReadV1 } from '../contracts/survey-quality-workspace.js'
import { SurveyQualityWorkspaceService } from './survey-quality-workspace.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) }
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quality-workspace-')), workspace = join(root, 'workspace'), runtime = join(root, 'runtime')
  const output = join(workspace, '.workwise', 'deliverables', 'project-a', 'run-a', 'report.txt')
  await mkdir(join(output, '..'), { recursive: true })
  const data = Buffer.from('Immutable project evidence\n')
  await writeFile(output, data)
  const project = { id: 'project-a', revision: 1, workspace }
  const manifest = DeliverableManifestV1.parse({ schemaVersion: 1, id: 'manifest-a', projectId: project.id, runId: 'run-a',
    inputDatasets: [], analyses: [], charts: [], citations: [], adjustments: [], deformations: [], surveySources: [],
    outputs: [{ path: relative(workspace, output), mediaType: 'text/plain', sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length }],
    validation: { valid: true, errors: [], warnings: [] }, reviewStatus: 'draft', runtimeVersion: 'test', createdAt: '2026-09-20T01:00:00.000Z' })
  const manifestPath = join(output, '..', 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  const options = { rootDir: runtime, nowIso: () => '2026-09-20T01:00:00.000Z',
    getProject: (id: string) => id === project.id ? project : id === 'other-project' ? { ...project, id } : null,
    getManifest: (pid: string, id: string) => pid === project.id && id === manifest.id ? manifest : null }
  const services = [new SurveyQualityWorkspaceService(options)]
  cleanup.push(async () => { services.forEach(service => service.close()); await rm(root, { recursive: true, force: true }) })
  const service = services[0]!
  const planRequest = { manifestId: manifest.id, expectedProjectRevision: project.revision, idempotencyKey: 'freeze-plan-1', requiredEvidence: [{ id: 'support', title: 'Supporting material bytes', memberId: 'output-1' }] }
  const plan = () => service.createPlan(project.id, planRequest)
  const reopen = () => { const value = new SurveyQualityWorkspaceService(options); services.push(value); return value }
  const restart = () => { services.splice(0).forEach(value => value.close()); return reopen() }
  const db = () => new Database(join(runtime, 'survey-quality.sqlite3'))
  return { root, runtime, workspace, output, data, project, manifest, manifestPath, service, options, planRequest, plan, reopen, restart, db }
}

describe('Survey quality evidence workspace persistence', () => {
  it('freezes real bytes and check requirements, retains references, appends server-only checks and reopens without granting approval', async () => {
    const f = await fixture(), original = await readFile(f.manifestPath), frozen = f.plan()
    expect(f.plan()).toEqual(frozen)
    expect(frozen.plan.requiredCheckIds).toEqual(['artifact-bytes', 'evidence:support'])
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, requiredEvidence: [] })).toThrow('conflict')
    const created = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'create-record-1' })
    expect(created.verification).toMatchObject({ coverageStatus: 'not-evaluated', reason: 'independent-checkpoint-unavailable', checks: [{ checkId: 'artifact-bytes', status: 'missing' }, { checkId: 'evidence:support', status: 'missing' }] })
    const body = { expectedHeadHash: created.verification.headHash, idempotencyKey: 'check-artifact-1', checkId: 'artifact-bytes' }
    const checked = f.service.appendCheck(f.project.id, created.record.id, body)
    expect(f.service.appendCheck(f.project.id, created.record.id, body)).toEqual(checked)
    expect(checked.events[0]).toMatchObject({ actor: { kind: 'system', id: 'survey-quality-workspace' }, stage: 'workspace-evidence', event: { kind: 'check', outcome: 'passed' } })
    const evidence = f.service.retainEvidence(f.project.id, { artifactId: frozen.artifact.id, memberId: 'output-1', idempotencyKey: 'retain-evidence-1' })
    const complete = f.service.appendCheck(f.project.id, created.record.id, { expectedHeadHash: checked.verification.headHash, idempotencyKey: 'check-evidence-1', checkId: 'evidence:support', evidenceId: evidence.id })
    expect(SurveyQualityWorkspaceRecordReadV1.parse(complete).verification).toMatchObject({ coverageStatus: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
    expect(complete.verification.checks.every(check => check.status === 'passed')).toBe(true)
    expect(f.service.listPlans(f.project.id).plans).toEqual([frozen])
    expect(f.service.listRecords(f.project.id).records).toHaveLength(1)
    expect(await readFile(f.manifestPath)).toEqual(original)
    expect(f.manifest.reviewStatus).toBe('draft')
    expect(f.restart().getRecord(f.project.id, created.record.id)).toEqual(complete)
  })

  it('serializes competing heads across two service connections and rejects changed idempotent arguments', async () => {
    const f = await fixture(), frozen = f.plan(), peer = f.reopen()
    const record = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'create-record-1' })
    const head = record.verification.headHash
    const first = f.service.appendCheck(f.project.id, record.record.id, { expectedHeadHash: head, idempotencyKey: 'append-first-1', checkId: 'artifact-bytes' })
    expect(() => peer.appendCheck(f.project.id, record.record.id, { expectedHeadHash: head, idempotencyKey: 'append-other-1', checkId: 'artifact-bytes' })).toThrow('stale')
    expect(() => peer.appendCheck(f.project.id, record.record.id, { expectedHeadHash: first.verification.headHash, idempotencyKey: 'append-first-1', checkId: 'artifact-bytes' })).toThrow('conflict')
    const second = peer.appendCheck(f.project.id, record.record.id, { expectedHeadHash: first.verification.headHash, idempotencyKey: 'append-second-1', checkId: 'artifact-bytes' })
    expect(second.events.map(event => event.sequence)).toEqual([1, 2])
    expect(second.events[1]!.event.kind).toBe('artifact-check')
  })

  it('reads events and local heads from one snapshot during a peer append', async () => {
    const f = await fixture(), frozen = f.plan(), peer = f.reopen()
    const record = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'snapshot-record-1' })
    const originalPrepare = Database.prototype.prepare
    let appendPending = true
    const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      const statement = originalPrepare.call(this, sql)
      if (sql.startsWith('SELECT * FROM quality_events WHERE')) {
        const originalAll = statement.all.bind(statement) as (...params: unknown[]) => unknown[]
        statement.all = (...params: unknown[]) => {
          const rows = originalAll(...params)
          if (appendPending) {
            appendPending = false
            peer.appendCheck(f.project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: 'snapshot-append-1', checkId: 'artifact-bytes' })
          }
          return rows
        }
      }
      return statement
    })
    try {
      expect(f.service.getRecord(f.project.id, record.record.id).events).toHaveLength(0)
      expect(f.service.getRecord(f.project.id, record.record.id).events).toHaveLength(1)
    } finally { prepare.mockRestore() }
  })

  it('rejects another frozen artifact evidence even when member bytes match', async () => {
    const f = await fixture(), frozen = f.plan()
    const record = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'binding-record-1' })
    const other = f.service.createPlan(f.project.id, { ...f.planRequest, idempotencyKey: 'other-frozen-plan' })
    const wrongMember = f.service.retainEvidence(f.project.id, { artifactId: frozen.artifact.id, memberId: 'manifest', idempotencyKey: 'same-artifact-wrong-member' })
    expect(() => f.service.appendCheck(f.project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: 'reject-wrong-member', checkId: 'evidence:support', evidenceId: wrongMember.id })).toThrow('invalid-reference')
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, idempotencyKey: 'unknown-member-plan', requiredEvidence: [{ id: 'report', title: 'Report', memberId: 'output-999' }] })).toThrow('invalid-reference')
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, idempotencyKey: 'unbound-member-plan', requiredEvidence: [{ id: 'report', title: 'Report' }] })).toThrow()
    for (const memberId of ['output-1', 'manifest']) {
      const evidence = f.service.retainEvidence(f.project.id, { artifactId: other.artifact.id, memberId, idempotencyKey: `retain-other-${memberId}` })
      expect(() => f.service.appendCheck(f.project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: `reject-other-${memberId}`, checkId: 'evidence:support', evidenceId: evidence.id })).toThrow('invalid-reference')
    }
    const otherOutput = join(f.workspace, '.workwise', 'deliverables', f.project.id, 'run-b', 'report.txt')
    const differentBytes = Buffer.from('Evidence for a different delivery')
    const otherManifest = DeliverableManifestV1.parse({ ...f.manifest, id: 'manifest-b', runId: 'run-b',
      outputs: [{ ...f.manifest.outputs[0], path: relative(f.workspace, otherOutput), sha256: createHash('sha256').update(differentBytes).digest('hex'), sizeBytes: differentBytes.length }] })
    await mkdir(join(otherOutput, '..'), { recursive: true })
    await writeFile(otherOutput, differentBytes)
    await writeFile(join(otherOutput, '..', 'manifest.json'), JSON.stringify(otherManifest))
    const originalGetManifest = f.options.getManifest
    f.options.getManifest = (pid, mid) => pid === f.project.id && mid === otherManifest.id ? otherManifest : originalGetManifest(pid, mid)
    const differentArtifact = f.service.createPlan(f.project.id, { ...f.planRequest, manifestId: otherManifest.id, idempotencyKey: 'different-manifest-plan' })
    const differentEvidence = f.service.retainEvidence(f.project.id, { artifactId: differentArtifact.artifact.id, memberId: 'output-1', idempotencyKey: 'different-output-evidence' })
    expect(differentEvidence.sha256).not.toBe(frozen.artifact.members[1]!.sha256)
    expect(() => f.service.appendCheck(f.project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: 'reject-different-output', checkId: 'evidence:support', evidenceId: differentEvidence.id })).toThrow('invalid-reference')
    expect(f.service.getRecord(f.project.id, record.record.id).events).toHaveLength(0)
  })

  it('rejects caller-authored outcomes, actor claims, check lists, cross-project references and missing evidence', async () => {
    const f = await fixture(), frozen = f.plan()
    const record = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'create-record-1' })
    const request = { expectedHeadHash: record.verification.headHash, idempotencyKey: 'append-first-1', checkId: 'artifact-bytes' }
    for (const injected of [{ outcome: 'passed' }, { actor: { kind: 'human', id: 'user' } }, { stage: 'acceptance' }, { requiredChecks: [] }]) {
      expect(() => f.service.appendCheck(f.project.id, record.record.id, { ...request, ...injected })).toThrow()
    }
    expect(() => f.service.appendCheck(f.project.id, record.record.id, { ...request, checkId: 'evidence:support' })).toThrow('invalid-reference')
    expect(() => f.service.appendCheck(f.project.id, record.record.id, { ...request, checkId: 'not-in-plan' })).toThrow('invalid-reference')
    for (const action of [() => f.service.getPlan('other-project', frozen.plan.id), () => f.service.getRecord('other-project', record.record.id),
      () => f.service.retainEvidence('other-project', { artifactId: frozen.artifact.id, memberId: 'output-1', idempotencyKey: 'cross-evidence-1' }),
      () => f.service.createRecord('other-project', { planId: frozen.plan.id, idempotencyKey: 'cross-record-1' })]) expect(action).toThrow('not-found')
    expect(f.service.getRecord(f.project.id, record.record.id).events).toHaveLength(0)
  })

  it('rejects modified originals and does not silently refreeze an idempotent plan', async () => {
    const f = await fixture(), frozen = f.plan()
    await writeFile(f.output, 'changed')
    expect(() => f.plan()).toThrow('stale')
    expect(() => f.service.getPlan(f.project.id, frozen.plan.id)).toThrow('stale')
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, idempotencyKey: 'another-plan-key' })).toThrow('stale')
    const db = f.db()
    try { expect(db.prepare("SELECT count(*) AS count FROM quality_objects WHERE kind='plan'").get()).toEqual({ count: 1 }) } finally { db.close() }
  })

  it('detects changes made between initial copying and the final freeze check', async () => {
    const f = await fixture()
    const read = f.options.getManifest
    let calls = 0
    f.options.getManifest = (pid, mid) => {
      if (++calls === 2) truncateSync(f.output, 0)
      return read(pid, mid)
    }
    expect(() => f.plan()).toThrow('stale')
    const db = f.db()
    try { expect(db.prepare('SELECT count(*) AS count FROM quality_objects').get()).toEqual({ count: 0 }) } finally { db.close() }
    expect(await readdir(join(f.runtime, 'quality-blobs'))).toEqual([])
  })

  it('rejects an atomic path replacement during the bounded read even with identical content', async () => {
    const f = await fixture(), replacement = join(f.root, 'replacement.json')
    await writeFile(replacement, await readFile(f.manifestPath))
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
      const count = actual.readSync(...args)
      renameSync(replacement, f.manifestPath)
      return count
    })
    expect(() => f.plan()).toThrow('integrity')
    expect(f.service.listPlans(f.project.id).plans).toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')('rejects FIFO members without blocking on open', async () => {
    const f = await fixture()
    await rm(f.output)
    execFileSync('mkfifo', [f.output], { timeout: 2000 })
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      // Fail before opening if a regression removes NONBLOCK: this guard
      // avoids hanging the test runner on a real FIFO with no writer.
      if (path === f.output) expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
      return actual.openSync(path, flags, mode)
    })
    try { expect(() => f.plan()).toThrow('limit') }
    finally { vi.mocked(openSync).mockImplementation(actual.openSync) }
    expect(f.service.listPlans(f.project.id).plans).toHaveLength(0)
  })

  it('blocks symlink paths and oversized files before retaining any plan', async () => {
    const f = await fixture()
    await rm(f.output); await writeFile(join(f.root, 'outside.txt'), f.data); await symlink(join(f.root, 'outside.txt'), f.output)
    expect(() => f.plan()).toThrow('integrity')
    await rm(f.output); await writeFile(f.output, f.data); truncateSync(f.output, LIMITS.fileBytes + 1)
    expect(() => f.plan()).toThrow('limit')
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, requiredEvidence: Array.from({ length: 65 }, (_, i) => ({ id: `x${i}`, title: 'x' })) })).toThrow()
    expect(() => f.service.listPlans(f.project.id, 51)).toThrow('limit')
  })

  it('rejects workspace escapes and stale project revisions without changing the frozen plan', async () => {
    const f = await fixture(), frozen = f.plan()
    f.project.revision++
    expect(() => f.service.getPlan(f.project.id, frozen.plan.id)).toThrow('stale')
    expect(() => f.plan()).toThrow('stale')
    f.project.revision--
    f.manifest.outputs[0]!.path = join(f.root, 'outside.txt')
    await writeFile(join(f.root, 'outside.txt'), f.data)
    await writeFile(f.manifestPath, JSON.stringify(f.manifest))
    expect(() => f.service.createPlan(f.project.id, { ...f.planRequest, idempotencyKey: 'escape-plan-key' })).toThrow('integrity')
  })

  it('keeps stale and corrupt history visible without blocking later valid plans and records', async () => {
    const f = await fixture(), old = f.plan()
    const oldRecord = f.service.createRecord(f.project.id, { planId: old.plan.id, idempotencyKey: 'history-old-record' })
    f.project.revision++
    const current = f.service.createPlan(f.project.id, { ...f.planRequest, expectedProjectRevision: f.project.revision, idempotencyKey: 'history-new-plan' })
    const currentRecord = f.service.createRecord(f.project.id, { planId: current.plan.id, idempotencyKey: 'history-new-record' })
    expect(f.service.listPlans(f.project.id)).toEqual({ plans: [current], unavailable: [{ id: old.plan.id, reason: 'stale' }], nextOffset: null })
    expect(f.service.listRecords(f.project.id)).toEqual({ records: [{ record: currentRecord.record, verification: currentRecord.verification }], unavailable: [{ id: oldRecord.record.id, reason: 'stale' }], nextOffset: null })
    expect(() => f.service.getPlan(f.project.id, old.plan.id)).toThrow('stale')
    expect(() => f.service.getRecord(f.project.id, oldRecord.record.id)).toThrow('stale')
    const first = f.service.listPlans(f.project.id, 1)
    expect(first.plans.length + first.unavailable.length).toBe(1)
    expect(first.nextOffset).toBe(1)
    const second = f.service.listPlans(f.project.id, 1, first.nextOffset!)
    expect(second.plans.length + second.unavailable.length).toBe(1)
    expect(second.nextOffset).toBeNull()
    const db = f.db()
    try {
      db.exec('DROP TRIGGER quality_objects_no_update')
      db.prepare('UPDATE quality_objects SET request_hash=? WHERE id=?').run('0'.repeat(64), old.plan.id)
    } finally { db.close() }
    expect(f.service.listPlans(f.project.id)).toMatchObject({ plans: [current], unavailable: [{ id: old.plan.id, reason: 'integrity' }] })
    expect(f.service.listRecords(f.project.id).unavailable).toEqual([{ id: oldRecord.record.id, reason: 'integrity' }])
    expect(f.service.listPlans('other-project')).toEqual({ plans: [], unavailable: [], nextOffset: null })
    expect(f.service.listRecords('other-project')).toEqual({ records: [], unavailable: [], nextOffset: null })
  })

  it('prevents overwrite and detects SQL identity mutation, event truncation and retained-byte corruption on reads', async () => {
    const f = await fixture(), frozen = f.plan(), record = f.service.createRecord(f.project.id, { planId: frozen.plan.id, idempotencyKey: 'create-record-1' })
    f.service.appendCheck(f.project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: 'append-first-1', checkId: 'artifact-bytes' })
    const db = f.db()
    try {
      for (const table of ['quality_objects', 'quality_events', 'quality_heads', 'quality_blobs']) {
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('append-only')
        expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`)).toThrow('append-only')
      }
      expect(() => db.exec("UPDATE quality_objects SET project_id='other-project'")).toThrow('append-only')
      db.exec('DROP TRIGGER quality_events_no_delete; DELETE FROM quality_events')
      expect(() => f.service.getRecord(f.project.id, record.record.id)).toThrow('integrity')
      db.exec('DROP TRIGGER quality_objects_no_update')
      db.prepare("UPDATE quality_objects SET request_hash=? WHERE id=?").run('0'.repeat(64), frozen.plan.id)
      expect(() => f.service.getPlan(f.project.id, frozen.plan.id)).toThrow('integrity')
    } finally { db.close() }
    const f2 = await fixture(), other = f2.plan()
    await writeFile(join(f2.runtime, 'quality-blobs', other.artifact.members[1]!.sha256), 'bad blob')
    expect(() => f2.service.getPlan(f2.project.id, other.plan.id)).toThrow('integrity')
  })
})
