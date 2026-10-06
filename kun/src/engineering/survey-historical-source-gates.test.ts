import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

async function createLevelingEpoch(service: SurveyService, projectId: string, suffix: string, observationEpoch: string, heightDifference: number) {
  const network = await importWorkwiseSurveyNetwork(service, {
    projectId,
    expectedRevision: 0,
    idempotencyKey: `historical-source-import-${suffix}`,
    networkType: 'leveling',
    network: {
      networkType: 'leveling',
      coordinateSystem: 'local-grid',
      projection: 'none',
      ellipsoid: 'none',
      verticalDatum: '1985-height',
      observationEpoch,
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 100, known: true }],
      unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 100 + heightDifference, known: false }],
      observations: [{ id: `dh-${suffix}`, type: 'height-difference', from: 'BM', to: 'P1', value: heightDifference, unit: 'm', sigma: 0.0002, sigmaUnit: 'm' }]
    }
  })
  const adjustment = service.createAdjustment({
    networkId: network.id,
    expectedRevision: network.revision,
    idempotencyKey: `historical-source-adjust-${suffix}`
  })
  expect(adjustment).toMatchObject({ run: { status: 'completed' }, result: { validation: 'valid' } })
  return { network, adjustment }
}

function mutateStoredNetwork(root: string, networkId: string, mutate: (network: Record<string, unknown>, database: Database.Database) => void): void {
  const database = new Database(join(root, 'survey.sqlite3'))
  try {
    const row = database.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(networkId) as { data_json: string } | undefined
    if (!row) throw new Error(`survey network ${networkId} was not found while seeding historical data`)
    const network = JSON.parse(row.data_json) as Record<string, unknown>
    mutate(network, database)
    database.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(network), networkId)
  } finally {
    database.close()
  }
}

function deformationRequest(projectId: string, adjustmentIds: string[], idempotencyKey: string) {
  return {
    projectId,
    adjustmentIds,
    expectedRevision: 1,
    idempotencyKey
  }
}

describe('historical survey source gates', () => {
  it('keeps old GSI results readable but prevents reuse of cumulative heights as adjacent differences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-legacy-gsi-height-'))
    const service = new SurveyService({ rootDir: root })
    const database = new Database(join(root, 'survey.sqlite3'))
    try {
      const bytes = await readFile(new URL('./fixtures/survey-formats/professional/leica-gsi-cumulative-leveling.gsi', import.meta.url))
      const network = await service.importNetwork({
        projectId: 'legacy-gsi', expectedRevision: 0, idempotencyKey: 'legacy-gsi-import',
        networkType: 'leveling', name: 'loop.GSI', dataBase64: bytes.toString('base64'),
        referenceDeclaration: { verticalDatum: '测试 BM 高程基准' },
        knownPoints: [{ id: 'BM', height: 100 }]
      })
      const adjusted = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'legacy-gsi-adjust' })
      expect(adjusted.run.status).toBe('completed')
      // The 300 m outward path is half the 600 m loop: its +0.4 mm closure
      // distributes -0.2 mm to P1 under inverse-length weights.
      expect(adjusted.result.points.find((point) => point.id === 'P1')?.height).toBeCloseTo(100.5998, 9)
      mutateStoredNetwork(root, network.id, (stored) => {
        for (const observation of stored.observations as Array<{ rawFields: Record<string, unknown> }>) {
          delete observation.rawFields.heightDifferenceSource
        }
      })
      const storedBytes = () => database.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(network.id)
      const beforeRead = storedBytes()
      expect(service.getNetwork(network.id)?.sourceFile?.sha256).toBe(network.sourceFile?.sha256)
      expect(service.getAdjustment(adjusted.run.id)?.result).toEqual(adjusted.result)
      expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
        expect.objectContaining({ code: 'source_not_adjustment_ready', message: expect.stringContaining('累计高程') })
      ]) })
      expect(() => service.getAdjustmentForNewUse(adjusted.run.id)).toThrow()
      expect(storedBytes()).toEqual(beforeRead)
    } finally { database.close(); service.close() }
  })

  it('preserves legacy COSA bytes and results but requires explicit axis semantics for new use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-legacy-cosa-axis-'))
    const service = new SurveyService({ rootDir: root })
    const database = new Database(join(root, 'survey.sqlite3'))
    try {
      const bytes = await readFile(new URL('./fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2', import.meta.url))
      const network = await service.importNetwork({ projectId: 'legacy-cosa', expectedRevision: 0, idempotencyKey: 'legacy-cosa-import', networkType: 'plane-control', name: 'network.in2', referenceDeclaration: { coordinateSystem: '公开合成样例独立坐标系' }, dataBase64: bytes.toString('base64') })
      const adjusted = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'legacy-cosa-adjust' })
      expect(adjusted.run.status).toBe('completed')
      mutateStoredNetwork(root, network.id, (stored) => {
        for (const observation of stored.observations as Array<{ rawFields: Record<string, unknown> }>) delete observation.rawFields.coordinateAxisOrder
      })
      const storedBytes = () => database.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(network.id)
      const beforeRead = storedBytes()
      expect(service.getNetwork(network.id)?.sourceFile?.sha256).toBe(network.sourceFile?.sha256)
      expect(service.getAdjustment(adjusted.run.id)?.result).toEqual(adjusted.result)
      expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
        expect.objectContaining({ code: 'source_not_adjustment_ready', message: expect.stringContaining('坐标轴') })
      ]) })
      expect(() => service.getAdjustmentForNewUse(adjusted.run.id)).toThrow()
      expect(storedBytes()).toEqual(beforeRead)
    } finally { database.close(); service.close() }
  })

  it('keeps an archive-only historical completed adjustment readable but prevents replay and deformation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-archive-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-archive'
    const reference = await createLevelingEpoch(service, projectId, 'archive-reference', '2026-01-01T00:00:00.000Z', 0.2)
    const current = await createLevelingEpoch(service, projectId, 'archive-current', '2026-01-11T00:00:00.000Z', 0.19)

    // Seed a database written before the disposition gate was enforced.  The
    // completed adjustment remains a historical record, while its source now
    // carries an archive-only disposition.
    mutateStoredNetwork(root, current.network.id, (network) => {
      const sourceFile = network.sourceFile as Record<string, unknown>
      sourceFile.disposition = 'archive-only'
      sourceFile.dispositionReason = 'historical source retained for audit only'
    })

    expect(service.getRawSourceIntegrity(current.network.id)).toMatchObject({ status: 'verified' })
    expect(service.getSourceEligibility(current.network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
      expect.objectContaining({ code: 'source_not_adjustment_ready', message: expect.stringContaining('archive-only') })
    ]) })
    expect(service.getAdjustment(current.adjustment.run.id)).toMatchObject({ run: { status: 'completed' }, result: { validation: 'valid' } })
    expect(service.getNetwork(current.network.id)?.sourceFile?.disposition).toBe('archive-only')
    expect(() => service.createAdjustment({
      networkId: current.network.id,
      expectedRevision: current.network.revision,
      idempotencyKey: 'historical-source-adjust-archive-current'
    })).toThrow(/历史平差 .*原始资料不再满足可平差门禁/)
    expect(() => service.compareDeformation(deformationRequest(projectId, [reference.adjustment.run.id, current.adjustment.run.id], 'historical-source-deformation-archive'))).toThrow(/archive-only/)
    expect(service.listDeformations(projectId)).toHaveLength(0)
    expect(service.getAdjustment(current.adjustment.run.id)?.result?.validation).toBe('valid')
    service.close()
  })

  it('binds an adjustment replay to its original network and rechecks its current source admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-adjustment-replay-binding-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-adjustment-replay-binding'
    const historical = await createLevelingEpoch(service, projectId, 'replay-binding-historical', '2026-01-01T00:00:00.000Z', 0.2)
    const ready = await createLevelingEpoch(service, projectId, 'replay-binding-ready', '2026-01-11T00:00:00.000Z', 0.19)
    const sharedKey = 'historical-source-adjust-replay-binding-historical'

    // A normal retry for the original network remains a true idempotent
    // replay, rather than creating another adjustment run.
    const sameNetworkReplay = service.createAdjustment({
      networkId: historical.network.id,
      expectedRevision: historical.network.revision,
      idempotencyKey: sharedKey
    })
    expect(sameNetworkReplay).toMatchObject({
      run: { id: historical.adjustment.run.id },
      result: { id: historical.adjustment.result.id, validation: 'valid' }
    })

    // The old result stays readable, but its current evidence is no longer
    // eligible for any replayed calculation.
    mutateStoredNetwork(root, historical.network.id, (network) => {
      const sourceFile = network.sourceFile as Record<string, unknown>
      sourceFile.disposition = 'archive-only'
      sourceFile.dispositionReason = 'retained only as historical evidence'
    })
    expect(service.getSourceEligibility(historical.network.id)).toMatchObject({ eligible: false })
    expect(service.getSourceEligibility(ready.network.id)).toMatchObject({ eligible: true })
    expect(() => service.createAdjustment({
      networkId: historical.network.id,
      expectedRevision: historical.network.revision,
      idempotencyKey: sharedKey
    })).toThrow(/原始资料不再满足可平差门禁/)

    // A client must not use a ready network B and the historical key from A
    // to receive A's now-ineligible result as though it belonged to B.
    expect(() => service.createAdjustment({
      networkId: ready.network.id,
      expectedRevision: ready.network.revision,
      idempotencyKey: sharedKey
    })).toThrow('adjustment idempotency key belongs to another network')
    expect(service.getAdjustment(historical.adjustment.run.id)?.result?.validation).toBe('valid')
    service.close()
  })

  it('binds deformation replays to their epoch set and refuses a ready-source key collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-deformation-replay-binding-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-deformation-replay-binding'
    const historicalReference = await createLevelingEpoch(service, projectId, 'deformation-replay-historical-reference', '2026-02-01T00:00:00.000Z', 0.2)
    const historicalCurrent = await createLevelingEpoch(service, projectId, 'deformation-replay-historical-current', '2026-02-11T00:00:00.000Z', 0.19)
    const sharedKey = 'historical-source-deformation-replay-binding'
    const historicalRequest = deformationRequest(projectId, [historicalReference.adjustment.run.id, historicalCurrent.adjustment.run.id], sharedKey)

    const first = service.compareDeformation(historicalRequest)
    const sameRequestReplay = service.compareDeformation(historicalRequest)
    expect(sameRequestReplay.id).toBe(first.id)

    mutateStoredNetwork(root, historicalCurrent.network.id, (network) => {
      const sourceFile = network.sourceFile as Record<string, unknown>
      sourceFile.disposition = 'archive-only'
      sourceFile.dispositionReason = 'retained only as historical evidence'
    })
    expect(service.getSourceEligibility(historicalCurrent.network.id)).toMatchObject({ eligible: false })
    expect(() => service.compareDeformation(historicalRequest)).toThrow(/archive-only/)

    const readyReference = await createLevelingEpoch(service, projectId, 'deformation-replay-ready-reference', '2026-03-01T00:00:00.000Z', 0.2)
    const readyCurrent = await createLevelingEpoch(service, projectId, 'deformation-replay-ready-current', '2026-03-11T00:00:00.000Z', 0.19)
    expect(service.getSourceEligibility(readyReference.network.id)).toMatchObject({ eligible: true })
    expect(service.getSourceEligibility(readyCurrent.network.id)).toMatchObject({ eligible: true })

    // The B/C request is independently admissible, but it must not replay
    // the archived A result under A's global idempotency key.
    expect(() => service.compareDeformation(deformationRequest(
      projectId,
      [readyReference.adjustment.run.id, readyCurrent.adjustment.run.id],
      sharedKey
    ))).toThrow('deformation idempotency key was reused with a different comparison request')
    expect(service.getDeformation(first.id)).toMatchObject({ id: first.id })
    service.close()
  })

  it('keeps a legacy/direct historical completed adjustment readable but prevents deformation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-legacy-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-legacy'
    const reference = await createLevelingEpoch(service, projectId, 'legacy-reference', '2026-02-01T00:00:00.000Z', 0.2)
    const current = await createLevelingEpoch(service, projectId, 'legacy-current', '2026-02-11T00:00:00.000Z', 0.19)

    // Simulate an old direct-structure row that predates source preservation
    // and the append-only ledger.  Do not delete the historical adjustment.
    mutateStoredNetwork(root, current.network.id, (network, database) => {
      delete network.sourceFile
      database.exec('DROP TRIGGER IF EXISTS survey_raw_source_ledger_no_delete')
      database.prepare('DELETE FROM survey_raw_source_ledger WHERE network_id = ?').run(current.network.id)
    })

    expect(service.getRawSourceIntegrity(current.network.id)).toMatchObject({ status: 'legacy-unverified', ledgerEntryCount: 0 })
    expect(service.getNetwork(current.network.id)).not.toBeNull()
    expect(service.getAdjustment(current.adjustment.run.id)).toMatchObject({ run: { status: 'completed' }, result: { validation: 'valid' } })
    expect(() => service.compareDeformation(deformationRequest(projectId, [reference.adjustment.run.id, current.adjustment.run.id], 'historical-source-deformation-legacy'))).toThrow(/原始资料尚未验证/)
    expect(service.listDeformations(projectId)).toHaveLength(0)
    expect(service.getAdjustment(current.adjustment.run.id)?.result?.validation).toBe('valid')
    service.close()
  })

  it('blocks unauditable canonical-unit claims and whole-file observation anchors before a new adjustment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-anchor-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-anchor'
    const historical = await createLevelingEpoch(service, projectId, 'anchor', '2026-03-01T00:00:00.000Z', 0.2)

    mutateStoredNetwork(root, historical.network.id, (network) => {
      const sourceFile = network.sourceFile as { fileSize: number; linearUnitCanonical: string; linearUnitRaw: string; parserSourceHash: string; records: Array<Record<string, unknown>>; rawRecordAnchors: Array<Record<string, unknown>> }
      // A legacy read-adapter can default canonical units to m/rad.  The raw
      // declaration and parser evidence must still be present.
      sourceFile.linearUnitCanonical = 'm'
      sourceFile.linearUnitRaw = 'legacy-unknown'
      sourceFile.parserSourceHash = 'legacy-unavailable'
      const observationRecordId = ((network.observations as Array<{ sourceRecordId?: string }>)[0]?.sourceRecordId)
      const anchor = sourceFile.records.find((item) => item.id === observationRecordId)!
      anchor.rawOffset = 0
      anchor.rawLength = sourceFile.fileSize
      anchor.byteOffset = 0
      anchor.byteLength = sourceFile.fileSize
      const mirror = sourceFile.rawRecordAnchors.find((item) => item.id === observationRecordId)!
      Object.assign(mirror, anchor)
    })

    const retried = service.createAdjustment({
      networkId: historical.network.id,
      expectedRevision: historical.network.revision,
      idempotencyKey: 'historical-source-adjust-anchor-retry'
    })
    expect(retried).toMatchObject({ run: { status: 'needs_attention' }, result: { validation: 'invalid' } })
    expect(retried.result.qualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unit_conflict', message: expect.stringContaining('linearUnitRaw=legacy-unknown') }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', message: expect.stringContaining('非整文件的精确字节范围') })
    ]))
    expect(service.getSourceEligibility(historical.network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
      expect.objectContaining({ code: 'unit_conflict', message: expect.stringContaining('linearUnitRaw=legacy-unknown') }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', message: expect.stringContaining('非整文件的精确字节范围') })
    ]) })
    expect(service.getAdjustment(historical.adjustment.run.id)).toMatchObject({ run: { status: 'completed' }, result: { validation: 'valid' } })
    service.close()
  })

  it('blocks duplicate point and observation identifiers before they can make solver mappings ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-historical-duplicate-identifiers-'))
    const service = new SurveyService({ rootDir: root })
    const projectId = 'project-historical-duplicate-identifiers'
    const historical = await createLevelingEpoch(service, projectId, 'duplicate-identifiers', '2026-03-11T00:00:00.000Z', 0.2)

    mutateStoredNetwork(root, historical.network.id, (network) => {
      const knownPoints = network.knownPoints as Array<{ id: string }>
      const unknownPoints = network.unknownPoints as Array<{ id: string }>
      const observations = network.observations as Array<Record<string, unknown>>
      unknownPoints[0]!.id = knownPoints[0]!.id
      observations.push({ ...observations[0] })
    })

    expect(service.getRawSourceIntegrity(historical.network.id)).toMatchObject({ status: 'verified' })
    expect(service.getSourceEligibility(historical.network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_observation', message: expect.stringContaining('重复点号') }),
      expect.objectContaining({ code: 'invalid_observation', message: expect.stringContaining('重复观测编号') })
    ]) })
    const retry = service.createAdjustment({
      networkId: historical.network.id,
      expectedRevision: historical.network.revision,
      idempotencyKey: 'historical-source-adjust-duplicate-identifiers-retry'
    })
    expect(retry).toMatchObject({ run: { status: 'needs_attention' }, result: { validation: 'invalid' } })
    expect(retry.result.qualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('重复点号') }),
      expect.objectContaining({ message: expect.stringContaining('重复观测编号') })
    ]))
    expect(service.getAdjustment(historical.adjustment.run.id)).toMatchObject({ run: { status: 'completed' }, result: { validation: 'valid' } })
    service.close()
  })

  it('keeps shared-record support from becoming a post-admission source-anchor rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-shared-source-record-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-shared-source-record',
      expectedRevision: 0,
      idempotencyKey: 'shared-source-record-import',
      networkType: 'leveling',
      network: {
        networkType: 'leveling',
        coordinateSystem: 'local-grid',
        projection: 'none',
        ellipsoid: 'none',
        verticalDatum: '1985-height',
        knownPoints: [
          { id: 'BM1', pointClass: 'known', height: 100, known: true },
          { id: 'BM2', pointClass: 'known', height: 100.2, known: true }
        ],
        unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 100.1, known: false }],
        observations: [
          { id: 'dh-1', type: 'height-difference', from: 'BM1', to: 'P1', value: 0.1, unit: 'm', sigma: 0.0002, sigmaUnit: 'm' },
          { id: 'dh-2', type: 'height-difference', from: 'P1', to: 'BM2', value: 0.1, unit: 'm', sigma: 0.0002, sigmaUnit: 'm' }
        ]
      }
    })
    mutateStoredNetwork(root, network.id, (storedNetwork) => {
      const observations = storedNetwork.observations as Array<{ sourceRecordId?: string }>
      observations[1]!.sourceRecordId = observations[0]!.sourceRecordId
    })

    // A parser may legitimately emit several derived observations from one
    // physical record (for example a GSI line). That relationship has to be
    // present in the parser-derived source at import time. Repointing a
    // frozen JSON network after admission must not recreate it by mutation.
    expect(service.getRawSourceIntegrity(network.id)).toMatchObject({ status: 'verified' })
    expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: false, findings: expect.arrayContaining([
      expect.objectContaining({ code: 'raw_source_integrity', message: expect.stringContaining('来源准入证据无效') })
    ]) })
    expect(service.createAdjustment({
      networkId: network.id,
      expectedRevision: network.revision,
      idempotencyKey: 'shared-source-record-adjust'
    })).toMatchObject({ run: { status: 'needs_attention' }, result: { validation: 'invalid' } })
    service.close()
  })

  it('reviews deformation-epoch sources before preview and rejects a deformation-only delivery with an archive-only source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-deformation-only-source-review-'))
    const workspace = join(root, 'workspace')
    let engineering!: EngineeringService
    const survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: (id) => engineering.getProject(id) })
    engineering = new EngineeringService({
      rootDir: join(root, 'runtime'),
      getAdjustments: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustment(id)
        return stored?.run.projectId === projectId && stored.result ? [stored.result] : []
      }),
      getAdjustmentEvidence: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustment(id)
        return stored?.run.projectId === projectId && stored.result
          ? [{
            run: {
              id: stored.run.id,
              projectId: stored.run.projectId,
              networkId: stored.run.networkId,
              inputHash: stored.run.inputHash,
              status: stored.run.status
            },
            result: stored.result
          }]
          : []
      }),
      getDeformations: (projectId, ids) => ids.flatMap((id) => {
        const deformation = survey.getDeformation(id)
        return deformation?.projectId === projectId ? [deformation] : []
      }),
      getSurveySources: (projectId, networkIds) => networkIds.flatMap((id) => {
        const network = survey.getNetwork(id)
        return network?.projectId === projectId
          ? [{
            networkId: id,
            ...(network.sourceFile ? { sourceFile: network.sourceFile } : {}),
            rawSourceIntegrity: survey.getRawSourceIntegrity(id),
            sourceEligibility: survey.getSourceEligibility(id),
            observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
            points: [...network.knownPoints, ...network.unknownPoints].map(({ id: pointId }) => ({ id: pointId }))
          }]
          : []
      })
    })
    const project = engineering.createProject({ name: '变形来源门禁', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'deformation-source-project' })
    const reference = await createLevelingEpoch(survey, project.id, 'delivery-reference', '2026-04-01T00:00:00.000Z', 0.2)
    const current = await createLevelingEpoch(survey, project.id, 'delivery-current', '2026-04-11T00:00:00.000Z', 0.19)
    const deformation = survey.compareDeformation(deformationRequest(project.id, [reference.adjustment.run.id, current.adjustment.run.id], 'deformation-source-comparison'))
    const dataset = await engineering.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'deformation-source-dataset',
      name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-04-01,1\nP1,2026-04-02,2').toString('base64')
    })
    const validated = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'deformation-source-validate' })
    const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'deformation-source-analysis' })

    mutateStoredNetwork(join(root, 'runtime'), current.network.id, (network) => {
      const sourceFile = network.sourceFile as Record<string, unknown>
      sourceFile.disposition = 'archive-only'
      sourceFile.dispositionReason = 'historical source retained for audit only'
      const knownPoints = network.knownPoints as Array<{ id: string }>
      const unknownPoints = network.unknownPoints as Array<{ id: string }>
      unknownPoints[0]!.id = knownPoints[0]!.id
    })

    await expect(engineering.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [],
      deformationIds: [deformation.id],
      expectedRevision: validated.revision,
      idempotencyKey: 'deformation-source-preview'
    })).rejects.toThrow(/archive-only[\s\S]*点号不唯一/)
    await expect(engineering.finalize({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [],
      deformationIds: [deformation.id],
      expectedRevision: validated.revision,
      idempotencyKey: 'deformation-source-finalize',
      acknowledgeWarnings: true
    })).rejects.toThrow(/archive-only[\s\S]*点号不唯一/)
    expect(engineering.getProjectOverview(project.id).manifests).toEqual([])
    expect(survey.getDeformation(deformation.id)).toMatchObject({ id: deformation.id })
    engineering.close()
    survey.close()
  })
})
