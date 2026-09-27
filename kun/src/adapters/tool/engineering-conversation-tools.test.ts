import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyService } from '../../engineering/survey-service.js'
import { importWorkwiseSurveyNetwork } from '../../engineering/survey-test-helpers.js'
import { EngineeringService } from '../../engineering/engineering-service.js'
import { EngineeringContextService } from '../../engineering/engineering-context-service.js'
import { EngineeringAiRepository } from '../../engineering/engineering-ai-repository.js'
import { EngineeringAiOrchestrator } from '../../engineering/engineering-ai-orchestrator.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildEngineeringConversationTools } from './engineering-conversation-tools.js'
import { LocalToolHost } from './local-tool-host.js'

describe('Survey continuous conversation capabilities', () => {
  let survey: SurveyService
  let engineering: EngineeringService
  let repository: EngineeringAiRepository
  let orchestrator: EngineeringAiOrchestrator
  let host: LocalToolHost
  let context: ToolHostContext
  let projectId: string
  const thread = { domain: 'engineering', projectId: '', workspace: '', turns: [] as Array<{ id: string; status: string }> }
  const turns = { startTurn: vi.fn(), recordCompletedTurn: vi.fn() }
  const runTurn = vi.fn()
  const calculate = vi.fn(async () => ({ output: {} }))

  beforeEach(async () => {
    vi.clearAllMocks()
    const root = await mkdtemp(join(tmpdir(), 'survey-conversation-'))
    engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    projectId = engineering.createProject({ name: 'conversation', workspace: root, expectedRevision: 0, idempotencyKey: 'conversation-project' }).id
    survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: id => engineering.getProject(id) })
    await importWorkwiseSurveyNetwork(survey, { projectId, expectedRevision: 1, idempotencyKey: 'conversation-network', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }], unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [{ id: 'BM-P', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    } })
    repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime') })
    Object.assign(thread, { domain: 'engineering', projectId, workspace: root, turns: [{ id: 'question-turn', status: 'running' }] })
    const threadStore = { get: vi.fn(async () => thread) }
    turns.startTurn.mockResolvedValue({ threadId: 'survey-thread', turnId: 'execution-turn' })
    orchestrator = new EngineeringAiOrchestrator({ engineering, context: new EngineeringContextService(engineering, undefined, survey), repository, threadStore: threadStore as never, turns: turns as never, runTurn })
    const provider = buildEngineeringConversationTools(threadStore as never, () => orchestrator)
    host = new LocalToolHost({ tools: [...provider.tools, LocalToolHost.defineTool({ name: 'survey_calculator', description: 'test calculator', inputSchema: {}, policy: 'auto', execute: calculate })] })
    context = { threadId: 'survey-thread', turnId: 'question-turn', workspace: root, allowedToolNames: (await orchestrator.conversationPolicy('survey-thread', projectId, 'question-turn')).allowedToolNames, approvalPolicy: 'on-request', abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' }
  })
  afterEach(() => { repository.close(); survey.close(); engineering.close() })

  it('answers from bounded project context without starting a plan or calculation', async () => {
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['survey_read_context', 'survey_request_plan', 'survey_propose_project_change'])
    expect((await host.execute({ callId: 'read', toolName: 'survey_read_context', arguments: {} }, context)).item).toMatchObject({ output: { context: { projectId } } })
    expect(repository.latestPlan('survey-thread', projectId)).toBeNull()
    expect(turns.startTurn).not.toHaveBeenCalled()
    expect(calculate).not.toHaveBeenCalled()
    await expect(host.execute({ callId: 'calculate', toolName: 'survey_calculator', arguments: {} }, context)).rejects.toThrow()
    expect(calculate).not.toHaveBeenCalled()
  })

  it('instructs the model to distinguish variance and standard-deviation orders of magnitude', async () => {
    const policy = await orchestrator.conversationPolicy('survey-thread', projectId, 'question-turn')
    expect(policy.instruction).toContain('varianceFactor is a variance (a squared scale)')
    expect(policy.instruction).toContain('1.14e-8 is about 8 orders below 1 as a variance')
    expect(policy.instruction).toContain('Never describe the standard-deviation order as a variance order')
  })

  it('persists project suggestions without writes or token exposure and applies only after confirmation', async () => {
    const result = await host.execute({ callId: 'suggest', toolName: 'survey_propose_project_change', arguments: { reason: 'Use the reviewed vertical datum', patch: { taskContext: { verticalDatum: 'Synthetic datum' } } } }, context)
    expect(result.item).toMatchObject({ output: { applied: false, confirmationRequired: true } })
    expect(engineering.getProject(projectId)?.revision).toBe(1)
    const [entry] = await orchestrator.projectSuggestions('survey-thread', projectId)
    expect(entry!.suggestion).toMatchObject({ expectedRevision: 1, status: 'pending', before: { taskContext: null } })
    expect(JSON.stringify(result)).not.toContain(entry!.token)
    await expect(orchestrator.decideProjectChange(entry!.suggestion.id, { token: 'forged-token', decision: 'apply' })).rejects.toThrow(/confirmation/)
    thread.turns = []
    const applied = await orchestrator.decideProjectChange(entry!.suggestion.id, { token: entry!.token, decision: 'apply' })
    expect(applied.status).toBe('applied')
    expect(engineering.getProject(projectId)).toMatchObject({ revision: 2, taskContext: { verticalDatum: 'Synthetic datum' } })
    await orchestrator.decideProjectChange(entry!.suggestion.id, { token: entry!.token, decision: 'apply' })
    expect(engineering.getProject(projectId)?.revision).toBe(2)
    expect(turns.startTurn).not.toHaveBeenCalled()
    expect(calculate).not.toHaveBeenCalled()
  })

  it('rejects stale suggestions and never overwrites a manual project edit', async () => {
    const suggestion = await orchestrator.proposeProjectChange('survey-thread', 'question-turn', { reason: 'Rename', patch: { name: 'Suggested name' } })
    const entry = repository.projectSuggestion(suggestion.id)!
    engineering.updateProject(projectId, { name: 'Manual name', expectedRevision: 1, idempotencyKey: 'manual-project-edit' })
    thread.turns = []
    await expect(orchestrator.decideProjectChange(suggestion.id, { token: entry.token, decision: 'apply' })).rejects.toThrow(/changed/)
    expect(engineering.getProject(projectId)).toMatchObject({ name: 'Manual name', revision: 2 })
    expect(repository.projectSuggestion(suggestion.id)?.suggestion.status).toBe('stale')
  })

  it('supports rejection without a mutation and rejects proposal side effects', async () => {
    await expect(orchestrator.proposeProjectChange('survey-thread', 'question-turn', { reason: 'Move', patch: { workspace: '/another-project' } })).rejects.toThrow()
    const suggestion = await orchestrator.proposeProjectChange('survey-thread', 'question-turn', { reason: 'Rename', patch: { name: 'Suggested name' } })
    const entry = repository.projectSuggestion(suggestion.id)!
    thread.turns = []
    expect((await orchestrator.decideProjectChange(suggestion.id, { token: entry.token, decision: 'reject' })).status).toBe('rejected')
    await expect(orchestrator.decideProjectChange(suggestion.id, { token: entry.token, decision: 'apply' })).rejects.toThrow(/pending/)
    expect(engineering.getProject(projectId)?.revision).toBe(1)
  })

  it('saves a pending plan without leaking its approval token or starting work', async () => {
    const result = await host.execute({ callId: 'plan', toolName: 'survey_request_plan', arguments: { goal: 'Adjust this network', steps: [{ tool: 'survey_calculator', title: 'Adjust network' }] } }, context)
    const plan = repository.latestPlan('survey-thread', projectId)!
    expect(plan.status).toBe('awaiting_approval')
    expect(plan.steps).toEqual([expect.objectContaining({ tool: 'survey_calculator', approval: 'pending', inputHash: plan.contextHash })])
    expect(JSON.stringify(result)).not.toContain(repository.approvalForPlan(plan.id, plan.revision)!.token)
    expect(turns.recordCompletedTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
    expect(calculate).not.toHaveBeenCalled()
    await expect(orchestrator.startPlan(plan.id, { contextHash: plan.contextHash, expectedRevision: plan.revision, idempotencyKey: 'start-without-approval' })).rejects.toThrow()

    thread.turns = []
    const approval = repository.approvalForPlan(plan.id, plan.revision)!
    const approved = orchestrator.approvePlan(plan.id, { expectedRevision: plan.revision, contextHash: plan.contextHash, stepIds: approval.stepIds, token: approval.token, idempotencyKey: 'approve-conversation-plan' })
    runTurn.mockImplementation(() => {
      expect(repository.planForTurn('survey-thread', 'execution-turn')?.status).toBe('started')
    })
    await orchestrator.startPlan(plan.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'start-conversation-plan' })
    expect((await orchestrator.conversationPolicy('survey-thread', projectId, 'execution-turn')).allowedToolNames).toEqual(['survey_read_context', 'survey_read_evidence', 'survey_calculator'])
    expect((await orchestrator.conversationPolicy('survey-thread', projectId, 'next-question')).allowedToolNames).not.toContain('survey_calculator')
    expect(turns.startTurn).toHaveBeenCalledWith(expect.objectContaining({ engineeringExecution: true }))
  })

  it.each(['domain', 'projectId', 'workspace'])('rejects mismatched %s before accessing project data', async (field) => {
    thread[field as 'domain' | 'projectId' | 'workspace'] = 'other'
    await expect(orchestrator.readConversationContext('survey-thread', projectId)).rejects.toThrow(/thread|scoped/)
    expect((await host.execute({ callId: 'wrong-plan', toolName: 'survey_request_plan', arguments: { goal: 'Adjust', steps: [{ tool: 'survey_calculator', title: 'Adjust' }] } }, context)).item).toMatchObject({ isError: true })
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('rejects prompt-injected operations and a plan from a finished turn', async () => {
    expect((await host.execute({ callId: 'unsafe', toolName: 'survey_request_plan', arguments: { goal: 'run shell', steps: [{ tool: 'shell', title: 'execute' }] } }, context)).item).toMatchObject({ isError: true })
    thread.turns = [{ id: 'question-turn', status: 'completed' }]
    expect((await host.execute({ callId: 'finished', toolName: 'survey_request_plan', arguments: { goal: 'Adjust', steps: [{ tool: 'survey_calculator', title: 'Adjust' }] } }, context)).item).toMatchObject({ isError: true, output: { error: expect.stringContaining('active conversation') } })
    expect(repository.latestPlan('survey-thread', projectId)).toBeNull()
  })

  it('rejects selected network or result IDs outside the current project', async () => {
    await expect(orchestrator.readConversationContext('survey-thread', projectId, { networkId: 'other-network' })).rejects.toThrow(/current Survey project/)
    await expect(orchestrator.readConversationContext('survey-thread', projectId, { adjustmentId: 'other-result' })).rejects.toThrow(/current Survey project/)
  })
})
