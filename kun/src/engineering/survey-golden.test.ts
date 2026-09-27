import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

describe('survey adjustment golden fixtures', () => {
  it('SURVEY-GOLDEN-LEVELING-001 adjusts a closed leveling route with inverse route-length weights', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-leveling-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'leveling-fixture', expectedRevision: 0, idempotencyKey: 'leveling-fixture-import', networkType: 'leveling', network: {
        knownPoints: [{ id: 'BM1', pointClass: 'known', height: 100, known: true }],
        unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 101, known: false }],
        observations: [
          { id: 'BM1-P1', type: 'height-difference', from: 'BM1', to: 'P1', value: 1, unit: 'm', routeLength: 1 },
          { id: 'P1-BM1', type: 'height-difference', from: 'P1', to: 'BM1', value: -0.999, unit: 'm', routeLength: 4 }
        ],
        instrumentParameters: { closedLoop: 1 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'leveling-fixture-validate' })
    expect(checked.qualityStatus).toBe('validated')
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'leveling-fixture-adjust' })

    // Independent two-observation solution:
    // x = (1 * 0 + 0.25 * -0.001) / (1 + 0.25) = -0.0002 m.
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('leveling')
    expect(output.result.closure.heightDifference).toBeCloseTo(0.001, 12)
    expect(output.result.closureUnits.heightDifference).toBe('m')
    expect(output.result.redundancy).toBe(1)
    expect(output.result.points.find((point) => point.id === 'P1')?.height).toBeCloseTo(100.9998, 10)
    expect(output.result.observations.find((item) => item.observationId === 'BM1-P1')?.residual).toBeCloseTo(-0.0002, 10)
    expect(output.result.observations.find((item) => item.observationId === 'P1-BM1')?.residual).toBeCloseTo(-0.0008, 10)
    expect(output.result.unitWeightStdDev).toBeCloseTo(Math.sqrt(2e-7), 12)
    expect(output.result.solverDiagnostics).toMatchObject({ iterations: 1, rank: 1 })
    service.close()
  })

  it('SURVEY-NEG-LEVELING-001 blocks a leveling network without a known height datum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-leveling-missing-datum-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'leveling-missing-datum', expectedRevision: 0, idempotencyKey: 'leveling-missing-datum-import', networkType: 'leveling', network: {
        knownPoints: [{ id: 'BM', pointClass: 'known', known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 1, known: false }],
        observations: [{ id: 'BM-P', type: 'height-difference', from: 'BM', to: 'P', value: 1, unit: 'm' }]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'leveling-missing-datum-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'leveling-missing-datum-adjust' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_datum', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('SURVEY-GOLDEN-HEIGHT-CONTROL-001 reports an attached height-control closure against two known benchmarks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-height-control-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'height-control-fixture', expectedRevision: 0, idempotencyKey: 'height-control-fixture-import', networkType: 'height-control', network: {
        knownPoints: [
          { id: 'BM-A', pointClass: 'known', height: 50, known: true },
          { id: 'BM-B', pointClass: 'known', height: 51, known: true }
        ],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 50.4, known: false }],
        observations: [
          { id: 'BM-A-P', type: 'height-difference', from: 'BM-A', to: 'P', value: 0.4, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
          { id: 'P-BM-B', type: 'height-difference', from: 'P', to: 'BM-B', value: 0.601, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'height-control-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'height-control-fixture-adjust' })

    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('height-control')
    expect(output.result.closure.heightDifference).toBeCloseTo(0.001, 12)
    expect(output.result.points.find((point) => point.id === 'P')?.height).toBeCloseTo(50.3995, 10)
    expect(output.result.observations.map((item) => item.residual)).toEqual([
      expect.closeTo(-0.0005, 10),
      expect.closeTo(-0.0005, 10)
    ])
    service.close()
  })

  it('SURVEY-NEG-HEIGHT-CONTROL-001 blocks height control without a known benchmark height', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-height-control-missing-datum-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'height-control-missing-datum', expectedRevision: 0, idempotencyKey: 'height-control-missing-datum-import', networkType: 'height-control', network: {
        knownPoints: [{ id: 'BM', pointClass: 'known', known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 0.5, known: false }],
        observations: [{ id: 'BM-P', type: 'height-difference', from: 'BM', to: 'P', value: 0.5, unit: 'm' }]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'height-control-missing-datum-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'height-control-missing-datum-adjust' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_datum', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('SURVEY-GOLDEN-PLANE-CONTROL-001 iteratively adjusts a mixed-observation plane-control fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-plane-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'plane-fixture', expectedRevision: 0, idempotencyKey: 'plane-fixture-import', networkType: 'plane-control', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, { id: 'B', pointClass: 'known', x: 100, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 0, y: 99.95, known: false }],
        observations: [
          { id: 'AP', type: 'distance', from: 'A', to: 'P', value: 100, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
          { id: 'BP', type: 'distance', from: 'B', to: 'P', value: Math.sqrt(10000 + 10000), unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
          { id: 'direction-AP', type: 'direction', from: 'A', to: 'P', value: 0, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' },
          { id: 'angle-APB', type: 'angle', station: 'P', left: 'A', right: 'B', value: 315, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'plane-fixture-validate' })
    expect(checked.qualityStatus).toBe('validated')
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'plane-fixture-adjust' })
    expect(output.run.status).toBe('completed')
    expect(output.result.validation).toBe('valid')
    expect(output.result.strategyId).toBe('plane-control')
    expect(output.result.redundancy).toBe(2)
    expect(output.result.observations.map((item) => item.unit)).toEqual(['m', 'm', 'rad', 'rad'])
    expect(output.result.solverDiagnostics?.iterations).toBeGreaterThan(1)
    expect(output.result.solverDiagnostics?.rank).toBe(2)
    const displacement = output.result.displacements.find((item) => item.pointId === 'P')
    expect(displacement?.kind).toBe('horizontal')
    expect(displacement?.dY).toBeCloseTo(0.05, 3)
    service.close()
  })

  it('SURVEY-NEG-PLANE-CONTROL-001 blocks rank-deficient repeated plane observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-plane-rank-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'plane-rank-fixture', expectedRevision: 0, idempotencyKey: 'plane-rank-fixture-import', networkType: 'plane-control', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 10, y: 0, known: false }],
        observations: [
          { id: 'AP-1', type: 'distance', from: 'A', to: 'P', value: 10, unit: 'm' },
          { id: 'AP-2', type: 'distance', from: 'A', to: 'P', value: 10, unit: 'm' }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'plane-rank-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'plane-rank-fixture-adjust' })
    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'rank_deficient', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('SURVEY-GOLDEN-TRIANGULATION-001 adjusts a triangulation fixture from three independent station angles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-triangulation-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'triangulation-fixture', expectedRevision: 0, idempotencyKey: 'triangulation-fixture-import', networkType: 'triangulation', network: {
        knownPoints: [
          { id: 'A', pointClass: 'known', x: 0, y: 0, known: true },
          { id: 'B', pointClass: 'known', x: 100, y: 0, known: true }
        ],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 50.2, y: 49.8, known: false }],
        observations: [
          { id: 'angle-A', type: 'angle', station: 'A', left: 'P', right: 'B', value: 45, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' },
          { id: 'angle-B', type: 'angle', station: 'B', left: 'A', right: 'P', value: 45, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' },
          { id: 'angle-P', type: 'angle', station: 'P', left: 'B', right: 'A', value: 90, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'triangulation-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'triangulation-fixture-adjust' })

    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('triangulation')
    expect(output.result.observationCount).toBe(3)
    expect(output.result.unknownCount).toBe(2)
    expect(output.result.redundancy).toBe(1)
    expect(output.result.points.find((point) => point.id === 'P')?.x).toBeCloseTo(50, 6)
    expect(output.result.points.find((point) => point.id === 'P')?.y).toBeCloseTo(50, 6)
    expect(output.result.observations.every((item) => item.unit === 'rad')).toBe(true)
    expect(output.result.solverDiagnostics?.iterations).toBeGreaterThan(1)
    expect(output.result.solverDiagnostics?.rank).toBe(2)
    service.close()
  })

  it.each([
    {
      name: 'distance-only observations',
      observations: [
        { id: 'AP', type: 'distance' as const, from: 'A', to: 'P', value: Math.sqrt(5000), unit: 'm' },
        { id: 'BP', type: 'distance' as const, from: 'B', to: 'P', value: Math.sqrt(5000), unit: 'm' }
      ],
      expectedCode: 'invalid_observation'
    },
    {
      name: 'malformed station angle',
      observations: [
        { id: 'angle-A', type: 'angle' as const, station: 'A', left: 'P', value: 45, unit: 'deg' },
        { id: 'angle-B', type: 'angle' as const, station: 'B', left: 'A', right: 'P', value: 45, unit: 'deg' }
      ],
      expectedCode: 'malformed_geometry'
    }
  ])('SURVEY-NEG-TRIANGULATION-001 blocks triangulation with $name', async ({ name, observations, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-triangulation-invalid-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: `triangulation-${name}`, expectedRevision: 0, idempotencyKey: `triangulation-${name}`, networkType: 'triangulation', network: {
        knownPoints: [
          { id: 'A', pointClass: 'known', x: 0, y: 0, known: true },
          { id: 'B', pointClass: 'known', x: 100, y: 0, known: true }
        ],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 50, y: 50, known: false }],
        observations
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `triangulation-validate-${name}` })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `triangulation-adjust-${name}` })

    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.strategyId).toBe('triangulation')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('SURVEY-GOLDEN-TRAVERSE-001 adjusts an ordered traverse using its distance and turn-angle equations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-traverse-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'traverse-fixture', expectedRevision: 0, idempotencyKey: 'traverse-fixture-import', networkType: 'traverse', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, { id: 'B', pointClass: 'known', x: 100, y: 100, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 0.2, y: 99.8, known: false }],
        observations: [
          { id: 'A-P', type: 'distance', from: 'A', to: 'P', value: 100, unit: 'm', sigma: 0.002, sigmaUnit: 'm' },
          { id: 'P-B', type: 'distance', from: 'P', to: 'B', value: 100, unit: 'm', sigma: 0.002, sigmaUnit: 'm' },
          { id: 'turn-P', type: 'angle', station: 'P', left: 'A', right: 'B', value: 270, unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' }
        ],
        instrumentParameters: { startAzimuthDeg: 0, endAzimuthDeg: 90 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'traverse-fixture-validate' })
    expect(checked.qualityStatus).toBe('validated')
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'traverse-fixture-adjust' })

    expect(output.run.status).toBe('completed')
    expect(output.result.validation).toBe('valid')
    expect(output.result.strategyId).toBe('traverse')
    expect(output.result.observationCount).toBe(3)
    expect(output.result.algorithmVersion).toBe('workwise-survey-adjustment-7')
    expect(output.result.redundancy).toBe(1)
    expect(output.result.points.find((point) => point.id === 'P')).toMatchObject({ id: 'P' })
    expect(output.result.points.find((point) => point.id === 'P')?.x).toBeCloseTo(0, 6)
    expect(output.result.points.find((point) => point.id === 'P')?.y).toBeCloseTo(100, 6)
    expect(output.result.closure.fx).toBeCloseTo(0, 12)
    expect(output.result.closure.fy).toBeCloseTo(0, 12)
    expect(output.result.closure.relativeClosure).toBeCloseTo(0, 12)
    expect(output.result.closure.angular).toBeCloseTo(0, 12)
    expect(output.result.closureUnits).toEqual({ fx: 'm', fy: 'm', relativeClosure: 'ratio', angular: 'rad' })
    expect(output.result.observations.map((item) => item.unit)).toEqual(['m', 'm', 'rad'])
    expect(output.result.solverDiagnostics?.iterations).toBeGreaterThan(1)
    expect(output.result.solverDiagnostics?.rank).toBe(2)
    service.close()
  })

  it.each([
    {
      name: 'unordered edges',
      observations: [
        { id: 'P-B', type: 'distance' as const, from: 'P', to: 'B', value: 100, unit: 'm' },
        { id: 'A-P', type: 'distance' as const, from: 'A', to: 'P', value: 100, unit: 'm' },
        { id: 'turn-P', type: 'angle' as const, station: 'P', left: 'A', right: 'B', value: 270, unit: 'deg' }
      ],
      expectedCode: 'malformed_geometry'
    },
    {
      name: 'missing orientation',
      observations: [
        { id: 'A-P', type: 'distance' as const, from: 'A', to: 'P', value: 100, unit: 'm' },
        { id: 'P-B', type: 'distance' as const, from: 'P', to: 'B', value: 100, unit: 'm' },
        { id: 'unrelated-direction', type: 'direction' as const, from: 'A', to: 'B', value: 45, unit: 'deg' }
      ],
      expectedCode: 'malformed_geometry'
    },
    {
      name: 'unknown end datum',
      observations: [
        { id: 'A-P', type: 'distance' as const, from: 'A', to: 'P', value: 100, unit: 'm' },
        { id: 'P-B', type: 'distance' as const, from: 'P', to: 'B', value: 100, unit: 'm' },
        { id: 'turn-P', type: 'angle' as const, station: 'P', left: 'A', right: 'B', value: 270, unit: 'deg' }
      ],
      expectedCode: 'missing_datum'
    }
  ])('SURVEY-NEG-TRAVERSE-001 blocks a traverse with $name', async ({ name, observations, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-traverse-invalid-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: `traverse-invalid-${name}`, expectedRevision: 0, idempotencyKey: `traverse-invalid-${name}`, networkType: 'traverse', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, ...(name === 'unknown end datum' ? [] : [{ id: 'B', pointClass: 'known' as const, x: 100, y: 100, known: true }])],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 0, y: 100, known: false }, ...(name === 'unknown end datum' ? [{ id: 'B', pointClass: 'unknown' as const, x: 100, y: 100, known: false }] : [])],
        observations,
        instrumentParameters: name === 'missing orientation' ? {} : { startAzimuthDeg: 0 }
      }
    })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `traverse-invalid-adjust-${name}` })
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.strategyId).toBe('traverse')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('blocks a rank-deficient traverse instead of returning partial coordinates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-traverse-rank-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'traverse-rank', expectedRevision: 0, idempotencyKey: 'traverse-rank-import', networkType: 'traverse', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, { id: 'B', pointClass: 'known', x: 100, y: 100, known: true }],
        unknownPoints: [
          { id: 'P', pointClass: 'unknown', x: 0, y: 100, known: false },
          { id: 'Q', pointClass: 'unknown', x: 50, y: 50, known: false }
        ],
        observations: [
          { id: 'A-P', type: 'distance', from: 'A', to: 'P', value: 100, unit: 'm' },
          { id: 'P-B', type: 'distance', from: 'P', to: 'B', value: 100, unit: 'm' },
          { id: 'turn-P', type: 'angle', station: 'P', left: 'A', right: 'B', value: 270, unit: 'deg' }
        ],
        instrumentParameters: { startAzimuthDeg: 0 }
      }
    })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'traverse-rank-adjust' })
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'rank_deficient', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it.each([
    { caseId: 'SURVEY-GOLDEN-CPIII-FREE-STATION-001', networkType: 'cpiii-free-station' as const },
    { caseId: 'SURVEY-GOLDEN-CPIII-RESECTION-001', networkType: 'cpiii-resection' as const }
  ])('$caseId solves $networkType with station orientation and paired vertical evidence', async ({ networkType }) => {
    const root = await mkdtemp(join(tmpdir(), `workwise-${networkType}-fixture-`))
    const service = new SurveyService({ rootDir: root })
    const station = { x: 40, y: 30, height: 8 }
    const targets = {
      A: { x: 0, y: 0, height: 10 },
      B: { x: 100, y: 0, height: 12 },
      C: { x: 0, y: 100, height: 11 }
    }
    const orientationDeg = 10
    const directionReading = (target: { x: number; y: number }): number => {
      const bearing = Math.atan2(target.x - station.x, target.y - station.y) * 180 / Math.PI
      return ((bearing - orientationDeg) % 360 + 360) % 360
    }
    const horizontalA = Math.hypot(targets.A.x - station.x, targets.A.y - station.y)
    const deltaHeightA = (targets.A.height + 1.8) - (station.height + 1.5)
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: `${networkType}-fixture`, expectedRevision: 0, idempotencyKey: `${networkType}-fixture-import`, networkType, network: {
        knownPoints: Object.entries(targets).map(([id, point]) => ({ id, pointClass: 'known' as const, ...point, known: true })),
        unknownPoints: [{ id: 'S1', pointClass: 'station', x: 40.2, y: 29.8, height: 8.1, known: false }],
        observations: [
          ...Object.entries(targets).map(([id, point]) => ({ id: `direction-S1-${id}`, type: 'direction' as const, station: 'S1', target: id, value: directionReading(point), unit: 'deg', sigma: 2, sigmaUnit: 'arcsec' })),
          { id: 'slope-S1-A', type: 'slope-distance', station: 'S1', target: 'A', value: Math.hypot(horizontalA, deltaHeightA), unit: 'm', sigma: 0.002, sigmaUnit: 'm', stationHeightOffset: 1.5, targetHeightOffset: 1.8 },
          { id: 'zenith-S1-A', type: 'zenith', station: 'S1', target: 'A', value: Math.atan2(horizontalA, deltaHeightA), unit: 'rad', sigma: 2, sigmaUnit: 'arcsec', stationHeightOffset: 1.5, targetHeightOffset: 1.8 }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `${networkType}-fixture-validate` })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `${networkType}-fixture-adjust` })

    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe(networkType)
    expect(output.result.unknownCount).toBe(4)
    expect(output.result.redundancy).toBe(1)
    expect(output.result.points.find((point) => point.id === 'S1')?.x).toBeCloseTo(station.x, 6)
    expect(output.result.points.find((point) => point.id === 'S1')?.y).toBeCloseTo(station.y, 6)
    expect(output.result.points.find((point) => point.id === 'S1')?.height).toBeCloseTo(station.height, 6)
    expect(output.result.parameters['orientation:S1']).toBeCloseTo(orientationDeg * Math.PI / 180, 8)
    expect(output.result.parameterUnits['orientation:S1']).toBe('rad')
    expect(output.result.observations.map((item) => item.unit)).toEqual(['rad', 'rad', 'rad', 'm', 'rad'])
    expect(output.result.solverDiagnostics?.iterations).toBeGreaterThan(1)
    expect(output.result.solverDiagnostics?.rank).toBe(4)
    service.close()
  })

  it.each([
    { caseId: 'SURVEY-NEG-CPIII-FREE-STATION-001', networkType: 'cpiii-free-station' as const, name: 'fewer than three fixed directions', includeThirdDirection: false, includeSlope: false, includeZenith: false, targetHeight: 10, expectedCode: 'malformed_geometry' },
    { caseId: 'SURVEY-NEG-CPIII-RESECTION-001', networkType: 'cpiii-resection' as const, name: 'fewer than three fixed directions', includeThirdDirection: false, includeSlope: false, includeZenith: false, targetHeight: 10, expectedCode: 'malformed_geometry' },
    { caseId: 'SURVEY-NEG-CPIII-FREE-STATION-002', networkType: 'cpiii-free-station' as const, name: 'unpaired slope distance', includeThirdDirection: true, includeSlope: true, includeZenith: false, targetHeight: 10, expectedCode: 'malformed_geometry' },
    { caseId: 'SURVEY-NEG-CPIII-FREE-STATION-003', networkType: 'cpiii-free-station' as const, name: 'missing vertical datum', includeThirdDirection: true, includeSlope: true, includeZenith: true, targetHeight: undefined, expectedCode: 'missing_datum' }
  ])('$caseId blocks $networkType with $name', async ({ networkType, name, includeThirdDirection, includeSlope, includeZenith, targetHeight, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-cpiii-invalid-'))
    const service = new SurveyService({ rootDir: root })
    const directions = [
      { id: 'direction-A', type: 'direction' as const, station: 'S', target: 'A', value: 220, unit: 'deg' },
      { id: 'direction-B', type: 'direction' as const, station: 'S', target: 'B', value: 110, unit: 'deg' },
      ...(includeThirdDirection ? [{ id: 'direction-C', type: 'direction' as const, station: 'S', target: 'C', value: 320, unit: 'deg' }] : [])
    ]
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: `cpiii-${networkType}-${name}`, expectedRevision: 0, idempotencyKey: `cpiii-${networkType}-${name}`, networkType, network: {
        knownPoints: [
          { id: 'A', pointClass: 'known', x: 0, y: 0, ...(targetHeight === undefined ? {} : { height: targetHeight }), known: true },
          { id: 'B', pointClass: 'known', x: 100, y: 0, height: 12, known: true },
          { id: 'C', pointClass: 'known', x: 0, y: 100, height: 11, known: true }
        ],
        unknownPoints: [{ id: 'S', pointClass: 'station', x: 40, y: 30, height: 8, known: false }],
        observations: [
          ...directions,
          ...(includeSlope ? [{ id: 'slope-A', type: 'slope-distance' as const, station: 'S', target: 'A', value: 50, unit: 'm' }] : []),
          ...(includeZenith ? [{ id: 'zenith-A', type: 'zenith' as const, station: 'S', target: 'A', value: 90, unit: 'deg' }] : [])
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `cpiii-invalid-validate-${name}` })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `cpiii-invalid-adjust-${name}` })

    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.strategyId).toBe(networkType)
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('SURVEY-GOLDEN-GNSS-001 adjusts correlated GNSS vector baselines against a fixed 3-D datum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-gnss-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const covariance = [4e-6, 1e-6, 0.2e-6, 1e-6, 9e-6, 0.3e-6, 0.2e-6, 0.3e-6, 4e-6]
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gnss-fixture', expectedRevision: 0, idempotencyKey: 'gnss-fixture-import', networkType: 'gnss', network: {
        knownPoints: [
          { id: 'A', pointClass: 'known', x: 0, y: 0, height: 10, known: true },
          { id: 'B', pointClass: 'known', x: 100, y: 0, height: 20, known: true }
        ],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 9.9, y: 19.9, height: 29.9, known: false }],
        observations: [
          { id: 'A-P', type: 'gnss-baseline', from: 'A', to: 'P', value: 0, vectorX: 10.001, vectorY: 20, vectorZ: 20, unit: 'm', covariance },
          { id: 'B-P', type: 'gnss-baseline', from: 'B', to: 'P', value: 0, vectorX: -90, vectorY: 20.002, vectorZ: 10, unit: 'm', covariance }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'gnss-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'gnss-fixture-adjust' })

    // Independent GLS reference for equal covariance blocks: the adjusted
    // point is the arithmetic mean of the two datum-derived coordinates.
    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('gnss')
    expect(output.result.inputHash).toBe(output.run.inputHash)
    expect(output.result.linearUnit).toBe('m')
    expect(output.result.observationCount).toBe(6)
    expect(output.result.unknownCount).toBe(3)
    expect(output.result.redundancy).toBe(3)
    expect(output.result.degreesOfFreedom).toBe(3)
    expect(output.result.solverDiagnostics).toMatchObject({ iterations: 1, rank: 3 })
    expect(output.result.points.find((point) => point.id === 'P')).toMatchObject({
      x: expect.closeTo(10.0005, 10),
      y: expect.closeTo(20.001, 10),
      height: expect.closeTo(30, 10)
    })
    expect(output.result.observations.map((item) => [item.observationId, item.unit, item.residual])).toEqual([
      ['A-P:x', 'm', expect.closeTo(-0.0005, 10)],
      ['A-P:y', 'm', expect.closeTo(0.001, 10)],
      ['A-P:z', 'm', expect.closeTo(0, 10)],
      ['B-P:x', 'm', expect.closeTo(0.0005, 10)],
      ['B-P:y', 'm', expect.closeTo(-0.001, 10)],
      ['B-P:z', 'm', expect.closeTo(0, 10)]
    ])
    expect(output.result.closure.baselineX).toBeCloseTo(Math.sqrt(5e-7), 12)
    expect(output.result.closure.baselineY).toBeCloseTo(Math.sqrt(2e-6), 12)
    expect(output.result.closure.baselineZ).toBeCloseTo(0, 12)
    expect(output.result.closure.baseline).toBeCloseTo(Math.sqrt(2.5e-6), 12)
    expect(output.result.covariance).toHaveLength(3)
    service.close()
  })

  it.each([
    {
      name: 'legacy scalar baseline',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 0, y: 0, height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown' as const, x: 1, y: 2, height: 3, known: false }],
      observations: [{ id: 'scalar', type: 'gnss-baseline' as const, from: 'A', to: 'P', value: 3.7, unit: 'm', covariance: [1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6] }],
      expectedCode: 'invalid_observation'
    },
    {
      name: 'missing covariance',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 0, y: 0, height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown' as const, x: 1, y: 2, height: 3, known: false }],
      observations: [{ id: 'no-covariance', type: 'gnss-baseline' as const, from: 'A', to: 'P', value: 0, vectorX: 1, vectorY: 2, vectorZ: -7, unit: 'm' }],
      expectedCode: 'missing_covariance'
    },
    {
      name: 'non-positive-definite covariance',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 0, y: 0, height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown' as const, x: 1, y: 2, height: 3, known: false }],
      observations: [{ id: 'bad-covariance', type: 'gnss-baseline' as const, from: 'A', to: 'P', value: 0, vectorX: 1, vectorY: 2, vectorZ: -7, unit: 'm', covariance: [1, 2, 0, 2, 1, 0, 0, 0, 1] }],
      expectedCode: 'invalid_observation'
    },
    {
      name: 'incomplete fixed datum',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 0, y: 0, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown' as const, x: 1, y: 2, height: 3, known: false }],
      observations: [{ id: 'no-height-datum', type: 'gnss-baseline' as const, from: 'A', to: 'P', value: 0, vectorX: 1, vectorY: 2, vectorZ: 3, unit: 'm', covariance: [1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6] }],
      expectedCode: 'missing_datum'
    }
  ])('SURVEY-NEG-GNSS-001 blocks GNSS with $name', async ({ name, knownPoints, unknownPoints, observations, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-gnss-invalid-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: `gnss-${name}`, expectedRevision: 0, idempotencyKey: `gnss-${name}`, networkType: 'gnss', network: { knownPoints, unknownPoints, observations } })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `gnss-validate-${name}` })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `gnss-adjust-${name}` })
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.strategyId).toBe('gnss')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('blocks a rank-deficient GNSS network with an unobserved unknown point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-gnss-rank-'))
    const service = new SurveyService({ rootDir: root })
    const covariance = [1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6]
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gnss-rank', expectedRevision: 0, idempotencyKey: 'gnss-rank-import', networkType: 'gnss', network: {
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, height: 10, known: true }],
        unknownPoints: [
          { id: 'P', pointClass: 'unknown', x: 1, y: 2, height: 3, known: false },
          { id: 'Q', pointClass: 'unknown', x: 4, y: 5, height: 6, known: false }
        ],
        observations: [{ id: 'A-P', type: 'gnss-baseline', from: 'A', to: 'P', value: 0, vectorX: 1, vectorY: 2, vectorZ: -7, unit: 'm', covariance }]
      }
    })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'gnss-rank-adjust' })
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'rank_deficient', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('estimates and applies a seven-parameter 3-D Helmert transformation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-helmert7-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const sourcePoints = [
      { id: 'A', x: 1000, y: 2000, height: 3000, targetX: 1000.99, targetY: 1998.004, targetHeight: 3003.01 },
      { id: 'B', x: 1100, y: 2000, height: 3000, targetX: 1100.9902, targetY: 1998.0043, targetHeight: 3003.0102 },
      { id: 'C', x: 1000, y: 2100, height: 3050, targetX: 1000.9896, targetY: 2098.00415, targetHeight: 3053.0102 },
      { id: 'D', x: 1050, y: 2070, height: 3100, targetX: 1050.98969, targetY: 2068.00419, targetHeight: 3103.01037 }
    ]
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'helmert7-fixture', expectedRevision: 0, idempotencyKey: 'helmert7-fixture-import', networkType: 'coordinate-transform', network: {
        transformType: 'helmert-7',
        knownPoints: sourcePoints.map(({ id, x, y, height }) => ({ id, pointClass: 'known', x, y, height, known: true })),
        unknownPoints: [{ id: 'T', pointClass: 'unknown', x: 1025, y: 2050, height: 3025, known: false }],
        observations: sourcePoints.map(({ id, targetX, targetY, targetHeight }) => ({ id: `pair-${id}`, type: 'coordinate-pair', from: id, value: 0, unit: 'm', sigma: 0.001, sigmaUnit: 'm', targetX, targetY, targetHeight }))
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'helmert7-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'helmert7-fixture-adjust' })
    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.status).toBe('completed')
    expect(output.run.method).toBe('helmert-seven-parameter')
    expect(output.result.transformType).toBe('helmert-7')
    expect(output.result.unknownCount).toBe(7)
    expect(output.result.observationCount).toBe(12)
    expect(output.result.degreesOfFreedom).toBe(5)
    expect(output.result.solverDiagnostics?.rank).toBe(7)
    expect(output.result.parameters).toMatchObject({ translationX: expect.closeTo(1, 7), translationY: expect.closeTo(-2, 7), translationZ: expect.closeTo(3, 7), scalePpm: expect.closeTo(2, 7), rotationX: expect.closeTo(1e-6, 10), rotationY: expect.closeTo(-2e-6, 10), rotationZ: expect.closeTo(3e-6, 10) })
    expect(output.result.points.find((point) => point.id === 'T')).toMatchObject({ x: expect.closeTo(1025.98985, 6), y: expect.closeTo(2048.00415, 6), height: expect.closeTo(3028.01015, 6) })
    service.close()
  })

  it('fits a deterministic height correction plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-height-fit-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const controls = [
      { id: 'A', x: 0, y: 0, targetHeight: 100.5 },
      { id: 'B', x: 100, y: 0, targetHeight: 100.6 },
      { id: 'C', x: 0, y: 100, targetHeight: 100.3 },
      { id: 'D', x: 100, y: 100, targetHeight: 100.4 }
    ]
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'height-fit-fixture', expectedRevision: 0, idempotencyKey: 'height-fit-fixture-import', networkType: 'coordinate-transform', network: {
        transformType: 'height-fit',
        knownPoints: controls.map(({ id, x, y }) => ({ id, pointClass: 'known', x, y, height: 100, known: true })),
        unknownPoints: [{ id: 'T', pointClass: 'unknown', x: 50, y: 50, height: 100, known: false }],
        observations: controls.map(({ id, targetHeight }) => ({ id: `height-${id}`, type: 'coordinate-pair', from: id, value: 0, unit: 'm', sigma: 0.001, sigmaUnit: 'm', targetHeight }))
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'height-fit-fixture-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'height-fit-fixture-adjust' })
    expect(checked.qualityStatus).toBe('validated')
    expect(output.run.method).toBe('height-fit')
    expect(output.result.transformType).toBe('height-fit')
    expect(output.result.parameters).toMatchObject({ heightOffset: expect.closeTo(0.5, 10), heightSlopeX: expect.closeTo(0.001, 10), heightSlopeY: expect.closeTo(-0.002, 10) })
    expect(output.result.points.find((point) => point.id === 'T')?.height).toBeCloseTo(100.45, 10)
    expect(output.result.degreesOfFreedom).toBe(1)
    service.close()
  })

  it('performs Gauss-Kruger forward and inverse conversion with explicit datum metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-gauss-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const forward = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gauss-forward', expectedRevision: 0, idempotencyKey: 'gauss-forward-import', networkType: 'coordinate-transform', network: {
        transformType: 'gauss-kruger-forward', ellipsoid: 'CGCS2000', centralMeridian: 120,
        knownPoints: [{ id: 'G', pointClass: 'known', latitude: 30, longitude: 120.5, height: 12, known: true }], unknownPoints: [], observations: [], instrumentParameters: { falseEasting: 1 }
      }
    })
    const checkedForward = service.validateNetwork(forward.id, { expectedRevision: forward.revision, idempotencyKey: 'gauss-forward-validate' })
    const forwardOutput = service.createAdjustment({ networkId: forward.id, expectedRevision: checkedForward.revision, idempotencyKey: 'gauss-forward-adjust' })
    const projected = forwardOutput.result.points.find((point) => point.id === 'G')!
    expect(forwardOutput.run.status).toBe('completed')
    expect(forwardOutput.result.transformType).toBe('gauss-kruger-forward')
    expect(projected.x).toBeCloseTo(3320218.650437519, 6)
    expect(projected.y).toBeCloseTo(548243.4486061679, 6)

    const inverse = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gauss-inverse', expectedRevision: 0, idempotencyKey: 'gauss-inverse-import', networkType: 'coordinate-transform', network: {
        transformType: 'gauss-kruger-inverse', ellipsoid: 'CGCS2000', centralMeridian: 120,
        knownPoints: [{ id: 'G', pointClass: 'known', x: projected.x, y: projected.y, height: 12, known: true }], unknownPoints: [], observations: [], instrumentParameters: { falseEasting: 1 }
      }
    })
    const inverseOutput = service.createAdjustment({ networkId: inverse.id, expectedRevision: inverse.revision, idempotencyKey: 'gauss-inverse-adjust' })
    expect(inverseOutput.run.status).toBe('completed')
    expect(inverseOutput.result.transformType).toBe('gauss-kruger-inverse')
    expect(inverseOutput.result.points.find((point) => point.id === 'G')).toMatchObject({ latitude: expect.closeTo(30, 8), longitude: expect.closeTo(120.5, 8) })
    service.close()
  })

  it('round-trips Gauss-Kruger coordinates with both a zone prefix and false easting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-gauss-zone-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const forward = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gauss-zone-forward', expectedRevision: 0, idempotencyKey: 'gauss-zone-forward-import', networkType: 'coordinate-transform', network: {
        transformType: 'gauss-kruger-forward', ellipsoid: 'CGCS2000', centralMeridian: 120,
        knownPoints: [{ id: 'G', pointClass: 'known', latitude: 30, longitude: 120.5, known: true }], unknownPoints: [], observations: [],
        instrumentParameters: { falseEasting: 1, zonePrefix: 1 }
      }
    })
    const projectedOutput = service.createAdjustment({ networkId: forward.id, expectedRevision: forward.revision, idempotencyKey: 'gauss-zone-forward-adjust' })
    const projected = projectedOutput.result.points.find((point) => point.id === 'G')!
    expect(projected.y).toBeCloseTo(40_548_243.44860617, 6)

    const inverse = await importWorkwiseSurveyNetwork(service, {
      projectId: 'gauss-zone-inverse', expectedRevision: 0, idempotencyKey: 'gauss-zone-inverse-import', networkType: 'coordinate-transform', network: {
        transformType: 'gauss-kruger-inverse', ellipsoid: 'CGCS2000', centralMeridian: 120,
        knownPoints: [{ id: 'G', pointClass: 'known', x: projected.x, y: projected.y, known: true }], unknownPoints: [], observations: [],
        instrumentParameters: { falseEasting: 1, zonePrefix: 1 }
      }
    })
    const geographicOutput = service.createAdjustment({ networkId: inverse.id, expectedRevision: inverse.revision, idempotencyKey: 'gauss-zone-inverse-adjust' })
    expect(geographicOutput.result.points.find((point) => point.id === 'G')).toMatchObject({ latitude: expect.closeTo(30, 8), longitude: expect.closeTo(120.5, 8) })
    service.close()
  })

  it('archives a coordinate transform whose point coordinates use mm without a frozen point-unit mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-transform-units-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'transform-units', expectedRevision: 0, idempotencyKey: 'transform-units-import', networkType: 'coordinate-transform', network: {
        transformType: 'similarity-2d', unit: 'mm',
        knownPoints: [{ id: 'P', pointClass: 'known', x: 10_000, y: 20_000, known: true }], unknownPoints: [], observations: [],
        instrumentParameters: { translationX: 1_000, translationY: 2_000, rotationDeg: 0, scalePpm: 0 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'transform-units-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'transform-units-adjust' })
    expect(network.sourceFile?.disposition).toBe('archive-only')
    expect(network.sourceFile?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_record', severity: 'blocking' })
    ]))
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' })
    ]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('blocks partial explicit parameters even when control pairs could be fitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-transform-partial-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'transform-partial', expectedRevision: 0, idempotencyKey: 'transform-partial-import', networkType: 'coordinate-transform', network: {
        transformType: 'similarity-2d',
        knownPoints: [
          { id: 'A', pointClass: 'known', x: 0, y: 0, known: true },
          { id: 'B', pointClass: 'known', x: 100, y: 0, known: true }
        ],
        unknownPoints: [],
        observations: [
          { id: 'pair-A', type: 'coordinate-pair', from: 'A', value: 0, unit: 'm', targetX: 5, targetY: 7 },
          { id: 'pair-B', type: 'coordinate-pair', from: 'B', value: 0, unit: 'm', targetX: 105, targetY: 7 }
        ],
        instrumentParameters: { translationX: 5 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'transform-partial-validate' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'transform-partial-adjust' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_observation', severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it.each([
    {
      name: 'incomplete similarity parameters',
      transformType: 'similarity-2d' as const,
      centralMeridian: undefined,
      ellipsoid: 'CGCS2000',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 0, y: 0, known: true }],
      observations: [] as Array<Record<string, unknown>>,
      instrumentParameters: { translationX: 0 },
      expectedCode: 'missing_datum'
    },
    {
      name: 'incomplete seven parameters',
      transformType: 'helmert-7' as const,
      centralMeridian: undefined,
      ellipsoid: 'CGCS2000',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 1, y: 2, height: 3, known: true }],
      observations: [] as Array<Record<string, unknown>>,
      instrumentParameters: { translationX: 1, translationY: 2, translationZ: 3 },
      expectedCode: 'missing_datum'
    },
    {
      name: 'missing Gauss meridian',
      transformType: 'gauss-kruger-forward' as const,
      centralMeridian: undefined,
      ellipsoid: 'CGCS2000',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, latitude: 30, longitude: 120, known: true }],
      observations: [] as Array<Record<string, unknown>>,
      instrumentParameters: {},
      expectedCode: 'missing_datum'
    },
    {
      name: 'unsupported ellipsoid',
      transformType: 'gauss-kruger-inverse' as const,
      centralMeridian: 120,
      ellipsoid: 'unknown',
      knownPoints: [{ id: 'A', pointClass: 'known' as const, x: 3320000, y: 500000, known: true }],
      observations: [] as Array<Record<string, unknown>>,
      instrumentParameters: {},
      expectedCode: 'missing_datum'
    }
  ])('blocks coordinate transformation with $name instead of applying identity', async ({ name, transformType, centralMeridian, ellipsoid, knownPoints, observations, instrumentParameters, expectedCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-transform-invalid-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: `transform-${name}`, expectedRevision: 0, idempotencyKey: `transform-${name}`, networkType: 'coordinate-transform', network: { transformType, ...(centralMeridian === undefined ? {} : { centralMeridian }), ellipsoid, knownPoints, unknownPoints: [], observations, instrumentParameters } })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `transform-validate-${name}` })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `transform-adjust-${name}` })
    expect(checked.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: expectedCode, severity: 'blocking' })]))
    expect(output.result.points).toEqual([])
    service.close()
  })

  it('applies a configured coordinate transformation and preserves point deltas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-transform-fixture-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'transform-fixture', expectedRevision: 0, idempotencyKey: 'transform-fixture-import', networkType: 'coordinate-transform', network: {
        transformType: 'similarity-2d',
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 10, y: 20, known: false }],
        observations: [{ id: 'AP', type: 'distance', from: 'A', to: 'P', value: Math.sqrt(500), unit: 'm' }],
        instrumentParameters: { translationX: 1, translationY: 2, rotationDeg: 0, scalePpm: 0 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'transform-fixture-validate' })
    // The transform subtype determines the actual runtime method; callers do
    // not label a similarity-2d calculation as a seven-parameter Helmert run.
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'transform-fixture-adjust' })
    expect(output.result.closure.translationX).toBe(1)
    expect(output.result.closure.translationY).toBe(2)
    expect(output.result.displacements.find((item) => item.pointId === 'P')?.magnitude).toBeCloseTo(Math.sqrt(5), 8)
    service.close()
  })
})
