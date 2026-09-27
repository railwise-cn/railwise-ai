import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { SurveyFormatRegistry, SURVEY_FORMAT_LIMITS } from './survey-format-registry.js'
import { P0_SURVEY_FORMAT_IDS, findP0SurveyFormatEntry } from './survey-format-catalog.js'

const registry = new SurveyFormatRegistry()
const COSA_IN2_FIXTURE_DIRECTORY = new URL('./fixtures/survey-formats/cosa-in2/', import.meta.url)
const PROFESSIONAL_FIXTURE_DIRECTORY = new URL('./fixtures/survey-formats/professional/', import.meta.url)

async function ingest(name: string, value: string | Uint8Array) {
  return registry.ingest({ name, bytes: Buffer.from(value), networkType: 'plane-control' })
}

function frozenWorkwiseSource(network: Record<string, unknown>, space?: number): string {
  return JSON.stringify({
    format: 'workwise-survey-network',
    formatVersion: 1,
    network
  }, null, space)
}

function compactJsonRecords(count: number): string {
  return new Array(count).fill('{}').join(',')
}

function compactFrozenWorkwiseArrays(knownPoints: string, unknownPoints: string, observations: string): string {
  return `{"format":"workwise-survey-network","formatVersion":1,"network":{"knownPoints":[${knownPoints}],"unknownPoints":[${unknownPoints}],"observations":[${observations}]}}`
}

async function cosaIn2Fixture(name: string): Promise<Buffer> {
  return await readFile(new URL(name, COSA_IN2_FIXTURE_DIRECTORY))
}

describe('SurveyFormatRegistry', () => {
  it('parses Leica GSI-8 records with raw anchors and canonical observation units', async () => {
    const source = '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456 42....+00000001 81..00+00100000 82..00+00200000 83..00+00050000 84..00+00000000 85..00+00000000 86..00+00000000\n'
    const result = await ingest('station.gsi', source)
    const catalog = findP0SurveyFormatEntry('leica-gsi8')!
    expect(result.sourceFile.detection).toMatchObject({ format: 'leica-gsi8', vendor: 'Leica/Hexagon', extensionConflict: false })
    expect(result.sourceFile).toMatchObject({
      sourcePath: expect.stringMatching(/^attachment:\/\/sha256\/[0-9a-f]{64}\/station\.gsi$/),
      fileSize: Buffer.byteLength(source),
      formatId: 'leica-gsi8',
      detectionMethod: 'content-signature',
      linearUnitRaw: '0:0.001-m',
      angularUnitRaw: '2:0.00001-gon',
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad',
      parserId: 'survey-format-registry',
      parserSourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      summary: expect.objectContaining({ pointCount: expect.any(Number), stationCount: expect.any(Number), observationCount: expect.any(Number), recordCount: expect.any(Number), skippedRecordCount: expect.any(Number) })
    })
    expect(result.sourceFile).toMatchObject({
      disposition: catalog.currentDisposition,
      requiresManualConfirmation: false,
      dispositionReason: expect.stringContaining(catalog.currentDispositionReason)
    })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning',
      message: expect.stringContaining(`P0 格式目录 ${catalog.registryVersion}`),
      suggestedAction: expect.stringContaining('闭合')
    }))
    expect(result.sourceFile.originalPreserved).toBe(true)
    expect(result.sourceFile.records).toEqual(result.sourceFile.rawRecordAnchors)
    expect(result.sourceFile.rawRecordAnchors[0]).toMatchObject({ sourceRecord: 1, recordType: 'GSI', rawOffset: 0, rawLength: Buffer.byteLength(source.trimEnd()), rawLineNo: 1, rawSnippet: expect.stringContaining('*11....') })
    expect(Object.values(result.sourceFile.preservedRawFields)).toContain('42....+00000001')
    expect(result.observations.map((item) => [item.type, item.unit])).toEqual(expect.arrayContaining([
      ['direction', 'rad'], ['zenith', 'rad'], ['slope-distance', 'm']
    ]))
    expect(result.observations[0]?.sourceLocator).toBe('GSI:1')
  })

  it('distinguishes and parses Leica GSI-16 metric words', async () => {
    const result = await ingest('station.gsi', '*11....+0000000000000001 21..02+0000000004500000 22..02+0000000009000000 31..00+0000000000123456\n')
    const catalog = findP0SurveyFormatEntry('leica-gsi16')!
    expect(result.sourceFile.detection.format).toBe('leica-gsi16')
    expect(result.sourceFile).toMatchObject({ disposition: catalog.currentDisposition, requiresManualConfirmation: false })
    expect(result.observations).toContainEqual(expect.objectContaining({ type: 'slope-distance', value: 123.456, unit: 'm' }))
  })

  it('keeps UTF-16LE GSI raw line anchors in the original byte address space', async () => {
    const firstLine = '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456'
    const secondLine = '*11....+00000002 21..02+04600000 22..02+09100000 31..00+00111111'
    const source = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${firstLine}\r\n${secondLine}`, 'utf16le')])
    const result = await ingest('station-utf16.gsi', source)
    const first = result.sourceFile.rawRecordAnchors.find((record) => record.id === 'record-1')!
    const second = result.sourceFile.rawRecordAnchors.find((record) => record.id === 'record-2')!

    expect(result.sourceFile.detection.format).toBe('leica-gsi8')
    expect(first).toMatchObject({ rawOffset: 2, rawLength: Buffer.byteLength(firstLine, 'utf16le') })
    expect(second).toMatchObject({
      rawOffset: 2 + Buffer.byteLength(`${firstLine}\r\n`, 'utf16le'),
      rawLength: Buffer.byteLength(secondLine, 'utf16le')
    })
    expect(second.rawOffset % 2).toBe(0)
    expect(source.subarray(second.rawOffset, second.rawOffset + second.rawLength).toString('utf16le')).toBe(secondLine)
  })

  it('keeps CR-only GSI records in their original byte ranges', async () => {
    const firstLine = '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456'
    const secondLine = '*11....+00000002 21..02+04600000 22..02+09100000 31..00+00111111'
    const source = `${firstLine}\r${secondLine}\r`
    const result = await ingest('station-cr-only.gsi', source)

    expect(result.sourceFile.detection.format).toBe('leica-gsi8')
    expect(result.sourceFile.rawRecordAnchors).toHaveLength(2)
    expect(result.sourceFile.rawRecordAnchors[0]).toMatchObject({
      rawOffset: 0,
      rawLength: Buffer.byteLength(firstLine),
      rawLineNo: 1
    })
    expect(result.sourceFile.rawRecordAnchors[1]).toMatchObject({
      rawOffset: Buffer.byteLength(firstLine) + 1,
      rawLength: Buffer.byteLength(secondLine),
      rawLineNo: 2
    })
  })

  it('carries a malformed GSI lexical diagnostic to its exact source anchor', async () => {
    const firstLine = '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456'
    const invalidWord = '21..02+04500000,22..02+09000000'
    const source = `${firstLine}\r${invalidWord}`
    const result = await ingest('malformed.gsi', source)
    const diagnostic = result.sourceFile.diagnostics.find((item) => item.message.includes('物理词法校验失败'))!

    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(diagnostic).toMatchObject({
      code: 'invalid_record',
      severity: 'blocking',
      byteOffset: source.indexOf(','),
      recordAnchor: expect.any(String)
    })
    const anchor = result.sourceFile.rawRecordAnchors.find((item) => item.id === diagnostic.recordAnchor)
    expect(anchor).toMatchObject({
      rawOffset: source.indexOf(','),
      rawLength: 1,
      rawSnippet: ','
    })
  })

  it.each([
    ['survey.hexml', '<HeXML version="2.0"><Point name="S1"><Northing>0</Northing><Easting>0</Easting></Point><Point name="P1"><Northing>10</Northing><Easting>10</Easting></Point><RawObservation stationName="S1" targetName="P1" horizAngle="45" slopeDistance="14.142" /></HeXML>', 'leica-hexml'],
    ['survey.jxl', '<JOBFile version="1.0"><FieldBook><StationRecord ID="setup-1"><StationName>S1</StationName></StationRecord><TargetRecord ID="target-1"><TargetName>P1</TargetName></TargetRecord><Circle><StationID>setup-1</StationID><TargetID>target-1</TargetID><HorizontalCircle>45</HorizontalCircle><EDMDistance>14.142</EDMDistance></Circle></FieldBook></JOBFile>', 'trimble-jobxml'],
    ['survey.xml', '<LandXML version="1.2"><CgPoints><CgPoint name="S1">0 0 0</CgPoint><CgPoint name="P1">10 10 0</CgPoint></CgPoints><Survey><ReducedObservation setupID="S1" targetSetupID="P1" horizAngle="45" slopeDistance="14.142" /></Survey></LandXML>', 'landxml']
  ])('retains documented XML survey exchange %s for audit but does not promote P1/P2 parser output', async (name, content, format) => {
    const result = await ingest(name, content)
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.observations.length).toBeGreaterThan(0)
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning',
      message: expect.stringContaining('不构成 adjustment-ready 许可')
    }))
    // Minified XML records share the one physical source line. The registry
    // publishes that honest line-level boundary, while deliberately leaving
    // element-level byte spans for a separately verified dialect adapter.
    expect(result.sourceFile.rawRecordAnchors.length).toBeGreaterThan(0)
    expect(result.sourceFile.rawRecordAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^xml-/), rawLineNo: 1, byteOffset: 0 })
    ]))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('元素级偏移')
    }))
    if (format === 'landxml') {
      expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
        message: expect.stringContaining('Units.angleUnit / directionUnit')
      }))
      expect(result.sourceFile.linearUnitRaw).toContain('not-declared')
      expect(result.sourceFile.angularUnitRaw).toContain('not-declared')
      expect(result.observations.every((observation) => !['m', 'deg'].includes(observation.unit))).toBe(true)
    }
    expect(new Set(result.sourceFile.records.map((record) => record.id)).size).toBe(result.sourceFile.records.length)
  })

  it('preserves LandXML foot/radian/direction declarations without relabelling values as metres or degrees', async () => {
    const source = [
      '<LandXML version="1.2">',
      '<Units><Imperial linearUnit="foot" angularUnit="radian" directionUnit="southAzimuth" /></Units>',
      '<CgPoints><CgPoint name="S1">0 0 0</CgPoint><CgPoint name="P1">10 10 0</CgPoint></CgPoints>',
      '<Survey><ReducedObservation setupID="S1" targetSetupID="P1" horizAngle="0.7853981634" slopeDistance="100" /></Survey>',
      '</LandXML>'
    ].join('')
    const result = await ingest('imperial-radian.landxml', source)

    expect(result.sourceFile).toMatchObject({
      formatId: 'landxml',
      disposition: 'archive-only',
      linearUnitRaw: expect.stringContaining('linearunit=foot'),
      angularUnitRaw: expect.stringContaining('angularunit=radian'),
      linearUnitCanonical: 'unverified',
      angularUnitCanonical: 'unverified'
    })
    expect(result.sourceFile.angularUnitRaw).toContain('directionunit=southAzimuth')
    expect(Object.values(result.sourceFile.preservedRawFields)).toEqual(expect.arrayContaining(['foot', 'radian', 'southAzimuth']))
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'direction', value: 0.7853981634, unit: 'landxml-angular-unit-unverified' }),
      expect.objectContaining({ type: 'slope-distance', value: 100, unit: 'landxml-linear-unit-unverified' })
    ]))
    expect(result.observations.every((observation) => !['m', 'deg'].includes(observation.unit))).toBe(true)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', message: expect.stringContaining('数值未换算为 m 或 deg')
    }))
  })

  it('parses Trimble/Zeiss M5 leveling records without inventing a datum', async () => {
    const result = await ingest('level.m5', 'For M5|KD1 BM1|Z 100.000\nFor M5|KD1 P1|From BM1|HD 0.125|Dist 50\n')
    expect(result.sourceFile.detection.format).toBe('trimble-m5')
    expect(result.sourceFile).toMatchObject({ disposition: 'adjustment-ready', requiresManualConfirmation: false })
    expect(result.observations[0]).toMatchObject({ type: 'height-difference', from: 'BM1', to: 'P1', value: 0.125, unit: 'm' })
    expect(result.knownPoints).toHaveLength(0)
    expect(result.unknownPoints[0]?.height).toBeUndefined()
  })

  it('uses high-confidence M5 content over a misleading DAT extension', async () => {
    const result = await ingest('level.dat', 'For M5|KD1 BM1|Z 100.000\nFor M5|KD1 P1|From BM1|HD 0.125|Dist 50\n')
    expect(result.sourceFile.detection).toMatchObject({
      format: 'trimble-m5',
      extension: '.dat',
      extensionConflict: true,
      method: 'content-signature',
      confidence: 0.96
    })
    expect(result.sourceFile.disposition).toBe('adjustment-ready')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_conflict', severity: 'warning', message: expect.stringContaining('高置信内容优先')
    }))
    expect(result.observations).toEqual([expect.objectContaining({
      type: 'height-difference', from: 'BM1', to: 'P1', value: 0.125, unit: 'm'
    })])
  })

  it('parses real Trimble/Zeiss M5 aBFFB DAT records and preserves line provenance', async () => {
    const bytes = await readFile(new URL('trimble-m5-abffb.dat', PROFESSIONAL_FIXTURE_DIRECTORY))
    const result = await ingest('trimble-m5-abffb.dat', bytes)

    expect(result.sourceFile.detection.format).toBe('trimble-m5')
    expect(result.sourceFile.parserId).toBe('trimble-m5-abffb-parser')
    expect(result.sourceFile.parserVersion).toBe('0.2.0')
    expect(result.sourceFile).toMatchObject({
      disposition: 'adjustment-ready',
      requiresManualConfirmation: false,
      fileSize: bytes.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(result.observations).toHaveLength(4)
    expect(result.observations[0]).toMatchObject({
      type: 'height-difference', from: 'sy730', to: 'z1', unit: 'm',
      routeLength: expect.closeTo(60.0435, 6),
      sourceRow: 3,
      sourceLocator: 'M5:3-6'
    })
    expect(result.observations.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(4.990805, 6)
    expect(result.sourceFile.rawRecordAnchors.length).toBe(19)
    expect(result.sourceFile.records).toEqual(result.sourceFile.rawRecordAnchors)
    expect(result.sourceFile.rawRecordAnchors[2]).toMatchObject({
      id: 'record-3', sourceRecord: 3, rawLineNo: 3,
      rawSnippet: expect.stringContaining('Adr    10')
    })
    expect(result.observations[0]?.rawFields).toMatchObject({
      format: 'M5-aBFFB', from: 'sy730', to: 'z1', pattern: 'RbRfRfRb'
    })
    expect(result.unknownPoints.every((point) => point.height === undefined)).toBe(true)
    expect(result.sourceFile.diagnostics.some((item) => item.severity === 'blocking')).toBe(false)
  })

  it.each([
    ['golden-single-station.in2', 4, 9, 0],
    ['golden-multi-station-known-edge.in2', 8, 16, 2],
    ['golden-dms-carry-boundary.in2', 3, 7, 0]
  ])('uses the bounded structural COSA probe and retains audited parsed observations for %s', async (fixtureName, observationCount, recordCount, skippedRecordCount) => {
    const result = await ingest(`synthetic/${fixtureName}`, await cosaIn2Fixture(fixtureName))
    const catalog = findP0SurveyFormatEntry('cosa-in2')!
    expect(result.sourceFile.detection).toMatchObject({
      format: 'cosa-in2',
      vendor: 'COSA(科傻)',
      method: 'structural-probe',
      confidence: 0.98,
      extensionConflict: false
    })
    expect(result.sourceFile).toMatchObject({
      parserId: catalog.parserId,
      parserVersion: catalog.parserVersion,
      parserSourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      linearUnitRaw: 'm',
      angularUnitRaw: 'cosa-degree-dot-mmss',
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad',
      disposition: catalog.currentDisposition,
      requiresManualConfirmation: false,
      summary: { observationCount, recordCount, skippedRecordCount }
    })
    expect(result.sourceFile.dispositionReasonEn).toContain(catalog.registryVersion)
    expect(result.sourceFile.dispositionReasonEn).not.toMatch(/[\u3400-\u9fff]/u)
    const policy = result.sourceFile.diagnostics.find((item) => item.code === 'format_detected' && item.severity === 'warning')!
    expect(policy.localized?.en.message).toContain(catalog.formatId)
    expect(policy.localized?.en.suggestedAction).toContain('closure')
    expect(result.sourceFile.records).toHaveLength(recordCount)
    expect(result.sourceFile.records).toEqual(result.sourceFile.rawRecordAnchors)
    expect(result.sourceFile.records[0]).toMatchObject({
      id: 'cosa-in2-record-1', sourceRecord: 1, recordType: 'prior-header', rawOffset: 0,
      rawLength: expect.any(Number), rawSnippet: expect.stringContaining(',')
    })
    expect(result.observations).toHaveLength(observationCount)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', message: expect.stringContaining(`P0 格式目录 ${catalog.registryVersion}`), suggestedAction: expect.stringContaining('闭合')
    }))
    expect(result.sourceFile.diagnostics.some((diagnostic) => diagnostic.severity === 'blocking')).toBe(false)
  })

  it('maps COSA prior sigmas, correction state, raw fields, and the L,0 backsight role without losing provenance', async () => {
    const result = await ingest('control.in2', await cosaIn2Fixture('golden-single-station.in2'))
    const reset = result.observations.find((observation) => observation.rawFields?.role === 'backsight-reset')!
    const distance = result.observations.find((observation) => observation.type === 'distance')!
    expect(reset).toMatchObject({
      type: 'direction', unit: 'rad', sigmaUnit: 'rad',
      qualityFlags: expect.arrayContaining(['cosa-backsight-reset']),
      correctionState: {
        ppmApplied: false, prismConstantApplied: false, additiveConstantApplied: false,
        meteoApplied: false, slopeToHorizontalApplied: false, earthCurvatureRefractionApplied: false,
        centeringApplied: false, projectionReductionApplied: false
      },
      sourceRecordId: 'cosa-in2-record-6',
      rawFields: expect.objectContaining({
        role: 'backsight-reset', rawUnit: 'cosa-degree-dot-mmss',
        priorDirectionSigmaArcSeconds: '1.768', priorDistanceConstantMillimetres: '1', priorDistancePpm: '1'
      })
    })
    expect(reset.sigma).toBeCloseTo(1.768 * Math.PI / (180 * 3_600), 15)
    expect(distance).toMatchObject({ type: 'distance', unit: 'm', sigmaUnit: 'm' })
    expect(distance.sigma).toBeCloseTo(Math.hypot(0.001, 1e-6 * 100), 15)
    expect(result.sourceFile.preservedRawFields).toMatchObject({
      'source:cosa-in2:prior-direction-arc-seconds': '1.768',
      'source:cosa-in2:prior-distance-constant-millimetres': '1',
      'source:cosa-in2:prior-distance-ppm': '1'
    })
  })

  it('creates target-only COSA points with deterministic direction-distance initials and station-circle directions', async () => {
    const result = await ingest('target-only.in2', [
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

    const target = result.unknownPoints.find((point) => point.id === 'P')!
    const station = result.unknownPoints.find((point) => point.id === 'S1')!
    expect(target).toMatchObject({
      pointClass: 'unknown',
      known: false,
      rawFields: expect.objectContaining({
        role: 'target',
        initialCoordinateMethod: 'cosa-station-polar-rigid-initialization'
      })
    })
    expect(target.x).toEqual(expect.any(Number))
    expect(target.y).toEqual(expect.any(Number))
    expect(station.rawFields).toMatchObject({ initialCoordinateMethod: 'cosa-station-polar-rigid-initialization' })
    expect(result.observations.filter((observation) => observation.type === 'direction')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        station: 'S1',
        rawFields: expect.objectContaining({ directionReference: 'cosa-station-circle', stationCircleOrientation: true, coordinateAxisOrder: 'north-east' })
      })
    ]))
  })

  it('accepts COSA export blank separators without persisting zero-length source anchors', async () => {
    const source = [
      '1,1,1',
      '',
      'A,0,0',
      '',
      'S1',
      '',
      'A,L,0',
      'B,L,90.00000',
      '',
      'B,S,100.000'
    ].join('\n')
    const result = await ingest('blank-separated.in2', source)

    expect(result.sourceFile).toMatchObject({
      detection: { format: 'cosa-in2', method: 'structural-probe' },
      disposition: 'adjustment-ready',
      summary: { pointCount: 1, stationCount: 1, observationCount: 3, recordCount: 6 }
    })
    expect(result.observations).toHaveLength(3)
    expect(result.sourceFile.records).toHaveLength(6)
    expect(result.sourceFile.records.every((record) => record.rawLength > 0)).toBe(true)
    expect(result.sourceFile.records.some((record) => record.recordType === 'blank')).toBe(false)
  })

  it.each([
    ['negative-header-two-fields.in2', 1],
    ['negative-missing-backsight-reset.in2', 5],
    ['negative-point-name-comma.in2', 3],
    ['negative-dms-minutes-60.in2', 6],
    ['negative-dms-seconds-60.in2', 6]
  ])('converts COSA parser failure %s into an exact blocking source anchor with no partial observations', async (fixtureName, sourceRecord) => {
    const result = await ingest(fixtureName, await cosaIn2Fixture(fixtureName))
    const failure = result.sourceFile.diagnostics.find((diagnostic) => diagnostic.code === 'invalid_record' && diagnostic.severity === 'blocking')
    expect(result.sourceFile.detection).toMatchObject({ format: 'cosa-in2', method: 'structural-probe' })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(failure).toMatchObject({
      sourceRecord,
      byteOffset: expect.any(Number),
      recordAnchor: `cosa-in2-record-${sourceRecord}`,
      suggestedAction: expect.any(String)
    })
    expect(failure?.suggestedAction).not.toBe('')
    expect(result.sourceFile.records).toContainEqual(expect.objectContaining({
      id: `cosa-in2-record-${sourceRecord}`,
      sourceRecord,
      rawOffset: expect.any(Number), rawLength: expect.any(Number)
    }))
  })

  it('maps a COSA parser limit failure to limit_exceeded while preserving an actionable source anchor', async () => {
    const source = `1,1,1\nA,0,0\nS\nA,L,0\n${'\n'.repeat(SURVEY_FORMAT_LIMITS.maxTextLines)}`
    const result = await ingest('oversized-lines.in2', source)
    const failure = result.sourceFile.diagnostics.find((diagnostic) => diagnostic.code === 'limit_exceeded' && diagnostic.severity === 'blocking')
    expect(result.sourceFile).toMatchObject({ formatId: 'cosa-in2', disposition: 'archive-only' })
    expect(result.observations).toHaveLength(0)
    expect(failure).toMatchObject({
      sourceRecord: expect.any(Number),
      byteOffset: expect.any(Number),
      recordAnchor: expect.stringMatching(/^cosa-in2-record-/),
      suggestedAction: expect.stringContaining('maxRecords')
    })
    expect(result.sourceFile.records).toContainEqual(expect.objectContaining({
      id: failure?.recordAnchor,
      rawLength: expect.any(Number),
      rawOffset: expect.any(Number)
    }))
  })

  it.each([
    ['field.raw', 'JB,NMTest\nOC,OPST1,N 0,E 0,EL100,HI1.5\nSS,FP1,AR45.0000,ZE90.0000,SD10.0000,TH1.8\n', 'tds-raw'],
    ['field.rw5', 'JB,NMCarlson\nOC,OPST1,N 0,E 0,EL100,HI1.5\nSS,FP1,AR45.0000,ZE90.0000,SD10.0000,TH1.8\n', 'carlson-rw5']
  ])('parses RAW/RW5 station and shot semantics for %s', async (name, content, format) => {
    const result = await ingest(name, content)
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', message: expect.stringContaining('不构成 adjustment-ready 许可')
    }))
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slope-distance', station: 'ST1', target: '1', unit: 'rw5-linear-unverified' })
    ]))
    expect(result.observations.some((item) => item.type === 'direction' || item.type === 'zenith')).toBe(false)
    expect(result.sourceFile.angularUnitCanonical).toBe('unverified')
  })

  it('recognizes Sokkia SDR while blocking an ambiguous fixed-width dialect', async () => {
    const result = await ingest('field.sdr', '00SDR33 V04-04  SAMPLE JOB\n08TP P1 100.000 200.000 50.000\n')
    expect(result.sourceFile.detection.format).toBe('sokkia-sdr')
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_geometry', severity: 'blocking' }))
  })

  it.each([
    [
      'SDR20',
      [
        '00NMSDR20     V03-05    01-Jan-26 00:00 113111',
        `02TP0001${'0'.padEnd(10)}${'0'.padEnd(10)}${'100'.padEnd(10)}${'1.5'.padEnd(10)}`,
        '03NM1.80000000',
        `09F100010002${'10'.padEnd(10)}${'90'.padEnd(10)}${'45'.padEnd(10)}`
      ].join('\n'),
      '0001',
      '0002'
    ],
    [
      'SDR33',
      [
        '00NMSDR33 V04-04.02     01-Jan-26 00:00 113111',
        `02TP${'ST01'.padStart(16)}${'0'.padEnd(16)}${'0'.padEnd(16)}${'100'.padEnd(16)}${'1.5'.padEnd(16)}`,
        '03NM1.800',
        `09F1${'ST01'.padStart(16)}${'P01'.padStart(16)}${'10'.padEnd(16)}${'90'.padEnd(16)}${'45'.padEnd(16)}`
      ].join('\n'),
      'ST01',
      'P01'
    ]
  ])('retains independently laid out %s polar records without granting adjustment readiness', async (_dialect, content, station, target) => {
    const result = await ingest('polar.sdr', content)
    expect(result.sourceFile.detection).toMatchObject({ format: 'sokkia-sdr', version: _dialect })
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', message: expect.stringContaining('不构成 adjustment-ready 许可')
    }))
    expect(result.knownPoints).toContainEqual(expect.objectContaining({ id: station, known: true }))
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'direction', station, target, value: 45, unit: 'deg', face: 'left' }),
      expect.objectContaining({ type: 'zenith', station, target, value: 90, unit: 'deg' }),
      expect.objectContaining({ type: 'slope-distance', station, target, value: 10, unit: 'm', stationHeightOffset: 1.5, targetHeightOffset: 1.8 })
    ]))
  })

  it.each([
    ['control.gts', 'TOPCON GTS-7 field data\nJOB,CONTROL\n', 'topcon-gts7'],
    ['control.fc5', 'TOPCON FC-5 field data\nJOB,CONTROL\n', 'topcon-fc5'],
    ['control.raw', 'CO,Nikon RAW data format V2.00\nST,ST01,1.500,BS01,0\nF1,P01,10.0,45.0,90.0,1.8\n', 'nikon-raw']
  ])('identifies additional total-station/controller dialect %s without inventing observations', async (name, content, format) => {
    const result = await ingest(name, content)
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_geometry', severity: 'blocking' }))
  })

  it('routes a Spectra Survey Pro project through the audited-converter boundary', async () => {
    const result = await ingest('field.survey', 'Spectra Precision Survey Pro project\n')
    expect(result.sourceFile.detection.format).toBe('spectra-survey-pro')
    expect(result.sourceFile.disposition).toBe('converter-required')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'converter_required', severity: 'blocking' }))
  })

  it.each([
    ['site.obs', '     3.04           O                   RINEX VERSION / TYPE\nSITE                                                        MARKER NAME\n  1000.0  2000.0  3000.0                  APPROX POSITION XYZ\n                                                            END OF HEADER\n> 2026 09 04 00 00 00.0000000  0  0\n', 'rinex-observation'],
    ['future.rnx', '     4.00           O                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n', 'rinex-observation'],
    ['broadcast.nav', '     4.00           N                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n', 'rinex-navigation'],
    ['weather.met', '     3.05           M                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n', 'rinex-meteorological'],
    ['clock.clk', '     3.04           C                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n', 'rinex-clock'],
    ['solution.snx', '%=SNX 2.02 TEST 26:001:00000 TEST 26:001:00000 26:002:00000 P 00001 0 S\n+SOLUTION/ESTIMATE\n     1 STAX SITE A 0001 26:001:00000 m    2  1.00000000000000E+03\n     2 STAY SITE A 0001 26:001:00000 m    2  2.00000000000000E+03\n     3 STAZ SITE A 0001 26:001:00000 m    2  3.00000000000000E+03\n-SOLUTION/ESTIMATE\n', 'sinex'],
    ['track.nmea', '$GNGGA,123519,3114.1234,N,12128.5678,E,4,18,0.7,12.345,M,0.0,M,,*00\n', 'nmea-0183']
  ])('classifies GNSS source %s without pretending it is an adjusted baseline', async (name, content, format) => {
    const result = await ingest(name, content)
    expect(result.sourceFile.detection.format).toBe(format)
    if (name === 'future.rnx') expect(result.sourceFile.detection.version).toBe('4.00')
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.rawRecordAnchors.length).toBeGreaterThan(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'gnss_processing_required', severity: 'blocking' }))
  })

  it('reads only the SINEX estimate column and rejects duplicate solution/site components', async () => {
    const result = await ingest('solution.snx', [
      '%=SNX 2.02 TEST', '+SOLUTION/ESTIMATE',
      '     1 STAX SITE A 0001 26:001:00000 m    2  1.00000000000000E+03  0.1',
      '     2 STAY SITE A 0001 26:001:00000 m    2  2.00000000000000E+03  0.1',
      '     3 STAZ SITE A 0001 26:001:00000 m    2  3.00000000000000E+03  0.1',
      '     4 STAX SITE A 0002 26:001:00000 m    2  9.00000000000000E+03  0.1',
      '-SOLUTION/ESTIMATE'
    ].join('\n'))
    expect(result.unknownPoints).toEqual([])
    expect(result.sourceFile.summary.skippedRecordCount).toBe(1)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'record_ignored', message: expect.stringContaining('多个点标识') }))
  })

  it('blocks a RINEX-like file without END OF HEADER while retaining line anchors', async () => {
    const result = await ingest('incomplete.24o', '     3.04           O                   RINEX VERSION / TYPE\n  1000.0  2000.0  3000.0                  APPROX POSITION XYZ\n')
    expect(result.sourceFile.detection.format).toBe('rinex-observation')
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.sourceFile.rawRecordAnchors.length).toBe(2)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('END OF HEADER') }))
  })

  it('anchors structurally complete RTCM3 frames while requiring GNSS processing', async () => {
    const result = await ingest('base.rtcm3', Buffer.from([0xd3, 0x00, 0x02, 0x43, 0x50, 0, 0, 0]))
    expect(result.sourceFile.detection.format).toBe('rtcm3')
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.rawRecordAnchors).toContainEqual(expect.objectContaining({
      rawOffset: 0,
      rawLength: 8,
      byteOffset: 0,
      byteLength: 8,
      recordType: 'RTCM3-1077'
    }))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('1077') }))
  })

  it('retains a truncated RTCM3 frame as an anchored invalid record without a baseline claim', async () => {
    const result = await ingest('truncated.rtcm3', Buffer.from([0xd3, 0x00, 0x02, 0x43]))
    const failure = result.sourceFile.diagnostics.find((item) => item.code === 'invalid_record' && item.severity === 'blocking')

    expect(result.sourceFile.detection.format).toBe('rtcm3')
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
    expect(failure).toMatchObject({
      byteOffset: 0,
      recordAnchor: 'rtcm3-record-1',
      suggestedAction: expect.stringContaining('完整的 RTCM3')
    })
    expect(result.sourceFile.rawRecordAnchors).toContainEqual(expect.objectContaining({
      id: failure?.recordAnchor,
      rawOffset: 0,
      rawLength: 4,
      byteOffset: 0,
      byteLength: 4,
      recordType: 'RTCM3-truncated'
    }))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'gnss_processing_required', severity: 'blocking' }))
  })

  it('recognizes an RTCM2 preamble without claiming a baseline solution', async () => {
    const result = await ingest('base.rtcm2', Buffer.from([0x66, 0x14, 0x00, 0x00, 0x00, 0x00]))
    expect(result.sourceFile.detection).toMatchObject({ format: 'rtcm2', version: '2.x' })
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.rawRecordAnchors[0]).toMatchObject({ recordType: 'rtcm2-unparsed-source', byteOffset: 0 })
  })

  it.each([
    ['orbit.sp3', '#cP2026 09 04 00 00 00.00000000      96 ORBIT IGS20 HLM  IGS\n## 2434 0.00000000 900.00000000 00000 0.0000000000000\n', 'sp3'],
    ['iono.ion', '     1.0            IONOSPHERE MAPS     GPS                 IONEX VERSION / TYPE\n', 'ionex'],
    ['antenna.atx', '     1.4            M                                       ANTEX VERSION / SYST\n', 'antex']
  ])('recognizes GNSS product %s as processing evidence rather than a baseline', async (name, content, format) => {
    const result = await ingest(name, content)
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
  })

  it.each([
    ['receiver.ubx', Buffer.from([0xb5, 0x62, 0x01, 0x07, 0x00, 0x00, 0x00, 0x00]), 'ublox-ubx', 'UBX-01-07'],
    ['receiver.nov', Buffer.from([0xaa, 0x44, 0x12, 0x0c, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0]), 'novatel-oem', 'NOVATEL-42'],
    ['receiver.sbf', Buffer.from([0x24, 0x40, 0x00, 0x00, 0x15, 0x00, 0x08, 0x00]), 'septentrio-sbf', 'SBF-21'],
    ['receiver.bnx', Buffer.from([0xe2, 0x00, 0x00, 0x00]), 'binex', 'BINEX-0xe2']
  ])('inspects receiver-native GNSS stream %s and records byte anchors', async (name, bytes, format, recordType) => {
    const result = await ingest(name, bytes)
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.sourceFile.rawRecordAnchors[0]).toMatchObject({ byteOffset: 0, recordType })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'gnss_processing_required', severity: 'blocking' }))
  })

  it.each([
    ['receiver.jps', 'javad-jps'],
    ['receiver.tps', 'topcon-tps'],
    ['receiver.sth', 'south-sth'],
    ['receiver.zhd', 'hitarget-zhd'],
    ['receiver.hcn', 'chcnav-hcn'],
    ['receiver.cnb', 'comnav-cnb']
  ])('retains extension-identified GNSS receiver source %s for audited processing', async (name, format) => {
    const result = await ingest(name, Buffer.from([0, 1, 2, 3, 4, 5]))
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile.disposition).toBe('gnss-processing-required')
    expect(result.observations).toHaveLength(0)
  })

  it('recognizes Hatanaka/CRINEX and requires a local decompressor', async () => {
    const result = await ingest('station.24d', '     3.1            COMPACT RINEX FORMAT                    CRINEX VERS   / TYPE\n                                                            END OF HEADER\n')
    expect(result.sourceFile.detection.format).toBe('hatanaka-rinex')
    expect(result.sourceFile.disposition).toBe('converter-required')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'converter_required', severity: 'blocking' }))
  })

  it.each([
    ['receiver.t00', 'trimble-t00'],
    ['receiver.t01', 'trimble-t01'],
    ['receiver.t02', 'trimble-t02'],
    ['receiver.t04', 'trimble-t04'],
    ['legacy.job', 'trimble-job'],
    ['captivate.dbx', 'leica-dbx'],
    ['office.mdb', 'leica-mdb']
  ])('retains opaque vendor source %s and requires an audited local converter', async (name, format) => {
    const result = await ingest(name, Buffer.from([0, 1, 2, 3, 4, 5]))
    expect(result.sourceFile.detection.format).toBe(format)
    expect(result.sourceFile.disposition).toBe('converter-required')
  })

  it('keeps a generic JSON document unknown instead of inheriting WorkWise readiness', async () => {
    const result = await ingest('wrong.gsi', '{"networkType":"leveling"}')
    expect(result.sourceFile.detection).toMatchObject({ format: 'unknown', confidence: 0, extensionConflict: false })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_format', severity: 'blocking' }))
  })

  it('lets high-confidence GSI content win an extension conflict, then enters the normal P0 strategy gate', async () => {
    const gsi = '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456\n'
    const result = await ingest('actually-gsi.in2', gsi)
    const catalog = findP0SurveyFormatEntry('leica-gsi8')!
    expect(result.sourceFile.detection).toMatchObject({
      format: 'leica-gsi8', method: 'content-signature', confidence: 0.98,
      extension: '.in2', extensionConflict: true
    })
    expect(result.sourceFile).toMatchObject({
      disposition: catalog.currentDisposition,
      requiresManualConfirmation: false,
      dispositionReason: expect.stringContaining(catalog.currentDispositionReason)
    })
    expect(result.observations).not.toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'format_conflict', severity: 'warning' }))
    expect(result.sourceFile.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'format_conflict', severity: 'blocking' }))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', suggestedAction: expect.stringContaining('闭合')
    }))
  })

  it('lets a high-confidence COSA structural probe win a suffix conflict and enter the normal P0 strategy gate', async () => {
    const result = await ingest('actually-cosa.gsi', await cosaIn2Fixture('golden-single-station.in2'))
    expect(result.sourceFile.detection).toMatchObject({
      format: 'cosa-in2', method: 'structural-probe', confidence: 0.98,
      extension: '.gsi', extensionConflict: true
    })
    expect(result.observations).toHaveLength(4)
    expect(result.sourceFile).toMatchObject({ disposition: 'adjustment-ready', requiresManualConfirmation: false })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'format_conflict', severity: 'warning' }))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('P0 格式目录') }))
  })

  it.each(['wrong.hexml', 'wrong.landxml', 'wrong.sdr20'])(
    'does not trust a professional extension when %s contains generic JSON',
    async (name) => {
      const result = await ingest(name, '{"networkType":"leveling"}')
      expect(result.sourceFile.detection).toMatchObject({ format: 'unknown', extensionConflict: false })
      expect(result.sourceFile.disposition).toBe('archive-only')
      expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_format', severity: 'blocking' }))
    }
  )

  it.each([
    ['level.in1', 'cosa-in1'],
    ['network.NET', 'cosa-net'],
    ['result.ou1', 'cosa-ou1'],
    ['result.ou2', 'cosa-ou2'],
    ['level.dat', 'south-dat']
  ])('uses only a manually-confirmed archive fallback for unsupported P0 extension %s', async (name, format) => {
    const result = await ingest(name, 'opaque,unverified,payload\n')
    expect(result.sourceFile.detection).toMatchObject({ format, method: 'extension-fallback', confidence: 0.25, extensionConflict: false })
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_geometry', severity: 'blocking', suggestedAction: expect.any(String) }))
  })

  it('uses the bounded P0 catalogue as the runtime capability/disposition authority for every P0 format', async () => {
    const cases = [
      { format: 'cosa-in1', name: 'level.in1', value: 'opaque,unverified,payload\n', hasAuditableParse: false },
      { format: 'cosa-in2', name: 'control.in2', value: await cosaIn2Fixture('golden-single-station.in2'), hasAuditableParse: true },
      { format: 'cosa-net', name: 'network.NET', value: 'opaque,unverified,payload\n', hasAuditableParse: false },
      { format: 'cosa-ou1', name: 'result.ou1', value: 'opaque,unverified,payload\n', hasAuditableParse: false },
      { format: 'cosa-ou2', name: 'result.ou2', value: 'opaque,unverified,payload\n', hasAuditableParse: false },
      { format: 'south-dat', name: 'level.dat', value: 'opaque,unverified,payload\n', hasAuditableParse: false },
      { format: 'trimble-m5', name: 'level.m5', value: await readFile(new URL('trimble-m5-abffb.dat', PROFESSIONAL_FIXTURE_DIRECTORY)), hasAuditableParse: true },
      { format: 'leica-gsi8', name: 'station.gsi', value: '*11....+00000001 21..02+04500000 22..02+09000000 31..00+00123456\n', hasAuditableParse: true },
      { format: 'leica-gsi16', name: 'station.gsi', value: '*11....+0000000000000001 21..02+0000000004500000 22..02+0000000009000000 31..00+0000000000123456\n', hasAuditableParse: true }
    ] as const
    expect(cases.map((entry) => entry.format)).toEqual(P0_SURVEY_FORMAT_IDS)

    for (const testCase of cases) {
      const catalog = findP0SurveyFormatEntry(testCase.format)!
      const result = await ingest(testCase.name, testCase.value)
      const expectedDisposition = testCase.hasAuditableParse ? catalog.currentDisposition : 'archive-only'
      expect(result.sourceFile).toMatchObject({
        formatId: testCase.format,
        disposition: expectedDisposition,
        requiresManualConfirmation: expectedDisposition !== 'adjustment-ready'
      })
      expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
        code: 'format_detected', severity: 'warning',
        message: expect.stringContaining(`P0 格式目录 ${catalog.registryVersion}`),
        suggestedAction: expect.any(String)
      }))
      if (testCase.hasAuditableParse) {
        expect(result.observations).not.toHaveLength(0)
        expect(result.sourceFile.dispositionReason).toContain(catalog.currentDispositionReason)
        expect(result.sourceFile.diagnostics.some((diagnostic) => diagnostic.severity === 'blocking')).toBe(false)
      } else {
        expect(result.observations).toHaveLength(0)
        expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_geometry', severity: 'blocking' }))
      }
    }
  })

  it('keeps only the frozen WorkWise JSON input outside the vendor parser gate', async () => {
    const name = 'network.json'
    const content = frozenWorkwiseSource({
      networkType: 'leveling',
      coordinateSystem: '本地坐标系', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height',
      unit: 'm',
      knownPoints: [{ id: 'BM-基准', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [
        { id: 'dh-first', type: 'height-difference', from: 'BM-基准', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
        { id: 'dh-second', type: 'height-difference', from: 'BM-基准', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }
      ]
    }, 2)
    const format = 'workwise-json'
    const result = await ingest(name, content)
    expect(result.sourceFile).toMatchObject({
      formatId: format,
      formatVersion: '1',
      disposition: 'adjustment-ready',
      requiresManualConfirmation: false,
      parserId: 'workwise-survey-source',
      linearUnitRaw: 'm',
      angularUnitRaw: 'not-declared',
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad'
    })
    const anchors = new Map(result.sourceFile.rawRecordAnchors.map((anchor) => [anchor.id, anchor]))
    const sourceBytes = Buffer.from(content)
    for (const [anchorId, sourceId] of [
      ['workwise-json-known-point-1', 'BM-基准'],
      ['workwise-json-unknown-point-1', 'P'],
      ['workwise-json-observation-1', 'dh-first'],
      ['workwise-json-observation-2', 'dh-second']
    ]) {
      const anchor = anchors.get(anchorId)
      expect(anchor).toMatchObject({
        id: anchorId,
        rawOffset: expect.any(Number),
        rawLength: expect.any(Number),
        byteOffset: expect.any(Number),
        byteLength: expect.any(Number)
      })
      expect(anchor!.rawOffset).toBeGreaterThan(0)
      expect(anchor!.rawLength).toBeLessThan(sourceBytes.length)
      expect(anchor!.rawSnippet).toContain(sourceId)
      expect(JSON.parse(sourceBytes.subarray(anchor!.rawOffset, anchor!.rawOffset + anchor!.rawLength).toString('utf8'))).toMatchObject({ id: sourceId })
    }
    expect(anchors.get('workwise-json-observation-1')!.rawOffset).not.toBe(anchors.get('workwise-json-observation-2')!.rawOffset)
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dh-first', sourceRecordId: 'workwise-json-observation-1', sourceLocator: 'WorkWise JSON:network.observations[0]' }),
      expect.objectContaining({ id: 'dh-second', sourceRecordId: 'workwise-json-observation-2', sourceLocator: 'WorkWise JSON:network.observations[1]' })
    ]))
    expect(result.sourceFile.diagnostics).not.toContainEqual(expect.objectContaining({
      message: expect.stringContaining('不构成 adjustment-ready 许可')
    }))
  })

  it('warns once when bounded preserved raw fields reach the entry limit without changing frozen-source readiness', async () => {
    // The JSON duplicate-key guard also bounds one object at 10,000 keys, so
    // distribute this cross-record total across two normal source records.
    const knownRawFields = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`vendor-known-${index + 1}`, 'v'])
    )
    const unknownRawFields = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`vendor-unknown-${index + 1}`, 'v'])
    )
    const result = await ingest('raw-field-entry-limit.json', frozenWorkwiseSource({
      networkType: 'coordinate-transform', transformType: 'similarity-2d', unit: 'm',
      knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0, rawFields: knownRawFields }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0, rawFields: unknownRawFields }],
      observations: []
    }))

    const warnings = result.sourceFile.diagnostics.filter((diagnostic) => diagnostic.code === 'limit_exceeded' && diagnostic.severity === 'warning')
    expect(result.sourceFile).toMatchObject({ formatId: 'workwise-json', disposition: 'adjustment-ready' })
    expect(Object.keys(result.sourceFile.preservedRawFields)).toHaveLength(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldEntries)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining('preservedRawFields'),
      suggestedAction: expect.stringContaining('原始附件')
    })
  })

  it('warns once when flattened preserved raw fields exceed the byte limit', async () => {
    const rawFieldEnvelopeBytes = Buffer.byteLength(JSON.stringify({ large: '' }), 'utf8')
    const rawValue = 'x'.repeat(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldBytes - rawFieldEnvelopeBytes)
    expect(Buffer.byteLength(JSON.stringify({ large: rawValue }), 'utf8')).toBe(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldBytes)
    expect(Buffer.byteLength(JSON.stringify({ 'point:A:large': rawValue }), 'utf8')).toBeGreaterThan(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldBytes)

    const result = await ingest('raw-field-byte-limit.json', frozenWorkwiseSource({
      networkType: 'coordinate-transform', transformType: 'similarity-2d', unit: 'm',
      knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0, rawFields: { large: rawValue } }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0 }],
      observations: []
    }))

    const warnings = result.sourceFile.diagnostics.filter((diagnostic) => diagnostic.code === 'limit_exceeded' && diagnostic.severity === 'warning')
    expect(result.sourceFile).toMatchObject({ formatId: 'workwise-json', disposition: 'adjustment-ready' })
    expect(result.sourceFile.preservedRawFields).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('preservedRawFields')
  })

  it('emits the same single retention warning when the archive-only SUC collector reaches its own cap', async () => {
    const overflowingLine = new Array(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldEntries + 1).fill('opaque').join(',')
    const source = [
      'SSJ3,4,1,0.0000',
      'Start,2024.09.19,00:11:24',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2024.09.19,00:12:24',
      overflowingLine
    ].join('\n')
    const result = await ingest('retention-limit.suc', source)

    const warnings = result.sourceFile.diagnostics.filter((diagnostic) => diagnostic.code === 'limit_exceeded' && diagnostic.severity === 'warning')
    expect(result.sourceFile).toMatchObject({ formatId: 'survey-cloud-suc', disposition: 'archive-only' })
    expect(Object.keys(result.sourceFile.preservedRawFields)).toHaveLength(SURVEY_FORMAT_LIMITS.maxPreservedRawFieldEntries)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('preservedRawFields')
  })

  it('keeps exact original-byte anchors for a UTF-16LE frozen WorkWise source', async () => {
    const json = frozenWorkwiseSource({
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh-utf16', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    }, 2)
    const source = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
    const result = await ingest('network-utf16.json', source)
    const anchor = result.sourceFile.rawRecordAnchors.find((record) => record.id === 'workwise-json-observation-1')!

    expect(result.sourceFile).toMatchObject({ disposition: 'adjustment-ready' })
    expect(anchor).toMatchObject({ rawOffset: expect.any(Number), rawLength: expect.any(Number), byteOffset: expect.any(Number), byteLength: expect.any(Number) })
    expect(anchor.rawOffset).toBeGreaterThan(2)
    expect(anchor.rawLength % 2).toBe(0)
    expect(JSON.parse(source.subarray(anchor.rawOffset, anchor.rawOffset + anchor.rawLength).toString('utf16le'))).toMatchObject({ id: 'dh-utf16' })
  })

  it('accounts for a UTF-8 BOM when locating a frozen WorkWise record', async () => {
    const json = frozenWorkwiseSource({
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh-bom', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm' }]
    })
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])
    const result = await ingest('network-bom.json', source)
    const anchor = result.sourceFile.rawRecordAnchors.find((record) => record.id === 'workwise-json-observation-1')!

    expect(result.sourceFile.disposition).toBe('adjustment-ready')
    expect(anchor.rawOffset).toBeGreaterThan(3)
    expect(JSON.parse(source.subarray(anchor.rawOffset, anchor.rawOffset + anchor.rawLength).toString('utf8'))).toMatchObject({ id: 'dh-bom' })
  })

  it('anchors a high-record-count frozen WorkWise source without collapsing record ranges', async () => {
    const observationCount = 5_000
    const result = await ingest('many-observations.json', frozenWorkwiseSource({
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: Array.from({ length: observationCount }, (_, index) => ({
        id: `dh-${index + 1}`,
        type: 'height-difference',
        from: 'BM',
        to: 'P',
        value: 0.1,
        unit: 'm'
      }))
    }))
    const first = result.sourceFile.rawRecordAnchors.find((record) => record.id === 'workwise-json-observation-1')!
    const last = result.sourceFile.rawRecordAnchors.find((record) => record.id === `workwise-json-observation-${observationCount}`)!

    expect(result.sourceFile).toMatchObject({ disposition: 'adjustment-ready', recordCount: observationCount + 2 })
    expect(first.rawOffset).toBeGreaterThan(0)
    expect(last.rawOffset).toBeGreaterThan(first.rawOffset)
    expect(last.rawLength).toBeLessThan(result.sourceFile.fileSize)
  })

  it('rejects escaped-equivalent duplicate frozen network keys before UTF-8 JSON parsing', async () => {
    // JSON.parse would silently keep the latter networkType.  The escaped key
    // proves the lexical guard compares decoded JSON-key semantics, not only
    // byte-identical spellings.
    const source = '{"format":"workwise-survey-network","formatVersion":1,"network":{"networkType":"leveling","\\u006eetworkType":"plane-control","unit":"m","knownPoints":[],"unknownPoints":[],"observations":[]}}'
    const result = await ingest('duplicate-network-type.json', source)

    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only' })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('重复对象键 "networkType"')
    }))
    expect(result.observations).toEqual([])
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it.each(['value', 'unit'] as const)('rejects duplicate observation %s keys in a UTF-16 frozen source before publishing anchors', async (duplicateKey) => {
    const duplicatedObservation = duplicateKey === 'value'
      ? '{"id":"dh","type":"height-difference","from":"BM","to":"P","value":0.1,"value":100,"unit":"m"}'
      : '{"id":"dh","type":"height-difference","from":"BM","to":"P","value":0.1,"unit":"m","unit":"mm"}'
    const json = `{"format":"workwise-survey-network","formatVersion":1,"network":{"networkType":"leveling","unit":"m","knownPoints":[{"id":"BM","pointClass":"known","known":true,"height":10}],"unknownPoints":[{"id":"P","pointClass":"unknown","known":false,"height":10.1}],"observations":[${duplicatedObservation}]}}`
    const source = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
    const result = await ingest('duplicate-observation-utf16.json', source)

    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only' })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_record', severity: 'blocking', message: expect.stringContaining(`重复对象键 "${duplicateKey}"`)
    }))
    expect(result.observations).toEqual([])
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it('bounds frozen WorkWise observations before object materialization and publishes no anchors', async () => {
    // Minimal JSON values keep the regression fixture compact. The registry
    // must reject on the 100,001st lexical array element before JSON.parse or
    // Zod can create an observation collection (or record anchors).
    const source = compactFrozenWorkwiseArrays('', '', compactJsonRecords(SURVEY_FORMAT_LIMITS.maxParsedObservations + 1))
    const result = await ingest('too-many-workwise-observations.json', source)

    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'limit_exceeded',
      severity: 'blocking',
      message: expect.stringContaining('network.observations')
    }))
    expect(result.observations).toEqual([])
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it('bounds combined known and unknown point records before object materialization', async () => {
    const source = compactFrozenWorkwiseArrays(
      compactJsonRecords(SURVEY_FORMAT_LIMITS.maxParsedPoints),
      '{}',
      ''
    )
    const result = await ingest('too-many-workwise-points.json', source)

    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'limit_exceeded',
      severity: 'blocking',
      message: expect.stringContaining('knownPoints 与 network.unknownPoints 合计')
    }))
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it('counts duplicate protected point arrays toward the combined preflight limit', async () => {
    const half = compactJsonRecords(SURVEY_FORMAT_LIMITS.maxParsedPoints / 2)
    const source = `{"format":"workwise-survey-network","formatVersion":1,"network":{"knownPoints":[${half}],"knownPoints":[${half}],"unknownPoints":[{}],"observations":[]}}`
    const result = await ingest('duplicate-workwise-point-arrays.json', source)

    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'limit_exceeded',
      severity: 'blocking',
      message: expect.stringContaining('knownPoints 与 network.unknownPoints 合计')
    }))
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it('bounds total raw point and observation records before object materialization', async () => {
    const source = compactFrozenWorkwiseArrays(
      '{}',
      '',
      compactJsonRecords(SURVEY_FORMAT_LIMITS.maxParsedObservations)
    )
    const result = await ingest('too-many-workwise-records.json', source)

    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'limit_exceeded',
      severity: 'blocking',
      message: expect.stringContaining('原始记录合计超过')
    }))
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toEqual([])
  })

  it('archives a frozen WorkWise source with duplicate solver identities instead of selecting one record', async () => {
    const result = await ingest('ambiguous-identities.json', frozenWorkwiseSource({
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [
        { id: 'BM', pointClass: 'unknown', known: false, height: 10.1 },
        { id: 'P', pointClass: 'unknown', known: false, height: 10.2 }
      ],
      observations: [
        { id: 'dh-repeat', type: 'height-difference', from: 'BM', to: 'P', value: 0.2, unit: 'm' },
        { id: 'dh-repeat', type: 'height-difference', from: 'BM', to: 'P', value: 0.2, unit: 'm' }
      ]
    }))

    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only' })
    expect(result.sourceFile.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('重复点号 BM') }),
      expect.objectContaining({
        code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('重复观测编号 dh-repeat'),
        recordAnchor: 'workwise-json-observation-1'
      })
    ]))
    // The retained archive still has a distinct physical anchor for each raw
    // observation; it is simply ineligible for a solver to consume.
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dh-repeat', sourceRecordId: 'workwise-json-observation-1' }),
      expect.objectContaining({ id: 'dh-repeat', sourceRecordId: 'workwise-json-observation-2' })
    ]))
  })

  it.each([
    ['network type', {
      unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm' }]
    }, '未显式声明 networkType'],
    ['coordinate transform type', {
      networkType: 'coordinate-transform', unit: 'm',
      knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 10, y: 0 }],
      observations: [{ id: 'pair', type: 'coordinate-pair', from: 'A', to: 'P', value: 0, unit: 'm', targetX: 10, targetY: 0 }]
    }, '未显式声明 transformType']
  ] as const)('does not let an import request supply missing frozen %s semantics', async (_caseName, network, message) => {
    const result = await ingest('missing-frozen-semantics.json', frozenWorkwiseSource(network))

    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only' })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_record', severity: 'blocking', message: expect.stringContaining(message)
    }))
  })

  it('archives a frozen WorkWise source that does not have an auditable point-coordinate unit contract', async () => {
    const result = await ingest('centimetres.json', frozenWorkwiseSource({
      networkType: 'leveling', unit: 'cm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10_000 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10_020 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 20, unit: 'cm', sigma: 0.1, sigmaUnit: 'cm' }]
    }))
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', linearUnitRaw: expect.stringContaining('cm'), linearUnitCanonical: 'unverified', angularUnitCanonical: 'unverified' })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('坐标/高程单位 cm') }))
  })

  it.each([
    ['network coordinate unit', {
      networkType: 'leveling',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm' }]
    }],
    ['linear observation unit', {
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1 }]
    }],
    ['angular observation unit', {
      networkType: 'plane-control', unit: 'm',
      knownPoints: [{ id: 'A', pointClass: 'known', known: true, x: 0, y: 0 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, x: 1, y: 0 }],
      observations: [{ id: 'dir', type: 'direction', from: 'A', to: 'P', value: 100 }]
    }],
    ['sigma unit', {
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
      observations: [{ id: 'dh', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001 }]
    }]
  ])('does not default a missing frozen WorkWise %s', async (_label, network) => {
    const result = await ingest('missing-unit.json', frozenWorkwiseSource(network))
    expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', linearUnitCanonical: 'unverified', angularUnitCanonical: 'unverified' })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_record', severity: 'blocking', message: expect.stringContaining('未显式声明') }))
  })

  it('keeps CSV and XLSX archive-only until a saved mapping and unit/angle confirmation workflow exists', async () => {
    const csv = await ingest('mapping.csv', 'type,from,to,value,unit\nheight-difference,BM,P1,0.1,m\n')
    const workbook = new JSZip()
    workbook.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    workbook.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    workbook.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    const xlsx = await ingest('mapping.xlsx', await workbook.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))

    for (const result of [csv, xlsx]) {
      expect(result.sourceFile).toMatchObject({ disposition: 'archive-only', requiresManualConfirmation: true })
      expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
        code: 'mapping_required', severity: 'blocking', suggestedAction: expect.any(String)
      }))
    }
    expect(csv.sourceFile.formatId).toBe('delimited-text')
    expect(xlsx.sourceFile.formatId).toBe('xlsx')
  })

  it('recognizes a structurally complete SurveyCloud SUC file for archival review without assigning measurement semantics', async () => {
    const source = [
      'SSJ3,4,1,0.0000',
      'Start,2022-11-10,12:42:36',
      'SSJ2        ,     0.03009,    90.00013,    85.92927,   0.0000,     0.00',
      'Z1          ,   181.16232,    90.00016,    39.96530,   0.0000,     0.00',
      'End,2022-11-12,13:17:00'
    ].join('\r\n')
    const result = await ingest('synthetic.suc', source)

    expect(result.sourceFile.detection).toMatchObject({
      format: 'survey-cloud-suc',
      vendor: '测量云',
      method: 'structural-probe',
      confidence: 0.98,
      extension: '.suc',
      extensionConflict: false
    })
    expect(result.sourceFile).toMatchObject({
      formatId: 'survey-cloud-suc',
      parserId: 'survey-cloud-suc-archive-adapter',
      disposition: 'archive-only',
      requiresManualConfirmation: true,
      linearUnitRaw: 'not-declared',
      angularUnitRaw: 'not-declared',
      linearUnitCanonical: 'unverified',
      angularUnitCanonical: 'unverified',
      datumDeclared: null,
      heightSystemDeclared: null,
      summary: { observationCount: 0, recordCount: 5 }
    })
    expect(result.observations).toEqual([])
    expect(result.knownPoints).toEqual([])
    expect(result.unknownPoints).toEqual([])
    expect(result.sourceFile.rawRecordAnchors).toHaveLength(5)
    for (const [index, line] of source.split('\r\n').entries()) {
      const anchor = result.sourceFile.rawRecordAnchors[index]!
      expect(anchor).toMatchObject({
        id: `survey-cloud-suc-line-${index + 1}`,
        sourceRecord: index + 1,
        rawLineNo: index + 1,
        rawLength: Buffer.byteLength(line),
        rawSnippet: line
      })
      expect(Buffer.from(source).subarray(anchor.rawOffset, anchor.rawOffset + anchor.rawLength).toString('utf8')).toBe(line)
    }
    expect(result.sourceFile.preservedRawFields).toMatchObject({
      'source:suc.line.3.field.1': 'SSJ2        ',
      'source:suc.line.3.field.2': '     0.03009'
    })
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_detected', severity: 'warning', message: expect.stringContaining('不构成 adjustment-ready 许可')
    }))
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'missing_geometry', severity: 'blocking', message: expect.stringContaining('F-FMT-11')
    }))
  })

  it.each([
    ['missing Start', [
      'SSJ3,4,1,0.0000',
      'SSJ2,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022-11-12,13:17:00'
    ].join('\n')],
    ['missing End', [
      'SSJ3,4,1,0.0000',
      'Start,2022-11-10,12:42:36',
      'SSJ2,0.03009,90.00013,85.92927,0.0000,0.00'
    ].join('\n')],
    ['wrong measurement field count', [
      'SSJ3,4,1,0.0000',
      'Start,2022-11-10,12:42:36',
      'SSJ2,0.03009,90.00013,85.92927,0.0000',
      'End,2022-11-12,13:17:00'
    ].join('\n')],
    ['generic SUC text', 'name,value\nP1,1\n']
  ])('does not misidentify incomplete or generic SUC-shaped content: %s', async (_label, source) => {
    const result = await ingest('negative.suc', source)

    expect(result.sourceFile.detection.format).not.toBe('survey-cloud-suc')
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toEqual([])
  })

  it('lets a complete SUC structural signature safely win over a conflicting extension', async () => {
    const source = [
      'SSJ3,4,1,0.0000',
      'Start,2022-11-10,12:42:36',
      'SSJ2,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022-11-12,13:17:00'
    ].join('\n')
    const result = await ingest('misnamed.gsi', source)

    expect(result.sourceFile.detection).toMatchObject({
      format: 'survey-cloud-suc',
      method: 'structural-probe',
      confidence: 0.98,
      extension: '.gsi',
      extensionConflict: true
    })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'format_conflict', severity: 'warning', message: expect.stringContaining('高置信内容优先处理')
    }))
  })

  it.each(['SSJ4', 'XSJ3', 'Z1'])('accepts observed opaque SUC header record-code shapes without assigning them meaning: %s', async (headerCode) => {
    const source = [
      `${headerCode},4,1,0.0000`,
      'Start,2022-11-10,12:42:36',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022-11-12,13:17:00'
    ].join('\n')
    const result = await ingest(`synthetic-${headerCode}.suc`, source)

    expect(result.sourceFile).toMatchObject({
      formatId: 'survey-cloud-suc',
      disposition: 'archive-only',
      linearUnitCanonical: 'unverified',
      angularUnitCanonical: 'unverified'
    })
    expect(result.observations).toEqual([])
  })

  it.each([
    ['dotted date with merged timestamp and trailing Z', [
      'SSJ4,4,1,0.0000',
      'Start,2022.11.10 12:42:36 Z',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022.11.12 13:17:00Z'
    ].join('\n')],
    ['compact date-time with repeated clock field', [
      '"SSJ4",4,1,0.0000',
      '"Start","2024.09.1900:11:24","00:11:24"',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      '"End","2024.12.1902:07:06","02:07:06"'
    ].join('\r\n')],
    ['whole-line quoted CSV records', [
      '"SSJ3,4,1,0.0000"',
      '"Start,2024.09.19 00:11:24,00:11:24"',
      '"P1,0.03009,90.00013,85.92927,0.0000,0.00"',
      '"End,2024.09.19 00:12:24,00:12:24"'
    ].join('\r\n')],
    ['comma records with tab padding', [
      'SSJ3\t,4,1,0.0000',
      'Start\t,2024.09.19 00:11:24,00:11:24',
      'P1\t,0.03009,90.00013,85.92927,0.0000,0.00',
      'End\t,2024.09.19 00:12:24,00:12:24'
    ].join('\r\n')],
    ['tab-padded lifecycle with a single-digit redundant clock and sequence rows', [
      'SSJ3\t,4,1,0.0000',
      'Start\t,\t2024.09.19\t\t00:11:24Z\t,\t0:11:24\t\t\t\t',
      '1\t\t\t\t\t\t\t\t\t\t',
      'P1\t,0.03009,90.00013,85.92927,0.0000,0.00',
      'End\t,\t2024.09.19\t\t00:12:24Z\t,\t0:12:24\t\t\t\t'
    ].join('\r\n'), 5],
    ['quoted tab-delimited fields with separate Z token', [
      ' "XSJ4" \t "4" \t "1" \t "0.0000" ',
      ' "Start" \t "2022.11.10" \t "12:42:36" \t "Z" ',
      '  "P,1" \t "0.03009" \t "90.00013" \t "85.92927" \t "0.0000" \t "0.00"  ',
      ' "End" \t "2022.11.12 13:17:00 Z" '
    ].join('\r\n')]
  ])('accepts bounded SUC lifecycle and delimiter variants without assigning semantics: %s', async (_label, source, expectedRecordCount = 4) => {
    const result = await ingest('variant.suc', source)

    expect(result.sourceFile.detection).toMatchObject({
      format: 'survey-cloud-suc',
      method: 'structural-probe',
      confidence: 0.98
    })
    expect(result.sourceFile).toMatchObject({
      formatId: 'survey-cloud-suc',
      disposition: 'archive-only',
      summary: { observationCount: 0, recordCount: expectedRecordCount }
    })
    expect(result.observations).toEqual([])
    expect(result.sourceFile.preservedRawFields).toMatchObject(
      source.includes('Start\t,\t2024.09.19\t\t00:11:24Z')
        ? {
          'source:suc.line.1.field.1': 'SSJ3\t',
          'source:suc.line.2.field.1': 'Start\t',
          'source:suc.line.3.field.1': '1',
          'source:suc.line.4.field.1': 'P1\t'
        }
        : source.includes('SSJ3\t')
        ? {
          'source:suc.line.1.field.1': 'SSJ3\t',
          'source:suc.line.2.field.1': 'Start\t',
          'source:suc.line.3.field.1': 'P1\t'
        }
        : source.includes('\t')
        ? {
          'source:suc.line.1.field.1': ' "XSJ4" ',
          'source:suc.line.3.field.1': '  "P,1" ',
          'source:suc.line.3.field.2': ' "0.03009" '
        }
        : source.includes('"SSJ3,')
          ? {
            'source:suc.line.1.field.1': '"SSJ3,4,1,0.0000"',
            'source:suc.line.2.field.1': '"Start,2024.09.19 00:11:24,00:11:24"'
          }
        : source.includes('2024.09.19')
          ? {
            'source:suc.line.2.field.2': '"2024.09.1900:11:24"',
            'source:suc.line.2.field.3': '"00:11:24"'
          }
        : {
          'source:suc.line.2.field.2': '2022.11.10 12:42:36 Z'
        }
    )
  })

  it.each([
    ['invalid dotted calendar date', [
      'SSJ4,4,1,0.0000',
      'Start,2022.02.30,12:42:36',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022.11.12,13:17:00'
    ].join('\n')],
    ['invalid clock token', [
      'SSJ4,4,1,0.0000',
      'Start,2022.11.10,25:42:36',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022.11.12,13:17:00'
    ].join('\n')],
    ['unclosed quoted measurement field', [
      '"SSJ4",4,1,0.0000',
      '"Start",2022.11.10,12:42:36',
      '"P1,0.03009,90.00013,85.92927,0.0000,0.00',
      '"End",2022.11.12,13:17:00'
    ].join('\n')],
    ['malformed lifecycle followed by a valid pair', [
      'SSJ4,4,1,0.0000',
      'Start,2022.02.30,12:42:36',
      'Start,2022.11.10,12:42:36',
      'P1,0.03009,90.00013,85.92927,0.0000,0.00',
      'End,2022.11.12,13:17:00'
    ].join('\n')]
  ])('does not identify malformed SUC lifecycle or quote structure: %s', async (_label, source) => {
    const result = await ingest('invalid-variant.suc', source)

    expect(result.sourceFile.detection.format).not.toBe('survey-cloud-suc')
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toEqual([])
  })

  it('does not reinterpret an unknown DAT file as generic delimited data', async () => {
    const result = await ingest('unknown.dat', '010203040506070809\n112233445566778899\n')
    expect(result.sourceFile.detection).toMatchObject({ format: 'south-dat', method: 'extension-fallback', confidence: 0.25 })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_geometry', severity: 'blocking' }))
  })

  it('does not downgrade an unrecognized .in2 comma table to generic delimited parsing', async () => {
    const result = await ingest('random.in2', 'column,one,two\nvalue,three,four\n')
    expect(result.sourceFile.detection).toMatchObject({ format: 'unknown', method: 'content-signature' })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_format', severity: 'blocking' }))
  })

  it('keeps an unknown binary archive-only instead of attempting a table parser', async () => {
    const result = await ingest('opaque.bin', Buffer.from([0, 1, 2, 3, 0, 4, 5]))
    expect(result.sourceFile.detection.format).toBe('unknown')
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown_format', severity: 'blocking' }))
  })

  it('limits content detection to the fixed 8 KiB probe tier', async () => {
    const lateGsi = `${'x'.repeat(SURVEY_FORMAT_LIMITS.detectionProbeBytes)}\n*110001+00000001 210001+04500000 220001+09000000 310001+00123456\n`
    const result = await ingest('late.gsi', lateGsi)
    expect(result.sourceFile.detection.format).toBe('unknown')
    expect(result.sourceFile.disposition).toBe('archive-only')
  })

  it('safely unwraps one gzip source and preserves the original hash', async () => {
    const content = Buffer.from('     3.04           O                   RINEX VERSION / TYPE\n                                                            END OF HEADER\n')
    const compressed = gzipSync(content)
    const result = await ingest('site.obs.gz', compressed)
    expect(result.sourceFile.detection.format).toBe('rinex-observation')
    expect(result.sourceFile.size).toBe(compressed.length)
    expect(result.effectiveBytes.equals(content)).toBe(true)
  })

  it('does not publish decompressed COSA anchors against the compressed original attachment', async () => {
    const compressed = gzipSync(await cosaIn2Fixture('golden-single-station.in2'))
    const result = await ingest('control.in2.gz', compressed)
    expect(result.sourceFile.detection).toMatchObject({ format: 'cosa-in2', method: 'structural-probe' })
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.records).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe_archive', severity: 'blocking', suggestedAction: expect.stringContaining('未压缩') }))
  })

  it.each([
    ['gzip', async (source: Buffer) => gzipSync(source), 'station.gsi.gz'],
    ['one-member ZIP', async (source: Buffer) => {
      const zip = new JSZip()
      zip.file('station.gsi', source)
      return await zip.generateAsync({ type: 'nodebuffer' })
    }, 'station.zip']
  ])('does not publish decompressed %s GSI anchors against the preserved container', async (_container, wrap, name) => {
    const source = Buffer.from('*110001+00000001 210001+04500000 220001+09000000 310001+00123456\n')
    const result = await ingest(name, await wrap(source))

    expect(result.sourceFile.detection.format).toBe('leica-gsi8')
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toHaveLength(0)
    expect(result.sourceFile.records).toHaveLength(0)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'unsafe_archive', severity: 'blocking', message: expect.stringContaining('成员字节流')
    }))
  })

  it('blocks multi-file ZIP input while retaining a reviewable source record', async () => {
    const zip = new JSZip(); zip.file('a.obs', 'RINEX'); zip.file('b.obs', 'RINEX')
    const result = await ingest('bundle.zip', await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe_archive', severity: 'blocking' }))
  })

  it('rejects a ZIP with a tampered member CRC before publishing archive metadata', async () => {
    const zip = new JSZip(); zip.file('station.gsi', '*110001+00000001 210001+04500000 220001+09000000 310001+00123456\\n')
    const valid = await zip.generateAsync({ type: 'nodebuffer' })
    const corrupted = Buffer.from(valid)
    const centralDirectory = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralDirectory).toBeGreaterThanOrEqual(0)
    // The central-directory CRC32 field starts 16 bytes after its signature.
    corrupted[centralDirectory + 16] = corrupted[centralDirectory + 16]! ^ 0x01

    const result = await ingest('corrupted.zip', corrupted)
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.observations).toEqual([])
    expect(result.sourceFile.records).toEqual([])
    expect(result.sourceFile.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({
      code: 'unsafe_archive', severity: 'blocking', message: expect.stringContaining('CRC32')
    }))
  })

  it('rejects a .xlsx extension whose ZIP is not an OOXML workbook', async () => {
    const zip = new JSZip(); zip.file('payload.json', '{"networkType":"leveling"}')
    const result = await ingest('fake.xlsx', await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe_archive', message: expect.stringContaining('不是有效的 Excel OOXML') }))
  })

  it('blocks XML entity declarations and excessive nesting before normalization', async () => {
    const entity = await ingest('unsafe.xml', '<!DOCTYPE LandXML [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><LandXML version="1.2"><CgPoint name="P1">&xxe;</CgPoint></LandXML>')
    expect(entity.sourceFile.disposition).toBe('archive-only')
    expect(entity.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_record', severity: 'blocking' }))

    const nested = `${'<Node>'.repeat(SURVEY_FORMAT_LIMITS.maxXmlDepth + 1)}${'</Node>'.repeat(SURVEY_FORMAT_LIMITS.maxXmlDepth + 1)}`
    const depth = await ingest('deep.xml', `<LandXML version="1.2">${nested}</LandXML>`)
    expect(depth.sourceFile.disposition).toBe('archive-only')
    expect(depth.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'limit_exceeded', message: expect.stringContaining('嵌套深度') }))
  })

  it('detects common Chinese text encoding without corrupting format detection', async () => {
    const gb18030Csv = Buffer.from([0xb5, 0xe3, 0xba, 0xc5, 0x2c, 0xd6, 0xb5, 0x0a, 0x50, 0x31, 0x2c, 0x31, 0x0a])
    const result = await ingest('points.csv', gb18030Csv)
    expect(result.sourceFile.detection.format).toBe('delimited-text')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'encoding_detected', message: '文本编码 gb18030' }))
  })

  it('blocks a gzip expansion-ratio bomb without throwing away provenance', async () => {
    const compressed = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x41))
    const result = await ingest('bomb.obs.gz', compressed)
    expect(result.sourceFile.disposition).toBe('archive-only')
    expect(result.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'limit_exceeded', severity: 'blocking' }))
  })

  it('blocks text record and parsed point limits before a network reaches the matrix layer', async () => {
    const tooManyLines = `JB,NMTest\n${'--\n'.repeat(SURVEY_FORMAT_LIMITS.maxTextLines)}`
    const lineResult = await ingest('oversized.raw', tooManyLines)
    expect(lineResult.sourceFile.disposition).toBe('archive-only')
    expect(lineResult.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'limit_exceeded', message: expect.stringContaining('文本记录上限') }))

    const points = Array.from({ length: SURVEY_FORMAT_LIMITS.maxParsedPoints + 1 }, (_, index) => `<CgPoint name="P${index}">${index} ${index} 0</CgPoint>`).join('')
    const pointResult = await ingest('oversized.xml', `<LandXML version="1.2"><CgPoints>${points}</CgPoints></LandXML>`)
    expect(pointResult.sourceFile.disposition).toBe('archive-only')
    expect(pointResult.sourceFile.diagnostics).toContainEqual(expect.objectContaining({ code: 'limit_exceeded', message: expect.stringContaining('解析点位') }))
  })

  it('publishes explicit ingestion bounds', () => {
    expect(SURVEY_FORMAT_LIMITS).toMatchObject({ maxSourceBytes: 64 * 1024 * 1024, maxArchiveRatio: 200, maxArchiveEntries: 32, maxXmlDepth: 64, maxParsedObservations: 100_000 })
  })
})
