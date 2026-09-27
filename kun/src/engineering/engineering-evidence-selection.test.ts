import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

describe('Exact Survey evidence selection', () => {
  it('reads a residual past the summary limit with its original byte anchor, and rejects stale or mismatched references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-evidence-'))
    const engineering = new EngineeringService({ rootDir: root })
    const project = engineering.createProject({ name: 'evidence', workspace: root, expectedRevision: 0, idempotencyKey: 'evidence-project' })
    const survey = new SurveyService({ rootDir: root, getProject: id => engineering.getProject(id) })
    try {
      const network = await importWorkwiseSurveyNetwork(survey, {
        projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'evidence-network', networkType: 'leveling',
        network: {
          knownPoints: [{ id: 'BM', known: true, pointClass: 'known', height: 10 }],
          unknownPoints: [{ id: 'P', known: false, pointClass: 'unknown', height: 10.1 }],
          observations: Array.from({ length: 31 }, (_, i) => ({ id: `obs-${i}`, type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }))
        }
      })
      const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'evidence-validate' })
      const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'evidence-adjust' })
      const context = new EngineeringContextService(engineering, undefined, survey)
      const selection = { networkId: network.id, networkRevision: checked.revision, sourceSha256: checked.sourceFile!.sha256, adjustmentId: adjustment.run.id, observationId: 'obs-30' }
      const evidence = context.conversationEvidence(project.id, selection) as { selectedObservation: { id: string; sourceRecordId: string }; selectedRawRecord: { id: string; rawOffset: number; rawLength: number; rawSnippet: string }; adjustments: Array<{ residuals: Array<{ observationId: string }> }> }
      expect(evidence.selectedObservation.id).toBe('obs-30')
      expect(evidence.selectedRawRecord.id).toBe(evidence.selectedObservation.sourceRecordId)
      expect(evidence.selectedRawRecord.rawOffset).toBeGreaterThan(0)
      expect(evidence.selectedRawRecord.rawLength).toBeGreaterThan(0)
      expect(evidence.selectedRawRecord.rawSnippet).toContain('obs-30')
      expect(evidence.adjustments[0]?.residuals.map(row => row.observationId)).toEqual(['obs-30'])
      expect(() => context.conversationEvidence(project.id, { ...selection, networkRevision: 999 })).toThrow(/stale/)
      expect(() => context.conversationEvidence(project.id, { ...selection, sourceSha256: 'changed' })).toThrow(/hash/)
      expect(() => context.conversationEvidence(project.id, { ...selection, sourceRecordId: checked.observations[0]!.sourceRecordId })).toThrow(/anchor does not match/)
      expect(() => context.conversationEvidence(project.id, { ...selection, observationId: 'missing' })).toThrow(/observation/)
      expect(() => context.conversationEvidence(project.id, { ...selection, diagnosticIndex: 999 })).toThrow(/diagnostic/)
      expect(context.conversationEvidence(project.id, { adjustmentId: adjustment.run.id, pointId: 'P' })).toMatchObject({ selectedPoint: { id: 'P' }, adjustments: [{ selectedAdjustedPoint: { id: 'P' } }] })
      expect(() => context.conversationEvidence(project.id, { pointId: 'P' })).toThrow(/requires/)
    } finally { survey.close(); engineering.close() }
  })

  it('resolves an exact historical output while refusing cross-project and mismatched delivery references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-delivery-evidence-'))
    const engineering = new EngineeringService({ rootDir: root })
    try {
      const project = engineering.createProject({ name: 'delivery', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'evidence-project' })
      const other = engineering.createProject({ name: 'other', workspace: root, expectedRevision: 0, idempotencyKey: 'evidence-other-project' })
      const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'evidence-import', name: 'data.csv', dataBase64: Buffer.from('point,time,value,unit\nA,2026-01-01,1,mm\nA,2026-01-02,2,mm').toString('base64') })
      const checked = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'evidence-validate' })
      const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: checked.revision, idempotencyKey: 'evidence-analyse' })
      const input = { projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: checked.revision }
      const preview = await engineering.previewReport({ ...input, idempotencyKey: 'evidence-preview' })
      const context = new EngineeringContextService(engineering)
      const evidence = context.conversationEvidence(project.id, { runId: preview.run.id, outputSha256: preview.files[1]!.sha256 })
      expect(evidence).toMatchObject({ selectedDelivery: { runId: preview.run.id, reviewStatus: 'draft', verification: 'recorded-metadata-only', outputCount: 4, outputs: [preview.files[1]] } })
      expect(engineering.getPreviewEvidence(other.id, preview.run.id)).toBeNull()
      expect(() => context.conversationEvidence(other.id, { runId: preview.run.id })).toThrow(/current Survey project/)
      expect(() => context.conversationEvidence(project.id, { runId: preview.run.id, outputSha256: 'wrong' })).toThrow(/output hash/)
      const manifest = await engineering.finalize({ ...input, idempotencyKey: 'evidence-finalize', acknowledgeWarnings: true })
      expect(context.conversationEvidence(project.id, { manifestId: manifest.id })).toMatchObject({ selectedDelivery: { manifestId: manifest.id, reviewStatus: 'draft' } })
      expect(() => context.conversationEvidence(other.id, { manifestId: manifest.id })).toThrow(/current Survey project/)
      expect(() => context.conversationEvidence(project.id, { manifestId: manifest.id, runId: preview.run.id })).toThrow(/does not match/)
    } finally { engineering.close() }
  })
})
