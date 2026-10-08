import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SurveyCollaborationError, SurveyCollaborationService } from './survey-collaboration.js'
import type { ProfessionalReportModel } from './survey-professional-report.js'
import { FlowRepository } from '../flow/repository.js'
import { FlowRuntimeService } from '../flow/service.js'
import { buildCoreFlowAdapters } from '../flow/core-adapters.js'
import { buildFlowNodeRegistry } from '../flow/node-registry.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function model(projectName: string): ProfessionalReportModel {
  return {
    title: '控制网专业审查稿', projectName, taskType: '平面控制网', generatedAt: '2026-10-06T00:00:00.000Z',
    reviewStatus: 'unsigned', reportStatus: 'draft', sourceBinding: [],
    tables: [{ id: 'summary', title: '平差统计', columns: [{ key: 'status', label: '计算状态' }, { key: 'count', label: '观测数' }], rows: [{ status: '计算有效', count: 5 }] }],
    notes: ['成果由固定版本的专业审查投影生成。'], signoff: [{ role: '复核', name: '', date: '', signature: '' }]
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-collaboration-service-'))
  const workspace = join(root, 'workspace'); await (await import('node:fs/promises')).mkdir(workspace, { recursive: true })
  const project = { schemaVersion: 1, id: 'project-collaboration', name: '协作审查合成项目', taskType: 'control-network', monitoringType: 'control-network', unit: 'm', signConvention: 'positive', thresholds: {}, reportPeriod: {}, workspace, revision: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' }
  const report = model(project.name), bytes = Buffer.from(JSON.stringify({ model: report })), outputPath = 'professional-review.json'
  await writeFile(join(workspace, outputPath), bytes)
  const manifest = { schemaVersion: 1, id: 'manifest-collaboration', projectId: project.id, runId: 'run-collaboration', inputDatasets: [], analyses: [], charts: [], citations: [], adjustments: [], deformations: [], surveySources: [], outputs: [{ path: outputPath, mediaType: 'application/json', sha256: sha(bytes), sizeBytes: bytes.length }], validation: { valid: true, errors: [], warnings: [] }, reviewStatus: 'draft', runtimeVersion: 'test', createdAt: project.createdAt }
  let contextHash = 'sha256-context-a'
  const engineering = { getProject: () => project, getManifestForProject: () => manifest, verifyDeliverable: () => ({ valid: true }) }
  const context = { snapshot: () => ({ contextHash }) }
  const dbPath = join(root, 'collaboration.sqlite')
  const service = new SurveyCollaborationService(dbPath, engineering as any, context as any, () => '2026-10-06T01:00:00.000Z')
  cleanup.push(async () => { try { service.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { root, workspace, project, manifest, dbPath, engineering, context, service, get contextHash() { return contextHash }, set contextHash(value: string) { contextHash = value } }
}

describe('SurveyCollaborationService', () => {
  it('creates an auditable draft in the workspace and is idempotent', async () => {
    const f = await fixture(); const input = { manifestId: f.manifest.id, expectedProjectRevision: 1, idempotencyKey: 'create-collaboration-1' }
    const first = await f.service.create(f.project.id, input), second = await f.service.create(f.project.id, input)
    expect(second).toEqual(first); expect(first.notesPath.startsWith('.workwise/')).toBe(true); expect(first.designPath.startsWith('.workwise/')).toBe(true)
    expect(await readFile(join(f.workspace, first.notesPath), 'utf8')).toContain('专业复核补充说明')
    expect(await readFile(join(f.workspace, first.designPath), 'utf8')).toContain('"schemaVersion": "v1"')
    await expect(f.service.create(f.project.id, { ...input, expectedProjectRevision: 2 })).rejects.toMatchObject({ reason: 'validation' })
  })

  it('seals edited files, rejects old references, and detects source/context staleness', async () => {
    const f = await fixture(); const draft = await f.service.create(f.project.id, { manifestId: f.manifest.id, expectedProjectRevision: 1, idempotencyKey: 'seal-collaboration-1' })
    const old = { projectId: draft.projectId, draftId: draft.id, revision: draft.revision, contentHash: draft.contentHash }
    await writeFile(join(f.workspace, draft.notesPath), '# 已确认的专业复核意见\n\n闭合差满足项目限差。\n')
    await expect(f.service.check(old)).rejects.toMatchObject({ reason: 'stale' })
    const sealed = await f.service.seal(f.project.id, draft.id, draft.revision)
    expect(sealed.revision).toBe(2); expect(sealed.contentHash).not.toBe(draft.contentHash); await expect(f.service.check(old)).rejects.toMatchObject({ reason: 'stale' })
    f.contextHash = 'sha256-context-b'; await expect(f.service.check({ projectId: sealed.projectId, draftId: sealed.id, revision: sealed.revision, contentHash: sealed.contentHash })).rejects.toMatchObject({ reason: 'stale' })
  })

  it('persists drafts across service restart and completes a real approval-gated Flow export', async () => {
    const f = await fixture(); const draft = await f.service.create(f.project.id, { manifestId: f.manifest.id, expectedProjectRevision: 1, idempotencyKey: 'flow-collaboration-1' })
    const restarted = new SurveyCollaborationService(f.dbPath, f.engineering as any, f.context as any, () => '2026-10-06T01:01:00.000Z')
    expect(restarted.get(f.project.id, draft.id)).toEqual(draft)
    const flowRepo = new FlowRepository(join(f.root, 'flow.sqlite')); const runtime = new FlowRuntimeService(flowRepo, buildFlowNodeRegistry({ survey_drafts: { available: true }, approvals: { available: true } }), buildCoreFlowAdapters(restarted.adapters(flowRepo)))
    const reviewed = await restarted.startReview(f.project.id, draft.id, draft.revision, runtime); expect(reviewed.runId).toBeTruthy(); expect(reviewed.flowId).toBeTruthy()
    await vi.waitFor(() => expect(flowRepo.getRun(reviewed.runId!)?.status).toBe('waiting_approval'))
    const waiting = flowRepo.getRun(reviewed.runId!)!, definition = flowRepo.getVersion(waiting.versionId)!.definition, exportNode = definition.nodes.find(node => node.type === 'railwise.survey_draft_export')!
    const exportAdapter = restarted.adapters(flowRepo).get('railwise.survey_draft_export')!
    await expect(exportAdapter({ run: waiting, definition, node: exportNode, input: waiting.input, signal: new AbortController().signal })).rejects.toMatchObject({ reason: 'approval' })
    await runtime.decide(reviewed.runId!, 'approval', 'approve'); await vi.waitFor(() => expect(flowRepo.getRun(reviewed.runId!)?.status).toBe('succeeded'))
    const run = flowRepo.getRun(reviewed.runId!)!, first = await exportAdapter({ run, definition, node: exportNode, input: run.input, signal: new AbortController().signal })
    if (first.kind !== 'output') throw new Error('Expected export output')
    const receipt = first.output as { files: Array<{ path: string; mediaType: string; sha256: string; sizeBytes: number }> }
    expect(receipt.files.map(file => file.mediaType)).toEqual(expect.arrayContaining(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/svg+xml']))
    expect(receipt.files).toHaveLength(4)
    const bytes = await Promise.all(receipt.files.map(file => readFile(join(f.workspace, file.path))))
    expect(bytes[0]![0]).toBe(0x50); expect((await JSZip.loadAsync(bytes[0]!)).file('word/document.xml')).toBeTruthy()
    expect(bytes[1]!.subarray(0, 4).toString()).toBe('%PDF'); expect((await JSZip.loadAsync(bytes[2]!)).file('xl/workbook.xml')).toBeTruthy(); expect(bytes[3]!.toString('utf8')).toContain('<svg')
    const replay = await exportAdapter({ run, definition, node: exportNode, input: run.input, signal: new AbortController().signal }); expect(replay).toEqual({ kind: 'output', output: receipt })
    await writeFile(join(f.workspace, receipt.files[0]!.path), 'tampered'); await expect(exportAdapter({ run, definition, node: exportNode, input: run.input, signal: new AbortController().signal })).rejects.toMatchObject({ reason: 'integrity' })
    runtime.shutdown(); restarted.close()
  })
})
