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
  it.each([50035, 49152, 49999, 65235])('does not turn resource URL port %i into a daily time', port => {
    const requirement = extractScheduleRequirement(`使用broswer-skill，读取 http://127.0.0.1:${port}/fixture，将网页实际内容生成HTML报告并交付。每天09:00和17:00前提前30分钟执行。`)!
    expect(requirement).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 })
    expect(scheduleForRequirement(requirement)).toEqual({ kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai' })
  })
  it('ignores times in multiple resource URL paths and queries', () => {
    expect(extractScheduleRequirement('每天09:00和17:00执行，读取 http://127.0.0.1:50035/archive/02:15?at=09:00&until=21:45 和 https://example.com:49152/report/10:00?check=03:30。')).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    expect(extractScheduleRequirement('每天读取 http://127.0.0.1:50035/report/09:00?check=17:00。')).toBeUndefined()
    expect(extractScheduleRequirement('09:00读取 https://example.com/daily/report。')).toBeUndefined()
  })
  it.each([
    'https://example.com/Asia/Tokyo?timezone=America/New_York&note=提前90分钟',
    'https://example.com/report?at=09:00前&timezone=America/New_York'
  ])('ignores timezone and lead instructions inside resource URL %s', url => {
    expect(extractScheduleRequirement(`读取 ${url}。每天09:00和17:00执行。`)).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    expect(extractScheduleRequirement(`读取 ${url}。每天09:00和17:00执行，提前15分钟，时区 Europe/London。`)).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Europe/London', leadMinutes: 15 })
  })
  it('keeps independent Chinese deadlines beside resource URLs', () => {
    const requirement = extractScheduleRequirement('读取 http://127.0.0.1:50035/fixture。每天早上9点前、下午5点前执行，时区 Asia/Tokyo。')!
    expect(requirement).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Tokyo', leadMinutes: 30 })
    expect(scheduleForRequirement(requirement)).toEqual({ kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Tokyo' })
  })
  it('does not extract partial numeric clock values', () => {
    expect(extractScheduleRequirement('每天记录109:00、09:000和19:001的数据，在17:00执行。')).toEqual({ kind: 'daily', times: ['17:00'], timezone: 'Asia/Shanghai' })
  })
  it('keeps recurrence when output paths resemble timezone identifiers', () => {
    for (const path of ['/tmp/report-ABCdef/workspace/report.html', 'F:/Projects/Reports/report.html']) {
      expect(extractScheduleRequirement(`生成HTML到 ${path}。每天09:00和17:00执行。`)).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
      expect(extractScheduleRequirement(`生成HTML到 ${path}。每天09:00和17:00执行，时区 America/New_York。`)).toMatchObject({ timezone: 'America/New_York' })
    }
    expect(extractScheduleRequirement('Run every day at 09:00 in America/Port-au-Prince.')).toMatchObject({ timezone: 'America/Port-au-Prince' })
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
