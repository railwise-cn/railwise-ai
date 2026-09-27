import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyEvidenceReader, type SurveyEvidenceSources } from './survey-evidence-reader.js'
import { buildEngineeringConversationTools } from '../adapters/tool/engineering-conversation-tools.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import type { ToolHostContext } from '../ports/tool-host.js'

it('reads persisted monitoring rows and exact historical receipts without a new calculation or audit write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'survey-evidence-readback-'))
  let now = '2026-09-21T00:00:00.000Z'
  const service = new EngineeringService({ rootDir: join(root, 'runtime'), nowIso: () => now })
  try {
    const db = (service as unknown as { db: Database.Database }).db
    const project = service.createProject({ name: 'Readback', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'readback-project' })
    const imported = await service.importDataset({ projectId: project.id, expectedRevision: 1, idempotencyKey: 'readback-import', name: 'monitoring.csv',
      dataBase64: Buffer.from('monitoringItem,point,time,value,unit\nsettlement,P1,2026-08-01T00:00:00Z,0,mm\nsettlement,P1,2026-08-02T00:00:00Z,5,mm').toString('base64') })
    const dataset = service.validateDataset({ datasetId: imported.id, expectedRevision: imported.revision, idempotencyKey: 'readback-validate' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'readback-analysis' })
    const manifest = await service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: dataset.revision, idempotencyKey: 'readback-finalize', acknowledgeWarnings: true })
    const receipt = service.verifyDeliverable(project.id, manifest.id)
    now = '2026-09-21T00:01:00.000Z'
    const replay = await service.replayMonitoringDeliverable(project.id, manifest.id)
    await service.flush()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = snapshot()
    const calculate = vi.spyOn(service, 'createAnalysis'), verify = vi.spyOn(service, 'verifyDeliverable'), rerun = vi.spyOn(service, 'replayMonitoringDeliverable')
    const reader = new SurveyEvidenceReader({ engineering: service } as unknown as SurveyEvidenceSources)
    const base = { schemaVersion: 1, projectId: project.id, projectRevision: project.revision }
    const scope = { projectId: project.id, workspace: root }
    expect(reader.read({ ...base, kind: 'monitoring-dataset', datasetId: dataset.id, datasetRevision: dataset.revision, sourceFileHash: dataset.sourceFileHash,
      selector: { path: ['observations', 1], identity: { id: dataset.observations[1]!.id } } }, scope)).toMatchObject({ status: 'resolved', value: { value: 5 } })
    expect(reader.read({ ...base, kind: 'monitoring-analysis', analysisId: analysis.id, datasetId: dataset.id, inputHash: analysis.inputHash, algorithmVersion: analysis.algorithmVersion,
      selector: { path: ['results', 0], identity: { monitoringItem: 'settlement', point: 'P1' } } }, scope)).toMatchObject({ status: 'resolved', value: { currentValue: 5 } })
    expect(reader.read({ ...base, kind: 'deliverable-verification', manifestId: manifest.id, checkedAt: receipt.checkedAt }, scope)).toMatchObject({ status: 'resolved', value: receipt })
    expect(reader.read({ ...base, kind: 'monitoring-replay', manifestId: manifest.id, attemptId: replay.attemptId, checkedAt: replay.checkedAt }, scope)).toMatchObject({ status: 'resolved', value: replay })
    expect(reader.read({ ...base, kind: 'deliverable-verification', manifestId: manifest.id, checkedAt: now }, scope)).toMatchObject({ status: 'unavailable', reason: 'not-found' })
    expect(reader.read({ ...base, kind: 'monitoring-replay', manifestId: manifest.id, attemptId: 'missing', checkedAt: replay.checkedAt }, scope)).toMatchObject({ status: 'unavailable', reason: 'not-found' })
    expect(service.readMonitoringDatasetEvidence('other', dataset.id)).toBeNull()
    expect(service.readMonitoringAnalysisEvidence('other', analysis.id)).toBeNull()
    expect(snapshot()).toEqual(before)
    expect(calculate).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(rerun).not.toHaveBeenCalled()

    now = receipt.checkedAt
    verify.mockRestore()
    service.verifyDeliverable(project.id, manifest.id)
    expect(reader.read({ ...base, kind: 'deliverable-verification', manifestId: manifest.id, checkedAt: receipt.checkedAt }, scope)).toMatchObject({ status: 'unavailable', reason: 'record-unavailable-or-integrity-failed' })
  } finally { await service.flush(); service.close(); await rm(root, { recursive: true, force: true }) }
})

it('advertises the real model tool only when allowed and enforces thread project and workspace', async () => {
  const hash = 'a'.repeat(64)
  const thread = { domain: 'engineering', projectId: 'project', workspace: '/workspace' }
  const getRecord = vi.fn(() => ({ id: 'record', projectId: 'project', recordHash: hash, result: { decision: 'not-evaluated' } }))
  const reader = new SurveyEvidenceReader({ engineering: { getProject: () => ({ id: 'project', revision: 1, workspace: '/workspace' }) }, scoring: { getRecord } } as unknown as SurveyEvidenceSources)
  const provider = buildEngineeringConversationTools({ get: async () => thread } as never, () => { throw new Error('no orchestrator actions allowed') }, reader)
  const host = new LocalToolHost({ tools: [...provider.tools] })
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: '/workspace', allowedToolNames: ['survey_read_evidence'], approvalPolicy: 'on-request', abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' }
  const call = { callId: 'read', toolName: 'survey_read_evidence', arguments: { schemaVersion: 1, kind: 'scoring', projectId: 'project', projectRevision: 1, recordId: 'record', recordHash: hash } }
  expect((await host.listTools(context)).map(tool => tool.name)).toEqual(['survey_read_evidence'])
  expect((await host.execute(call, context)).item).toMatchObject({ output: { status: 'resolved', value: { result: { decision: 'not-evaluated' } } } })
  expect((await host.listTools({ ...context, allowedToolNames: [] })).map(tool => tool.name)).not.toContain('survey_read_evidence')
  getRecord.mockClear()
  expect((await host.execute(call, { ...context, workspace: '/other' })).item).toMatchObject({ isError: true })
  thread.projectId = 'other'
  expect((await host.execute(call, context)).item).toMatchObject({ output: { status: 'unavailable', reason: 'binding-mismatch' } })
  thread.domain = 'personal'
  expect((await host.execute(call, context)).item).toMatchObject({ isError: true })
  expect(getRecord).not.toHaveBeenCalled()
})
