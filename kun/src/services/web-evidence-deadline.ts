/** Parse only explicit source calendar dates/times. Unzoned source dates use China time. */
export function evidenceDeadlineCutoff(value: string): number | undefined {
  const trimmed = value.trim()
  // Remove only this finite timezone annotation; the remaining date/time must still match in full.
  const beijingSuffix = /(?:（北京时间）|\(北京时间\)|北京时间)$/.exec(trimmed)
  const raw = beijingSuffix ? trimmed.slice(0, beijingSuffix.index).trimEnd() : trimmed
  const chinese = /^(20\d{2})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})(?:时(\d{1,2})分(?:(\d{1,2})秒)?|[:：](\d{2})(?:[:：](\d{2}))?))?$/.exec(raw)
  const iso = /^(20\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(raw)
  if (!chinese && !iso) return undefined
  const match = (chinese ?? iso)!
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hasTime = match[4] !== undefined
  const hour = hasTime ? Number(match[4]) : 23
  const minute = hasTime ? Number(chinese ? match[5] ?? match[7] : match[5]) : 59
  const second = hasTime ? Number(chinese ? match[6] ?? match[8] ?? 0 : match[6] ?? 0) : 59
  const millis = hasTime ? Number(iso?.[7]?.padEnd(3, '0') ?? 0) : 999
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined
  const zone = iso?.[8]
  let offset = 8 * 60
  if (zone === 'Z') offset = 0
  else if (zone) {
    const zoneHour = Number(zone.slice(1, 3)), zoneMinute = Number(zone.slice(4, 6))
    if (zoneHour > 14 || zoneMinute > 59 || zoneHour === 14 && zoneMinute !== 0) return undefined
    offset = (zone[0] === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute)
  }
  if (beijingSuffix && offset !== 8 * 60) return undefined
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000
}
