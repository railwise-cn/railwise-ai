import { describe, expect, it } from 'vitest'
import { surveyImportKey } from './survey-import-identity'

describe('survey import identity', () => {
  it('replays identical imports while keeping source, project, strategy and mapping changes distinct', async () => {
    const input = { name: 'field.in1', dataBase64: 'original-bytes', networkType: 'leveling', cosaIn1Mapping: { knownPointRecordCount: 2 } }
    const original = await surveyImportKey('project-one', input)
    expect(await surveyImportKey('project-one', input)).toBe(original)
    const variants = await Promise.all([
      surveyImportKey('project-two', input),
      surveyImportKey('project-one', { ...input, dataBase64: 'different-data' }),
      surveyImportKey('project-one', { ...input, networkType: 'plane-control' }),
      surveyImportKey('project-one', { ...input, cosaIn1Mapping: { knownPointRecordCount: 3 } }),
      surveyImportKey('project-one', { ...input, tabularMapping: { linearUnit: 'mm', confirmed: true } }),
      surveyImportKey('project-one', { ...input, name: 'renamed.in1' })
    ])
    expect(new Set([original, ...variants]).size).toBe(7)
    expect(original).not.toContain('original-bytes')
  })
})
