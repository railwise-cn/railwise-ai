import { describe, expect, it } from 'vitest'
import { evidenceCardNavigationTarget, navigationTargetIsCurrent, planStepNavigationTarget, surveyNavigationTarget, type EngineeringNavigationContext } from './engineering-evidence-navigation'

const sha = 'a'.repeat(64)
const context: EngineeringNavigationContext = {
  workspaceRoot: '/survey', project: { id: 'project', revision: 3 },
  networks: [{ id: 'network', revision: 7, sourceFile: { sha256: sha } }],
  adjustments: [{ run: { id: 'run', networkId: 'network' } }],
  datasets: [{ id: 'dataset', revision: 2, sourceFileHash: sha, findings: [{ id: 'finding', code: 'missing', row: 21 }] }],
  analyses: [{ id: 'analysis', datasetId: 'dataset', inputHash: sha }],
  manifests: [{ id: 'manifest', runId: 'delivery-run', outputs: [{ path: 'out/report.pdf', sha256: sha }] }]
}
describe('exact engineering evidence navigation', () => {
  it('locates only literal current network revisions and refuses unresolved predecessor bindings', () => {
    const step = { tool: 'railwise.control_network', parameters: { networkId: 'network', expectedRevision: 7 } }
    expect(planStepNavigationTarget(context, 'project', step)).toMatchObject({ kind: 'survey', networkId: 'network', networkRevision: 7, sourceSha256: sha, section: 'network' })
    expect(planStepNavigationTarget(context, 'other-project', step)).toBeNull()
    expect(planStepNavigationTarget(context, 'project', { ...step, parameters: { networkId: 'network', expectedRevision: 6 } })).toBeNull()
    expect(planStepNavigationTarget(context, 'project', { ...step, parameterBindings: [{ parameter: 'expectedRevision' }] })).toBeNull()
    expect(planStepNavigationTarget(context, 'project', { ...step, parameters: undefined })).toBeNull()
  })
  it('requires an exact run for result reads and never chooses the latest run', () => {
    const step = { tool: 'survey_adjustment_read', parameters: { networkId: 'network', adjustmentId: 'run' } }
    expect(planStepNavigationTarget(context, 'project', step)).toMatchObject({ adjustmentId: 'run', section: 'result' })
    expect(planStepNavigationTarget(context, 'project', { ...step, parameters: { networkId: 'network' } })).toBeNull()
    expect(planStepNavigationTarget({ ...context, adjustments: [{ run: { id: 'run', networkId: 'other' } }] }, 'project', step)).toBeNull()
  })
  it('keeps selected record identifiers without truncating them to a visible table page', () => {
    const evidence = { projectId: 'project', projectRevision: 3, networkId: 'network', networkRevision: 7, sourceSha256: sha, section: 'preflight', sourceRecordId: 'record-121', diagnosticIndex: 120 }
    expect(surveyNavigationTarget(context, evidence)).toMatchObject({ sourceRecordId: 'record-121', diagnosticIndex: 120 })
    expect(surveyNavigationTarget(context, { ...evidence, sourceSha256: 'b'.repeat(64) })).toBeNull()
    expect(surveyNavigationTarget(context, { ...evidence, projectRevision: 2 })).toBeNull()
    expect(surveyNavigationTarget({ ...context, networks: [...context.networks, ...context.networks] }, evidence)).toBeNull()
  })
  it('matches finding identity, source digest and row locator together', () => {
    const card = { id: 'dataset:missing:21', kind: 'finding', sourceHash: sha, locator: 'row:21' }
    expect(evidenceCardNavigationTarget(context, card)).toMatchObject({ kind: 'dataset', datasetId: 'dataset', findingId: 'finding' })
    expect(evidenceCardNavigationTarget(context, { ...card, locator: 'row:22' })).toBeNull()
    expect(evidenceCardNavigationTarget(context, { ...card, sourceHash: 'b'.repeat(64) })).toBeNull()
    expect(evidenceCardNavigationTarget({ ...context, datasets: [...context.datasets, ...context.datasets] }, card)).toBeNull()
  })
  it('resolves exact status, analysis and output cards without parsing their display text', () => {
    expect(evidenceCardNavigationTarget(context, { id: 'dataset', kind: 'status', sourceHash: sha })).toMatchObject({ datasetId: 'dataset' })
    expect(evidenceCardNavigationTarget(context, { id: 'analysis:metric', kind: 'metric', sourceHash: sha })).toMatchObject({ analysisId: 'analysis' })
    expect(evidenceCardNavigationTarget(context, { id: 'manifest:out/report.pdf', kind: 'artifact', sourceHash: sha, locator: 'out/report.pdf' })).toMatchObject({ manifestId: 'manifest', runId: 'delivery-run', outputPath: 'out/report.pdf' })
    expect(evidenceCardNavigationTarget(context, { id: 'manifest:out/report.pdf', kind: 'artifact', sourceHash: sha, locator: '../out/report.pdf' })).toBeNull()
    expect(evidenceCardNavigationTarget(context, { id: 'dataset', kind: 'citation', sourceHash: sha })).toBeNull()
  })
  it('rechecks project revision, workspace and data revision when opening a prepared target', () => {
    const target = evidenceCardNavigationTarget(context, { id: 'dataset', kind: 'status', sourceHash: sha })!
    expect(navigationTargetIsCurrent(context, target)).toBe(true)
    expect(navigationTargetIsCurrent({ ...context, workspaceRoot: '/other' }, target)).toBe(false)
    expect(navigationTargetIsCurrent({ ...context, project: { ...context.project, revision: 4 } }, target)).toBe(false)
    expect(navigationTargetIsCurrent({ ...context, datasets: context.datasets.map(item => ({ ...item, revision: 3 })) }, target)).toBe(false)
  })
})
