import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileAttachmentStore } from '../src/attachments/attachment-store.js'
import { chunkAttachmentText } from '../src/attachments/attachment-chunker.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { FlowDefinitionV1, FlowNodeV1 } from '../src/contracts/flow.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { buildCoreFlowAdapters } from '../src/flow/core-adapters.js'
import { buildRuntimeFlowAdapters } from '../src/flow/runtime-adapters.js'
import { FlowRepository } from '../src/flow/repository.js'
import { FlowRuntimeService } from '../src/flow/service.js'
import { buildFlowNodeRegistry } from '../src/flow/node-registry.js'

const roots: string[] = []
const policy = { timeoutMs: 5_000, retryAttempts: 0, retryBackoffMs: 1, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkWise 0.3.3 tender and Flow acceptance', () => {
  it('retrieves a page-cited clause from a 101-page tender and produces a real bid DOCX without full-document injection', async () => {
    const root = await workspace('tender')
    const store = attachmentStore(root)
    const pdf = syntheticTenderPdf(101)
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(101)
    const attachment = await store.createDocument({
      name: '招标文件-101页.pdf', data: pdf, mimeType: 'application/pdf', kind: 'pdf', workspace: root
    })
    const sections = chunkAttachmentText({
      attachmentId: attachment.id,
      blocks: Array.from({ length: 101 }, (_, index) => ({
        text: index === 86
          ? '第八十七页 专用合同条款：投标保证金金额为人民币伍拾万元，到账截止时间为开标前一工作日。'
          : `第${index + 1}页 招标文件通用条款与项目背景资料。`,
        provenance: { page: index + 1, heading: index === 86 ? '投标保证金' : '通用条款' }
      }))
    })
    await store.replaceSections(attachment.id, sections)
    await store.updateV2(attachment.id, {
      state: 'ready', indexState: 'ready', parser: { engine: 'markitdown', version: 'acceptance', local: true },
      sourceStructure: { pageCount: 101 }, summary: '101 页招标文件，包含合同、资格和报价条款。'
    })

    const results = await store.searchSections(attachment.id, '投标保证金 伍拾万元', { workspace: root }, 5)
    expect(results[0]).toMatchObject({ provenance: { page: 87 } })
    expect(results[0]?.text.replace(/\s+/gu, '')).toContain('伍拾万元')
    const metadata = await store.getV2(attachment.id)
    expect(JSON.stringify(metadata)).not.toContain('伍拾万元')

    const adapters = buildRuntimeFlowAdapters({ model: new SequenceModel([]), defaultModel: 'acceptance' })
    const output = await adapters.get('docx_output')!({
      run: { id: 'run-tender', flowId: 'flow-tender', versionId: 'v1', status: 'running', input: {}, invocationStack: [], startedAt: '', updatedAt: '' },
      definition: { id: 'flow-tender', workspace: root } as FlowDefinitionV1,
      node: node('docx', 'docx_output', { outputPath: '投标文件.docx' }),
      input: `# 投标响应\n\n依据招标文件第 87 页，投标保证金为人民币伍拾万元。`,
      signal: new AbortController().signal
    }) as { kind: 'output'; output: { path: string } }
    const docx = await JSZip.loadAsync(await readFile(output.output.path))
    expect(await docx.file('word/document.xml')!.async('string')).toContain('第 87 页')
  })

  it.each([false, true])('preserves scheduled DOCX delivery and durable approval; legacy archive=%s cannot claim a false success', async (includeLegacyArchive) => {
    const root = await workspace('flow')
    const store = attachmentStore(root)
    const attachment = await store.createDocument({ name: 'tender.pdf', data: syntheticTenderPdf(101), mimeType: 'application/pdf', kind: 'pdf', workspace: root })
    await store.replaceSections(attachment.id, chunkAttachmentText({ attachmentId: attachment.id, blocks: [{ text: '投标保证金为人民币伍拾万元。', provenance: { page: 87 } }] }))
    await store.updateV2(attachment.id, { state: 'ready', indexState: 'ready', summary: 'Tender summary' })

    const databasePath = join(root, 'flow.sqlite')
    const repository = new FlowRepository(databasePath)
    const graph = acceptanceFlow(root, attachment.id, includeLegacyArchive)
    repository.create(withoutPersistenceFields(graph))
    repository.publish(graph.id)
    repository.saveTriggerState({ flowId: graph.id, nodeId: 'schedule', enabled: true, nextRunAt: '2026-07-31T00:00:00.000Z', state: {} })
    const model = new SequenceModel(['ERROR', '已按第 87 页响应：投标保证金为人民币伍拾万元。'])
    const adapters = buildCoreFlowAdapters(new Map(), { model, defaultModel: 'acceptance', attachments: store })
    const first = new FlowRuntimeService(repository, buildFlowNodeRegistry(), adapters)
    expect(await first.tickSchedules(new Date('2026-08-01T00:00:00.000Z'))).toBe(1)
    await vi.waitFor(() => expect(first.history(graph.id)[0]?.status).toBe('waiting_approval'))
    const runId = first.history(graph.id)[0]!.id
    const beforeRestart = first.runDetails(runId)!
    expect(beforeRestart.nodeRuns.filter((item) => item.nodeId === 'agent').map((item) => item.status)).toEqual(['failed', 'succeeded'])
    expect(beforeRestart.nodeRuns.find((item) => item.nodeId === 'retrieve')?.output).toMatchObject({ untrusted: true, results: [{ provenance: { page: 87 } }] })
    expect((await readFile(join(root, 'bid.docx'))).length).toBeGreaterThan(100)
    first.shutdown()

    const reopened = new FlowRepository(databasePath)
    const second = new FlowRuntimeService(reopened, buildFlowNodeRegistry(), adapters)
    await second.decide(runId, 'approval', 'approve', 'QA accepted after restart')
    await vi.waitFor(() => expect(second.runDetails(runId)?.run.status).toBe(includeLegacyArchive ? 'failed' : 'succeeded'))
    expect(second.runDetails(runId)?.nodeRuns.find((item) => item.nodeId === 'approval')?.status).toBe('succeeded')
    if (includeLegacyArchive) {
      expect(second.runDetails(runId)?.nodeRuns.find((item) => item.nodeId === 'archive')).toMatchObject({ status: 'failed', error: expect.stringContaining('归档') })
    } else {
      expect(second.runDetails(runId)?.nodeRuns.some((item) => item.nodeId === 'archive')).toBe(false)
    }
    expect(second.history(graph.id).some((item) => item.id === runId)).toBe(true)
    const exported = JSON.stringify(second.exportRedacted(graph.id))
    expect(exported).not.toContain(root)
    expect(exported).not.toContain('acceptance-secret')
    expect(exported).toContain('${LOCAL_PATH}')
    expect(exported).toContain('${secretToken}')
    second.shutdown()
  })
})

class SequenceModel implements ModelClient {
  readonly provider = 'acceptance'; readonly model = 'acceptance'
  constructor(private readonly outputs: string[]) {}
  async *stream(_request: ModelRequest) {
    const output = this.outputs.shift() ?? ''
    if (output === 'ERROR') throw new Error('transient acceptance failure')
    yield { kind: 'assistant_text_delta' as const, text: output }
    yield { kind: 'completed' as const, stopReason: 'stop' as const }
  }
}

async function workspace(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `workwise-0.3.3-${label}-`)); roots.push(root); return root
}

function attachmentStore(root: string): FileAttachmentStore {
  return new FileAttachmentStore({ rootDir: join(root, '.attachments'), config: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }).attachments })
}

function node(id: string, type: string, config: Record<string, unknown> = {}): FlowNodeV1 {
  return { id, type, label: id, position: { x: 0, y: 0 }, bindings: {}, config, policy: { ...policy }, disabled: false }
}

function acceptanceFlow(root: string, attachmentId: string, includeLegacyArchive: boolean): FlowDefinitionV1 {
  const nodes = [
    node('schedule', 'schedule_trigger', { kind: 'interval', everyMinutes: 60 }),
    node('retrieve', 'knowledge_retrieval', { attachmentId, query: '投标保证金 伍拾万元' }),
    { ...node('agent', 'agent', { prompt: '依据检索来源编制投标响应。' }), policy: { ...policy, retryAttempts: 1 } },
    node('docx', 'docx_output', { outputPath: 'bid.docx' }),
    node('approval', 'human_approval', { summary: '审批投标文件' }),
    ...(includeLegacyArchive ? [node('archive', 'archive')] : [])
  ]
  const edges = [
    ['schedule', 'retrieve'], ['retrieve', 'agent'], ['agent', 'docx'], ['docx', 'approval'],
    ...(includeLegacyArchive ? [['approval', 'archive']] : [])
  ].map(([sourceNodeId, targetNodeId], index) => ({ id: `edge-${index}`, sourceNodeId, sourcePortId: 'output', targetNodeId, targetPortId: 'input', branch: 'normal' as const }))
  return { schemaVersion: 1, id: 'flow-acceptance', name: 'Tender acceptance', description: '', revision: 1, nodes, edges, variables: { secretToken: 'acceptance-secret', sourcePath: root }, workspace: root, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }
}

function withoutPersistenceFields(value: FlowDefinitionV1): Omit<FlowDefinitionV1, 'revision' | 'createdAt' | 'updatedAt'> {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = value; return draft
}

function syntheticTenderPdf(pageCount: number): Buffer {
  const objects: string[] = []
  const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2)
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = pageIds[index]!; const contentId = pageId + 1
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    const text = index === 86 ? 'Page 87 Tender Bond RMB 500000' : `Page ${index + 1} Tender General Terms`
    const stream = `BT /F1 12 Tf 50 790 Td (${text}) Tj ET`
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  }
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
