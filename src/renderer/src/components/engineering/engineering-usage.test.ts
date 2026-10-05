// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { readEngineeringUsage, recordEngineeringUsage } from './engineering-usage'

beforeEach(() => {
  const data = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } })
})

it('keeps bounded local aggregates without source identifiers and ignores bad timings', () => {
  for (let i = 0; i < 60; i++) recordEngineeringUsage('firstImportMs', i)
  recordEngineeringUsage('firstImportMs', NaN)
  recordEngineeringUsage('recoveryAttempts')
  recordEngineeringUsage('recoverySuccesses')
  const usage = readEngineeringUsage()
  expect(usage.firstImportMs).toHaveLength(50)
  expect(usage.firstImportMs[0]).toBe(10)
  expect(usage.recoveryAttempts).toBe(1)
  expect(usage.recoverySuccesses).toBe(1)
  expect(Object.keys(usage)).not.toContain('projectId')
})

it('recovers from malformed historical counters without blocking the workbench', () => {
  window.localStorage.setItem('workwise.survey.usage.v1', '{')
  expect(readEngineeringUsage().advancedOpens).toBe(0)
  recordEngineeringUsage('advancedOpens')
  expect(readEngineeringUsage().advancedOpens).toBe(1)
})
