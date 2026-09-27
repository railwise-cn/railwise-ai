import { describe, expect, it } from 'vitest'
import { validEngineeringReportPeriod } from './engineering-report-period'

describe('Engineering report calendar dates', () => {
  it('accepts empty, one-sided and leap-year periods without timezone conversion', () => {
    for (const period of [{}, { start: '2000-02-29' }, { end: '2024-02-29' }, { start: '2026-09-19', end: '2026-09-19' }]) {
      expect(validEngineeringReportPeriod(period)).toBe(true)
    }
  })
  it('rejects impossible dates, non-ISO inputs and reversed periods', () => {
    for (const start of ['1900-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '0000-01-01', '2026-01-00', '2026-13-01', '26-9-19', '2026-09-19T00:00:00Z']) {
      expect(validEngineeringReportPeriod({ start })).toBe(false)
    }
    expect(validEngineeringReportPeriod({ start: '2026-09-20', end: '2026-09-19' })).toBe(false)
  })
})
