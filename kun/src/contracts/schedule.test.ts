import { describe, expect, it } from 'vitest'
import { extractScheduleRequirement, nextScheduleOccurrence, normalizeScheduleSpec, scheduleForRequirement } from './schedule.js'

describe('daily schedule contract', () => {
  it('extracts both deadlines and schedules the requested lead time', () => {
    const requirement = extractScheduleRequirement('每天9点和17点前抓取网页并生成HTML，提前30分钟执行。')!
    expect(requirement).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 })
    const schedule = scheduleForRequirement(requirement)
    expect(schedule).toEqual({ kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai' })
    expect(nextScheduleOccurrence(schedule, new Date('2026-11-13T00:29:00Z'))).toBe('2026-11-13T00:30:00.000Z')
    expect(nextScheduleOccurrence(schedule, new Date('2026-11-13T00:30:00Z'))).toBe('2026-11-13T08:30:00.000Z')
    expect(nextScheduleOccurrence(schedule, new Date('2026-11-13T08:30:00Z'))).toBe('2026-11-14T00:30:00.000Z')
  })
  it('preserves exact times without adding a lead when none was requested', () => {
    expect(extractScheduleRequirement('每天09:00、17:00执行')).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    expect(extractScheduleRequirement('查看09:00和17:00的新闻')).toBeUndefined()
  })
  it('recognizes the original Chinese morning and afternoon deadlines', () => {
    expect(extractScheduleRequirement('每天执行两次，早上九点前一次，下午五点前一次。')).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 })
    expect(extractScheduleRequirement('每天9点/17点执行')).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    expect(extractScheduleRequirement('每天09/17定时执行')).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
  })
  it('reads legacy timeOfDay and the previously displayed expression', () => {
    expect(normalizeScheduleSpec({ kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' })).toEqual({ kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' })
    expect(normalizeScheduleSpec({ kind: 'interval', everyMinutes: 15, schedule: 'daily:09:00,17:00', timezone: 'Asia/Shanghai' })).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
  })
  it('uses the configured timezone across DST and does not repeat ambiguous wall time', () => {
    expect(nextScheduleOccurrence({ kind: 'daily', times: ['09:00'], timezone: 'America/New_York' }, new Date('2026-03-07T15:00:00Z'))).toBe('2026-03-08T13:00:00.000Z')
    expect(nextScheduleOccurrence({ kind: 'daily', times: ['02:30'], timezone: 'America/New_York' }, new Date('2026-03-08T00:00:00Z'))).toBe('2026-03-09T06:30:00.000Z')
    expect(nextScheduleOccurrence({ kind: 'daily', times: ['01:30'], timezone: 'America/New_York' }, new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-02T06:30:00.000Z')
  })
  it('rejects invalid time and timezone instead of silently changing the schedule', () => {
    expect(() => normalizeScheduleSpec({ kind: 'daily', times: ['25:00'], timezone: 'Asia/Shanghai' })).toThrow()
    expect(() => normalizeScheduleSpec({ kind: 'daily', times: ['09:00'], timezone: 'Mars/Base' })).toThrow()
  })
})
