import { describe, expect, it } from 'vitest'
import { projectAiPlanStatus, projectAiPlanSteps } from './EngineeringAiCommandCenter'
import { numberLabel } from './SurveyAdjustmentPanel'

describe('engineering agent surface contract', () => {
  it('exposes an explicit agent execution protocol alongside the conversation', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const source = await readFile(new URL('./EngineeringAiCommandCenter.tsx', import.meta.url), 'utf8')

    expect(source).toContain('<EngineeringComposer')
    expect(source).toContain("t('engineeringTypedPlan')")
    expect(source).toContain("t('engineeringApproveAndStart')")
    expect(source).toContain("t('engineeringEvidenceReturn')")
    expect(source).toContain('type="checkbox"')
    expect(source).toContain('needsApproval && !riskConfirmed')
    expect(source).toContain('activeThread.workspace === workspaceRoot')
  })

  it('makes the survey console method and constraint explicit', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const source = await readFile(new URL('./SurveyAdjustmentPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('survey-adjustment-method')
    expect(source).toContain('survey-constraint-mode')
    expect(source).toContain("t('surveyWeightModel')")
    expect(source).toContain("t('surveyFixedPoints')")
    expect(source).toContain("t('surveyWeightedLeastSquares')")
    expect(source).toContain("t('surveySigma0')")
    expect(source).toContain("t('surveyVarianceFactor',")
    expect(source).toContain("t('surveyStandardizedResidual')")
    expect(source).toContain("measurementLabel(t, residual.residual, residual.unit")
  })

  it('does not round a non-zero variance factor to zero', () => {
    expect(numberLabel(2e-7, 6)).toBe('2e-7')
    expect(numberLabel(0, 6)).toBe('0')
    expect(numberLabel(0.0004472135955, 6)).toBe('0.000447')
  })

  it('does not present approved steps as completed when TaskRun is stalled', () => {
    const plan = {
      id: 'plan-1',
      projectId: 'project-1',
      contextHash: 'sha256-context',
      revision: 3,
      goal: 'prepare reviewed deliverables',
      status: 'started',
      taskId: 'task-1',
      steps: [
        { id: 'inspect', title: '校核工程数据', tool: 'monitoring_data_first_check', risk: 'read', approval: 'approved' },
        { id: 'report', title: '准备报告', tool: 'report_export', risk: 'export', approval: 'approved' }
      ]
    }

    expect(projectAiPlanSteps(plan, 'stalled')).toEqual([
      expect.objectContaining({ title: '校核工程数据', state: 'blocked' }),
      expect.objectContaining({ title: '准备报告', state: 'blocked' })
    ])
    expect(projectAiPlanSteps(plan, 'running').map((step) => step.state)).toEqual(['ready', 'ready'])
    expect(projectAiPlanSteps(plan, 'completed').map((step) => step.state)).toEqual(['blocked', 'blocked'])
    expect(projectAiPlanStatus(plan, 'completed')).toBe('needs_attention')
    const partial = { ...plan, execution: { complete: false, completedStepIds: ['inspect'], pendingStepIds: ['report'] } }
    expect(projectAiPlanSteps(partial, 'completed').map(step => step.state)).toEqual(['done', 'blocked'])
    expect(projectAiPlanStatus(partial, 'completed')).toBe('needs_attention')
    const completed = { ...plan, execution: { complete: true, completedStepIds: ['inspect', 'report'], pendingStepIds: [] } }
    expect(projectAiPlanSteps(completed, 'completed').map(step => step.state)).toEqual(['done', 'done'])
    expect(projectAiPlanStatus(completed, 'completed')).toBe('completed')
    expect(projectAiPlanStatus({ ...partial, status: 'needs_attention' }, 'completed')).toBe('needs_attention')
    expect(projectAiPlanStatus({ ...partial, execution: { ...partial.execution, complete: true } }, 'completed')).toBe('needs_attention')
  })
})
