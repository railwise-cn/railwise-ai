/**
 * Select the primary closure metric for the compact engineering summary.
 * The result is deterministic: each network family gets the metric an
 * operator normally uses first, with compatibility fallbacks for older
 * Runtime results that expose a different closure field.
 */
export function selectSurveyClosureKey(networkType: string | undefined, closure: Record<string, number> | undefined): string | undefined {
  if (!closure) return undefined

  const priorities: Record<string, string[]> = {
    leveling: ['heightDifference', 'vertical', 'closure'],
    traverse: ['relativeClosure', 'horizontal', 'fx', 'fy'],
    gnss: ['baseline', 'baselineX', 'baselineY', 'baselineZ'],
    'plane-control': ['horizontal', 'angular'],
    triangulation: ['horizontal', 'angular'],
    'cpiii-free-station': ['horizontal', 'angular'],
    'cpiii-resection': ['horizontal', 'angular'],
    'coordinate-transform': ['translationX', 'scalePpm', 'rotationRad']
  }
  const fallback = ['horizontal', 'angular', 'vertical', 'heightDifference', 'relativeClosure', 'baseline', 'fx', 'fy', 'translationX', 'scalePpm', 'rotationRad']
  const candidates = priorities[networkType ?? ''] ?? fallback
  return candidates.find((key) => Number.isFinite(closure[key]))
}

export function surveyReadiness(input: {
  blocked: boolean
  disposition?: string
  networkValidated: boolean
  datasetValidated: boolean
  hasSource: boolean
  hasResult: boolean
  hasOutputs: boolean
  reviewStatus?: string
  manifestValid: boolean
}): string {
  if (input.blocked) return 'blocked'
  if (input.disposition && input.disposition !== 'adjustment-ready') return input.disposition
  if (input.hasOutputs) return input.manifestValid && input.reviewStatus === 'approved' ? 'reviewed' : 'candidate'
  if (input.hasResult) return 'candidate'
  if (input.networkValidated || input.datasetValidated) return 'adjustment-ready'
  return input.hasSource ? 'needs-confirmation' : 'not-started'
}

/** Translate only the legacy missing-datum sentinel; never rewrite user datum names. */
export function surveyDatumLabel(value: string | undefined, t: (key: string) => string): string {
  return !value || value === '待确认' ? t('surveyPendingConfirmation') : value
}

export function surveyStatusLabel(value: string | undefined, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    imported: 'engineeringStatusImported', validated: 'surveyValidated', blocked: 'engineeringStatusBlocked',
    completed: 'engineeringStatusCompleted', running: 'engineeringStatusRunning',
    failed: 'engineeringStatusFailed', cancelled: 'engineeringStatusCancelled', queued: 'engineeringStatusQueued'
  }
  return value ? labels[value] ? t(labels[value]) : value : '—'
}

/** Never round a small nonzero engineering result down to an apparent exact zero. */
export function surveyMeasurementNumber(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString(locale, value !== 0 && Math.abs(value) < 0.0001
    ? { notation: 'scientific', maximumSignificantDigits: 5 }
    : { maximumFractionDigits: 4 })
}
