import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'

const KEY = 'workwise.survey.usage.v1'
type Usage = {
  schemaVersion: 1
  firstImportMs: number[]
  actionsToFirstResult: number[]
  primaryActions: number
  resultsReached: number
  returnNavigation: number
  recoveryAttempts: number
  recoverySuccesses: number
  advancedOpens: number
  journeyAttempts: JourneyAttempt[]
}
type JourneyAttempt = { id: string; startedAt: string; finishedAt?: string; outcome: 'started' | 'passed' | 'cancelled' | 'failed' | 'interrupted' }
const empty = (): Usage => ({ schemaVersion: 1, firstImportMs: [], actionsToFirstResult: [], primaryActions: 0, resultsReached: 0, returnNavigation: 0, recoveryAttempts: 0, recoverySuccesses: 0, advancedOpens: 0, journeyAttempts: [] })
let journey: { actions: number; reachedResult: boolean } | null = null
let journeyId: string | null = null
const now = (): string => new Date().toISOString()
const newId = (): string => `journey-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
function writeUsage(usage: Usage): void { writeBrowserStorageItem(KEY, JSON.stringify(usage)) }
function closeOpenJourneys(usage: Usage, outcome: JourneyAttempt['outcome']): void {
  const timestamp = now()
  usage.journeyAttempts = usage.journeyAttempts.map(item => item.outcome === 'started' ? { ...item, outcome, finishedAt: timestamp } : item)
}
export function beginEngineeringJourney(): void {
  const usage = readEngineeringUsage()
  closeOpenJourneys(usage, 'interrupted')
  journeyId = newId()
  usage.journeyAttempts = [...usage.journeyAttempts, { id: journeyId, startedAt: now(), outcome: 'started' as const }].slice(-100)
  writeUsage(usage)
  journey = { actions: 1, reachedResult: false }
}
export function leaveEngineeringJourney(): void {
  if (!journeyId) { journey = null; return }
  const usage = readEngineeringUsage()
  const timestamp = now()
  usage.journeyAttempts = usage.journeyAttempts.map(item => item.id === journeyId && item.outcome === 'started' ? { ...item, outcome: 'cancelled', finishedAt: timestamp } : item)
  writeUsage(usage)
  journeyId = null
  journey = null
}
export function recordEngineeringJourneyFailure(): void {
  if (!journeyId) return
  const usage = readEngineeringUsage()
  const timestamp = now()
  usage.journeyAttempts = usage.journeyAttempts.map(item => item.id === journeyId && item.outcome === 'started' ? { ...item, outcome: 'failed', finishedAt: timestamp } : item)
  writeUsage(usage)
  journeyId = null
  journey = null
}
export function readEngineeringJourneyMetrics(): { attempts: number; completed: number; failed: number; cancelled: number; interrupted: number; open: number } {
  const attempts = readEngineeringUsage().journeyAttempts
  return { attempts: attempts.length, completed: attempts.filter(item => item.outcome === 'passed').length, failed: attempts.filter(item => item.outcome === 'failed').length, cancelled: attempts.filter(item => item.outcome === 'cancelled').length, interrupted: attempts.filter(item => item.outcome === 'interrupted').length, open: attempts.filter(item => item.outcome === 'started').length }
}

/** Local aggregate counters only: no files, goals, IDs, values or outbound data. */
export function readEngineeringUsage(): Usage {
  try {
    const stored = JSON.parse(readBrowserStorageItem(KEY) ?? 'null') as Usage | null
    if (!stored || stored.schemaVersion !== 1) return empty()
    const result = empty()
    for (const key of ['primaryActions', 'resultsReached', 'returnNavigation', 'recoveryAttempts', 'recoverySuccesses', 'advancedOpens'] as const) {
      result[key] = Number.isSafeInteger(stored[key]) && stored[key] >= 0 ? stored[key] : 0
    }
    result.firstImportMs = Array.isArray(stored.firstImportMs) ? stored.firstImportMs.filter(ms => Number.isFinite(ms) && ms >= 0).slice(-50) : []
    result.actionsToFirstResult = Array.isArray(stored.actionsToFirstResult) ? stored.actionsToFirstResult.filter(count => Number.isSafeInteger(count) && count >= 1).slice(-50) : []
    result.journeyAttempts = Array.isArray(stored.journeyAttempts) ? stored.journeyAttempts.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.startedAt === 'string' && ['started', 'passed', 'cancelled', 'failed', 'interrupted'].includes(item.outcome)).slice(-100) as JourneyAttempt[] : []
    return result
  } catch { return empty() }
}

export function recordEngineeringUsage(event: Exclude<keyof Usage, 'schemaVersion' | 'actionsToFirstResult' | 'journeyAttempts'>, duration?: number): void {
  const usage = readEngineeringUsage()
  if (event === 'primaryActions' && journey && !journey.reachedResult) journey.actions++
  if (event === 'resultsReached' && journey && !journey.reachedResult) {
    usage.actionsToFirstResult = [...usage.actionsToFirstResult, journey.actions].slice(-50)
    journey.reachedResult = true
    if (journeyId) {
      const timestamp = now()
      usage.journeyAttempts = usage.journeyAttempts.map(item => item.id === journeyId && item.outcome === 'started' ? { ...item, outcome: 'passed', finishedAt: timestamp } : item)
      journeyId = null
    }
  }
  if (event === 'firstImportMs') {
    if (duration === undefined || !Number.isFinite(duration) || duration < 0) return
    usage.firstImportMs = [...usage.firstImportMs, Math.round(duration)].slice(-50)
  } else usage[event] = Math.min(Number.MAX_SAFE_INTEGER, usage[event] + 1)
  writeBrowserStorageItem(KEY, JSON.stringify(usage))
}
