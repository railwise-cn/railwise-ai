// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { engineeringImportKind } from './engineering-import'
import { isSurveyImportFile } from './survey-file-selection'

describe('shared engineering import entry', () => {
  it('routes monitoring CSV by headers without treating survey CSV as monitoring', async () => {
    expect(await engineeringImportKind(new File(['点号,时间,观测值\nP1,2026-01-01,1'], 'data.csv'), 'auto')).toBe('monitoring')
    expect(await engineeringImportKind(new File(['from,to,distance\nP1,P2,100'], 'network.csv'), 'auto')).toBe('survey')
    expect(await engineeringImportKind(new File(['from,to,distance'], 'network.csv'), 'monitoring')).toBe('monitoring')
    expect(await engineeringImportKind(new File([], 'network.xlsx'), 'survey')).toBe('survey')
  })
  it('routes the same computation formats out of AI upload while retaining documents as attachments', () => {
    for (const name of ['source.csv', 'monitor.xlsx', 'observations.IN2', 'instrument.gsi']) expect(isSurveyImportFile({ name })).toBe(true)
    for (const name of ['brief.docx', 'drawing.pdf', 'photo.png']) expect(isSurveyImportFile({ name })).toBe(false)
  })
})
