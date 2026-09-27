/** ISO dates are kept as local calendar dates, never converted through a time zone. */
export function validEngineeringReportPeriod(period: { start?: string; end?: string }): boolean {
  for (const value of [period.start, period.end]) {
    if (!value) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    if (year < 1 || month < 1 || month > 12 || day < 1) return false
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!) return false
  }
  return !period.start || !period.end || period.start <= period.end
}
