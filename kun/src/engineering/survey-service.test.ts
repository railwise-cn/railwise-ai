import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import Database from 'better-sqlite3'
import type { SurveyConverterManifestV1 } from '../contracts/survey.js'
import { SurveyConverterRegistry, type SandboxedSurveyConverterExecutor } from './survey-converter.js'
import { SurveyFormatRegistry } from './survey-format-registry.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork, workwiseSurveyNetworkFileImport } from './survey-test-helpers.js'

const COSA_IN2_FIXTURE_DIRECTORY = new URL('./fixtures/survey-formats/cosa-in2/', import.meta.url)

function utf16FrozenSourceBytes(value: object, encoding: 'utf-16le' | 'utf-16be'): Buffer {
  const json = JSON.stringify(value)
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
  const littleEndian = Buffer.from(json, 'utf16le')
  const bigEndian = Buffer.alloc(littleEndian.length)
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1]!
    bigEndian[index + 1] = littleEndian[index]!
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])
}

describe('SurveyService', () => {
  it('applies explicit known-point mappings without losing parser provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-known-point-mapping-'))
    const service = new SurveyService({ rootDir: root })
    const network = await service.importNetwork({
      ...workwiseSurveyNetworkFileImport({
        projectId: 'project-known-point-mapping', expectedRevision: 0, idempotencyKey: 'survey-known-point-map-1', networkType: 'leveling',
        knownPoints: [{ id: 'BM', height: 10 }],
        network: {
          networkType: 'leveling',
          knownPoints: [],
          unknownPoints: [{ id: 'BM', pointClass: 'unknown', known: false }, { id: 'P', pointClass: 'unknown', known: false }],
          observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }],
          instrumentParameters: {}
        }
      })
    })
    expect(network.knownPoints).toEqual([expect.objectContaining({ id: 'BM', height: 10, known: true, pointClass: 'known', sourceLocator: expect.stringContaining('WorkWise JSON:') })])
    expect(network.unknownPoints).toEqual([expect.objectContaining({ id: 'P', known: false })])
    expect(network.findings.some((item) => item.code === 'missing_datum')).toBe(false)
    service.close()
  })

  it('keeps unmapped source points unknown and rejects conflicting or reused mapping requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-known-point-gates-'))
    const service = new SurveyService({ rootDir: root })
    const base = {
      projectId: 'project-known-point-gates', expectedRevision: 0, networkType: 'leveling' as const,
      network: {
        networkType: 'leveling' as const,
        knownPoints: [],
        unknownPoints: [{ id: 'BM', pointClass: 'unknown' as const, known: false, height: 10 }],
        observations: [], instrumentParameters: {}
      }
    }
    const unmapped = await service.importNetwork({ ...workwiseSurveyNetworkFileImport({ ...base, idempotencyKey: 'survey-known-point-gates-1' }) })
    expect(unmapped.unknownPoints).toEqual([expect.objectContaining({ id: 'BM', known: false })])
    await expect(service.importNetwork({ ...workwiseSurveyNetworkFileImport({ ...base, idempotencyKey: 'survey-known-point-gates-2', knownPoints: [{ id: 'BM', height: 9 }] }) })).rejects.toThrow(/known point mapping conflicts/i)

    const mapped = await service.importNetwork({ ...workwiseSurveyNetworkFileImport({ ...base, idempotencyKey: 'survey-known-point-gates-replay', knownPoints: [{ id: 'BM', height: 10 }] }) })
    expect(mapped.knownPoints).toEqual([expect.objectContaining({ id: 'BM', height: 10, known: true })])
    await expect(service.importNetwork({ ...workwiseSurveyNetworkFileImport({ ...base, idempotencyKey: 'survey-known-point-gates-replay', knownPoints: [{ id: 'BM', height: 11 }] }) })).rejects.toThrow(/different import request/i)
    service.close()
  })

  it('flushes asynchronous adjustment sidecars before workspace cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-persistence-flush-'))
    const workspace = join(root, 'workspace')
    const service = new SurveyService({ rootDir: join(root, 'runtime'), getProject: (id) => id === 'project-flush' ? { id, workspace, revision: 1 } : null })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-flush', expectedRevision: 0, idempotencyKey: 'survey-import-persistence-flush', networkType: 'leveling',
      network: {
        projectId: 'project-flush', networkType: 'leveling', knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
        observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }],
        instrumentParameters: {}
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-persistence-flush' })
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-persistence-flush' })

    await service.flush()

    await expect(readFile(join(workspace, '.workwise', 'engineering', 'adjustments', `${adjustment.run.id}.json`), 'utf8')).resolves.toContain(adjustment.run.id)
    service.close()
  })

  it('persists both opaque input and converted active source with independently verifiable hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-conversion-provenance-'))
    const executablePath = join(root, 'user-supplied-converter')
    const executableBytes = Buffer.from('synthetic local converter')
    await writeFile(executablePath, executableBytes)
    await chmod(executablePath, 0o755)

    const converted = Buffer.from(JSON.stringify({
      format: 'workwise-survey-network',
      formatVersion: 1,
      network: {
        networkType: 'leveling',
        coordinateSystem: 'local-grid',
        projection: 'none',
        ellipsoid: 'none',
        verticalDatum: 'local-benchmark',
        unit: 'm',
        knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
        observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
      }
    }))
    const manifest: SurveyConverterManifestV1 = {
      schemaVersion: 1,
      id: 'test-local-t02-exporter',
      version: '1.0.0-test',
      origin: 'user-supplied',
      auditReference: 'synthetic:test-only',
      executablePath,
      executableHash: createHash('sha256').update(executableBytes).digest('hex'),
      inputFormats: ['trimble-t02'],
      outputFormat: 'workwise-json',
      outputExtension: '.json',
      arguments: ['--input', '{input}', '--output', '{output}'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
      networkAccess: 'none'
    }
    const executor: SandboxedSurveyConverterExecutor = {
      networkIsolation: 'verified-none',
      async execute(request) {
        await writeFile(request.outputPath, converted)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const registry = new SurveyFormatRegistry(new SurveyConverterRegistry([manifest], executor))
    const service = new SurveyService({ rootDir: root, formatRegistry: registry })
    const original = Buffer.from([0, 1, 2, 3, 4, 5])
    const originalHash = createHash('sha256').update(original).digest('hex')
    const convertedHash = createHash('sha256').update(converted).digest('hex')

    const network = await service.importNetwork({
      projectId: 'project-conversion-provenance',
      expectedRevision: 0,
      idempotencyKey: 'survey-import-conversion-provenance',
      networkType: 'leveling',
      name: 'control.t02',
      dataBase64: original.toString('base64')
    })

    expect(network).toMatchObject({
      inputAttachmentHash: convertedHash,
      sourceFile: {
        sha256: convertedHash,
        conversionInput: { sha256: originalHash, formatId: 'trimble-t02', originalPreserved: true },
        converter: { origin: 'user-supplied', inputHash: originalHash, outputHash: convertedHash, networkAccess: 'none' }
      }
    })
    expect(await readFile(join(root, 'sources', originalHash, 'original'))).toEqual(original)
    expect(await readFile(join(root, 'sources', convertedHash, 'original'))).toEqual(converted)
    expect(service.getRawSourceIntegrity(network.id)).toMatchObject({ status: 'verified' })
    expect(service.getRawSourceLedger(network.id)[0]).toMatchObject({ sourceSha256: convertedHash })
    service.close()
  })

  it.each(['utf-16le', 'utf-16be'] as const)('uses the validated frozen WorkWise envelope for %s rather than request metadata', async (encoding) => {
    const root = await mkdtemp(join(tmpdir(), `workwise-survey-${encoding}-`))
    const service = new SurveyService({ rootDir: root })
    const source = utf16FrozenSourceBytes({
      format: 'workwise-survey-network',
      formatVersion: 1,
      network: {
        networkType: 'plane-control',
        coordinateSystem: 'UTF16 工程坐标系',
        projection: 'gauss-kruger',
        centralMeridian: 120,
        ellipsoid: 'CGCS2000',
        verticalDatum: '1985-height',
        unit: 'm',
        knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0 }],
        observations: [{ id: 'utf16-distance', type: 'distance', from: 'A', to: 'P', value: 10, unit: 'm' }]
      }
    }, encoding)

    const network = await service.importNetwork({
      projectId: `project-${encoding}`,
      expectedRevision: 0,
      idempotencyKey: `survey-import-${encoding}-frozen-envelope`,
      // Deliberately conflicts with the frozen envelope. This must never
      // change the source's network semantics merely because it is UTF-16.
      networkType: 'leveling',
      name: `frozen-${encoding}.json`,
      dataBase64: source.toString('base64')
    })

    expect(network).toMatchObject({
      networkType: 'plane-control',
      coordinateSystem: 'UTF16 工程坐标系',
      projection: 'gauss-kruger',
      centralMeridian: 120,
      ellipsoid: 'CGCS2000',
      verticalDatum: '1985-height',
      sourceFile: { disposition: 'adjustment-ready' }
    })
    expect(network.observations).toContainEqual(expect.objectContaining({
      id: 'utf16-distance', sourceRecordId: 'workwise-json-observation-1'
    }))
    const anchor = network.sourceFile!.records.find((item) => item.id === 'workwise-json-observation-1')!
    expect(anchor.rawSnippet).toContain('utf16-distance')
    expect(anchor.rawSnippet).not.toMatch(/^hex:/)
    expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: true })
    service.close()
  })

  it('fails closed when a frozen WorkWise source leaves solver semantics to the import request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-missing-frozen-semantics-'))
    const service = new SurveyService({ rootDir: root })
    const sources = [
      {
        idempotencyKey: 'survey-import-missing-network-type',
        requestNetworkType: 'plane-control' as const,
        envelope: {
          format: 'workwise-survey-network', formatVersion: 1,
          network: {
            unit: 'm',
            knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }],
            unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0 }],
            observations: [{ id: 'distance', type: 'distance', from: 'A', to: 'P', value: 10, unit: 'm' }]
          }
        }
      },
      {
        idempotencyKey: 'survey-import-missing-transform-type',
        requestNetworkType: 'coordinate-transform' as const,
        transformType: 'similarity-2d' as const,
        envelope: {
          format: 'workwise-survey-network', formatVersion: 1,
          network: {
            networkType: 'coordinate-transform', unit: 'm',
            knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }],
            unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0 }],
            observations: [{ id: 'pair', type: 'coordinate-pair', from: 'A', to: 'P', value: 0, unit: 'm', targetX: 10, targetY: 0 }]
          }
        }
      }
    ]

    for (const source of sources) {
      const network = await service.importNetwork({
        projectId: 'project-missing-frozen-semantics',
        expectedRevision: 0,
        idempotencyKey: source.idempotencyKey,
        networkType: source.requestNetworkType,
        ...(source.transformType ? { transformType: source.transformType } : {}),
        name: `${source.idempotencyKey}.json`,
        dataBase64: Buffer.from(JSON.stringify(source.envelope)).toString('base64')
      })
      expect(network.sourceFile).toMatchObject({ disposition: 'archive-only' })
      expect(network.qualityStatus).toBe('blocked')
      expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: false })
      expect(service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `adjust-${source.idempotencyKey}` }).run.status).toBe('needs_attention')
    }
    service.close()
  })

  it('imports, validates and adjusts a weighted leveling network with traceable results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-1', expectedRevision: 0, idempotencyKey: 'survey-import-level-1', networkType: 'leveling',
      network: {
        projectId: 'project-1', networkType: 'leveling', knownPoints: [{ id: 'BM1', pointClass: 'known', height: 100, known: true }],
        unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 100.2, known: false }],
        observations: [{ id: 'o1', type: 'height-difference', from: 'BM1', to: 'P1', value: 0.2, unit: 'm', sigma: 0.002, sigmaUnit: 'm' }],
        instrumentParameters: {}
      }
    })
    expect(network.id).toMatch(/^network_/)
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-level-1' })
    expect(checked.qualityStatus).toBe('validated')
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-level-1' })
    expect(adjustment.run.status).toBe('completed')
    expect(adjustment.result.validation).toBe('valid')
    expect(adjustment.result.linearUnit).toBe('m')
    expect(adjustment.result.angularUnit).toBe('rad')
    expect(adjustment.result.unitWeightStdDevUnit).toBe('dimensionless')
    expect(adjustment.result.varianceFactorUnit).toBe('dimensionless')
    expect(adjustment.result.closure).toEqual({})
    expect(adjustment.result.closureUnits).toEqual({})
    expect(adjustment.result.observations[0]?.unit).toBe('m')
    expect(adjustment.result.observations[0]?.standardizedResidualUnit).toBe('sigma')
    expect(adjustment.result.points.find((point) => point.id === 'P1')?.height).toBeCloseTo(100.2, 5)
    expect(adjustment.result.inputHash).toBe(adjustment.run.inputHash)
    service.close()
  })

  it('keeps linear and angular residual units separate in a mixed plane network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-units-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-units', expectedRevision: 0, idempotencyKey: 'survey-import-units-1', networkType: 'plane-control',
      network: {
        projectId: 'project-units', networkType: 'plane-control',
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 10, y: 0, known: false }],
        observations: [
          { id: 'distance-a-p', type: 'distance', from: 'A', to: 'P', value: 10_000, unit: 'mm', sigma: 1, sigmaUnit: 'mm' },
          { id: 'direction-a-p', type: 'direction', from: 'A', to: 'P', value: 100, unit: 'grad', sigma: 1, sigmaUnit: 'arcsec' }
        ]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-units-1' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-units-1' })

    expect(output.run.status).toBe('completed')
    expect(output.result.observations.map((item) => item.unit)).toEqual(['m', 'rad'])
    expect(output.result.closureUnits).toMatchObject({ horizontal: 'm', angular: 'rad' })
    expect(output.result.closure.horizontal).toBeCloseTo(0, 12)
    expect(output.result.closure.angular).toBeCloseTo(0, 12)
    service.close()
  })

  it('adds canonical units when reading a legacy stored adjustment without rewriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-legacy-units-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: 'project-legacy-units', expectedRevision: 0, idempotencyKey: 'survey-import-legacy-units', networkType: 'leveling', network: {
      projectId: 'project-legacy-units', networkType: 'leveling',
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [{ id: 'legacy-observation', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    } })
    const created = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-legacy-units' })
    service.close()

    const db = new Database(join(root, 'survey.sqlite3'))
    const row = db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(created.run.id) as { data_json: string }
    const legacy = JSON.parse(row.data_json) as { result: { linearUnit?: string; angularUnit?: string; unitWeightStdDevUnit?: string; varianceFactorUnit?: string; closureUnits?: unknown; observations: Array<{ unit?: string; standardizedResidualUnit?: string }> } }
    delete legacy.result.linearUnit
    delete legacy.result.angularUnit
    delete legacy.result.closureUnits
    delete legacy.result.unitWeightStdDevUnit
    delete legacy.result.varianceFactorUnit
    for (const observation of legacy.result.observations) {
      delete observation.unit
      delete observation.standardizedResidualUnit
    }
    db.prepare('UPDATE survey_adjustments SET data_json = ? WHERE id = ?').run(JSON.stringify(legacy), created.run.id)
    db.close()

    const reopened = new SurveyService({ rootDir: root })
    const restored = reopened.getAdjustment(created.run.id)
    expect(restored?.result?.linearUnit).toBe('m')
    expect(restored?.result?.angularUnit).toBe('rad')
    expect(restored?.result?.closure).toEqual({})
    expect(restored?.result?.closureUnits).toEqual({})
    expect(restored?.result?.unitWeightStdDevUnit).toBe('dimensionless')
    expect(restored?.result?.varianceFactorUnit).toBe('dimensionless')
    expect(restored?.result?.observations[0]?.unit).toBe('m')
    expect(restored?.result?.observations[0]?.standardizedResidualUnit).toBe('sigma')
    reopened.close()
  })

  it('atomically reserves a source import idempotency key across service instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-import-atomic-'))
    const firstService = new SurveyService({ rootDir: root })
    const secondService = new SurveyService({ rootDir: root })
    const request = {
      projectId: 'project-import-atomic',
      expectedRevision: 0,
      idempotencyKey: 'survey-import-atomic-001',
      networkType: 'leveling' as const,
      name: 'leveling.csv',
      dataBase64: Buffer.from([
        'type,from,to,value,unit',
        'height-difference,BM,P1,0.1,m'
      ].join('\n')).toString('base64')
    }

    let first: Awaited<ReturnType<SurveyService['importNetwork']>>
    let second: Awaited<ReturnType<SurveyService['importNetwork']>>
    try {
      ;[first, second] = await Promise.all([
        firstService.importNetwork(request),
        secondService.importNetwork(request)
      ])
    } finally {
      firstService.close()
      secondService.close()
    }

    expect(first!.id).toBe(second!.id)
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_networks').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_raw_source_ledger').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_idempotency WHERE key = ?').get(request.idempotencyKey)).toEqual({ count: 1 })
      expect(db.prepare('SELECT network_id, sequence FROM survey_raw_source_ledger').get()).toEqual({ network_id: first!.id, sequence: 1 })
      const idempotency = db.prepare('SELECT result_json FROM survey_idempotency WHERE key = ?').get(request.idempotencyKey) as { result_json: string }
      expect(JSON.parse(idempotency.result_json)).toMatchObject({
        kind: 'survey-network-import',
        requestHash: expect.any(String),
        projectId: request.projectId,
        source: expect.objectContaining({ mode: 'raw-source', name: request.name }),
        network: { id: first!.id }
      })
    } finally {
      db.close()
    }

    const replayService = new SurveyService({ rootDir: root })
    try {
      expect((await replayService.importNetwork(request)).id).toBe(first!.id)
    } finally {
      replayService.close()
    }
  })

  it('accepts sequential multi-file imports against the same unchanged project revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-import-batch-revision-'))
    let projectLookups = 0
    const service = new SurveyService({
      rootDir: root,
      getProject: () => {
        projectLookups += 1
        return { id: 'project-import-batch-revision', workspace: root, revision: 1 }
      }
    })
    const request = (name: string, key: string, value: number) => ({
      projectId: 'project-import-batch-revision',
      expectedRevision: 1,
      idempotencyKey: key,
      networkType: 'leveling' as const,
      name,
      dataBase64: Buffer.from([
        'type,from,to,value,unit',
        `height-difference,BM,${name.replace('.csv', '')},${value},m`
      ].join('\n')).toString('base64')
    })

    try {
      const first = await service.importNetwork(request('epoch-a.csv', 'survey-import-batch-a', 0.1))
      const second = await service.importNetwork(request('epoch-b.csv', 'survey-import-batch-b', 0.2))

      expect(first.id).not.toBe(second.id)
      expect(first.projectId).toBe('project-import-batch-revision')
      expect(second.projectId).toBe('project-import-batch-revision')
      expect(projectLookups).toBeGreaterThanOrEqual(4)
      expect(service.listNetworks('project-import-batch-revision')).toHaveLength(2)
    } finally {
      service.close()
    }
  })

  it('rejects a concurrent different-source collision after acquiring the import writer lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-import-concurrent-collision-'))
    const firstService = new SurveyService({ rootDir: root })
    const secondService = new SurveyService({ rootDir: root })
    const source = (height: number) => Buffer.from(JSON.stringify({
      format: 'workwise-survey-network',
      formatVersion: 1,
      network: {
        networkType: 'leveling', unit: 'm', coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height',
        knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10 + height }],
        observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: height, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
      }
    })).toString('base64')
    const request = (dataBase64: string) => ({
      projectId: 'project-import-concurrent-collision',
      expectedRevision: 0,
      idempotencyKey: 'survey-import-concurrent-collision-001',
      networkType: 'leveling' as const,
      name: 'epoch.json',
      dataBase64
    })
    const attempts = await Promise.allSettled([
      firstService.importNetwork(request(source(0.1))),
      secondService.importNetwork(request(source(0.2)))
    ])
    try {
      const fulfilled = attempts.find((attempt) => attempt.status === 'fulfilled')
      const rejected = attempts.find((attempt) => attempt.status === 'rejected')
      expect(fulfilled?.status).toBe('fulfilled')
      expect(rejected?.status).toBe('rejected')
      if (fulfilled?.status !== 'fulfilled' || rejected?.status !== 'rejected') throw new Error('expected exactly one concurrent import winner')
      expect(rejected.reason).toBeInstanceOf(Error)
      expect((rejected.reason as Error).message).toMatch(/different import request/)
      expect(firstService.getRawSourceIntegrity(fulfilled.value.id)).toMatchObject({ status: 'verified', ledgerEntryCount: 1 })
      const database = new Database(join(root, 'survey.sqlite3'))
      try {
        expect(database.prepare('SELECT COUNT(*) AS count FROM survey_networks').get()).toEqual({ count: 1 })
        expect(database.prepare('SELECT COUNT(*) AS count FROM survey_raw_source_ledger').get()).toEqual({ count: 1 })
        expect(database.prepare('SELECT COUNT(*) AS count FROM survey_idempotency WHERE key = ?').get('survey-import-concurrent-collision-001')).toEqual({ count: 1 })
      } finally {
        database.close()
      }
    } finally {
      firstService.close()
      secondService.close()
    }
  })

  it('binds source-import replays to project and immutable input provenance while leaving legacy history readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-import-binding-'))
    const service = new SurveyService({ rootDir: root })
    const frozenEnvelope = (height: number) => ({
      format: 'workwise-survey-network',
      formatVersion: 1,
      network: {
        networkType: 'leveling',
        coordinateSystem: 'local-grid',
        projection: 'none',
        ellipsoid: 'none',
        verticalDatum: '1985-height',
        unit: 'm',
        knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10 + height }],
        observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: height, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
      }
    })
    const utf16Source = utf16FrozenSourceBytes(frozenEnvelope(0.1), 'utf-16le')
    const request = {
      projectId: 'project-import-binding-a',
      expectedRevision: 0,
      idempotencyKey: 'survey-import-binding-001',
      networkType: 'leveling' as const,
      name: 'epoch-a.json',
      dataBase64: utf16Source.toString('base64')
    }

    const imported = await service.importNetwork(request)
    expect((await service.importNetwork(request)).id).toBe(imported.id)
    await expect(service.importNetwork({ ...request, projectId: 'project-import-binding-b' })).rejects.toThrow(/different import request/)
    // The filename is format context, not cosmetic metadata. Reusing the
    // key under a conflicting extension must not reuse the old JSON result.
    await expect(service.importNetwork({ ...request, name: 'epoch-a.csv' })).rejects.toThrow(/different import request/)
    // Equivalent parsed JSON with different original bytes/encoding is a new
    // source identity: the durable raw byte ledger must remain UTF-16.
    await expect(service.importNetwork({ ...request, dataBase64: Buffer.from(JSON.stringify(frozenEnvelope(0.1))).toString('base64') })).rejects.toThrow(/different import request/)
    await expect(service.importNetwork({ ...request, dataBase64: Buffer.from(JSON.stringify(frozenEnvelope(0.2))).toString('base64') })).rejects.toThrow(/different import request/)
    await expect(service.importNetwork({ ...request, inputAttachmentHash: 'different-attachment-provenance' })).rejects.toThrow(/different import request/)
    expect(service.listNetworks()).toHaveLength(1)
    expect(await readFile(join(root, 'sources', imported.sourceFile!.sha256, 'original'))).toEqual(utf16Source)
    expect(service.getRawSourceIntegrity(imported.id)).toMatchObject({ status: 'verified', ledgerEntryCount: 1 })

    // A pre-envelope generic idempotency row must never turn an historical
    // network into a freshly issued import result. The durable network itself
    // remains readable for audit/migration.
    const database = new Database(join(root, 'survey.sqlite3'))
    try {
      database.prepare('UPDATE survey_idempotency SET result_json = ? WHERE key = ?').run(JSON.stringify(imported), request.idempotencyKey)
    } finally {
      database.close()
    }
    await expect(service.importNetwork(request)).rejects.toThrow(/no bound import request/)
    expect(service.getNetwork(imported.id)).toMatchObject({ id: imported.id, projectId: request.projectId })
    service.close()
  })

  it('binds in-process legacy structured imports without making them source-admissible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-legacy-import-binding-'))
    const service = new SurveyService({ rootDir: root })
    const request = {
      projectId: 'project-legacy-import-binding',
      expectedRevision: 0,
      idempotencyKey: 'survey-legacy-import-binding-001',
      networkType: 'leveling' as const,
      network: {
        networkType: 'leveling' as const,
        unit: 'm',
        knownPoints: [{ id: 'BM', pointClass: 'known' as const, known: true, height: 10 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown' as const, known: false, height: 10.1 }],
        observations: [{ id: 'dh', type: 'height-difference' as const, from: 'BM', to: 'P', value: 0.1, unit: 'm' }]
      }
    }
    const imported = await service.importNetwork(request)
    // Field order is not semantics; the canonical request binding preserves a
    // legitimate retry while still covering every structured input field.
    expect((await service.importNetwork({
      ...request,
      network: {
        observations: request.network.observations,
        unknownPoints: request.network.unknownPoints,
        knownPoints: request.network.knownPoints,
        unit: request.network.unit,
        networkType: request.network.networkType
      }
    })).id).toBe(imported.id)
    await expect(service.importNetwork({
      ...request,
      network: { ...request.network, unknownPoints: [{ ...request.network.unknownPoints[0]!, height: 10.2 }] }
    })).rejects.toThrow(/different import request/)
    await expect(service.importNetwork({ ...request, projectId: 'project-legacy-import-binding-other' })).rejects.toThrow(/different import request/)
    expect(service.getRawSourceIntegrity(imported.id)).toMatchObject({ status: 'legacy-unverified' })
    expect(service.getNetwork(imported.id)).toMatchObject({ id: imported.id, projectId: request.projectId })
    service.close()
  })

  it('keeps a committed import replayable if its sidecar projection fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-import-sidecar-'))
    const nonDirectoryWorkspace = join(root, 'not-a-workspace')
    await writeFile(nonDirectoryWorkspace, 'not a directory')
    const request = {
      projectId: 'project-import-sidecar',
      expectedRevision: 0,
      idempotencyKey: 'survey-import-sidecar-001',
      networkType: 'leveling' as const,
      name: 'leveling.csv',
      dataBase64: Buffer.from('type,from,to,value,unit\nheight-difference,BM,P1,0.1,m').toString('base64')
    }
    const service = new SurveyService({
      rootDir: root,
      getProject: () => ({ id: request.projectId, workspace: nonDirectoryWorkspace, revision: 1 })
    })
    try {
      await expect(service.importNetwork(request)).rejects.toThrow()
      await expect(service.importNetwork(request)).resolves.toEqual(expect.objectContaining({ projectId: request.projectId }))
    } finally {
      service.close()
    }

    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_networks').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_raw_source_ledger').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM survey_idempotency WHERE key = ?').get(request.idempotencyKey)).toEqual({ count: 1 })
    } finally {
      db.close()
    }

    const replayService = new SurveyService({ rootDir: root })
    try {
      await expect(replayService.importNetwork(request)).resolves.toEqual(expect.objectContaining({ projectId: request.projectId }))
    } finally {
      replayService.close()
    }
  })

  it('blocks a disconnected network and preserves idempotent imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-'))
    const service = new SurveyService({ rootDir: root })
    const body = {
      projectId: 'project-2', expectedRevision: 0, idempotencyKey: 'survey-import-disconnected', networkType: 'leveling' as const,
      network: {
        projectId: 'project-2', networkType: 'leveling' as const, knownPoints: [{ id: 'BM1', pointClass: 'known' as const, height: 1, known: true }],
        unknownPoints: [{ id: 'P2', pointClass: 'unknown' as const, height: 2, known: false }],
        observations: [{ id: 'o2', type: 'height-difference' as const, from: 'P2', to: 'P2', value: 0, unit: 'm' }], instrumentParameters: {}
      }
    }
    const first = await importWorkwiseSurveyNetwork(service, body); const second = await importWorkwiseSurveyNetwork(service, body)
    expect(second.id).toBe(first.id)
    const checked = service.validateNetwork(first.id, { expectedRevision: first.revision, idempotencyKey: 'survey-validate-disconnected' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(checked.findings.some((item) => item.code === 'disconnected_network')).toBe(true)
    service.close()
  })

  it('does not fabricate GNSS adjustment without covariance and fixed datum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: 'project-3', expectedRevision: 0, idempotencyKey: 'survey-import-gnss-1', network: {
      projectId: 'project-3', networkType: 'gnss', knownPoints: [], unknownPoints: [{ id: 'P1' }], observations: [{ id: 'g1', type: 'gnss-baseline', from: 'P1', to: 'P1', value: 0, unit: 'm' }]
    } })
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-gnss-1' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.qualityFindings.some((item) => item.code === 'missing_covariance')).toBe(true)
    service.close()
  })

  it('adjusts a complete GNSS baseline network with covariance and fixed datum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gnss-valid-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: 'project-gnss-valid', expectedRevision: 0, idempotencyKey: 'survey-import-gnss-valid', networkType: 'gnss', network: {
      projectId: 'project-gnss-valid', networkType: 'gnss',
      knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, height: 10, known: true }, { id: 'B', pointClass: 'known', x: 100, y: 0, height: 20, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 9.9, y: 19.9, height: 29.9, known: false }],
      observations: [
        { id: 'g1', type: 'gnss-baseline', from: 'A', to: 'P', value: 0, vectorX: 10.001, vectorY: 20, vectorZ: 20, unit: 'm', covariance: [4e-6, 1e-6, 0.2e-6, 1e-6, 9e-6, 0.3e-6, 0.2e-6, 0.3e-6, 4e-6] },
        { id: 'g2', type: 'gnss-baseline', from: 'B', to: 'P', value: 0, vectorX: -90, vectorY: 20.002, vectorZ: 10, unit: 'm', covariance: [4e-6, 1e-6, 0.2e-6, 1e-6, 9e-6, 0.3e-6, 0.2e-6, 0.3e-6, 4e-6] }
      ]
    } })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-gnss-valid' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-gnss-valid' })
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('gnss')
    expect(output.result.closure.baseline).toBeDefined()
    expect(output.result.observationCount).toBe(6)
    expect(output.result.unknownCount).toBe(3)
    expect(output.result.redundancy).toBe(3)
    expect(output.result.solverDiagnostics?.rank).toBe(3)
    expect(output.result.points.find((point) => point.id === 'P')).toMatchObject({ x: expect.closeTo(10.0005, 8), y: expect.closeTo(20.001, 8), height: expect.closeTo(30, 8) })
    expect(output.result.observations.map((item) => item.observationId)).toEqual(['g1:x', 'g1:y', 'g1:z', 'g2:x', 'g2:y', 'g2:z'])
    const ellipse = output.result.points.find((point) => point.id === 'P')!.xyErrorEllipse!
    // Two equally weighted independent vector baselines yield C_parameter=C_observation/2.
    expect(ellipse.covarianceXY[0]).toBeCloseTo(2e-6 * output.result.varianceFactor, 16)
    expect(ellipse.covarianceXY[1]).toBeCloseTo(0.5e-6 * output.result.varianceFactor, 16)
    expect(ellipse.covarianceXY[3]).toBeCloseTo(4.5e-6 * output.result.varianceFactor, 16)
    expect(ellipse.semiMajor ** 2 + ellipse.semiMinor ** 2).toBeCloseTo(6.5e-6 * output.result.varianceFactor, 16)
    expect(ellipse.coordinatePlane).toBe('solution-xy')
    expect(output.result.points.find((point) => point.id === 'A')!.xyErrorEllipse).toBeUndefined()
    expect(service.getAdjustmentForNewUse(output.run.id)?.result?.points).toEqual(output.result.points)
    service.close()
  })

  it('imports GNSS ΔX/ΔY/ΔZ aliases and row-major covariance from CSV', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gnss-csv-'))
    const service = new SurveyService({ rootDir: root })
    const csv = 'type,from,to,dx,dy,dz,unit,covariance\ngnss-baseline,A,P,1000,2000,3000,mm,"1;0.1;0;0.1;2;0;0;0;3"'
    const network = await service.importNetwork({ projectId: 'project-gnss-csv', expectedRevision: 0, idempotencyKey: 'survey-import-gnss-csv', networkType: 'gnss', name: 'baselines.csv', dataBase64: Buffer.from(csv).toString('base64') })
    expect(network.observations[0]).toMatchObject({ value: 0, vectorX: 1000, vectorY: 2000, vectorZ: 3000, unit: 'mm' })
    expect(network.observations[0]?.covariance).toEqual([1, 0.1, 0, 0.1, 2, 0, 0, 0, 3])
    service.close()
  })

  it('imports a multi-sheet XLSX survey network with worksheet provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-xlsx-'))
    const service = new SurveyService({ rootDir: root })
    const workbook = new JSZip()
    const sheet = (point: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>type</t></is></c><c r="B1" t="inlineStr"><is><t>from</t></is></c><c r="C1" t="inlineStr"><is><t>to</t></is></c><c r="D1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>height-difference</t></is></c><c r="B2" t="inlineStr"><is><t>BM</t></is></c><c r="C2" t="inlineStr"><is><t>${point}</t></is></c><c r="D2" t="inlineStr"><is><t>1</t></is></c></row></sheetData></worksheet>`
    workbook.file('xl/worksheets/sheet1.xml', sheet('P1')); workbook.file('xl/worksheets/sheet2.xml', sheet('P2'))
    const network = await service.importNetwork({ projectId: 'project-xlsx', expectedRevision: 0, idempotencyKey: 'survey-import-xlsx-1', name: 'survey.xlsx', dataBase64: (await workbook.generateAsync({ type: 'nodebuffer' })).toString('base64'), networkType: 'leveling' })
    expect(network.observations).toHaveLength(2)
    expect(network.observations[0]?.sourceLocator).toContain('sheet1.xml')
    service.close()
  })

  it('normalizes legacy height datum metadata and preserves survey reference fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-json-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-json', expectedRevision: 0, idempotencyKey: 'survey-import-json-1', networkType: 'plane-control',
      network: {
        coordinateSystem: '工程独立坐标系', heightDatum: '项目高程基准',
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 1, y: 1, known: false }],
        observations: [{ id: 'a-p', type: 'direction', from: 'A', to: 'P', value: 45.5, unit: 'deg' }]
      }
    })
    expect(network.coordinateSystem).toBe('工程独立坐标系')
    expect(network.verticalDatum).toBe('项目高程基准')
    service.close()
  })

  it('converts DMS strings from a survey CSV into decimal degrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-dms-'))
    const service = new SurveyService({ rootDir: root })
    const csv = 'type,from,to,value,unit\ndirection,A,B,45°30′00″,deg\n'
    const network = await service.importNetwork({ projectId: 'project-dms', expectedRevision: 0, idempotencyKey: 'survey-import-dms-1', networkType: 'plane-control', name: 'angles.csv', dataBase64: Buffer.from(csv).toString('base64') })
    expect(network.observations[0]?.value).toBeCloseTo(45.5, 8)
    service.close()
  })

  it('blocks a declared closed leveling loop when the closure tolerance is exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-closure-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-closure', expectedRevision: 0, idempotencyKey: 'survey-import-closure-1', networkType: 'leveling',
      network: {
        knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10, known: false }],
        observations: [{ id: 'loop', type: 'height-difference', from: 'BM', to: 'BM', value: 0.02, unit: 'm' }],
        instrumentParameters: { closedLoop: 1, closureTolerance: 0.001 }
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-closure-1' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(checked.findings.some((item) => item.code === 'closure_exceeded')).toBe(true)
    service.close()
  })

  it('applies the raw closure tolerance to an unordered branched leveling network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-branched-closure-'))
    const service = new SurveyService({ rootDir: root })
    try {
      const network = await importWorkwiseSurveyNetwork(service, {
        projectId: 'branched-closure', expectedRevision: 0, idempotencyKey: 'branched-closure-import', networkType: 'leveling',
        network: {
          knownPoints: [{ id: 'A', pointClass: 'known', height: 100, known: true }, { id: 'B', pointClass: 'known', height: 103, known: true }],
          unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 101, known: false }, { id: 'Q', pointClass: 'unknown', height: 102, known: false }],
          observations: [
            { id: 'a', from: 'A', to: 'P', value: 1 },
            { id: 'e', from: 'Q', to: 'A', value: -2.005 },
            { id: 'c', from: 'Q', to: 'B', value: 1 },
            { id: 'b', from: 'P', to: 'Q', value: 1.001 },
            { id: 'd', from: 'P', to: 'B', value: 2.003 }
          ].map((item) => ({ ...item, type: 'height-difference', unit: 'm', sigma: 0.002, sigmaUnit: 'm' })),
          instrumentParameters: { closureTolerance: 0.004 }
        }
      })
      const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'branched-closure-validate' })
      expect(checked.qualityStatus).toBe('blocked')
      expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'closure_exceeded', severity: 'blocking' }))
      const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'branched-closure-adjust' })
      expect(adjustment.run.status).toBe('needs_attention')
      expect(adjustment.result.precision.passed).toBe(false)
    } finally { service.close() }
  })

  it('rejects a zero-length direction without dropping or relabeling observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-degenerate-plane-'))
    const service = new SurveyService({ rootDir: root })
    try {
      const network = await importWorkwiseSurveyNetwork(service, {
        projectId: 'degenerate-plane', expectedRevision: 0, idempotencyKey: 'degenerate-plane-import', networkType: 'plane-control',
        network: {
          knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, { id: 'B', pointClass: 'known', x: 0, y: 0, known: true }],
          unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 10, y: 10, known: false }],
          observations: [
            { id: 'undefined-direction', type: 'direction', from: 'A', to: 'B', value: 0, unit: 'rad', sigma: 0.001, sigmaUnit: 'rad' },
            { id: 'distance', type: 'distance', from: 'A', to: 'P', value: Math.sqrt(200), unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
            { id: 'direction', type: 'direction', from: 'A', to: 'P', value: Math.PI / 4, unit: 'rad', sigma: 0.001, sigmaUnit: 'rad' }
          ]
        }
      })
      const adjusted = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'degenerate-plane-adjust' })
      expect(adjusted.run.status).toBe('needs_attention')
      expect(adjusted.result.validation).toBe('invalid')
    } finally { service.close() }
  })

  it('does not silently use a generic plane strategy for an incomplete traverse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-traverse-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-traverse', expectedRevision: 0, idempotencyKey: 'survey-import-traverse-1', networkType: 'traverse',
      network: {
        projectId: 'project-traverse', networkType: 'traverse',
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 0, y: 10, known: false }],
        observations: [{ id: 'd1', type: 'distance', from: 'A', to: 'P', value: 10, unit: 'm' }]
      }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-traverse-1' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(checked.findings.some((item) => item.code === 'invalid_observation' && item.severity === 'blocking')).toBe(true)
    const result = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-traverse-1' })
    expect(result.run.status).toBe('needs_attention')
    expect(result.result.strategyId).toBe('traverse')
    expect(result.result.qualityFindings.some((item) => item.severity === 'blocking')).toBe(true)
    service.close()
  })

  it('blocks coordinate transformation when no explicit parameters are supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-transform-missing-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-transform-missing', expectedRevision: 0, idempotencyKey: 'survey-import-transform-missing', networkType: 'coordinate-transform',
      network: {
        projectId: 'project-transform-missing', networkType: 'coordinate-transform', transformType: 'similarity-2d',
        knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', x: 10, y: 20, known: false }],
        observations: [{ id: 'd1', type: 'distance', from: 'A', to: 'P', value: Math.sqrt(500), unit: 'm' }]
      }
    })
    const result = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-transform-missing' })
    expect(result.run.status).toBe('needs_attention')
    expect(result.result.qualityFindings.some((item) => item.code === 'missing_datum')).toBe(true)
    service.close()
  })

  it('fits a coordinate transformation from explicit source/target control pairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-transform-fit-'))
    const service = new SurveyService({ rootDir: root })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: 'project-transform-fit', expectedRevision: 0, idempotencyKey: 'survey-import-transform-fit', networkType: 'coordinate-transform', network: {
      projectId: 'project-transform-fit', networkType: 'coordinate-transform', transformType: 'similarity-2d',
      knownPoints: [{ id: 'A', pointClass: 'known', x: 0, y: 0, known: true }, { id: 'B', pointClass: 'known', x: 10, y: 0, known: true }], unknownPoints: [],
      observations: [
        { id: 'pair-a', type: 'distance', from: 'A', to: 'B', value: 10, unit: 'm', targetX: 5, targetY: 7 },
        { id: 'pair-b', type: 'distance', from: 'B', to: 'A', value: 10, unit: 'm', targetX: 15, targetY: 7 }
      ]
    } })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-transform-fit' })
    expect(output.run.status).toBe('completed')
    expect(output.result.strategyId).toBe('coordinate-transform')
    expect(output.result.closure.translationX).toBeCloseTo(5, 8)
    expect(output.result.closure.translationY).toBeCloseTo(7, 8)
    expect(output.result.solverDiagnostics?.rank).toBe(4)
    service.close()
  })

  it('retains a 2-D similarity transformation CSV but blocks it until a saved mapping is approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-transform-csv-'))
    const service = new SurveyService({ rootDir: root })
    const csv = [
      'id,type,sourceX,sourceY,targetX,targetY,unit,sigma',
      'A,coordinate-pair,0,0,5,7,m,0.001',
      'B,coordinate-pair,100,0,105,7,m,0.001',
      'C,coordinate-pair,0,100,5,107,m,0.001'
    ].join('\n')
    const network = await service.importNetwork({ projectId: 'project-transform-csv', expectedRevision: 0, idempotencyKey: 'survey-import-transform-csv', networkType: 'coordinate-transform', transformType: 'similarity-2d', name: 'control-pairs.csv', dataBase64: Buffer.from(csv).toString('base64') })
    expect(network.transformType).toBe('similarity-2d')
    expect(network.knownPoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'A', x: 0, y: 0 }), expect.objectContaining({ id: 'B', x: 100, y: 0 })]))
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-transform-csv' })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-transform-csv' })
    expect(checked.qualityStatus).toBe('blocked')
    expect(checked.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'mapping_required', severity: 'blocking' }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' })
    ]))
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.validation).toBe('invalid')
    expect(output.result.qualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'mapping_required', severity: 'blocking' }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' })
    ]))
    service.close()
  })

  it('persists immutable deformation comparison results from adjusted observation epochs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-deformation-'))
    const service = new SurveyService({ rootDir: root })
    const makeEpoch = async (suffix: string, observationEpoch: string, heightDifference: number) => {
      const network = await importWorkwiseSurveyNetwork(service, {
        projectId: 'project-deformation', expectedRevision: 0, idempotencyKey: `deformation-import-${suffix}`, networkType: 'leveling', network: {
          networkType: 'leveling', coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height', observationEpoch,
          knownPoints: [{ id: 'BM', pointClass: 'known', height: 100, known: true }],
          unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 100 + heightDifference, known: false }],
          observations: [{ id: `dh-${suffix}`, type: 'height-difference', from: 'BM', to: 'P1', value: heightDifference, unit: 'm', sigma: 0.0002, sigmaUnit: 'm' }]
        }
      })
      return service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `deformation-adjust-${suffix}` })
    }
    const reference = await makeEpoch('reference', '2026-01-01T00:00:00.000Z', 0.2)
    const current = await makeEpoch('current', '2026-01-11T00:00:00.000Z', 0.19)
    const comparison = service.compareDeformation({
      projectId: 'project-deformation', adjustmentIds: [current.run.id, reference.run.id],
      pairs: [{ id: 'tilt-BM-P1', firstPointId: 'BM', secondPointId: 'P1', kind: 'tilt', baselineM: 10 }],
      stabilityRateMPerDay: 0.0001, expectedRevision: current.run.revision, idempotencyKey: 'deformation-compare-001'
    })

    expect(comparison.referenceAdjustmentId).toBe(reference.run.id)
    expect(comparison.currentAdjustmentId).toBe(current.run.id)
    expect(comparison.durationDays).toBe(10)
    expect(comparison.points.find((point) => point.pointId === 'P1')).toMatchObject({
      dH: expect.closeTo(-0.01, 12), settlement: expect.closeTo(0.01, 12),
      trend: 'settling', rates: { settlementPerDay: expect.closeTo(0.001, 12) }
    })
    expect(comparison.pairs[0]).toMatchObject({ differentialSettlement: expect.closeTo(0.01, 12), tilt: expect.closeTo(0.001, 12) })
    expect(service.getDeformation(comparison.id)?.inputHash).toBe(comparison.inputHash)
    expect(service.listDeformations('project-deformation')).toHaveLength(1)

    const reused = service.compareDeformation({
      projectId: 'project-deformation', adjustmentIds: [reference.run.id, current.run.id], pairs: [{ id: 'tilt-BM-P1', firstPointId: 'BM', secondPointId: 'P1', kind: 'tilt', baselineM: 10 }],
      stabilityRateMPerDay: 0.0001, expectedRevision: current.run.revision, idempotencyKey: 'deformation-compare-002'
    })
    expect(reused.id).toBe(comparison.id)
    expect(service.listDeformations('project-deformation')).toHaveLength(1)

    // The historical row remains readable for audit, but any fresh use must
    // reproduce both its numerical payload and request fingerprint from live
    // adjustment evidence. Simulate a self-consistent storage edit that
    // leaves epoch identifiers and displacement values intact: a larger
    // threshold changes the derived trend from settling to stable.
    const database = new Database(join(root, 'survey.sqlite3'))
    try {
      const row = database.prepare('SELECT data_json FROM survey_deformations WHERE id = ?').get(comparison.id) as { data_json: string }
      const tampered = JSON.parse(row.data_json) as { stabilityRateMPerDay: number; points: Array<{ trend: string }> }
      tampered.stabilityRateMPerDay = 0.01
      for (const point of tampered.points) point.trend = 'stable'
      database.prepare('UPDATE survey_deformations SET data_json = ? WHERE id = ?').run(JSON.stringify(tampered), comparison.id)
    } finally {
      database.close()
    }
    expect(service.getDeformation(comparison.id)?.stabilityRateMPerDay).toBe(0.01)
    expect(() => service.getDeformationForNewUse(comparison.id)).toThrow(/fresh deterministic comparison/)
    expect(() => service.compareDeformation({
      projectId: 'project-deformation', adjustmentIds: [reference.run.id, current.run.id],
      pairs: [{ id: 'tilt-BM-P1', firstPointId: 'BM', secondPointId: 'P1', kind: 'tilt', baselineM: 10 }],
      stabilityRateMPerDay: 0.0001, expectedRevision: current.run.revision, idempotencyKey: 'deformation-compare-after-tamper'
    })).toThrow(/fresh deterministic comparison/)
    service.close()
  })

  it('blocks deformation comparison when epoch datum metadata differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-deformation-datum-'))
    const service = new SurveyService({ rootDir: root })
    const adjustmentIds: string[] = []
    for (const [index, verticalDatum] of ['datum-a', 'datum-b'].entries()) {
      const network = await importWorkwiseSurveyNetwork(service, {
        projectId: 'project-deformation-datum', expectedRevision: 0, idempotencyKey: `datum-import-${index}`, networkType: 'leveling', network: {
          networkType: 'leveling', coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum, observationEpoch: `2026-01-0${index + 1}T00:00:00.000Z`,
          knownPoints: [{ id: 'BM', pointClass: 'known', height: 100, known: true }], unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 100.2, known: false }],
          observations: [{ id: `dh-${index}`, type: 'height-difference', from: 'BM', to: 'P', value: 0.2 - index * 0.001, unit: 'm', sigma: 0.0002, sigmaUnit: 'm' }]
        }
      })
      adjustmentIds.push(service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `datum-adjust-${index}` }).run.id)
    }
    expect(() => service.compareDeformation({ projectId: 'project-deformation-datum', adjustmentIds, expectedRevision: 1, idempotencyKey: 'datum-compare-001' })).toThrow('identical coordinate system')
    service.close()
  })

  it('persists a Leica source unchanged for audit and lets strategy validation reject incomplete geometry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-source-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from('*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456 81..00+00100000 82..00+00200000 84..00+00000000 85..00+00000000\n')
    const network = await service.importNetwork({
      projectId: 'project-gsi', expectedRevision: 0, idempotencyKey: 'survey-import-gsi-source', networkType: 'plane-control',
      name: 'station.gsi', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile).toMatchObject({
      name: 'station.gsi', originalPreserved: true, disposition: 'adjustment-ready',
      detection: { format: 'leica-gsi8', vendor: 'Leica/Hexagon' },
      parserId: 'survey-format-registry'
    })
    expect(network.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'direction', sourceRecordId: 'record-1' }),
      expect.objectContaining({ type: 'slope-distance', unit: 'm' })
    ]))
    expect(network.qualityStatus).toBe('imported')
    expect(network.findings.some((finding) => finding.severity === 'blocking')).toBe(false)
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-gsi-source' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.validation).toBe('invalid')
    expect(await readFile(join(root, 'sources', network.sourceFile!.sha256, 'original'))).toEqual(source)
    service.close()
  })

  it('preserves legal Leica GSI ignored-record warnings without projecting parse errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-warning-projection-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      '410001+?......4',
      '110002+00000001 83..58+00000000',
      '110003+00000001 574..8+00010000 83..28+00000100',
      '110004+00000002 574..8+00020000 83..28+00000200'
    ].join('\r\n'))
    const network = await service.importNetwork({
      projectId: 'project-gsi-warning-projection', expectedRevision: 0, idempotencyKey: 'survey-import-gsi-warning-projection', networkType: 'height-control',
      name: 'leveling.GSI', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'record_ignored', severity: 'warning' })
    ]))
    expect(network.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'record_ignored', severity: 'warning' })
    ]))
    expect(network.findings.some((item) => item.code === 'parse_error')).toBe(false)
    expect(network.findings.some((item) => item.severity === 'blocking')).toBe(false)
    service.close()
  })

  it('promotes an explicitly mapped Leica GSI leveling point while retaining its raw locator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-known-point-mapping-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      '410001+?......4',
      '110002+00000001 83..58+00000000',
      '110003+00000002 574..8+00010000 83..28+00000100'
    ].join('\r\n'))
    try {
      const mapped = await service.importNetwork({
        projectId: 'project-gsi-known-point-mapping', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-map-1', networkType: 'height-control',
        name: 'leveling.GSI', dataBase64: source.toString('base64'), knownPoints: [{ id: '2', height: 10 }]
      })
      expect(mapped.knownPoints).toEqual([expect.objectContaining({
        id: '2', height: 10, pointClass: 'known', known: true, sourceLocator: 'GSI:3'
      })])
      expect(mapped.unknownPoints).toEqual([expect.objectContaining({ id: '1', pointClass: 'station', known: false })])
      expect(mapped.observations).toEqual([expect.objectContaining({ from: '1', to: '2', sourceLocator: 'GSI:3' })])
    } finally {
      service.close()
    }
  })

  it('keeps Leica GSI points unknown without an explicit known-point mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-known-point-default-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      '410001+?......4',
      '110002+00000001 83..58+00000000',
      '110003+00000002 574..8+00010000 83..28+00000100'
    ].join('\r\n'))
    try {
      const unmapped = await service.importNetwork({
        projectId: 'project-gsi-known-point-default', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-default-1', networkType: 'height-control',
        name: 'leveling.GSI', dataBase64: source.toString('base64')
      })
      expect(unmapped.knownPoints).toEqual([])
      expect(unmapped.unknownPoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '1', pointClass: 'station', known: false }),
        expect.objectContaining({ id: '2', pointClass: 'unknown', known: false, sourceLocator: 'GSI:3' })
      ]))
    } finally {
      service.close()
    }
  })

  it('blocks a known-point mapping that conflicts with coordinates in a Leica GSI source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-known-point-conflict-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from('*11....+00000001 81..00+00100000 82..00+00200000 83..00+00050000\n')
    try {
      await expect(service.importNetwork({
        projectId: 'project-gsi-known-point-conflict', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-conflict-1', networkType: 'height-control',
        name: 'station.GSI', dataBase64: source.toString('base64'), knownPoints: [{ id: '1', x: 2, y: 2, height: 0.5 }]
      })).rejects.toThrow(/known point mapping conflicts/i)
    } finally {
      service.close()
    }
  })

  it('binds GSI import idempotency to known-point mappings and does not fake raw provenance for manual points', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-gsi-known-point-idempotency-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      '410001+?......4',
      '110002+00000001 83..58+00000000',
      '110003+00000002 574..8+00010000 83..28+00000100'
    ].join('\r\n'))
    try {
      const first = await service.importNetwork({
        projectId: 'project-gsi-known-point-idempotency', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-idempotency-1', networkType: 'height-control',
        name: 'leveling.GSI', dataBase64: source.toString('base64')
      })
      expect(first.unknownPoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: '2', known: false })]))
      await expect(service.importNetwork({
        projectId: 'project-gsi-known-point-idempotency', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-idempotency-1', networkType: 'height-control',
        name: 'leveling.GSI', dataBase64: source.toString('base64'), knownPoints: [{ id: '2', height: 10 }]
      })).rejects.toThrow(/different import request/i)

      const manual = await service.importNetwork({
        projectId: 'project-gsi-known-point-idempotency', expectedRevision: 0, idempotencyKey: 'survey-gsi-known-point-manual-1', networkType: 'height-control',
        name: 'leveling.GSI', dataBase64: source.toString('base64'), knownPoints: [{ id: 'MANUAL-BM', height: 20 }]
      })
      expect(manual.knownPoints).toEqual(expect.arrayContaining([expect.objectContaining({
        id: 'MANUAL-BM', pointClass: 'known', known: true, sourceLocator: 'manual-known-point:MANUAL-BM'
      })]))
      expect(manual.knownPoints.find((point) => point.id === 'MANUAL-BM')?.sourceLocator).not.toMatch(/^GSI:/)
    } finally {
      service.close()
    }
  })

  it('keeps CSV survey observations archive-only until an explicit saved mapping and unit/angle confirmation is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-csv-mapping-gate-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from('type,from,to,value,unit\nheight-difference,BM,P1,0.1,m\n')
    const network = await service.importNetwork({
      projectId: 'project-csv-mapping-gate', expectedRevision: 0, idempotencyKey: 'survey-import-csv-mapping-gate', networkType: 'leveling',
      name: 'control.csv', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile).toMatchObject({ detection: { format: 'delimited-text' }, disposition: 'archive-only', requiresManualConfirmation: true })
    expect(network.observations).toHaveLength(1)
    expect(network.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'mapping_required', severity: 'blocking' }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' })
    ]))
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-csv-mapping-gate' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.validation).toBe('invalid')
    expect(adjustment.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' }))
    service.close()
  })

  it('lets a strictly parsed COSA source reach strategy validation but blocks incomplete control geometry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-cosa-archive-only-'))
    const service = new SurveyService({ rootDir: root })
    const source = await readFile(new URL('golden-single-station.in2', COSA_IN2_FIXTURE_DIRECTORY))
    const network = await service.importNetwork({
      projectId: 'project-cosa-archive-only', expectedRevision: 0, idempotencyKey: 'survey-import-cosa-archive-only', networkType: 'plane-control',
      name: 'control.in2', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile).toMatchObject({
      detection: { format: 'cosa-in2', method: 'structural-probe' },
      disposition: 'adjustment-ready'
    })
    expect(network.observations).toHaveLength(4)
    expect(network.qualityStatus).toBe('imported')
    expect(network.findings.some((finding) => finding.severity === 'blocking')).toBe(false)

    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-cosa-archive-only' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.validation).toBe('invalid')
    expect(adjustment.result.qualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'blocking' })
    ]))
    service.close()
  })

  it('adjusts target-only COSA station-circle observations with an explicit station orientation parameter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-cosa-station-circle-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      '1,1,1',
      'A,0,0',
      'B,100,0',
      'C,0,100',
      'S1',
      'A,L,0',
      'A,S,70.710678',
      'B,L,90.00000',
      'B,S,70.710678',
      'C,L,270.00000',
      'C,S,70.710678',
      'P,L,180.00000',
      'P,S,42.426407'
    ].join('\n'))
    const network = await service.importNetwork({
      projectId: 'project-cosa-station-circle', expectedRevision: 0, idempotencyKey: 'survey-import-cosa-station-circle', networkType: 'plane-control',
      name: 'target-only.in2', dataBase64: source.toString('base64')
    })
    expect(network.unknownPoints.filter((point) => ['S1', 'P'].includes(point.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'S1', x: expect.any(Number), y: expect.any(Number) }),
      expect.objectContaining({ id: 'P', x: expect.any(Number), y: expect.any(Number) })
    ]))

    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-validate-cosa-station-circle' })
    expect(checked.qualityStatus).toBe('validated')
    const adjustment = service.createAdjustment({ networkId: checked.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-cosa-station-circle' })

    expect(adjustment.run.status).toBe('completed')
    expect(adjustment.result).toMatchObject({ strategyId: 'plane-control', validation: 'valid' })
    expect(adjustment.result.parameters).toMatchObject({ 'orientation:S1': expect.any(Number) })
    expect(adjustment.result.parameterUnits).toMatchObject({ 'orientation:S1': 'rad' })
    expect(adjustment.result.points.find((point) => point.id === 'S1')).toMatchObject({ x: expect.closeTo(50, 5), y: expect.closeTo(50, 5) })
    expect(adjustment.result.points.find((point) => point.id === 'P')).toMatchObject({ x: expect.closeTo(80, 5), y: expect.closeTo(80, 5) })
    expect(adjustment.result.precision.passed).toBe(true)
    expect(network.findings.some((item) => item.code === 'parse_error')).toBe(false)
    expect(network.findings).toContainEqual(expect.objectContaining({ code: 'format_detected', suggestion: expect.stringContaining('闭合') }))
    expect(adjustment.result.points.filter((point) => ['S1', 'P'].includes(point.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'S1', x: expect.any(Number), y: expect.any(Number) }),
      expect.objectContaining({ id: 'P', x: expect.any(Number), y: expect.any(Number) })
    ]))
    service.close()
  })

  it('blocks parsed P1 LandXML from adjustment even when its parser retains observations for audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-landxml-archive-only-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from('<LandXML version="1.2"><CgPoints><CgPoint name="S1">0 0 0</CgPoint><CgPoint name="P1">10 10 0</CgPoint></CgPoints><Survey><ReducedObservation setupID="S1" targetSetupID="P1" horizAngle="45" slopeDistance="14.142" /></Survey></LandXML>')
    const network = await service.importNetwork({
      projectId: 'project-landxml-archive-only', expectedRevision: 0, idempotencyKey: 'survey-import-landxml-archive-only', networkType: 'plane-control',
      name: 'control.xml', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile).toMatchObject({
      detection: { format: 'landxml' },
      disposition: 'archive-only',
      requiresManualConfirmation: true
    })
    expect(network.observations.length).toBeGreaterThan(0)
    expect(network.findings).toContainEqual(expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' }))

    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-landxml-archive-only' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.validation).toBe('invalid')
    expect(adjustment.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' }))
    service.close()
  })

  it('fails closed for a structurally recognized SurveyCloud SUC source while its field semantics remain unverified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-suc-archive-only-'))
    const service = new SurveyService({ rootDir: root })
    const source = Buffer.from([
      'SSJ3,4,1,0.0000',
      'Start,2022-11-10,12:42:36',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022-11-12,13:17:00'
    ].join('\r\n'))
    const network = await service.importNetwork({
      projectId: 'project-suc-archive-only', expectedRevision: 0, idempotencyKey: 'survey-import-suc-archive-only', networkType: 'plane-control',
      name: 'control.suc', dataBase64: source.toString('base64')
    })

    expect(network.sourceFile).toMatchObject({
      detection: { format: 'survey-cloud-suc', method: 'structural-probe' },
      disposition: 'archive-only',
      requiresManualConfirmation: true,
      linearUnitCanonical: 'unverified',
      angularUnitCanonical: 'unverified'
    })
    expect(network.observations).toEqual([])
    expect(network.qualityStatus).toBe('blocked')
    expect(network.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'parse_error', severity: 'blocking', message: expect.stringContaining('F-FMT-11') }),
      expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' })
    ]))
    expect(service.getSourceEligibility(network.id)).toMatchObject({ eligible: false })
    expect(service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'survey-adjust-suc-archive-only' }).run.status).toBe('needs_attention')
    service.close()
  })

  it('keeps RINEX as a GNSS processing blocker rather than a fabricated baseline network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-rinex-source-'))
    const service = new SurveyService({ rootDir: root })
    const rinex = '     3.04           O                   RINEX VERSION / TYPE\nSITE                                                        MARKER NAME\n  1000.0  2000.0  3000.0                  APPROX POSITION XYZ\n                                                            END OF HEADER\n'
    const imported = await service.importNetwork({
      projectId: 'project-rinex', expectedRevision: 0, idempotencyKey: 'survey-import-rinex-source', networkType: 'plane-control',
      name: 'site.obs', dataBase64: Buffer.from(rinex).toString('base64')
    })
    expect(imported.networkType).toBe('gnss')
    expect(imported.qualityStatus).toBe('blocked')
    expect(imported.sourceFile?.disposition).toBe('gnss-processing-required')
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'survey-validate-rinex-source' })
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'gnss_processing_required', severity: 'blocking' }))
    const adjustment = service.createAdjustment({ networkId: checked.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-rinex-source' })
    expect(adjustment.run.status).toBe('needs_attention')
    expect(adjustment.result.validation).toBe('invalid')
    service.close()
  })

  it('keeps receiver-native UBX bytes as a GNSS processing blocker with byte provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-ubx-source-'))
    const service = new SurveyService({ rootDir: root })
    const ubx = Buffer.from([0xb5, 0x62, 0x01, 0x07, 0x00, 0x00, 0x00, 0x00])
    const imported = await service.importNetwork({
      projectId: 'project-ubx', expectedRevision: 0, idempotencyKey: 'survey-import-ubx-source', networkType: 'plane-control',
      name: 'receiver.ubx', dataBase64: ubx.toString('base64')
    })
    expect(imported.networkType).toBe('gnss')
    expect(imported.qualityStatus).toBe('blocked')
    expect(imported.observations).toHaveLength(0)
    expect(imported.sourceFile).toMatchObject({
      detection: { format: 'ublox-ubx', vendor: 'u-blox' },
      disposition: 'gnss-processing-required',
      rawRecordAnchors: [{ byteOffset: 0, byteLength: 8, recordType: 'UBX-01-07' }]
    })
    expect(await readFile(join(root, 'sources', imported.sourceFile!.sha256, 'original'))).toEqual(ubx)
    const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'survey-validate-ubx-source' })
    expect(checked.findings).toContainEqual(expect.objectContaining({ code: 'gnss_processing_required', severity: 'blocking' }))
    expect(service.createAdjustment({ networkId: checked.id, expectedRevision: checked.revision, idempotencyKey: 'survey-adjust-ubx-source' }).run.status).toBe('needs_attention')
    service.close()
  })

  it('retains an unmapped DAT source without falling back to a successful delimited import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-unknown-source-'))
    const service = new SurveyService({ rootDir: root })
    const network = await service.importNetwork({
      projectId: 'project-unknown-format', expectedRevision: 0, idempotencyKey: 'survey-import-unknown-format', networkType: 'leveling',
      name: 'instrument.dat', dataBase64: Buffer.from('010203040506\n998877665544\n').toString('base64')
    })
    expect(network.observations).toHaveLength(0)
    expect(network.sourceFile?.detection).toMatchObject({ format: 'south-dat', method: 'extension-fallback' })
    expect(network.sourceFile?.disposition).toBe('archive-only')
    expect(network.findings).toContainEqual(expect.objectContaining({ code: 'source_not_adjustment_ready', severity: 'blocking' }))
    service.close()
  })
})
