import { describe, expect, it } from 'vitest'
import { parseSurveyKnownPoints } from './survey-known-points'
import { surveyImportKey } from './survey-import-identity'

describe('explicit control point mapping', () => {
  it('reads metre-valued height controls and optional XY without inventing a datum', () => {
    expect(parseSurveyKnownPoints('\uFEFF# benchmark\nBM-1,100.001\nBM-2 99.4 10 20')).toEqual([
      { id: 'BM-1', height: 100.001 }, { id: 'BM-2', height: 99.4, x: 10, y: 20 }
    ])
    expect(parseSurveyKnownPoints('')).toEqual([])
  })
  it.each(['BM-1,', 'BM-1,Infinity', 'BM-1,1,2', 'BM-1,1\nBM-1,2', 'BM-1,NaN', 'BM-1,,100', 'BM-1,0x10'])('rejects ambiguous or invalid controls: %s', (input) => {
    expect(() => parseSurveyKnownPoints(input)).toThrow()
  })
  it('does not replay a previous import after control values change', async () => {
    const input = { name: 'level.gsi', dataBase64: 'AA==', networkType: 'leveling' }
    const first = await surveyImportKey('project', { ...input, knownPoints: [{ id: 'BM', height: 100 }] })
    expect(await surveyImportKey('project', { ...input, knownPoints: [{ id: 'BM', height: 101 }] })).not.toBe(first)
  })
})
