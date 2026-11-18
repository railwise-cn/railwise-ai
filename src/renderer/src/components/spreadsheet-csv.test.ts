import { describe, expect, it } from 'vitest'
import { exportSpreadsheetCsv, parseSpreadsheetCsv } from './spreadsheet-csv'

describe('spreadsheet CSV', () => {
  it('preserves Chinese text, leading zeroes, embedded commas, quotes and newlines', () => {
    const rows = [['001', '浙江,宁波', '点位"甲"', '第一行\n第二行', ''], ['', '', '核对']]
    expect(parseSpreadsheetCsv(exportSpreadsheetCsv(rows))).toEqual(rows)
  })

  it('protects formula-like text on export and keeps numeric values intact', () => {
    expect(parseSpreadsheetCsv(exportSpreadsheetCsv([['=2+2', '@token', '-002', -12]])))
      .toEqual([["'=2+2", "'@token", "'-002", '-12']])
    expect(() => parseSpreadsheetCsv('"unfinished')).toThrow()
  })
})
