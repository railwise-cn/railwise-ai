import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { EngineeringAiRepository } from './engineering-ai-repository.js'
import { EngineeringAiOrchestrator } from './engineering-ai-orchestrator.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { buildRailwiseToolProviders } from '../adapters/tool/railwise-tool-provider.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import type { EngineeringRunPlanV1 } from '../contracts/engineering-ai.js'
import { resolvedStepParameters } from './engineering-plan-execution.js'
import type { StartTurnRequest } from '../contracts/turns.js'

describe('Reviewed Survey plan execution', () => {
  let engineering: EngineeringService
  let survey: SurveyService
  let repository: EngineeringAiRepository
  let orchestrator: EngineeringAiOrchestrator
  let projectId: string
  let networkId: string
  let root: string
  const turns = { recordCompletedTurn: vi.fn(), startTurn: vi.fn(async () => ({ threadId: 'thread', turnId: 'turn' })) }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'survey-approved-parameters-'))
    engineering = new EngineeringService({ rootDir: root,
      getAdjustments: (project, ids) => ids.flatMap(id => { const stored = survey.getAdjustmentForProjectNewUse(project, id); return stored?.result ? [stored.result] : [] }),
      getAdjustmentEvidence: (project, ids) => ids.flatMap(id => { const stored = survey.getAdjustmentForProjectNewUse(project, id); return stored?.result ? [{ run: stored.run, result: stored.result }] : [] }),
      getSurveySources: (project, ids) => ids.flatMap(id => {
        const network = survey.getNetwork(id)
        return network?.projectId === project && network.sourceFile ? [{ networkId: id, sourceFile: network.sourceFile, observations: network.observations, points: [...network.knownPoints, ...network.unknownPoints], rawSourceIntegrity: survey.getRawSourceIntegrity(id), sourceEligibility: survey.getSourceEligibility(id) }] : []
      })
    })
    projectId = engineering.createProject({ name: 'Synthetic parameter acceptance', workspace: root, expectedRevision: 0, idempotencyKey: 'parameters-project' }).id
    survey = new SurveyService({ rootDir: root, getProject: id => engineering.getProject(id) })
    networkId = (await importWorkwiseSurveyNetwork(survey, { projectId, expectedRevision: 1, idempotencyKey: 'parameters-network', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }], unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [
        { id: 'one', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
        { id: 'two', type: 'height-difference', from: 'BM', to: 'P', value: 0.1001, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }
      ]
    } })).id
    repository = new EngineeringAiRepository({ rootDir: root })
    orchestrator = new EngineeringAiOrchestrator({ context: new EngineeringContextService(engineering, undefined, survey), repository,
      threadStore: { get: async () => ({ domain: 'engineering', projectId, workspace: root, turns: [] }) } as never,
      turns: turns as never, runTurn: vi.fn() })
    turns.startTurn.mockClear()
  })
  afterEach(() => { repository.close(); survey.close(); engineering.close() })

  async function startedPlan(selection: Pick<StartTurnRequest, 'model' | 'providerId' | 'reasoningEffort'> = {}): Promise<EngineeringRunPlanV1> {
    const created = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: '水准网平差和成果', idempotencyKey: 'parameters-plan' })
    expect(created.plan.status).toBe('awaiting_approval')
    expect(created.plan.steps[0]).toMatchObject({ parameters: { networkId, expectedRevision: 1 }, expectedOutputs: ['network-validation'], reversibility: 'revisioned-write' })
    const approved = orchestrator.approvePlan(created.plan.id, { expectedRevision: 1, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'parameters-approval' })
    return (await orchestrator.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'parameters-start', ...selection })).plan
  }

  it('propagates provider/model/effort on typed start and inherits saved selection on resume', async () => {
    const selection = { model: 'shared-model', providerId: 'provider-b', reasoningEffort: 'off' as const }
    const task = { id: 'task', threadId: 'thread', revision: 1, ...selection }
    const tasks = { activeTask: vi.fn(() => task), getTask: vi.fn(() => task), prepareResume: vi.fn(() => task) }
    orchestrator = new EngineeringAiOrchestrator({ context: new EngineeringContextService(engineering, undefined, survey), repository,
      threadStore: { get: async () => ({ domain: 'engineering', projectId, workspace: root, turns: [] }) } as never,
      turns: turns as never, tasks: tasks as never, runTurn: vi.fn() })
    const plan = await startedPlan(selection)
    expect(turns.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ engineeringExecution: true, request: expect.objectContaining(selection) }))
    const resumed = await orchestrator.resumePlan(plan.id, { expectedRevision: plan.revision, contextHash: plan.contextHash, idempotencyKey: 'provider-resume' })
    expect(turns.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ engineeringExecution: true, request: expect.objectContaining(selection) }))
    expect(tasks.prepareResume).toHaveBeenCalledWith('task', 1, undefined)
    const calls = turns.startTurn.mock.calls.length
    expect(await orchestrator.resumePlan(plan.id, { expectedRevision: plan.revision, contextHash: plan.contextHash, idempotencyKey: 'provider-resume' })).toEqual(resumed)
    expect(turns.startTurn).toHaveBeenCalledTimes(calls)
    tasks.activeTask.mockReturnValue({ ...task, id: 'unrelated-task' })
    await expect(orchestrator.resumePlan(plan.id, { expectedRevision: resumed.plan.revision, contextHash: resumed.plan.contextHash, idempotencyKey: 'wrong-task-resume' })).rejects.toMatchObject({ code: 'engineering_task_missing' })
    expect(tasks.prepareResume).toHaveBeenCalledTimes(1)
  })

  it('runs the actual deterministic tool chain with approved literals and persisted predecessor handles', async () => {
    const plan = await startedPlan()
    const tools = buildRailwiseToolProviders(engineering, survey, () => orchestrator).flatMap(provider => provider.tools)
    const host = new LocalToolHost({ tools })
    const context = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request' as const, abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' as const }
    await expect(orchestrator.authorizeToolCall('thread', 'turn', 'report_export', { projectId })).rejects.toThrow(/dependency order/)
    await expect(orchestrator.authorizeToolCall('thread', 'turn', 'survey_network_validate', { networkId: 'different-network', expectedRevision: 1 })).rejects.toThrow(/arguments/)
    for (const step of plan.steps) {
      const args = resolvedStepParameters(step, id => repository.stepEvidence(plan.id, id)?.handles ?? null)
      const result = await host.execute({ callId: step.id, toolName: step.tool, arguments: args }, context)
      expect(result.item, `${step.id}: ${JSON.stringify(result.item)}`).toMatchObject({ kind: 'tool_result' })
      expect('isError' in result.item && result.item.isError, `${step.id}: ${JSON.stringify(result.item)}`).not.toBe(true)
      expect(repository.stepEvidence(plan.id, step.id)).not.toBeNull()
    }
    const adjusted = repository.stepEvidence(plan.id, 'adjust-survey-network')!
    const report = repository.stepEvidence(plan.id, 'prepare-survey-report')!
    expect(report.parameters.adjustmentIds).toEqual([adjusted.handles['run.id']])
    expect(repository.stepEvidence(plan.id, 'review-survey-quality')!.parameters.adjustmentId).toBe(adjusted.handles['run.id'])
    expect(adjusted.parameters.expectedRevision).toBe(repository.stepEvidence(plan.id, 'inspect-survey-network')!.handles['network.revision'])
    expect(survey.listAdjustments(projectId)).toHaveLength(1)
    expect(orchestrator.getPlan(plan.id)?.execution).toEqual({ complete: true, completedStepIds: plan.steps.map(step => step.id), pendingStepIds: [] })
    const adjustmentStep = plan.steps[1]!
    await host.execute({ callId: 'repeat', toolName: adjustmentStep.tool, arguments: resolvedStepParameters(adjustmentStep, id => repository.stepEvidence(plan.id, id)?.handles ?? null) }, context)
    expect(survey.listAdjustments(projectId)).toHaveLength(1)
    expect(JSON.stringify(repository.stepEvidence(plan.id, adjustmentStep.id))).not.toContain('observations')
    repository.close()
    repository = new EngineeringAiRepository({ rootDir: root })
    expect(repository.stepEvidence(plan.id, 'prepare-survey-report')).toEqual(report)
  })

  it('rejects changed parameters, extra effects and calls from another turn before invoking a tool', async () => {
    await startedPlan()
    for (const requested of [{ networkId, expectedRevision: 99 }, { networkId, expectedRevision: 1, deleteSource: true }]) {
      await expect(orchestrator.authorizeToolCall('thread', 'turn', 'survey_network_validate', requested)).rejects.toThrow(/arguments/)
    }
    await expect(orchestrator.authorizeToolCall('thread', 'other-turn', 'survey_network_validate', { networkId, expectedRevision: 1 })).rejects.toThrow(/no executable/)
    expect(survey.getNetwork(networkId)?.revision).toBe(1)
    expect(survey.listAdjustments(projectId)).toHaveLength(0)
  })

  it('does not accept a receipt with parameters different from the reviewed step', async () => {
    const plan = await startedPlan()
    const step = plan.steps[0]!
    repository.recordStepEvidence(plan.id, step.id, { ...step.parameters, expectedRevision: 999, idempotencyKey: `engineering-plan:${plan.id}:${step.id}` }, { 'network.id': networkId, 'network.revision': 2 })
    expect(orchestrator.getPlan(plan.id)?.execution).toEqual({ complete: false, completedStepIds: [], pendingStepIds: plan.steps.map(item => item.id) })
  })

  it('accepts a successful read-only receipt with an empty handles object', async () => {
    const draft = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Prepare a citation placeholder', idempotencyKey: 'empty-handle-plan', steps: [{ id: 'cite', title: 'Citation', tool: 'standard_query', risk: 'read', dependsOn: [], inputHash: 'draft', approval: 'pending', parameters: { source: 'Synthetic source citation' } }] })
    const approved = orchestrator.approvePlan(draft.plan.id, { expectedRevision: draft.plan.revision, contextHash: draft.plan.contextHash, stepIds: draft.approval.stepIds, token: draft.approval.token, idempotencyKey: 'empty-handle-approval' })
    const { plan } = await orchestrator.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'empty-handle-start' })
    const host = new LocalToolHost({ tools: buildRailwiseToolProviders(engineering, survey, () => orchestrator).flatMap(provider => provider.tools) })
    const result = await host.execute({ callId: 'citation', toolName: 'standard_query', arguments: { source: 'Synthetic source citation' } }, { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'auto', awaitApproval: async () => 'deny', abortSignal: new AbortController().signal })
    expect(result.item).not.toMatchObject({ isError: true })
    expect(repository.stepEvidence(plan.id, 'cite')?.handles).toEqual({})
    expect(orchestrator.getPlan(plan.id)?.execution).toEqual({ complete: true, completedStepIds: ['cite'], pendingStepIds: [] })
  })

  it('chooses the default adjustment tool from the selected network instead of goal keywords', async () => {
    projectId = engineering.createProject({ name: 'Plane control test', workspace: root, expectedRevision: 0, idempotencyKey: 'plane-default-project' }).id
    const bytes = await readFile(new URL('./fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2', import.meta.url))
    const network = await survey.importNetwork({ projectId, expectedRevision: 1, idempotencyKey: 'plane-default-network', networkType: 'plane-control', name: 'synthetic.in2', dataBase64: bytes.toString('base64') })
    for (const goal of ['控制网平差', 'Adjust the survey network']) {
      const created = await orchestrator.createPlan({ threadId: 'thread', projectId, goal, idempotencyKey: `survey-default-${goal}` })
      expect(created.plan.steps[1]?.tool).toBe('control_network')
      expect(created.plan.steps[1]?.parameters?.networkId).toBe(network.id)
      expect(created.plan.status).toBe('awaiting_approval')
    }
  })

  it('executes namespaced monitoring tools with validation revisions and bound analysis outputs', async () => {
    await engineering.importDataset({ projectId, expectedRevision: 1, idempotencyKey: 'monitoring-plan-data', name: 'measurements.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1\nA,2026-01-02,1.1').toString('base64') })
    const created = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Check monitoring trends', steps: ['monitoring_data_first_check', 'deformation_rate', 'chart_generator', 'report_export'].map((tool, index) => ({ id: `step-${index}`, title: tool, tool: `railwise.${tool}`, risk: 'read', dependsOn: index ? [`step-${index - 1}`] : [], inputHash: 'draft', approval: 'pending' })), idempotencyKey: 'monitoring-parameters-plan' })
    const approved = orchestrator.approvePlan(created.plan.id, { expectedRevision: 1, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'monitoring-parameters-approval' })
    const { plan } = await orchestrator.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'monitoring-parameters-start' })
    const host = new LocalToolHost({ tools: buildRailwiseToolProviders(engineering, survey, () => orchestrator).flatMap(provider => provider.tools) })
    for (const step of plan.steps) {
      const result = await host.execute({ callId: step.id, toolName: step.tool, arguments: resolvedStepParameters(step, id => repository.stepEvidence(plan.id, id)?.handles ?? null) }, { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' })
      expect(result.item, JSON.stringify(result.item)).not.toMatchObject({ isError: true })
      expect(repository.stepEvidence(plan.id, step.id)).not.toBeNull()
    }
    expect(repository.stepEvidence(plan.id, 'step-1')!.parameters.expectedRevision).toBe(repository.stepEvidence(plan.id, 'step-0')!.handles['dataset.revision'])
    expect(repository.stepEvidence(plan.id, 'step-3')!.parameters.analysisId).toBe(repository.stepEvidence(plan.id, 'step-1')!.handles['analysis.id'])
  })

  it('preserves incomplete or legacy plans without allowing approval or execution', async () => {
    const created = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: 'Analyse monitoring data without any dataset', steps: [{ id: 'analyse', title: 'Analyse', tool: 'deformation_rate', risk: 'write', inputHash: 'placeholder', dependsOn: [], approval: 'pending' }], idempotencyKey: 'incomplete-plan' })
    expect(created.plan.status).toBe('needs_attention')
    expect(() => orchestrator.approvePlan(created.plan.id, { expectedRevision: 1, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'incomplete-approve' })).toThrow(/incomplete/)
    const legacy = { ...created.plan, status: 'approved' as const, steps: created.plan.steps.map(({ parameters: _parameters, parameterBindings: _bindings, expectedOutputs: _outputs, reversibility: _reversibility, ...step }) => ({ ...step, approval: 'approved' as const })) }
    repository.savePlan(legacy)
    await expect(orchestrator.startPlan(legacy.id, { expectedRevision: legacy.revision, contextHash: legacy.contextHash, idempotencyKey: 'legacy-start' })).rejects.toThrow(/incomplete/)
    expect(repository.getPlan(legacy.id)?.steps[0]?.parameters).toBeUndefined()
    expect(turns.startTurn).not.toHaveBeenCalled()
  })

  it('rejects cross-project selections and conflicting idempotency parameters', async () => {
    const request = { threadId: 'thread', projectId, goal: 'Read the selected result', idempotencyKey: 'specific-parameters', steps: [{ id: 'read', title: 'Read', tool: 'survey_adjustment_read', risk: 'read' as const, dependsOn: [], inputHash: 'context', approval: 'pending' as const, parameters: { networkId } }] }
    const created = await orchestrator.createPlan(request)
    expect((await orchestrator.createPlan(request)).plan.id).toBe(created.plan.id)
    await expect(orchestrator.createPlan({ ...request, steps: [{ ...request.steps[0]!, parameters: { networkId: 'another-network' } }] })).rejects.toThrow(/different plan request/)
    await expect(orchestrator.createPlan({ ...request, idempotencyKey: 'cross-project-parameters', steps: [{ ...request.steps[0]!, parameters: { networkId: 'another-network' } }] })).rejects.toThrow(/current project/)
    const rebuilt = await orchestrator.createPlan({ threadId: 'thread', projectId, goal: request.goal, replanOf: created.plan.id, idempotencyKey: 'preserve-replan-scope' })
    expect(rebuilt.plan.steps).toHaveLength(1)
    expect(rebuilt.plan.steps[0]).toMatchObject({ tool: 'survey_adjustment_read', parameters: { networkId }, approval: 'pending' })
    await expect(orchestrator.createPlan({ ...request, replanOf: created.plan.id, idempotencyKey: 'reject-replan-expansion' })).rejects.toThrow(/preserve/)
  })
})
