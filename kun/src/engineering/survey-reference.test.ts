import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SurveyNetworkImportRequest } from '../contracts/survey.js'
import { missingSurveyReferences, surveyReferenceDeclared, surveyReferenceRequirements } from '../contracts/survey-reference.js'
import { SurveyService } from './survey-service.js'

const services: SurveyService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.flush()
    service.close()
  }
})

async function createService() {
  const root = await mkdtemp(join(tmpdir(), 'railwise-survey-reference-'))
  const service = new SurveyService({ rootDir: root })
  services.push(service)
  return { root, service }
}

function sourceRequest(network: Record<string, unknown>, idempotencyKey = 'reference-import-001') {
  const original = Buffer.from(JSON.stringify({ format: 'workwise-survey-network', formatVersion: 1, network }))
  return { projectId: 'reference-test-project', expectedRevision: 0, idempotencyKey, name: 'control-network.json', dataBase64: original.toString('base64') }
}

function levelingNetwork() {
  return {
    networkType: 'leveling', unit: 'm',
    knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
    unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
    observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
  }
}

function planeNetwork() {
  return {
    networkType: 'plane-control', unit: 'm',
    knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }, { id: 'B', pointClass: 'known', known: true, x: 100, y: 0 }],
    unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 50, y: 50 }],
    observations: [
      { id: 'd1', type: 'distance', from: 'A', to: 'P', value: Math.sqrt(5000), unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
      { id: 'd2', type: 'distance', from: 'B', to: 'P', value: Math.sqrt(5000), unit: 'm', sigma: 0.001, sigmaUnit: 'm' }
    ]
  }
}

describe('survey professional reference requirements', () => {
  it.each(['待确认', ' 未声明 ', '未知', '待声明', 'none', 'N/A', 'not-confirmed', 'not specified', '—', ''])('rejects an undeclared reference token %j', value => {
    expect(surveyReferenceDeclared(value)).toBe(false)
  })

  it('requires only the reference dimensions actually used by the computation', () => {
    const base = { coordinateSystem: '工程独立坐标系', verticalDatum: '待确认', observations: [] }
    expect(surveyReferenceRequirements({ ...base, networkType: 'plane-control' })).toEqual({ coordinate: true, height: false })
    expect(missingSurveyReferences({ ...base, networkType: 'plane-control' })).toEqual([])
    expect(missingSurveyReferences({ ...base, networkType: 'leveling' })).toEqual(['height'])
    expect(missingSurveyReferences({ ...base, networkType: 'gnss' })).toEqual(['height'])
    for (const transformType of ['helmert-7', 'height-fit']) {
      expect(missingSurveyReferences({ ...base, networkType: 'coordinate-transform', transformType })).toEqual(['height'])
    }
    expect(missingSurveyReferences({ ...base, networkType: 'coordinate-transform', transformType: 'similarity-2d' })).toEqual([])
    expect(missingSurveyReferences({ ...base, networkType: 'plane-control', observations: [{ type: 'slope-distance' }] })).toEqual(['height'])
    expect(missingSurveyReferences({ ...base, networkType: 'coordinate-transform', observations: [{ type: 'coordinate-pair', targetHeight: 0 }] })).toEqual(['height'])
  })

  it('reads the legacy height datum alias when no confirmed canonical declaration exists', () => {
    expect(missingSurveyReferences({ networkType: 'leveling', verticalDatum: '待确认', heightDatum: '1985 国家高程基准', observations: [] })).toEqual([])
  })
})

describe('SurveyService reference declarations', () => {
  it('allows import and precheck with an undeclared coordinate reference, but produces no computed coordinates', async () => {
    const { service } = await createService()
    const imported = await service.importNetwork(sourceRequest(planeNetwork()))
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'reference-precheck-001' })
    expect(checked.observations).toHaveLength(2)
    expect(checked.qualityStatus).toBe('blocked')
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'reference_undeclared', severity: 'blocking', message: expect.stringContaining('平面坐标基准') }))
    const output = service.createAdjustment({ networkId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'reference-adjust-001' })
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.validation).toBe('invalid')
    expect(output.result.points).toEqual([])
  })

  it('calculates a plane-only network with a declared coordinate reference and no height datum', async () => {
    const { service } = await createService()
    const imported = await service.importNetwork({ ...sourceRequest(planeNetwork()), referenceDeclaration: { coordinateSystem: '工程独立坐标系' } })
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'reference-plane-precheck' })
    expect(imported.verticalDatum).toBe('待确认')
    expect(checked.findings.some(item => item.code === 'reference_undeclared')).toBe(false)
    const output = service.createAdjustment({ networkId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'reference-plane-adjust' })
    expect(output.run.status).toBe('completed')
    expect(output.result.points.find(point => point.id === 'P')).toMatchObject({ x: expect.closeTo(50, 7), y: expect.closeTo(50, 7) })
  })

  it('requires a height datum for leveling and accepts an explicit declaration without altering the original bytes', async () => {
    const { root, service } = await createService()
    const request = sourceRequest(levelingNetwork())
    const imported = await service.importNetwork(request)
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'reference-level-precheck' })
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'reference_undeclared', message: expect.stringContaining('高程基准') }))
    const blocked = service.createAdjustment({ networkId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'reference-level-blocked' })
    expect(blocked.result.points).toEqual([])

    const confirmed = await service.importNetwork({ ...request, idempotencyKey: 'reference-level-confirmed', referenceDeclaration: { verticalDatum: '项目 BM 高程基准' } })
    expect(confirmed.id).not.toBe(imported.id)
    expect(confirmed.referenceDeclaration).toMatchObject({ verticalDatum: '项目 BM 高程基准', origin: 'user-import', declaredAt: expect.any(String) })
    expect(confirmed.coordinateSystem).toBe('待确认')
    expect(confirmed.sourceFile!.sha256).toBe(imported.sourceFile!.sha256)
    const original = await readFile(join(root, 'sources', confirmed.sourceFile!.sha256, 'original'))
    expect(original.toString('base64')).toBe(request.dataBase64)
    expect(createHash('sha256').update(original).digest('hex')).toBe(confirmed.sourceFile!.sha256)
    expect(service.getRawSourceIntegrity(confirmed.id).status).toBe('verified')
    expect(service.getNetwork(imported.id)?.verticalDatum).toBe('待确认')
    expect(service.getAdjustment(blocked.run.id)?.result?.points).toEqual([])
    const output = service.createAdjustment({ networkId: confirmed.id, expectedRevision: confirmed.revision, idempotencyKey: 'reference-level-success' })
    expect(output.run.status).toBe('completed')
    expect(output.result.points.find(point => point.id === 'P')?.height).toBeCloseTo(10.1, 8)
  })

  it.each([
    ['gnss', undefined, []],
    ['coordinate-transform', 'helmert-7', []],
    ['coordinate-transform', 'height-fit', []],
    ['plane-control', undefined, [{ id: 'sd', type: 'slope-distance', from: 'A', to: 'P', value: 1, unit: 'm' }]]
  ])('blocks a missing height datum for %s / %s before solver dispatch', async (networkType, transformType, observations) => {
    const { service } = await createService()
    const imported = await service.importNetwork(sourceRequest({ ...planeNetwork(), networkType, transformType, observations, coordinateSystem: '工程独立坐标系' }))
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'reference-height-precheck' })
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'reference_undeclared', message: expect.stringContaining('高程基准') }))
    const output = service.createAdjustment({ networkId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'reference-height-adjust' })
    expect(output.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'reference_undeclared' }))
    expect(output.result.points).toEqual([])
  })

  it('rejects conflicting or placeholder declarations rather than replacing a source declaration', async () => {
    const { service } = await createService()
    const request = sourceRequest({ ...levelingNetwork(), verticalDatum: '1985 国家高程基准' })
    await expect(service.importNetwork({ ...request, referenceDeclaration: { verticalDatum: '1956 黄海高程系' } })).rejects.toThrow(/原资料中的声明不一致/)
    await expect(service.importNetwork({ ...request, referenceDeclaration: { verticalDatum: '待确认' } })).rejects.toThrow(/尚未确认/)
    expect(SurveyNetworkImportRequest.safeParse({ ...request, referenceDeclaration: {} }).success).toBe(false)
    expect(SurveyNetworkImportRequest.safeParse({ ...request, referenceDeclaration: { verticalDatum: '   ' } }).success).toBe(false)
    const accepted = await service.importNetwork({ ...request, referenceDeclaration: { verticalDatum: ' 1985 国家高程基准 ' } })
    expect(accepted.verticalDatum).toBe('1985 国家高程基准')
  })

  it('preserves a confirmed legacy height datum when the canonical source field is only a placeholder', async () => {
    const { service } = await createService()
    const request = sourceRequest({ ...levelingNetwork(), verticalDatum: '待确认', heightDatum: '旧项目 BM 高程基准' })
    const imported = await service.importNetwork(request)
    expect(imported.verticalDatum).toBe('旧项目 BM 高程基准')
    const output = service.createAdjustment({ networkId: imported.id, expectedRevision: imported.revision, idempotencyKey: 'reference-legacy-height-adjust' })
    expect(output.run.status).toBe('completed')
    await expect(service.importNetwork({ ...request, idempotencyKey: 'reference-legacy-height-conflict', referenceDeclaration: { verticalDatum: '另一项目高程基准' } })).rejects.toThrow(/原资料中的声明不一致/)
  })

  it('also treats textual unknown markers as placeholders during legacy alias migration', async () => {
    const { service } = await createService()
    const imported = await service.importNetwork(sourceRequest({
      ...levelingNetwork(),
      verticalDatum: 'unknown',
      heightDatum: '1985 国家高程基准'
    }, 'reference-legacy-height-unknown-marker'))
    expect(imported.verticalDatum).toBe('1985 国家高程基准')
    expect(service.createAdjustment({
      networkId: imported.id,
      expectedRevision: imported.revision,
      idempotencyKey: 'reference-legacy-height-unknown-adjust'
    }).run.status).toBe('completed')
  })

  it('binds the declaration to import identity and rejects a declaration change under the same retry key', async () => {
    const { service } = await createService()
    const request = { ...sourceRequest(levelingNetwork()), referenceDeclaration: { verticalDatum: '本地 BM 基准' } }
    const first = await service.importNetwork(request)
    expect((await service.importNetwork(request)).id).toBe(first.id)
    await expect(service.importNetwork({ ...request, referenceDeclaration: { verticalDatum: '另一 BM 基准' } })).rejects.toThrow(/different import request/)
  })

  it('keeps stored historical coordinates readable while a now-undeclared reference blocks a new calculation', async () => {
    const { root, service } = await createService()
    const imported = await service.importNetwork({ ...sourceRequest(levelingNetwork()), referenceDeclaration: { verticalDatum: '旧项目 BM 基准' } })
    const previous = service.createAdjustment({ networkId: imported.id, expectedRevision: imported.revision, idempotencyKey: 'reference-historical-old' })
    expect(previous.run.status).toBe('completed')
    await service.flush()
    const db = new Database(join(root, 'survey.sqlite3'))
    const legacy = { ...imported, verticalDatum: '待确认', referenceDeclaration: undefined }
    db.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(legacy), imported.id)
    const before = db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(previous.run.id)
    db.close()
    expect(service.getAdjustment(previous.run.id)?.result?.points).toEqual(previous.result.points)
    const current = service.createAdjustment({ networkId: imported.id, expectedRevision: legacy.revision, idempotencyKey: 'reference-historical-new' })
    expect(current.result.points).toEqual([])
    expect(current.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'reference_undeclared' }))
    const afterDb = new Database(join(root, 'survey.sqlite3'))
    expect(afterDb.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(previous.run.id)).toEqual(before)
    afterDb.close()
  })
})
