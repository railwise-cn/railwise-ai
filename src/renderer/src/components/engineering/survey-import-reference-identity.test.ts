import { describe, expect, it } from 'vitest'
import { surveyImportKey } from './survey-import-identity'

describe('survey reference import identity', () => {
  it('replays an unchanged declaration and distinguishes a changed coordinate or height reference for the same original bytes', async () => {
    const input = { name: 'survey.gsi', dataBase64: 'original-instrument-bytes', networkType: 'plane-control', referenceDeclaration: { coordinateSystem: '工程独立坐标系', verticalDatum: '项目高程基准' } }
    const original = await surveyImportKey('project-reference', input)
    expect(await surveyImportKey('project-reference', input)).toBe(original)
    const coordinateChange = await surveyImportKey('project-reference', { ...input, referenceDeclaration: { ...input.referenceDeclaration, coordinateSystem: 'CGCS2000' } })
    const heightChange = await surveyImportKey('project-reference', { ...input, referenceDeclaration: { ...input.referenceDeclaration, verticalDatum: '1985 国家高程基准' } })
    expect(new Set([original, coordinateChange, heightChange]).size).toBe(3)
  })
})
