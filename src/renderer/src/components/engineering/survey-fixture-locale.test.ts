import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SurveyFormatRegistry } from '../../../../../kun/src/engineering/survey-format-registry'
import { surveyDiagnosticText, surveyLegacyDiagnosticText } from './survey-diagnostic-text'

it('renders all shipped source-file fixture diagnostics in English without rewriting raw evidence', async () => {
  const root = fileURLToPath(new URL('../../../../../kun/src/engineering/fixtures/survey-formats/', import.meta.url))
  const registry = new SurveyFormatRegistry()
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && !/\.(md|json)$/.test(entry.name))
  expect(files.length).toBeGreaterThanOrEqual(40)
  for (const entry of files) {
    const name = join(entry.parentPath, entry.name)
    const result = await registry.ingest({ name: basename(name), bytes: await readFile(name) })
    const source = result.sourceFile
    const original = JSON.stringify(source)
    for (const diagnostic of source.diagnostics) {
      for (const field of ['message', 'action'] as const) {
        expect.soft(surveyDiagnosticText(diagnostic, 'en', field), `${entry.name}: ${diagnostic.code} ${field}`).not.toMatch(/\p{Script=Han}/u)
      }
      expect(surveyDiagnosticText(diagnostic, 'zh')).toBe(diagnostic.message)
    }
    expect.soft(source.dispositionReasonEn ?? surveyLegacyDiagnosticText(source.dispositionReason ?? '', 'en'), `${entry.name}: disposition`).not.toMatch(/\p{Script=Han}/u)
    expect(JSON.stringify(source)).toBe(original)
  }
})

it('preserves opaque identifiers that happen to match a system diagnostic', () => {
  const point = 'XML 点记录缺少点号'
  expect(surveyLegacyDiagnosticText(`${point} 记录缺少测站 OP/目标 FP 或两者相同，未生成观测`, 'en')).toContain(point)
  expect(surveyLegacyDiagnosticText('COSA .in2 解析失败（invalid-direction）：第 6 行、第 6 列应为 a COSA D.MMSSs direction with minute and second fields below 60', 'en')).toContain('line 6, column 6')
  expect(surveyLegacyDiagnosticText('工程自定义诊断：请保留', 'en')).toBe('工程自定义诊断：请保留')
})

it('renders rejected frozen JSON and truncated RTCM diagnostics without changing source evidence', async () => {
  const registry = new SurveyFormatRegistry()
  const base = {
    networkType: 'leveling', unit: 'm',
    knownPoints: [{ id: 'A', known: true, pointClass: 'known', height: 0 }],
    unknownPoints: [{ id: 'B', known: false, height: 0 }],
    observations: [{ id: 'AB', type: 'height-difference', from: 'A', to: 'B', value: 1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }],
    instrumentParameters: {}
  }
  type TestNetwork = Omit<typeof base, 'networkType' | 'unit' | 'observations'> & {
    networkType?: string
    unit?: string
    observations: Array<Omit<typeof base.observations[number], 'unit' | 'sigmaUnit'> & { unit?: string; sigmaUnit?: string }>
  }
  const mutations: Array<[string, (network: TestNetwork) => void]> = [
    ['missing network type', network => { delete network.networkType }],
    ['missing transform type', network => { network.networkType = 'coordinate-transform' }],
    ['duplicate point', network => { network.unknownPoints.push({ ...network.knownPoints[0] }) }],
    ['duplicate observation', network => { network.observations.push({ ...network.observations[0] }) }],
    ['missing network unit', network => { delete network.unit }],
    ['non-metre coordinates', network => { network.unit = 'cm' }],
    ['missing observation unit', network => { delete network.observations[0].unit }],
    ['missing sigma unit', network => { delete network.observations[0].sigmaUnit }],
    ['unsupported observation unit', network => { network.observations[0].unit = 'furlong' }],
    ['unsupported sigma unit', network => { network.observations[0].sigmaUnit = 'furlong' }],
    ['angular missing unit', network => { network.observations[0].type = 'direction'; delete network.observations[0].unit }],
    ['angular unsupported unit', network => { network.observations[0].type = 'direction'; network.observations[0].unit = 'turn' }]
  ]
  const cases: Array<{ name: string; bytes: Buffer }> = mutations.map(([label, mutate]) => {
    const network = structuredClone(base)
    mutate(network)
    return { name: `${label}.json`, bytes: Buffer.from(JSON.stringify({ format: 'workwise-survey-network', formatVersion: 1, network })) }
  })
  cases.push(
    { name: 'truncated-header.rtcm3', bytes: Buffer.from([0xd3, 0]) },
    { name: 'truncated-frame.rtcm3', bytes: Buffer.from([0xd3, 0, 2, 0x43]) },
    { name: 'mapping.csv', bytes: Buffer.from('point,x,y\nA,1,2\n') },
    { name: 'unknown.dat', bytes: Buffer.from('010203040506070809\n112233445566778899\n') },
    { name: 'station.gsi.gz', bytes: gzipSync(Buffer.from('*110001+00000001 210001+04500000 220001+09000000 310001+00123456\n')) }

  )
  for (const input of cases) {
    const { sourceFile: source } = await registry.ingest(input)
    expect(source.disposition, input.name).not.toBe('adjustment-ready')
    expect(source.diagnostics.some(item => item.severity === 'blocking'), input.name).toBe(true)
    const before = JSON.stringify(source)
    for (const diagnostic of source.diagnostics) {
      for (const field of ['message', 'action'] as const) {
        expect.soft(surveyDiagnosticText(diagnostic, 'en', field), `${input.name}: ${diagnostic.code} ${field}`).not.toMatch(/\p{Script=Han}/u)
      }
      expect(surveyDiagnosticText(diagnostic, 'zh')).toBe(diagnostic.message)
    }
    expect.soft(source.dispositionReasonEn ?? surveyLegacyDiagnosticText(source.dispositionReason ?? '', 'en'), input.name).not.toMatch(/\p{Script=Han}/u)
    expect(JSON.stringify(source)).toBe(before)
  }
})

it('keeps Chinese duplicate IDs and custom unit labels verbatim inside translated rejection messages', () => {
  const point = '控制点等 12 个'
  expect(surveyLegacyDiagnosticText(`WorkWise JSON 已知点/未知点中存在重复点号 ${point}；点位映射不唯一，不能进入平差。`, 'en')).toBe(`WorkWise JSON known/unknown points contain duplicate IDs ${point}. Point mapping is ambiguous and adjustment is blocked.`)
  const unit = '现场单位'
  expect(surveyLegacyDiagnosticText(`WorkWise JSON 网络坐标/高程单位 ${unit} 尚无冻结的点位换算合同；不得把点位数值标记为米制或进入平差。`, 'en')).toContain(unit)
})
