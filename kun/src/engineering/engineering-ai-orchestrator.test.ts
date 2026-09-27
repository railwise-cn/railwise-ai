import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { EngineeringAiOrchestrator } from './engineering-ai-orchestrator.js'
import { EngineeringAiRepository } from './engineering-ai-repository.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

describe('Engineering AI orchestration', () => {
  it('creates bounded plans, rejects unsafe tools and replays idempotent requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-ai-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'AI project', workspace: root, expectedRevision: 0, idempotencyKey: 'ai-project-001' })
    await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'ai-initial-dataset', name: 'data.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1').toString('base64') })
    const context = new EngineeringContextService(engineering)
    const repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime') })
    const turns = {
      recordCompletedTurn: vi.fn(async () => ({ threadId: 'thread-1', turnId: 'draft-turn', userMessageItemId: 'draft-user', assistantMessageItemId: 'draft-assistant' })),
      startTurn: vi.fn(async (_input: { threadId: string; request: { prompt: string } }) => ({ threadId: 'thread-1', turnId: 'turn-1' }))
    }
    const threadStore = { get: vi.fn(async () => ({ domain: 'engineering', projectId: project.id, turns: [] })) }
    const runTurn = vi.fn()
    const orchestrator = new EngineeringAiOrchestrator({ context, repository, threadStore: threadStore as never, turns: turns as never, runTurn })

    const first = await orchestrator.createPlan({ threadId: 'thread-1', projectId: project.id, goal: '检查本期数据并生成报告', idempotencyKey: 'ai-plan-001' })
    expect(first.plan.status).toBe('awaiting_approval')
    expect(first.approval.stepIds).toHaveLength(first.plan.steps.length)
    expect(turns.startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
    expect(turns.recordCompletedTurn).toHaveBeenCalledTimes(1)
    const replay = await orchestrator.createPlan({ threadId: 'thread-1', projectId: project.id, goal: '检查本期数据并生成报告', idempotencyKey: 'ai-plan-001' })
    expect(replay.plan.id).toBe(first.plan.id)
    await expect(orchestrator.createPlan({
      threadId: 'thread-1', projectId: project.id, goal: '不安全计划', idempotencyKey: 'ai-plan-002',
      steps: [{ id: 'bad', title: 'bad', tool: 'shell', risk: 'write', dependsOn: [], inputHash: first.plan.contextHash, approval: 'pending' }]
    })).rejects.toThrow(/allowlisted/)

    const approved = orchestrator.approvePlan(first.plan.id, { expectedRevision: 1, contextHash: first.plan.contextHash, stepIds: first.plan.steps.map((step) => step.id), token: first.approval.token, idempotencyKey: 'ai-approve-001' })
    expect(approved.status).toBe('approved')
    const started = await orchestrator.startPlan(first.plan.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, idempotencyKey: 'ai-start-001' })
    expect(started.plan.status).toBe('started')
    expect(turns.startTurn).toHaveBeenCalledTimes(1)
    expect(runTurn).toHaveBeenCalledWith('thread-1', 'turn-1')
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(turns.startTurn.mock.calls[0]?.[0].request.prompt).toContain('"surveyNetworks":[]')
    repository.close()
    engineering.close()
  })

  it('assigns tool effects on the server and requires fresh review for legacy understated risks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engineering-plan-risk-'))
    const engineering = new EngineeringService({ rootDir: root })
    const project = engineering.createProject({ name: 'risk review', workspace: root, expectedRevision: 0, idempotencyKey: 'risk-project-001' })
    const repository = new EngineeringAiRepository({ rootDir: root })
    const turns = { recordCompletedTurn: vi.fn(), startTurn: vi.fn() }
    const orchestrator = new EngineeringAiOrchestrator({
      context: new EngineeringContextService(engineering), repository,
      threadStore: { get: async () => ({ domain: 'engineering', projectId: project.id, turns: [] }) } as never,
      turns: turns as never, runTurn: vi.fn()
    })
    try {
      const tools = ['survey_network_validate', 'monitoring_data_first_check', 'deformation_rate', 'report_export', 'railwise.report_export', 'survey_adjustment_read']
      const created = await orchestrator.createPlan({
        threadId: 'risk-thread', projectId: project.id, goal: 'Review actual effects', idempotencyKey: 'risk-plan-001',
        steps: tools.map((tool, index) => ({ id: `step-${index}`, title: tool, tool, risk: 'read', dependsOn: [], inputHash: 'untrusted', approval: 'approved' }))
      })
      expect(created.plan.steps.map(step => step.risk)).toEqual(['write', 'write', 'write', 'export', 'export', 'read'])
      expect(created.plan.steps.every(step => step.approval === 'pending')).toBe(true)
      const old = { ...created.plan, steps: created.plan.steps.map(step => ({ ...step, risk: 'read' as const })) }
      repository.savePlan(old)
      expect(() => orchestrator.approvePlan(old.id, {
        expectedRevision: old.revision, contextHash: old.contextHash, stepIds: created.approval.stepIds,
        token: created.approval.token, idempotencyKey: 'risk-approve-old'
      })).toThrow(/tool effects changed/)
      const approvedOld = { ...old, status: 'approved' as const, steps: old.steps.map(step => ({ ...step, approval: 'approved' as const })) }
      repository.savePlan(approvedOld)
      await expect(orchestrator.startPlan(old.id, { expectedRevision: old.revision, contextHash: old.contextHash, idempotencyKey: 'risk-start-old' })).rejects.toThrow(/tool effects changed/)
      await expect(orchestrator.resumePlan(old.id, { expectedRevision: old.revision, contextHash: old.contextHash, idempotencyKey: 'risk-resume-old' })).rejects.toThrow(/tool effects changed/)
      repository.savePlan({ ...approvedOld, status: 'started', executionTurnId: 'old-turn' })
      expect((await orchestrator.conversationPolicy('risk-thread', project.id, 'old-turn')).allowedToolNames).not.toContain('report_export')
      expect(turns.startTurn).not.toHaveBeenCalled()
      expect(repository.getPlan(old.id)?.steps[0]?.risk).toBe('read')
    } finally { repository.close(); engineering.close() }
  })

  it('does not expose raw observation rows in the context snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-context-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'bounded', workspace: root, expectedRevision: 0, idempotencyKey: 'ctx-project-001' })
    await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'ctx-import-001', name: 'data.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1').toString('base64') })
    const snapshot = new EngineeringContextService(engineering).snapshot(project.id)
    expect(JSON.stringify(snapshot)).not.toContain('sourceFields')
    expect(snapshot.datasets[0]?.observationCount).toBe(1)
    expect(snapshot.watchDrafts).toEqual([])
    engineering.close()
  })

  it('keeps the context hash stable when only the snapshot timestamp changes', () => {
    const root = join(tmpdir(), `workwise-engineering-context-hash-${Date.now()}`)
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'stable-hash', workspace: root, expectedRevision: 0, idempotencyKey: 'ctx-hash-project-001' })
    let tick = 0
    const context = new EngineeringContextService(engineering, () => `2026-09-04T00:00:0${tick++}.000Z`)
    const first = context.snapshot(project.id)
    const second = context.snapshot(project.id)
    expect(second.generatedAt).not.toBe(first.generatedAt)
    expect(second.contextHash).toBe(first.contextHash)
    engineering.close()
  })

  it('selects survey tools for measurement and adjustment goals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-survey-ai-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'survey-ai', workspace: root, expectedRevision: 0, idempotencyKey: 'survey-ai-project-001' })
    const survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: (id) => engineering.getProject(id) })
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'survey-ai-network-001', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [{ id: 'BM-P', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    } })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-ai-network-check-001' })
    const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-ai-adjustment-001' })
    const repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime') })
    const context = new EngineeringContextService(engineering, undefined, survey)
    const snapshot = context.snapshot(project.id)
    expect(snapshot.surveyNetworks[0]).toMatchObject({ id: network.id, networkType: 'leveling', observationCount: 1 })
    expect(snapshot.surveyAdjustments[0]).toMatchObject({
      id: adjustment.run.id,
      strategyId: 'leveling',
      status: 'completed',
      sourceAdmission: {
        status: 'current-admissible',
        rawSourceIntegrity: { status: 'verified' },
        sourceEligibility: { eligible: true }
      }
    })
    expect(JSON.stringify(snapshot)).not.toContain('knownPoints')
    expect(JSON.stringify(snapshot)).not.toContain('observations')
    const orchestrator = new EngineeringAiOrchestrator({ context, repository, threadStore: { get: vi.fn(async () => ({ domain: 'engineering', projectId: project.id, turns: [] })) } as never, turns: { recordCompletedTurn: vi.fn() } as never, runTurn: vi.fn() })
    const plan = await orchestrator.createPlan({ threadId: 'survey-thread', projectId: project.id, goal: '对水准网执行加权最小二乘平差并检查闭合差', idempotencyKey: 'survey-ai-plan-001' })
    expect(plan.plan.steps.map((step) => step.tool)).toEqual([
      'survey_network_validate',
      'survey_calculator',
      'survey_adjustment_read',
      'report_export'
    ])
    repository.close()
    survey.close()
    engineering.close()
  })

  it('fails closed in AI context when a historical adjustment lacks current source-admission evidence', () => {
    const root = join(tmpdir(), `workwise-engineering-historical-context-${Date.now()}`)
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'historical context', workspace: root, expectedRevision: 0, idempotencyKey: 'historical-context-project' })
    const historicalSurvey = {
      listNetworks: () => [],
      listAdjustments: () => [{
        run: {
          id: 'adjustment-historical', networkId: 'network-historical', projectId: project.id,
          method: 'weighted-least-squares', constraint: 'fixed-known-points', algorithmVersion: 'historical', inputHash: 'historical-input',
          status: 'completed', revision: 1, idempotencyKey: 'historical-adjustment', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z'
        },
        result: {
          id: 'result-historical', networkId: 'network-historical', strategyId: 'leveling', algorithmVersion: 'historical', inputHash: 'historical-input',
          validation: 'valid', observationCount: 1, unknownCount: 1, degreesOfFreedom: 1
        }
      }]
    } as unknown as Pick<SurveyService, 'listNetworks' | 'listAdjustments'>

    const snapshot = new EngineeringContextService(engineering, undefined, historicalSurvey).snapshot(project.id)
    expect(snapshot.surveyAdjustments).toEqual([expect.objectContaining({
      id: 'adjustment-historical',
      sourceAdmission: {
        status: 'historical-non-admissible',
        rawSourceIntegrity: expect.objectContaining({ status: 'legacy-unverified' }),
        sourceEligibility: expect.objectContaining({
          eligible: false,
          findings: expect.arrayContaining([expect.objectContaining({ code: 'source_not_adjustment_ready' })])
        })
      }
    })])
    engineering.close()
  })

  it('marks a plan stale when the bounded context revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-stale-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'stale', workspace: root, expectedRevision: 0, idempotencyKey: 'stale-project-001' })
    const context = new EngineeringContextService(engineering)
    const threadStore = { get: vi.fn(async () => ({ domain: 'engineering', projectId: project.id, turns: [] })) }
    const events = { record: vi.fn(async () => undefined) }
    const repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime') })
    const orchestrator = new EngineeringAiOrchestrator({
      context,
      repository,
      threadStore: threadStore as never,
      turns: { recordCompletedTurn: vi.fn() } as never,
      runTurn: vi.fn(),
      events: events as never
    })
    const created = await orchestrator.createPlan({ threadId: 'thread-stale', projectId: project.id, goal: '检查数据', idempotencyKey: 'stale-plan-001' })
    engineering.updateProject(project.id, { name: 'stale-updated', expectedRevision: project.revision, idempotencyKey: 'stale-project-update-001' })
    await expect(Promise.resolve().then(() => orchestrator.validatePlan(created.plan.id, { expectedRevision: created.plan.revision, contextHash: created.plan.contextHash, idempotencyKey: 'stale-validate-001' }))).rejects.toThrow(/stale/i)
    expect(orchestrator.getPlan(created.plan.id)?.status).toBe('stale')
    expect(events.record).toHaveBeenCalled()
    repository.close()
    engineering.close()
  })

  it('rejects a thread outside the exact Engineering project before persisting or executing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-scope-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'scope', workspace: root, expectedRevision: 0, idempotencyKey: 'scope-project-001' })
    const repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime') })
    const turns = { recordCompletedTurn: vi.fn(), startTurn: vi.fn() }
    const runTurn = vi.fn()
    const orchestrator = new EngineeringAiOrchestrator({
      context: new EngineeringContextService(engineering),
      repository,
      threadStore: { get: vi.fn(async () => ({ domain: 'design', projectId: project.id, turns: [] })) } as never,
      turns: turns as never,
      runTurn
    })

    await expect(orchestrator.createPlan({
      threadId: 'wrong-thread',
      projectId: project.id,
      goal: '检查数据',
      idempotencyKey: 'scope-plan-001'
    })).rejects.toThrow(/not scoped/)
    expect(turns.recordCompletedTurn).not.toHaveBeenCalled()
    expect(turns.startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
    repository.close()
    engineering.close()
  })

  it('restores an awaiting-approval plan, token and idempotent result after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-restart-'))
    const runtimeRoot = join(root, 'runtime')
    const engineering = new EngineeringService({ rootDir: runtimeRoot })
    const project = engineering.createProject({ name: 'restart', workspace: root, expectedRevision: 0, idempotencyKey: 'restart-project-001' })
    const threadStore = { get: vi.fn(async () => ({ domain: 'engineering', projectId: project.id, turns: [] })) }
    const makeOrchestrator = (repository: EngineeringAiRepository) => new EngineeringAiOrchestrator({
      context: new EngineeringContextService(engineering),
      repository,
      threadStore: threadStore as never,
      turns: { recordCompletedTurn: vi.fn(async () => ({ threadId: 'restart-thread', turnId: 'draft-turn', userMessageItemId: 'draft-user', assistantMessageItemId: 'draft-assistant' })) } as never,
      runTurn: vi.fn()
    })
    const firstRepository = new EngineeringAiRepository({ rootDir: runtimeRoot })
    const first = makeOrchestrator(firstRepository)
    const created = await first.createPlan({ threadId: 'restart-thread', projectId: project.id, goal: '生成只读复核计划', idempotencyKey: 'restart-plan-001' })
    firstRepository.close()

    const reopenedRepository = new EngineeringAiRepository({ rootDir: runtimeRoot })
    const reopened = makeOrchestrator(reopenedRepository)
    const restored = await reopened.latestPlan({ threadId: 'restart-thread', projectId: project.id })
    const replay = await reopened.createPlan({ threadId: 'restart-thread', projectId: project.id, goal: '生成只读复核计划', idempotencyKey: 'restart-plan-001' })

    expect(restored?.plan).toEqual({ ...created.plan, execution: { complete: false, completedStepIds: [], pendingStepIds: created.plan.steps.map(step => step.id) } })
    expect(restored?.approval?.token).toBe(created.approval.token)
    expect(replay).toEqual(created)
    reopenedRepository.close()
    engineering.close()
  })

  it('persists bounded Watch drafts without exposing observation rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-watch-'))
    const engineering = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = engineering.createProject({ name: 'watch', workspace: root, expectedRevision: 0, idempotencyKey: 'watch-project-001' })
    const firstContext = new EngineeringContextService(engineering)
    const rule = await firstContext.addWatchDraft({ projectId: project.id, name: '沉降预警', expression: 'abs(value) >= threshold', idempotencyKey: 'watch-rule-001' })
    expect(rule.projectId).toBe(project.id)
    const restored = new EngineeringContextService(engineering).snapshot(project.id)
    expect(restored.watchDrafts[0]?.name).toBe('沉降预警')
    engineering.close()
  })
})
