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
}
const empty = (): Usage => ({ schemaVersion: 1, firstImportMs: [], actionsToFirstResult: [], primaryActions: 0, resultsReached: 0, returnNavigation: 0, recoveryAttempts: 0, recoverySuccesses: 0, advancedOpens: 0 })
let journey: { actions: number; reachedResult: boolean } | null = null
export function beginEngineeringJourney(): void { journey = { actions: 1, reachedResult: false } }
export function leaveEngineeringJourney(): void { journey = null }

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
    return result
  } catch { return empty() }
}

export function recordEngineeringUsage(event: Exclude<keyof Usage, 'schemaVersion' | 'actionsToFirstResult'>, duration?: number): void {
  const usage = readEngineeringUsage()
  if (event === 'primaryActions' && journey && !journey.reachedResult) journey.actions++
  if (event === 'resultsReached' && journey && !journey.reachedResult) {
    usage.actionsToFirstResult = [...usage.actionsToFirstResult, journey.actions].slice(-50)
    journey.reachedResult = true
  }
  if (event === 'firstImportMs') {
    if (duration === undefined || !Number.isFinite(duration) || duration < 0) return
    usage.firstImportMs = [...usage.firstImportMs, Math.round(duration)].slice(-50)
  } else usage[event] = Math.min(Number.MAX_SAFE_INTEGER, usage[event] + 1)
  writeBrowserStorageItem(KEY, JSON.stringify(usage))
}
