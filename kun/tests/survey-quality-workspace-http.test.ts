import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from '../src/engineering/engineering-service.js'
import { SurveyQualityWorkspaceService } from '../src/engineering/survey-quality-workspace.js'
import { SurveyQualityWorkspacePlanReadV1, SurveyQualityWorkspaceRecordReadV1, SurveyQualityEvidenceV1 } from '../src/contracts/survey-quality-workspace.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { buildHarness } from './http-server-test-harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })

describe('authenticated Survey quality workspace HTTP', () => {
  it('freezes actual EngineeringService output through authenticated reference APIs and never changes draft review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quality-workspace-http-')), runtime = join(root, 'runtime')
    const engineering = new EngineeringService({ rootDir: runtime })
    const quality = new SurveyQualityWorkspaceService({ rootDir: runtime,
      getProject: id => engineering.getProject(id), getManifest: (pid, mid) => engineering.getManifestForProject(pid, mid) })
    cleanup.push(async () => { await engineering.flush(); quality.close(); engineering.close(); await rm(root, { recursive: true, force: true }) })
    const project = engineering.createProject({ name: 'Quality HTTP sample', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'quality-project' })
    const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'quality-dataset', name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-09-01T00:00:00Z,1\nP1,2026-09-02T00:00:00Z,2').toString('base64') })
    const checked = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'quality-validate' })
    const manifest = await engineering.finalize({ projectId: project.id, datasetId: dataset.id, expectedRevision: checked.revision, idempotencyKey: 'quality-finalize', acknowledgeWarnings: true })
    const manifestFile = join(project.workspace, '.workwise', 'deliverables', project.id, manifest.runId, 'manifest.json')
    const original = await readFile(manifestFile)
    const h = buildHarness(); h.runtime.surveyQualityWorkspaceService = quality
    const base = `http://localhost/v1/engineering/projects/${project.id}`
    const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }
    const send = (path: string, method = 'GET', body?: unknown, auth = true) => dispatchRequest(h.router, new Request(base + path, {
      method, headers: auth ? headers : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }))
    const createSpy = vi.spyOn(quality, 'createPlan'), getSpy = vi.spyOn(quality, 'getRecord')
    for (const [method, path] of [['POST', '/quality-plans'], ['GET', '/quality-plans'], ['GET', '/quality-plans/unknown'], ['POST', '/quality-evidence'],
      ['POST', '/quality-records'], ['GET', '/quality-records'], ['GET', '/quality-records/unknown'], ['POST', '/quality-records/unknown/checks'], ['POST', '/quality-records/unknown/verify']]) {
      expect((await send(path!, method!, method === 'POST' ? {} : undefined, false)).status).toBe(401)
    }
    expect(createSpy).not.toHaveBeenCalled(); expect(getSpy).not.toHaveBeenCalled()
    const request = { manifestId: manifest.id, expectedProjectRevision: project.revision, idempotencyKey: 'quality-freeze', requiredEvidence: [{ id: 'report', title: 'Retained report bytes', memberId: 'output-1' }] }
    expect((await send('/quality-plans', 'POST', { ...request, requiredCheckIds: [] })).status).toBe(400)
    const response = await send('/quality-plans', 'POST', request)
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store')
    const plan = SurveyQualityWorkspacePlanReadV1.parse(await response.json())
    expect(plan.artifact.members).toHaveLength(manifest.outputs.length + 1)
    expect(await (await send('/quality-plans', 'POST', request)).json()).toEqual(plan)
    const created = await send('/quality-records', 'POST', { planId: plan.plan.id, idempotencyKey: 'quality-record' })
    expect(created.status).toBe(201)
    const record = SurveyQualityWorkspaceRecordReadV1.parse(await created.json())
    const evidenceResponse = await send('/quality-evidence', 'POST', { artifactId: plan.artifact.id, memberId: 'output-1', idempotencyKey: 'quality-evidence' })
    expect(evidenceResponse.status).toBe(201)
    const evidence = SurveyQualityEvidenceV1.parse(await evidenceResponse.json())
    const path = `/quality-records/${record.record.id}`
    const append = { expectedHeadHash: record.verification.headHash, idempotencyKey: 'quality-check-1', checkId: 'artifact-bytes' }
    for (const injection of [{ actor: { id: 'claimed-person', kind: 'human' } }, { outcome: 'passed' }, { requiredChecks: [] }]) {
      expect((await send(path + '/checks', 'POST', { ...append, ...injection })).status).toBe(400)
    }
    const first = SurveyQualityWorkspaceRecordReadV1.parse(await (await send(path + '/checks', 'POST', append)).json())
    expect((await send(path + '/checks', 'POST', { ...append, idempotencyKey: 'stale-head-key' })).status).toBe(409)
    const second = SurveyQualityWorkspaceRecordReadV1.parse(await (await send(path + '/checks', 'POST', {
      expectedHeadHash: first.verification.headHash, idempotencyKey: 'quality-check-2', checkId: 'evidence:report', evidenceId: evidence.id
    })).json())
    expect(second.events).toHaveLength(2)
    const verification = await send(path + '/verify', 'POST', {})
    expect(verification.status).toBe(200)
    expect(await verification.json()).toMatchObject({ coverageStatus: 'not-evaluated', checkpointTrust: 'local-records-only', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
    expect((await send(path + '/verify', 'POST', { checkpoint: { headHash: second.verification.headHash } })).status).toBe(400)
    expect((await send('/quality-records?limit=1')).status).toBe(200)
    for (const query of ['limit=1e1', 'offset=', 'limit=1&limit=2', 'projectId=other-project', 'limit=0', 'limit=51', 'offset=-1', 'offset=10001', 'limit=01', 'offset=1.5']) {
      for (const collection of ['/quality-plans', '/quality-records']) expect((await send(`${collection}?${query}`)).status).toBe(400)
    }
    expect((await send(`/quality-plans/${plan.plan.id}?limit=1`)).status).toBe(400)
    expect((await send(`${path}?offset=0`)).status).toBe(400)
    for (const [postPath, body] of [['/quality-plans', request], ['/quality-evidence', { artifactId: plan.artifact.id, memberId: 'output-1', idempotencyKey: 'query-evidence' }],
      ['/quality-records', { planId: plan.plan.id, idempotencyKey: 'query-record' }], [path + '/checks', append], [path + '/verify', {}]] as const) {
      expect((await send(`${postPath}?limit=1`, 'POST', body)).status).toBe(400)
    }
    expect((await send('/quality-plans?limit=50&offset=10000')).status).toBe(200)
    const crossProject = await dispatchRequest(h.router, new Request((base + path).replace(project.id, 'other-project'), { headers }))
    expect(crossProject.status).toBe(404); expect(await crossProject.text()).not.toContain(evidence.sha256)
    expect(await readFile(manifestFile)).toEqual(original)
    expect(engineering.getManifestForProject(project.id, manifest.id)!.reviewStatus).toBe('draft')
    await writeFile(join(project.workspace, manifest.outputs[0]!.path), 'changed output')
    const stale = await send(path)
    expect(stale.status).toBe(409); expect(await stale.text()).not.toContain(root)
    expect((await send('/quality-plans', 'POST', request)).status).toBe(409)
  })

  it('authenticates before revealing an unavailable service', async () => {
    const h = buildHarness(), url = 'http://localhost/v1/engineering/projects/p/quality-plans'
    expect((await dispatchRequest(h.router, new Request(url))).status).toBe(401)
    expect((await dispatchRequest(h.router, new Request(url, { headers: { authorization: 'Bearer tok-1' } }))).status).toBe(503)
  })
})
