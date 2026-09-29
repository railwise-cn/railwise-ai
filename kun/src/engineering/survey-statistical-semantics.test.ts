import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AdjustmentResultV1 } from '../contracts/survey.js'
import { SurveyResidualStatisticV1 } from '../contracts/survey-statistical-semantics.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { residualStatistic, statisticalEvidenceSheets, statisticalReportLines } from './survey-statistical-semantics.js'

async function fixture(kind: 'relative' | 'prior' | 'none' | 'gnss-exact' | 'gnss-no-redundancy') {
  const root = await mkdtemp(join(tmpdir(), 'survey-semantics-'))
  const service = new SurveyService({ rootDir: root })
  onTestFinished(() => service.close())
  const gnss = kind.startsWith('gnss')
  const observations: Array<Record<string, unknown>> = gnss ? [{ id: 'base', type: 'gnss-baseline', from: 'A', to: 'P', value: 1, unit: 'm',
    vectorX: 1, vectorY: 2, vectorZ: 3, covariance: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] : [
    { id: 'forward', type: 'height-difference', from: 'A', to: 'P', value: 1, unit: 'm', routeLength: 1,
      ...(kind === 'prior' ? { sigma: 0.002, sigmaUnit: 'm' } : {}) },
    ...(kind === 'none' ? [] : [{ id: 'back', type: 'height-difference', from: 'P', to: 'A', value: -0.999, unit: 'm', routeLength: 4,
      ...(kind === 'prior' ? { sigma: 0.004, sigmaUnit: 'm' } : {}) }])
  ]
  if (kind === 'gnss-exact') observations.push({ ...observations[0]!, id: 'repeat' })
  const network = await importWorkwiseSurveyNetwork(service, { projectId: 'stats', expectedRevision: 0, idempotencyKey: 'stats-import',
    networkType: gnss ? 'gnss' : 'leveling', network: {
      coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL',
      knownPoints: [{ id: 'A', known: true, pointClass: 'known', x: 0, y: 0, height: 0 }],
      unknownPoints: [{ id: 'P', known: false, pointClass: 'unknown', x: 1, y: 2, height: gnss ? 3 : 1 }], observations
    } })
  const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'stats-validate' })
  const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'stats-adjust' })
  return { service, output }
}

describe('versioned residual semantics', () => {
  it('distinguishes relative weights from supplied prior sigmas using independent leveling arithmetic', async () => {
    for (const kind of ['relative', 'prior'] as const) {
      const { service, output } = await fixture(kind)
      const first = output.result.observations[0]!
      // WLS with a 4:1 weight ratio gives residuals -0.0002, -0.0008.
      expect(first.residual).toBeCloseTo(-0.0002, 13)
      expect(first.residualStatistic).toMatchObject({ status: 'available', significance: 'not-evaluated',
        method: kind === 'relative' ? 'weight-normalized-residual' : 'observation-sigma-ratio',
        scaleBasis: kind === 'relative' ? 'relative-weight' : 'declared-prior' })
      expect(first.standardizedResidual).toBeCloseTo(kind === 'relative' ? 0.0002 : 0.1, 12)
      const summary = output.result.statisticalSummary!
      expect(summary).toMatchObject({ numericalStatus: 'clear', availableCount: 2, unavailableCount: 0, standardsConformity: 'not-evaluated' })
      expect(summary.varianceLog10RatioToUnit).toBeCloseTo(Math.log10(kind === 'relative' ? 2e-7 : 0.05), 12)
      expect(summary.standardDeviationLog10RatioToUnit).toBeCloseTo(summary.varianceLog10RatioToUnit! / 2, 12)
      expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
    }
  })

  it.each(['none', 'gnss-no-redundancy', 'gnss-exact'] as const)('does not report untestable %s residuals as zero or a pass', async (kind) => {
    const { service, output } = await fixture(kind)
    expect(output.result.validation).toBe('valid')
    expect(output.result.statisticalSummary).toMatchObject({ numericalStatus: 'not-evaluated', availableCount: 0,
      unavailableCount: output.result.observations.length, varianceLog10RatioToUnit: null, standardDeviationLog10RatioToUnit: null })
    for (const row of output.result.observations) {
      expect(row.standardizedResidual).toBeUndefined()
      expect(row.residualStatistic).toMatchObject({ status: 'not-testable', reason: kind === 'gnss-exact' ? 'residual-variance-unresolved' : 'no-redundancy' })
    }
    const sheets = statisticalEvidenceSheets([output.result])
    expect(sheets[1]!.rows[1]!.slice(7, 10)).toEqual(['', '', ''])
    expect(statisticalReportLines(output.result).join('\n')).toContain('不可检验=')
    expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
  })

  it('keeps unavailable numeric values out of strict contracts and leaves absent legacy semantics absent', async () => {
    const { output } = await fixture('prior')
    const { statisticalSummary: _summary, ...legacy } = output.result
    legacy.observations = legacy.observations.map(({ residualStatistic: _statistic, ...row }) => row)
    const before = JSON.stringify(legacy)
    expect(AdjustmentResultV1.parse(legacy)).toEqual(legacy)
    expect(JSON.stringify(legacy)).toBe(before)
    expect(AdjustmentResultV1.parse(legacy).statisticalSummary).toBeUndefined()
    expect(statisticalReportLines(legacy)[0]).toContain('历史记录未保存')
    const unavailable = residualStatistic({ method: 'residual-sigma-ratio', scaleBasis: 'estimated-posterior' }, NaN, 3)
    expect(unavailable).toMatchObject({ status: 'not-testable', reason: 'numeric-unavailable' })
    expect(SurveyResidualStatisticV1.safeParse({ ...unavailable, value: 0 }).success).toBe(false)
  })
})
