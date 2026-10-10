import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { SurveyFormatRegistry } from './survey-format-registry.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { EngineeringAiRepository } from './engineering-ai-repository.js'
import { EngineeringAiOrchestrator } from './engineering-ai-orchestrator.js'
import { resolvedStepParameters } from './engineering-plan-execution.js'
import { buildRailwiseToolProviders } from '../adapters/tool/railwise-tool-provider.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import type { EngineeringPlanStepV1 } from '../contracts/engineering-ai.js'

describe('Approved height-network preparation from preserved GSI', () => {
  let engineering: EngineeringService
  let survey: SurveyService
  let repository: EngineeringAiRepository
  let orchestrator: EngineeringAiOrchestrator
  let root: string
  let projectId: string
  let source: Awaited<ReturnType<SurveyService['importNetwork']>>
  let host: LocalToolHost
  let context: Parameters<LocalToolHost['execute']>[1]
  let formatRegistry: SurveyFormatRegistry
  const datum = 'Synthetic BM datum; declared, not field verified'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'survey-reviewed-reimport-'))
    engineering = new EngineeringService({ rootDir: root,
      getAdjustments: (project, ids) => ids.flatMap(id => { const a = survey.getAdjustmentForProjectNewUse(project, id); return a?.result ? [a.result] : [] }),
      getAdjustmentEvidence: (project, ids) => ids.flatMap(id => { const a = survey.getAdjustmentForProjectNewUse(project, id); return a?.result ? [{ run: a.run, result: a.result }] : [] }),
      getSurveySources: (project, ids) => ids.flatMap(id => {
        const n = survey.getNetwork(id)
        return n?.projectId === project && n.sourceFile ? [{ networkId: id, sourceFile: n.sourceFile, observations: n.observations, points: [...n.knownPoints, ...n.unknownPoints], rawSourceIntegrity: survey.getRawSourceIntegrity(id), sourceEligibility: survey.getSourceEligibility(id) }] : []
      })
    })
    projectId = engineering.createProject({ name: 'Synthetic unaided GSI', workspace: root, taskType: 'control-network', expectedRevision: 0, idempotencyKey: 'reimport-project' }).id
    formatRegistry = new SurveyFormatRegistry()
    survey = new SurveyService({ rootDir: root, getProject: id => engineering.getProject(id), formatRegistry })
    source = await survey.importNetwork({ projectId, expectedRevision: 1, idempotencyKey: 'reimport-source', networkType: 'plane-control', name: 'leveling.gsi', dataBase64: (await readFile(new URL('./fixtures/survey-formats/professional/leica-gsi-cumulative-leveling.gsi', import.meta.url))).toString('base64') })
    repository = new EngineeringAiRepository({ rootDir: root })
    orchestrator = new EngineeringAiOrchestrator({ context: new EngineeringContextService(engineering, undefined, survey), repository,
      threadStore: { get: async () => ({ domain: 'engineering', projectId, workspace: root, turns: [] }) } as never,
      turns: { recordCompletedTurn: vi.fn(), startTurn: vi.fn(async () => ({ threadId: 'thread', turnId: 'turn' })) } as never, runTurn: vi.fn() })
    host = new LocalToolHost({ tools: buildRailwiseToolProviders(engineering, survey, () => orchestrator).flatMap(p => p.tools) })
    context = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', allowedToolNames: ['survey_network_reimport', 'survey_network_validate', 'survey_calculator', 'control_network', 'report_export', 'survey_adjustment_read'], abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' }
  })
  afterEach(() => { vi.restoreAllMocks(); repository.close(); survey.close(); engineering.close() })

  const step = (id: string, tool: string, parameters: EngineeringPlanStepV1['parameters'], parameterBindings: EngineeringPlanStepV1['parameterBindings'] = [], dependsOn: string[] = []): EngineeringPlanStepV1 => ({ id, tool, title: tool, risk: 'write', parameters, parameterBindings, dependsOn, inputHash: 'server-resolved', approval: 'pending' })
  const bind = (parameter: string, stepId: string, output: 'network.id' | 'network.revision' | 'run.id', asArray = false) => ({ parameter, stepId, output, ...(asArray ? { asArray: true } : {}) })
  const declaration = () => ({ projectId, expectedRevision: 1, sourceNetworkId: source.id, sourceNetworkRevision: source.revision, sourceSha256: source.sourceFile!.sha256, networkType: 'leveling', verticalDatum: datum, knownPointId: 'BM', knownPointHeight: 100 })
  async function start(steps: EngineeringPlanStepV1[]) {
    const created = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Use declared BM100 synthetic height datum and adjust original GSI', steps, idempotencyKey: 'reimport-plan' })
    expect(created.plan.status).toBe('awaiting_approval')
    const approved = orchestrator.approvePlan(created.plan.id, { expectedRevision: created.plan.revision, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'reimport-approval' })
    return (await orchestrator.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'reimport-start' })).plan
  }

  it('requires approval, then executes reimport → validation → leveling → three-format draft with exact receipts', async () => {
    const old = JSON.stringify(survey.getNetwork(source.id))
    expect((await host.execute({ callId: 'unapproved', toolName: 'survey_network_reimport', arguments: declaration() }, context)).item).toMatchObject({ isError: true, output: { error: expect.stringContaining('approved plan') } })
    const plan = await start([
      step('prepare', 'survey_network_reimport', declaration()),
      step('validate', 'survey_network_validate', {}, [bind('networkId', 'prepare', 'network.id'), bind('expectedRevision', 'prepare', 'network.revision')], ['prepare']),
      step('adjust', 'survey_calculator', {}, [bind('networkId', 'prepare', 'network.id'), bind('expectedRevision', 'validate', 'network.revision')], ['validate']),
      step('report', 'report_export', { projectId, expectedRevision: 1 }, [bind('adjustmentIds', 'adjust', 'run.id', true)], ['adjust'])
    ])
    for (const s of plan.steps) {
      const result = await host.execute({ callId: s.id, toolName: s.tool, arguments: resolvedStepParameters(s, id => repository.stepEvidence(plan.id, id)?.handles ?? null) }, context)
      expect(result.item, JSON.stringify(result.item)).not.toMatchObject({ isError: true })
      expect(repository.stepEvidence(plan.id, s.id)).not.toBeNull()
    }
    const prepared = repository.stepEvidence(plan.id, 'prepare')!
    const newId = String(prepared.handles['network.id'])
    expect(newId).not.toBe(source.id)
    expect(survey.getNetwork(newId)).toMatchObject({ networkType: 'leveling', verticalDatum: datum, knownPoints: [{ id: 'BM', height: 100, known: true }], sourceFile: { sha256: source.sourceFile!.sha256 } })
    expect(JSON.stringify(survey.getNetwork(source.id))).toBe(old)
    expect(survey.getRawSourceIntegrity(newId).status).toBe('verified')
    const runId = String(repository.stepEvidence(plan.id, 'adjust')!.handles['run.id'])
    const adjusted = survey.getAdjustment(runId)!
    expect(adjusted.result!.points.find(p => p.id === 'P1')!.height).toBeCloseTo(100.5998, 9)
    expect(adjusted.result!.closure.heightDifference).toBeCloseTo(0.0004, 10)
    expect(repository.stepEvidence(plan.id, 'report')!.parameters.adjustmentIds).toEqual([runId])
    expect(orchestrator.getPlan(plan.id)!.execution.complete).toBe(true)
    const repeated = await host.execute({ callId: 'repeat', toolName: 'survey_network_reimport', arguments: declaration() }, context)
    expect(repeated.item).toMatchObject({ output: { network: { id: newId } } })
    expect(survey.listNetworks(projectId)).toHaveLength(2)
  })

  it.each(['revision', 'hash', 'point', 'raw-bytes'] as const)('rejects changed or unbound source: %s', async fault => {
    const request = { ...declaration(), idempotencyKey: 'reject-reimport' }
    if (fault === 'revision') request.sourceNetworkRevision++
    if (fault === 'hash') request.sourceSha256 = 'a'.repeat(64)
    if (fault === 'point') request.knownPointId = 'invented-point'
    if (fault === 'raw-bytes') await writeFile(join(root, 'sources', source.sourceFile!.sha256, 'original'), 'changed source')
    await expect(survey.reimportHeightNetwork(request)).rejects.toThrow()
    expect(survey.listNetworks(projectId)).toHaveLength(1)
  })

  it('rejects raw input/path injection and declarations for another project', async () => {
    await expect(survey.reimportHeightNetwork({ ...declaration(), idempotencyKey: 'reject-injection', dataBase64: 'AAAA' })).rejects.toThrow()
    await expect(survey.reimportHeightNetwork({ ...declaration(), idempotencyKey: 'reject-project', projectId: 'other' })).rejects.toThrow(/project/)
  })

  it('hides the write from ordinary turns and rejects execution without a plan gate', async () => {
    expect((await host.listTools({ ...context, allowedToolNames: undefined })).some(tool => tool.name === 'survey_network_reimport')).toBe(false)
    const unguarded = buildRailwiseToolProviders(engineering, survey).flatMap(p => p.tools).find(tool => tool.name === 'survey_network_reimport')!
    await expect(unguarded.execute(declaration(), context)).rejects.toThrow(/approved engineering plan/)
    expect(survey.listNetworks(projectId)).toHaveLength(1)
  })

  it('does not approve a stale source selection or a calculator bound to the unrepaired plane network', async () => {
    await expect(orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Prepare GSI', steps: [step('prepare', 'survey_network_reimport', { ...declaration(), sourceNetworkRevision: 99 })], idempotencyKey: 'stale-reimport-plan' })).rejects.toThrow(/stale|current project/)
    const wrong = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Adjust GSI leveling', steps: [
      step('prepare', 'survey_network_reimport', declaration()),
      step('adjust', 'survey_calculator', { networkId: source.id, expectedRevision: source.revision }, [], ['prepare'])
    ], idempotencyKey: 'wrong-target-plan' })
    expect(wrong.plan.status).toBe('needs_attention')
    expect(() => orchestrator.approvePlan(wrong.plan.id, { expectedRevision: wrong.plan.revision, contextHash: wrong.plan.contextHash, stepIds: wrong.approval.stepIds, token: wrong.approval.token, idempotencyKey: 'wrong-target-approval' })).toThrow(/incomplete/)
    expect(survey.listNetworks(projectId)).toHaveLength(1)
  })

  it('rejects a source changed after UI approval before executing any preparation step', async () => {
    const plan = await start([step('prepare', 'survey_network_reimport', declaration())])
    survey.validateNetwork(source.id, { expectedRevision: source.revision, idempotencyKey: 'change-approved-source' })
    const result = await host.execute({ callId: 'stale-approved', toolName: 'survey_network_reimport', arguments: declaration() }, context)
    expect(result.item).toMatchObject({ isError: true })
    expect(repository.stepEvidence(plan.id, 'prepare')).toBeNull()
    expect(survey.listNetworks(projectId)).toHaveLength(1)
  })

  it.each(['source', 'project'] as const)('rejects %s changes during real async parsing without a new durable import unit', async fault => {
    const sourceDb = new Database(join(root, 'survey.sqlite3'))
    const counts = () => ['survey_networks', 'survey_raw_source_ledger', 'survey_source_admissions', 'survey_idempotency'].map(table => (sourceDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
    const parse = formatRegistry.ingest.bind(formatRegistry)
    let entered!: () => void
    const parsing = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(formatRegistry, 'ingest').mockImplementationOnce(async request => {
      const parsed = await parse(request)
      entered()
      await barrier
      return parsed
    })
    const pending = survey.reimportHeightNetwork({ ...declaration(), idempotencyKey: 'reimport-during-change' })
    await parsing
    if (fault === 'source') survey.validateNetwork(source.id, { expectedRevision: source.revision, idempotencyKey: 'concurrent-validation' })
    else engineering.updateProject(projectId, { expectedRevision: 1, name: 'Changed during parse', idempotencyKey: 'concurrent-project-update' })
    const afterConcurrentChange = counts()
    release()
    try {
      await expect(pending).rejects.toThrow(fault === 'source' ? /source changed/ : /project revision conflict/)
      expect(survey.listNetworks(projectId)).toHaveLength(1)
      // Source validation has its own evidence/idempotency writes. Rejecting
      // the stale reimport must add nothing to that actual concurrent state.
      expect(counts()).toEqual(afterConcurrentChange)
      expect(sourceDb.prepare('SELECT result_json FROM survey_idempotency WHERE key = ?').get('reimport-during-change')).toBeUndefined()
    } finally { sourceDb.close() }
  })

  it('returns the atomically committed reimport when the old source changes during sidecar persistence', async () => {
    const projectedSurvey = survey as unknown as { persist(value: unknown, kind: string, workspace?: string): Promise<void> }
    const persist = projectedSurvey.persist.bind(survey)
    let entered!: () => void
    const projecting = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(projectedSurvey, 'persist').mockImplementationOnce(async (...args) => {
      await persist(...args)
      entered()
      await barrier
    })
    const pending = survey.reimportHeightNetwork({ ...declaration(), idempotencyKey: 'post-commit-reimport' })
    await projecting
    expect(survey.listNetworks(projectId)).toHaveLength(2)
    const changed = survey.validateNetwork(source.id, { expectedRevision: source.revision, idempotencyKey: 'post-commit-source-validation' })
    release()
    const imported = await pending
    expect(imported.id).not.toBe(source.id)
    expect(imported).toMatchObject({ networkType: 'leveling', knownPoints: [{ id: 'BM', height: 100 }], verticalDatum: datum })
    expect(survey.getNetwork(imported.id)).toEqual(imported)
    expect(survey.getNetwork(source.id)).toEqual(changed)
    expect(survey.getRawSourceIntegrity(imported.id).status).toBe('verified')
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      const stored = db.prepare('SELECT result_json FROM survey_idempotency WHERE key = ?').get('post-commit-reimport') as { result_json: string }
      expect(JSON.parse(stored.result_json)).toMatchObject({ network: { id: imported.id } })
    } finally { db.close() }
  })

  it('pauses on blocked validation without success receipt or automatic calculation', async () => {
    const plan = await start([
      step('validate', 'survey_network_validate', { networkId: source.id, expectedRevision: source.revision }),
      step('adjust', 'control_network', { networkId: source.id }, [bind('expectedRevision', 'validate', 'network.revision')], ['validate'])
    ])
    const result = await host.execute({ callId: 'blocked', toolName: 'survey_network_validate', arguments: { networkId: source.id, expectedRevision: source.revision } }, context)
    expect(result.item).toMatchObject({ isError: true, output: { network: { qualityStatus: 'blocked' } } })
    expect(repository.stepEvidence(plan.id, 'validate')).toBeNull()
    expect(orchestrator.getPlan(plan.id)!.status).toBe('needs_attention')
    expect((await host.execute({ callId: 'continue', toolName: 'control_network', arguments: { networkId: source.id } }, context)).item).toMatchObject({ isError: true, output: { error: expect.stringContaining('approved plan') } })
    expect(survey.listAdjustments(projectId)).toHaveLength(0)
  })

  it('retains invalid calculation output as failure, while history remains readable', async () => {
    const plan = await start([step('adjust', 'control_network', { networkId: source.id, expectedRevision: source.revision })])
    const result = await host.execute({ callId: 'invalid', toolName: 'control_network', arguments: { networkId: source.id, expectedRevision: source.revision } }, context)
    expect(result.item).toMatchObject({ isError: true, output: { run: { status: 'needs_attention' }, result: { validation: 'invalid', points: [] } } })
    expect(repository.stepEvidence(plan.id, 'adjust')).toBeNull()
    expect(orchestrator.getPlan(plan.id)!.status).toBe('needs_attention')
    const old = survey.listAdjustments(projectId)[0]!
    expect(survey.getAdjustment(old.run.id)!.result!.validation).toBe('invalid')
    const readTool = buildRailwiseToolProviders(engineering, survey).flatMap(p => p.tools).find(t => t.name === 'survey_adjustment_read')!
    expect(await readTool.execute({ networkId: source.id, adjustmentId: old.run.id }, context)).toMatchObject({ output: { result: { validation: 'invalid' } } })
  })
})
