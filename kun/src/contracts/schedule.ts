import { z } from 'zod'

const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
export const TimezoneSchema = z.string().min(1).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Use an IANA timezone such as Asia/Shanghai')

export const ScheduleRequirementSchema = z.object({
  kind: z.literal('daily'),
  times: z.array(timeOfDay).min(1).max(24).transform(values => [...new Set(values)].sort()),
  timezone: TimezoneSchema,
  leadMinutes: z.number().int().min(0).max(1439).optional()
})
export type ScheduleRequirement = z.infer<typeof ScheduleRequirementSchema>

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(1).max(10080) }),
  z.object({ kind: z.literal('at'), atTime: z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid date') }),
  ScheduleRequirementSchema.omit({ leadMinutes: true })
])
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>

/** Legacy records used the host timezone and a single timeOfDay. */
export function normalizeScheduleSpec(value: Record<string, unknown>): ScheduleSpec {
  const expression = typeof value.schedule === 'string' ? value.schedule.trim() : ''
  const daily = expression.match(/^daily:(\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2})*)$/)
  const interval = expression.match(/^interval:(\d+)(m|h)$/)
  if (daily) value = { ...value, kind: 'daily', times: daily[1]!.split(',').map(time => time.trim().padStart(5, '0')) }
  if (expression && !daily && !interval) throw new Error('Invalid schedule expression')
  if (interval) value = { ...value, kind: 'interval', everyMinutes: Number(interval[1]) * (interval[2] === 'h' ? 60 : 1) }
  const kind = value.kind ?? 'manual'
  if (kind === 'daily') return ScheduleSpecSchema.parse({ kind,
    times: value.times ?? [value.timeOfDay ?? '09:00'],
    timezone: value.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone })
  return ScheduleSpecSchema.parse({ ...value, kind })
}

export function scheduleForRequirement(requirement: ScheduleRequirement): ScheduleSpec {
  return ScheduleSpecSchema.parse({ ...requirement, times: requirement.times.map(time => {
    const [hours, minutes] = time.split(':').map(Number)
    const total = (hours! * 60 + minutes! - (requirement.leadMinutes ?? 0) + 1440) % 1440
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }) })
}

function wallParts(date: Date, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  return ['year', 'month', 'day', 'hour', 'minute'].map(type => Number(parts.find(part => part.type === type)?.value))
}

/** Select the first occurrence of an ambiguous wall time. Skip nonexistent DST times. */
function wallTimeInstant(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number | undefined {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offsets = new Set([-36, 0, 36].map(hours => {
    const sample = wall + hours * 3600000
    const [y, m, d, h, min] = wallParts(new Date(sample), timezone)
    return Date.UTC(y!, m! - 1, d!, h!, min!) - sample
  }))
  const candidates = [...offsets].map(offset => wall - offset).filter(instant =>
    wallParts(new Date(instant), timezone).join(',') === [year, month, day, hour, minute].join(','))
  return candidates.length ? Math.min(...candidates) : undefined
}

export function nextScheduleOccurrence(value: Record<string, unknown>, from: Date): string | undefined {
  const schedule = normalizeScheduleSpec(value)
  if (schedule.kind === 'manual') return undefined
  if (schedule.kind === 'at') return Date.parse(schedule.atTime) > from.getTime() ? schedule.atTime : undefined
  if (schedule.kind === 'interval') return new Date(from.getTime() + schedule.everyMinutes * 60000).toISOString()
  const [year, month, day] = wallParts(from, schedule.timezone)
  for (let offset = 0; offset < 4; offset++) {
    const date = new Date(Date.UTC(year!, month! - 1, day! + offset))
    for (const time of schedule.times) {
      const [hour, minute] = time.split(':').map(Number)
      const instant = wallTimeInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour!, minute!, schedule.timezone)
      if (instant !== undefined && instant > from.getTime()) return new Date(instant).toISOString()
    }
  }
  return undefined
}

/** Extract explicit daily times. Ambiguous recurrence remains available to ordinary clarification. */
export function extractScheduleRequirement(prompt: string): ScheduleRequirement | undefined {
  if (!/(?:每天|每日|daily|every day)/i.test(prompt)) return undefined
  const times = [...prompt.matchAll(/(?<![\d一二三四五六七八九十])([01]?\d|2[0-3]|二十[一二三]?|十[一二三四五六七八九]?|[零〇一二两三四五六七八九])(?:[:：]([0-5]\d)|\s*点(?:\s*([0-5]?\d)\s*分|半)?)/g)]
    .map(match => {
      let hour = chineseNumber(match[1]!)
      const preceding = prompt.slice(Math.max(0, (match.index ?? 0) - 12), match.index)
      const period = [...preceding.matchAll(/上午|早上|凌晨|下午|晚上|中午/g)].at(-1)?.[0]
      if (period && (['下午', '晚上'].includes(period) && hour < 12 || period === '中午' && hour < 6)) hour += 12
      if (period === '凌晨' && hour === 12) hour = 0
      const minute = match[0].endsWith('半') ? '30' : match[2] ?? match[3] ?? '00'
      return `${String(hour).padStart(2, '0')}:${minute.padStart(2, '0')}`
    })
  if (!times.length) {
    const paired = prompt.match(/(?:每天|每日)\s*(\d{1,2})\s*[\/、和及]\s*(\d{1,2})(?!\d)/)
    if (paired) times.push(...paired.slice(1).map(hour => `${hour.padStart(2, '0')}:00`))
  }
  if (!times.length) return undefined
  const lead = prompt.match(/提前\s*(\d+)\s*分钟|提前半小时/)
  const leadMinutes = lead ? Number(lead[1] ?? 30) : /(?:点|\d{2})\s*(?:之)?前/.test(prompt) ? 30 : undefined
  const timezone = prompt.match(/\b[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/)?.[0] ?? 'Asia/Shanghai'
  const parsed = ScheduleRequirementSchema.safeParse({ kind: 'daily', times, timezone, ...(leadMinutes !== undefined ? { leadMinutes } : {}) })
  return parsed.success ? parsed.data : undefined
}

function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (!value.includes('十')) return digits[value] ?? NaN
  const [tens, ones] = value.split('十')
  return (tens ? digits[tens]! : 1) * 10 + (ones ? digits[ones]! : 0)
}
