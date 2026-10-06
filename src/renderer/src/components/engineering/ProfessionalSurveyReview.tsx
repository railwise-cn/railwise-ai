import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, Bot, CheckCircle2, ClipboardCheck, FileOutput, GitBranch, Info, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SurveyProfessionalReviewV1, type SurveyProfessionalReasonV1 } from '@shared/survey-professional'
import { SurveyEvidenceReferenceV1 } from '@shared/survey-evidence-reference'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import type { EngineeringEvidenceReference } from './engineering-conversation-drafts'
import { buildSurveyTopology } from './survey-topology'
import { surveyNetworkTypeLabel } from './engineering-task-types'
import { surveyDatumLabel } from './survey-summary'
import { surveyObservationDisplayLabel } from './survey-professional-labels'

type Point = { id: string; height?: number; x?: number; y?: number; known?: boolean; pointClass?: string }
export type ProfessionalSurveyNetwork = {
  id: string
  revision: number
  networkType: string
  coordinateSystem?: string
  verticalDatum?: string
  heightDatum?: string
  unit?: string
  knownPoints: Point[]
  unknownPoints: Point[]
  observations: Array<{ id: string; from?: string; to?: string; station?: string; target?: string; left?: string; right?: string }>
  qualityStatus: string
  sourceFile?: { name: string; sha256: string }
}
type AdjustmentBinding = { run: { id: string; networkId: string; status: string }; result: { id: string; inputHash?: string; algorithmVersion?: string } }
type Ask = (label: string, evidence?: Partial<EngineeringEvidenceReference>) => void

function number(value: number | undefined | null, language: string, digits = 6): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value !== 0 && Math.abs(value) < 10 ** -digits) return value.toExponential(Math.max(0, digits - 1))
  return value.toLocaleString(language.startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: digits })
}

function statusTone(status?: string): string {
  if (status === 'pass') return 'text-green-700 dark:text-green-300'
  if (status === 'fail') return 'text-red-700 dark:text-red-300'
  return 'text-amber-700 dark:text-amber-300'
}

function taskDimensions(networkType: string | undefined, points: Point[]): { heightOnly: boolean; xy: boolean; height: boolean } {
  const heightOnly = networkType === 'leveling' || networkType === 'height-control'
  const planeOnly = ['traverse', 'plane-control', 'triangulation', 'cpiii-free-station', 'cpiii-resection'].includes(networkType ?? '')
  return {
    heightOnly,
    xy: !heightOnly && (planeOnly || points.some(point => point.x !== undefined || point.y !== undefined)),
    height: heightOnly || !planeOnly && points.some(point => point.height !== undefined)
  }
}

function topologyLabel(id: string): string { return id.length > 26 ? `${id.slice(0, 23)}...` : id }

export function SurveyProfessionalInputs({ network, onAsk }: { network: ProfessionalSurveyNetwork | null; onAsk?: Ask }): ReactElement | null {
  const { t } = useTranslation('common')
  const dimensions = taskDimensions(network?.networkType, [...(network?.knownPoints ?? []), ...(network?.unknownPoints ?? [])])
  const topology = useMemo(() => {
    const points = [...(network?.knownPoints ?? []), ...(network?.unknownPoints ?? [])]
    // Height networks show observed connectivity, not unrelated stored XY positions.
    return buildSurveyTopology(dimensions.heightOnly ? points.map(({ x: _x, y: _y, ...point }) => point) : points, network?.observations ?? [])
  }, [network, dimensions.heightOnly])
  const diagramHeight = Math.max(230, ...topology.nodes.map((point) => point.y + 48))
  if (!network) return null
  return <section className="border-t border-ds-border-muted bg-ds-card px-4 py-4" aria-label={t('surveyProfessionalInputs')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="flex items-center gap-2 text-[13px] font-semibold"><GitBranch className="h-4 w-4 text-accent" />{t('surveyProfessionalInputs')}</h4><AskButton label={t('surveyProfessionalInputs')} onAsk={onAsk} evidence={{ section: 'network', metric: 'datum' }} /></div>
    <dl className="mt-2 grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2 lg:grid-cols-3"><Datum label={t('surveyNetworkType')} value={surveyNetworkTypeLabel(network.networkType, t)} />{dimensions.xy ? <Datum label={t('surveyCoordinateSystem')} value={surveyDatumLabel(network.coordinateSystem, t)} /> : null}{dimensions.height ? <Datum label={t('surveyHeightDatum')} value={surveyDatumLabel(network.verticalDatum ?? network.heightDatum, t)} /> : null}</dl>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="min-w-0"><p className="text-[12px] font-medium text-ds-muted">{t('surveyProfessionalNetwork')}</p><div className="mt-2 overflow-auto border border-ds-border-muted bg-ds-main"><svg viewBox={`0 0 520 ${diagramHeight}`} className="w-full min-w-[320px]" style={{ height: Math.min(300, diagramHeight) }} role="img" aria-label={t('surveyTopologyAria', { layout: topology.hasCoordinateLayout ? t('surveyCoordinateLayout') : t('surveySchematicLayout') })}><g stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5">{topology.edges.map((edge) => { const from = topology.nodes.find((point) => point.id === edge.from); const to = topology.nodes.find((point) => point.id === edge.to); return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null })}</g>{topology.nodes.map((point) => <g key={`${point.index}:${point.id}`} transform={`translate(${point.x},${point.y})`}><title>{point.id}</title><circle r="10" fill={point.known || point.pointClass === 'known' ? '#2563eb' : 'var(--ds-card, white)'} stroke="#2563eb" strokeWidth="2" /><text y="28" textAnchor={point.x < 120 ? 'start' : point.x > 400 ? 'end' : 'middle'} fontSize="11" fill="currentColor" aria-label={point.id}>{topologyLabel(point.id)}</text></g>)}</svg></div><p className="mt-1 text-[11px] text-ds-faint">{topology.hasCoordinateLayout ? t('surveyNormalizedLayout') : t('surveySchematicHint')}</p></div>
      <div className="min-w-0"><p className="text-[12px] font-medium text-ds-muted">{t('surveyKnownPoints')}</p><div role="region" tabIndex={0} aria-label={t('surveyKnownPoints')} className="mt-2 overflow-x-auto border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><table className="w-full min-w-[360px] text-left text-[12px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2">{t('surveyPointId')}</th>{dimensions.xy ? <><th className="px-3 py-2">X (m)</th><th className="px-3 py-2">Y (m)</th></> : null}{dimensions.height ? <th className="px-3 py-2">H (m)</th> : null}<th className="px-3 py-2"><span className="sr-only">{t('surveyAskAgent')}</span></th></tr></thead><tbody className="divide-y divide-ds-border-muted">{network.knownPoints.map((point) => <KnownPointRow key={point.id} point={point} dimensions={dimensions} onAsk={onAsk} />)}</tbody></table>{!network.knownPoints.length ? <p className="px-3 py-4 text-[12px] text-amber-700 dark:text-amber-300">{t('surveyProfessionalKnownMissing')}</p> : null}</div></div>
    </div>
  </section>
}

export function ProfessionalSurveyReview({ projectId, projectRevision, network, adjustment, runtimeReady, onAsk, onViewDelivery }: {
  projectId: string
  projectRevision: number
  network: ProfessionalSurveyNetwork | null
  adjustment: AdjustmentBinding | null
  runtimeReady: boolean
  onAsk?: Ask
  onViewDelivery?: () => void
}): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [loaded, setLoaded] = useState<{ binding: string; review: SurveyProfessionalReviewV1 } | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [retry, setRetry] = useState(0)
  const binding = JSON.stringify([projectId, network?.id, network?.revision, adjustment?.run.id, adjustment?.result.id, adjustment?.result.inputHash, adjustment?.result.algorithmVersion])
  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    if (!runtimeReady || !adjustment || !network || adjustment.run.networkId !== network.id) { setLoadState('idle'); return }
    setLoadState('loading')
    void rendererRuntimeClient.runtimeRequest(`/v1/engineering/adjustments/${encodeURIComponent(adjustment.run.id)}/professional-review`, 'GET').then((response) => {
      if (!response.ok) throw new Error('unavailable')
      const parsed = SurveyProfessionalReviewV1.safeParse((JSON.parse(response.body) as { review?: unknown }).review)
      if (!parsed.success) throw new Error('invalid')
      const value = parsed.data
      if (value.projectId !== projectId || value.networkId !== network.id || value.runId !== adjustment.run.id || value.resultId !== adjustment.result.id
        || value.source.status === 'bound' && (value.source.networkRevision !== network.revision || value.source.sha256 !== network.sourceFile?.sha256)
        || adjustment.result.inputHash && value.inputHash !== adjustment.result.inputHash
        || adjustment.result.algorithmVersion && value.algorithmVersion !== adjustment.result.algorithmVersion) throw new Error('mismatch')
      if (!cancelled) { setLoaded({ binding, review: value }); setLoadState('idle') }
    }).catch(() => { if (!cancelled) setLoadState('unavailable') })
    return () => { cancelled = true }
  }, [binding, projectId, network, adjustment, runtimeReady, retry])
  const review = runtimeReady && loaded?.binding === binding ? loaded.review : null
  const dimensions = taskDimensions(review ? review.summary.networkType : network?.networkType, review?.points ?? [])
  const observationUnits = [...new Set(review?.observations.flatMap(observation => observation.unit ? [observation.unit] : []) ?? [])]
  const observationUnitLabel = observationUnits.join(' / ')
  const reasonText = (reason?: SurveyProfessionalReasonV1): string => reason ? t(`surveyProfessionalReason.${reason}`) : t('surveyProfessionalNotEvaluated')
  const canDraft = Boolean(review && adjustment?.run.status === 'completed' && review.summary.validation === 'valid' && review.source.status === 'bound' && review.source.integrity === 'verified')
  const failureCount = review?.checks.filter((check) => check.status === 'fail').length ?? 0
  const professionalEvidence = (path: Array<string | number>, id: string, extra: Partial<EngineeringEvidenceReference> = {}): Partial<EngineeringEvidenceReference> => {
    if (!review || review.source.status !== 'bound' || !review.source.networkRevision || !review.source.sha256) return {}
    const parsed = SurveyEvidenceReferenceV1.safeParse({
      schemaVersion: 1, kind: 'professional-review', projectId, projectRevision, networkId: review.networkId,
      networkRevision: review.source.networkRevision, sourceSha256: review.source.sha256, adjustmentId: review.runId,
      resultId: review.resultId, inputHash: review.inputHash, resultHash: review.resultHash,
      projectionHash: review.projectionHash, projectionVersion: review.projectionVersion,
      selector: { path, identity: { id } }
    })
    return parsed.success ? { section: 'result', typedEvidence: parsed.data, ...extra } : {}
  }
  const explain = onAsk && review?.source.status === 'bound' ? onAsk : undefined

  return <section className="survey-professional-review mt-4 bg-ds-card" aria-label={t('surveyProfessionalTitle')}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ds-border-muted py-3"><div><h3 className="flex items-center gap-2 text-[15px] font-semibold text-ds-ink"><ClipboardCheck className="h-4 w-4 text-accent" />{t('surveyProfessionalTitle')}</h3><p className="mt-1 text-[12px] text-ds-muted">{t('surveyProfessionalUnsigned')}</p></div>{onViewDelivery ? <button type="button" onClick={onViewDelivery} disabled={!canDraft} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-[13px] font-semibold text-white disabled:opacity-50"><FileOutput className="h-4 w-4" />{t('surveyProfessionalDraft')}</button> : null}</div>
    {!review ? <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 border-b border-ds-border-muted py-4 text-[12px] text-ds-muted"><span>{!runtimeReady ? t('surveyProfessionalOffline') : loadState === 'loading' ? t('surveyProfessionalLoading') : !adjustment ? t('surveyProfessionalAwaitCalculation') : t('surveyProfessionalUnavailable')}</span>{runtimeReady && adjustment && loadState === 'unavailable' ? <button type="button" onClick={() => setRetry(value => value + 1)} className="inline-flex min-h-11 items-center gap-2 px-3 text-accent"><RefreshCw className="h-4 w-4" />{t('surveyProfessionalRetry')}</button> : null}</div> : <>
      <div className="grid gap-x-6 gap-y-3 border-b border-ds-border-muted py-4 sm:grid-cols-2 lg:grid-cols-4"><Summary label={t('surveyProfessionalCalculation')} value={review.summary.validation === 'valid' ? t('surveyProfessionalCalculated') : t('surveyProfessionalFailed')} /><Summary label={t('surveyProfessionalChecks')} value={failureCount ? t('surveyProfessionalFailureCount', { count: failureCount }) : t('surveyProfessionalNeedsReview')} /><Summary label={t('surveyProfessionalPrecisionBasis')} value={t(`surveyProfessionalVariance.${review.summary.varianceBasis}`)} /><Summary label={t('surveyProfessionalStandards')} value={t('surveyProfessionalNotEvaluated')} /></div>
      <SurveyProfessionalInputs network={review.source.status === 'bound' ? network : null} onAsk={onAsk} />
      <dl className="grid gap-x-6 gap-y-3 border-t border-ds-border-muted py-4 text-[12px] sm:grid-cols-2 lg:grid-cols-4">{dimensions.xy && review.reference.projection ? <Datum label={t('surveyProfessionalProjection')} value={review.reference.projection} /> : null}{dimensions.xy && review.reference.ellipsoid ? <Datum label={t('surveyProfessionalEllipsoid')} value={review.reference.ellipsoid} /> : null}{dimensions.xy && review.reference.centralMeridian !== undefined ? <Datum label={t('surveyProfessionalCentralMeridian')} value={number(review.reference.centralMeridian, i18n.language)} /> : null}<Datum label={t('surveyUnit')} value={dimensions.heightOnly ? review.reference.linearUnit : observationUnitLabel || review.reference.linearUnit} /></dl>
      <Section title={t('surveyProfessionalChecks')} icon={<Info className="h-4 w-4" />}>
        <div className="divide-y divide-ds-border-muted">{review.checks.map((check, index) => <div key={check.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"><p className="min-w-28 text-[12px] font-medium">{t(`surveyProfessionalCheck.${check.id}`)}</p><Status status={check.status} /><p className="min-w-0 flex-1 text-[12px] text-ds-muted">{check.reason ? reasonText(check.reason) : ''}</p><AskButton label={t(`surveyProfessionalCheck.${check.id}`)} onAsk={explain} evidence={professionalEvidence(['checks', index], check.id, { metric: `professional-check:${check.id}` })} requireTyped /></div>)}</div>
      </Section>
      <Section title={t('surveyProfessionalClosure')} icon={<GitBranch className="h-4 w-4" />}>
        {review.closures.length ? <Table label={t('surveyProfessionalClosure')}><thead className="bg-ds-subtle text-ds-muted"><tr><th>{t('surveyProfessionalRoute')}</th><th>{t('surveyProfessionalObservedSum')} (m)</th><th>{t('surveyProfessionalKnownDifference')} (m)</th><th>{t('surveyProfessionalMisclosure')} (mm)</th><th>{t('surveyProfessionalTolerance')} (mm)</th><th>{t('surveyProfessionalStatus')}</th><th>{t('surveyAskAgent')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{review.closures.map((closure, index) => <tr key={closure.id} data-professional-closure={closure.id}><td><p className="font-medium">{closure.from} → {closure.to}</p><p className="text-[11px] text-ds-muted">{t(closure.kind === 'loop' ? 'surveyProfessionalLoop' : 'surveyProfessionalAttached')} · {closure.members.length} {t('surveyObservations')}</p></td><td className="tabular-nums">{number(closure.sumObservedMetres, i18n.language)}</td><td className="tabular-nums">{number(closure.knownHeightDifferenceMetres, i18n.language)}</td><td className="tabular-nums">{number(closure.misclosureMetres * 1000, i18n.language, 3)}</td><td className="tabular-nums">{number(closure.toleranceMetres === undefined ? undefined : closure.toleranceMetres * 1000, i18n.language, 3)}</td><td><Status status={closure.status} />{closure.reason ? <p className="mt-1 max-w-56 whitespace-normal text-[11px] text-ds-muted">{reasonText(closure.reason)}</p> : null}</td><td><AskButton label={`${t('surveyProfessionalClosure')} ${closure.from} → ${closure.to}`} onAsk={explain} evidence={professionalEvidence(['closures', index], closure.id, { metric: `professional-closure:${closure.id}`, observationId: closure.members[0]?.observationId, sourceRecordId: closure.members[0]?.sourceRecordId })} requireTyped /></td></tr>)}</tbody></Table> : <p className="py-3 text-[12px] text-ds-muted">{reasonText(review.checks.find(check => check.id === 'closure')?.reason)}</p>}
      </Section>
      <Section title={t('surveyProfessionalResidualNorms')} icon={<Info className="h-4 w-4" />}>
        <p className="text-[12px] text-ds-muted">{t('surveyProfessionalClosureVsResidual')}</p><dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">{review.residualNorms.map((norm) => <div key={norm.unit} className="flex gap-3 text-[12px]"><dt className="text-ds-muted">{t(norm.unit === 'rad' ? 'surveyAngularNorm' : 'surveyProfessionalLinearNorm')}</dt><dd className="font-medium tabular-nums">{number(norm.value, i18n.language, 8)} {norm.unit}</dd></div>)}</dl>
      </Section>
      <Section title={t('surveyProfessionalObservations')} icon={<AlertTriangle className="h-4 w-4" />}>
        <Table label={t('surveyProfessionalObservations')}><thead className="bg-ds-subtle text-ds-muted"><tr><th>{t('surveyObservationId')}</th><th>{t('surveyStationTarget')}</th><th>{dimensions.heightOnly ? t('surveyProfessionalObservedHeightDifference') : `${t('surveyProfessionalObserved')}${observationUnitLabel ? ` (${observationUnitLabel})` : ''}`}</th><th>{dimensions.heightOnly ? t('surveyProfessionalAdjustedHeightDifference') : `${t('surveyProfessionalAdjusted')}${observationUnitLabel ? ` (${observationUnitLabel})` : ''}`}</th><th>{dimensions.heightOnly ? t('surveyCorrection', { unit: 'mm' }) : `${t('surveyProfessionalCorrection')}${observationUnitLabel ? ` (${observationUnitLabel})` : ''}`}</th>{!dimensions.heightOnly ? <th>{t('surveyUnit')}</th> : null}<th>{t('surveyProfessionalScreening')}</th><th>{t('surveyAskAgent')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{review.observations.map((observation, index) => <tr key={observation.id} data-professional-observation={observation.observationId}><td className="font-medium">{surveyObservationDisplayLabel({ ...observation, sequence: index + 1 }, i18n.language)}{observation.component ? ` · ${observation.component.toUpperCase()}` : ''}</td><td>{observation.from ?? '—'} → {observation.to ?? '—'}</td><td className="tabular-nums">{number(observation.observed, i18n.language, 8)}</td><td className="tabular-nums">{number(observation.adjusted, i18n.language, 8)}</td><td className="tabular-nums">{number(dimensions.heightOnly ? observation.unit === 'm' ? observation.correction * 1000 : undefined : observation.correction, i18n.language, dimensions.heightOnly ? 3 : 8)}</td>{!dimensions.heightOnly ? <td>{observation.unit ?? '—'}</td> : null}<td className={observation.outlierCandidate ? 'text-amber-700 dark:text-amber-300' : 'text-ds-muted'}>{observation.outlierCandidate ? t('surveyProfessionalOutlierCandidate') : observation.screeningStatus === 'available' ? t('surveyProfessionalScreened') : t('surveyProfessionalNotEvaluated')}</td><td><AskButton label={surveyObservationDisplayLabel({ ...observation, sequence: index + 1 }, i18n.language)} onAsk={explain} evidence={professionalEvidence(['observations', index], observation.id, { metric: 'professional-observation', observationId: observation.observationId, sourceRecordId: observation.sourceRecordId })} requireTyped /></td></tr>)}</tbody></Table>
      </Section>
      <Section title={t('surveyProfessionalPrecision')} icon={<CheckCircle2 className="h-4 w-4" />}>
        <dl className="grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4"><Datum label={t('surveyProfessionalDegreesFreedom')} value={review.summary.degreesOfFreedom} /><Datum label={t('surveyProfessionalSigma0')} value={number(review.summary.unitWeightStdDev, i18n.language, 8)} /><Datum label={t('surveyProfessionalVarianceFactor')} value={number(review.summary.varianceFactor, i18n.language, 8)} /><Datum label={t('surveyProfessionalWeakestPoint')} value={review.weakestPoint.status === 'available' ? `${review.weakestPoint.pointId} · ${number((review.weakestPoint.standardErrorMetres ?? 0) * 1000, i18n.language, 3)} mm` : reasonText(review.weakestPoint.reason)} /></dl>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4"><Datum label={t('surveyProfessionalSolverRank')} value={review.solver?.rankStatus === 'available' ? `${review.solver.rank} / ${review.solver.parameterCount}` : t('surveyProfessionalNotEvaluated')} /><Datum label={t('surveyProfessionalDatumDefect')} value={review.solver?.datumDefect === undefined ? t('surveyProfessionalNotEvaluated') : review.solver.datumDefect} /><Datum label={t('surveyProfessionalDatumConstraint')} value={review.solver?.constraint ? t(`surveyProfessionalConstraint.${review.solver.constraint}`) : t('surveyProfessionalNotEvaluated')} /><Datum label={t('surveyProfessionalDatumStatusLabel')} value={review.solver?.datumStatus ? t(`surveyProfessionalDatumStatus.${review.solver.datumStatus}`) : t('surveyProfessionalNotEvaluated')} /></dl>
        <p className="mt-3 text-[12px] text-ds-muted">{t('surveyProfessionalDatumDefectBasis')}</p><p className="mt-1 text-[12px] text-ds-muted">{t('surveyProfessionalWeakestCriterion')}</p><p className="mt-1 text-[12px] text-ds-muted">{t('surveyProfessionalWeakestEdge')}: {reasonText(review.weakestEdge.reason)}</p>
      </Section>
      <Section title={t('surveyPointResults')} icon={<ClipboardCheck className="h-4 w-4" />}>
        <Table label={t('surveyPointResults')}><thead className="bg-ds-subtle text-ds-muted"><tr><th>{t('surveyPointId')}</th><th>{t('surveyRole')}</th>{dimensions.xy ? <><th>X (m)</th><th>Y (m)</th></> : null}{dimensions.height ? <th>H (m)</th> : null}{dimensions.xy ? <><th>{t('surveyProfessionalXCorrection')}</th><th>{t('surveyProfessionalYCorrection')}</th></> : null}{dimensions.height ? <th>{t('surveyProfessionalHeightCorrection')}</th> : null}<th>{dimensions.heightOnly ? t('surveyProfessionalHeightError') : `${t('surveyProfessionalPointError')} (mm)`}</th><th>{t('surveyProfessionalPrecisionBasis')}</th>{dimensions.xy ? <th>{t('surveyErrorEllipse')} (mm)</th> : null}<th>{t('surveyAskAgent')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{review.points.map((point, index) => <tr key={point.id} data-professional-point={point.id}><td className="font-medium">{point.id}</td><td>{t(`surveyProfessionalRole.${point.role}`)}</td>{dimensions.xy ? <><td className="tabular-nums">{number(point.x, i18n.language)}</td><td className="tabular-nums">{number(point.y, i18n.language)}</td></> : null}{dimensions.height ? <td className="tabular-nums">{number(point.height, i18n.language)}</td> : null}{dimensions.xy ? <><td className="tabular-nums">{number(point.correctionX === undefined ? undefined : point.correctionX * 1000, i18n.language, 3)}</td><td className="tabular-nums">{number(point.correctionY === undefined ? undefined : point.correctionY * 1000, i18n.language, 3)}</td></> : null}{dimensions.height ? <td className="tabular-nums">{number(point.correctionHeight === undefined ? undefined : point.correctionHeight * 1000, i18n.language, 3)}</td> : null}<td className="tabular-nums">{number(point.standardError === undefined ? undefined : point.standardError * 1000, i18n.language, 3)}</td><td>{point.precisionBasis === 'not-recorded' ? t('surveyProfessionalNotEvaluated') : t(`surveyProfessionalVariance.${point.precisionBasis}`)}</td>{dimensions.xy ? <td className="tabular-nums">{point.xyErrorEllipse ? <><p>{number(point.xyErrorEllipse.semiMajor * 1000, i18n.language, 3)} / {number(point.xyErrorEllipse.semiMinor * 1000, i18n.language, 3)}</p><p className="mt-1 text-[11px] text-ds-muted">{t('surveyErrorEllipseOrientation', { angle: point.xyErrorEllipse.orientationRad === null ? t('surveyErrorEllipseNoOrientation') : `${number(point.xyErrorEllipse.orientationRad * 180 / Math.PI, i18n.language, 4)}°` })}</p></> : '—'}</td> : null}<td><AskButton label={point.id} onAsk={explain} evidence={professionalEvidence(['points', index], point.id, { metric: 'professional-point', pointId: point.id })} requireTyped /></td></tr>)}</tbody></Table>
      </Section>
    </>}
  </section>
}

function KnownPointRow({ point, dimensions, onAsk }: { point: Point; dimensions: ReturnType<typeof taskDimensions>; onAsk?: Ask }): ReactElement { const { i18n } = useTranslation('common'); return <tr><td className="px-3 py-2 font-medium">{point.id}</td>{dimensions.xy ? <><td className="px-3 py-2 tabular-nums">{number(point.x, i18n.language)}</td><td className="px-3 py-2 tabular-nums">{number(point.y, i18n.language)}</td></> : null}{dimensions.height ? <td className="px-3 py-2 tabular-nums">{number(point.height, i18n.language)}</td> : null}<td className="px-3 py-2"><AskButton label={point.id} onAsk={onAsk} evidence={{ section: 'points', pointId: point.id, metric: 'known-point' }} /></td></tr> }
function AskButton({ label, onAsk, evidence, requireTyped = false }: { label: string; onAsk?: Ask; evidence?: Partial<EngineeringEvidenceReference>; requireTyped?: boolean }): ReactElement { const { t } = useTranslation('common'); const enabled = Boolean(onAsk && (!requireTyped || evidence?.typedEvidence)); return <button type="button" disabled={!enabled} aria-label={t('surveyAskEvidence', { label })} title={t('surveyAskEvidence', { label })} onClick={() => { if (enabled) onAsk?.(label, evidence) }} className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap px-2 text-[12px] font-medium text-accent hover:bg-ds-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><Bot aria-hidden="true" className="h-4 w-4 shrink-0" />{t('surveyProfessionalExplain')}</button> }
function Datum({ label, value }: { label: string; value?: string | number }): ReactElement { return <div className="min-w-0"><dt className="text-ds-muted">{label}</dt><dd className="mt-1 break-words font-medium text-ds-ink">{value === undefined || value === '' ? '—' : value}</dd></div> }
function Status({ status }: { status?: string }): ReactElement { const { t } = useTranslation('common'); return <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${statusTone(status)}`}>{status === 'pass' ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Info aria-hidden="true" className="h-3.5 w-3.5" />}{t(status === 'pass' ? 'surveyProfessionalPassed' : status === 'fail' ? 'surveyProfessionalFailed' : 'surveyProfessionalNotEvaluated')}</span> }
function Summary({ label, value }: { label: string; value: string }): ReactElement { return <div><p className="text-[12px] text-ds-muted">{label}</p><p className="mt-1 text-[13px] font-medium text-ds-ink">{value}</p></div> }
function Section({ title, icon, children }: { title: string; icon: ReactElement; children: ReactNode }): ReactElement { return <section className="border-t border-ds-border-muted py-4"><h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ds-ink"><span className="text-accent">{icon}</span>{title}</h4>{children}</section> }
function Table({ label, children }: { label: string; children: ReactNode }): ReactElement { return <div role="region" tabIndex={0} aria-label={label} className="overflow-x-auto border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><table className="w-full min-w-[700px] text-left text-[12px] [&_td]:whitespace-nowrap [&_td]:px-3 [&_td]:py-2 [&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold">{children}</table></div> }
