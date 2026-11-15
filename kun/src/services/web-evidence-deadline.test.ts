import { expect, it } from 'vitest'
import { evidenceDeadlineCutoff } from './web-evidence-deadline.js'

it.each(['2026年11月18日14时00分', '2026年11月18日 14:00', '2026-11-18 14:00', '2026-11-18T14:00:00+08:00', '2026-11-18T06:00:00Z'])('uses the exact source time with a fixed timezone: %s', raw => {
  expect(evidenceDeadlineCutoff(raw)).toBe(Date.parse('2026-11-18T06:00:00Z'))
})
it('preserves the explicit date-only contract without falling back from malformed time', () => {
  expect(evidenceDeadlineCutoff('2026-11-18')).toBe(Date.parse('2026-11-18T15:59:59.999Z'))
  expect(evidenceDeadlineCutoff('2026年11月18日')).toBe(Date.parse('2026-11-18T15:59:59.999Z'))
})
it.each(['2026年11月18日14时', '2026年11月18日下午2点', '截止2026年11月18日14时00分', '2026-11-18 14', '2026-02-29', '2026-11-31', '2026-11-18 24:00', '2026-11-18 14:60', '2026-11-18T14:00:00+14:30', '2026-11-18T14:00:00+25:00'])('rejects invalid or ambiguous source times: %s', raw => {
  expect(evidenceDeadlineCutoff(raw)).toBeUndefined()
})
