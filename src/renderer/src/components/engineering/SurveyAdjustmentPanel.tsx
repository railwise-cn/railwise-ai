import { SurveyFreeLevelingTrial } from './SurveyFreeLevelingTrial'
import { surveyDiagnosticText, surveyLegacyDiagnosticText, surveyRuntimeErrorText, type SurveyDiagnosticText } from './survey-diagnostic-text'
import { surveyDatumLabel, surveyStatusLabel } from './survey-summary'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import appI18n from '../../i18n'
import { Activity, AlertTriangle, Bot, CheckCircle2, CircleDot, Compass, FileCode2, FileUp, GitBranch, Grid3X3, Play, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { buildSurveyTopology } from './survey-topology'
import { SURVEY_FILE_ACCEPT } from './survey-file-selection'
import { useEngineeringConversationDrafts, prepareEngineeringQuestion, type EngineeringEvidenceReference } from './engineering-conversation-drafts'
import { CosaIn1MappingForm, type CosaIn1Mapping } from './CosaIn1MappingForm'
import { parseSurveyKnownPoints } from './survey-known-points'
import { surveyImportKey } from './survey-import-identity'
import { surveyNetworkTypeLabel } from './engineering-task-types'
import { SurveyStatisticalDiagnostics } from './SurveyStatisticalDiagnostics'
import type { SurveyStatisticalBinding } from '../../agent/survey-statistics-client'
import { focusEvidenceElement, type SurveyEvidenceNavigationTarget } from './engineering-evidence-navigation'
import { EngineeringEvidenceQuestion, EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'

type Project = { id: string; revision: number; workspace?: string; taskType?: string }
type SurveySection = 'network' | 'observations' | 'points' | 'result' | 'deformation' | 'free-trial'
type SurveyPoint = { id: string; pointClass?: string; x?: number; y?: number; height?: number; latitude?: number; longitude?: number; known?: boolean }
type SurveyObservation = { id: string; type?: string; from?: string; to?: string; station?: string; target?: string; left?: string; right?: string; value?: number; unit?: string; vectorX?: number; vectorY?: number; vectorZ?: number; covariance?: number[]; sigma?: number; sigmaUnit?: string; stationHeightOffset?: number; targetHeightOffset?: number; distance?: number; direction?: number; sourceRecordId?: string }
type SurveyImportDisposition = 'adjustment-ready' | 'gnss-processing-required' | 'converter-required' | 'archive-only'
type RawSourceIntegrity = { status: 'verified' | 'legacy-unverified' | 'failed'; ledgerEntryCount: number; errors: string[] }
type SourceEligibilityFinding = SurveyDiagnosticText & { code?: string; severity?: string; message?: string; suggestion?: string }
type SourceEligibility = { eligible: boolean; findings?: SourceEligibilityFinding[] }
type NetworkWithRawSourceIntegrity = Network & { rawSourceIntegrity?: RawSourceIntegrity; sourceEligibility?: SourceEligibility }
type RawRecordAnchor = {
  id: string
  sourceRecord?: number
  rawOffset?: number
  rawLength?: number
  rawLineNo?: number
  /** Legacy aliases remain display-only; residual tracing requires rawOffset/rawLength. */
  line?: number
  byteOffset?: number
  byteLength?: number
  section?: string
  recordType?: string
  rawSnippet?: string
}
type SurveySourceFile = {
  name: string
  size: number
  sha256: string
  originalPreserved: true
  /** Optional flattened provenance fields keep old persisted source records readable. */
  formatId?: string
  vendor?: string
  formatVersion?: string | null
  detectionMethod?: string
  detectionConfidence?: number
  extensionClaimed?: string | null
  extensionContentConflict?: boolean
  requiresManualConfirmation?: boolean
  dispositionReason?: string
  dispositionReasonEn?: string
  parserSourceHash?: string
  converterId?: string
  converterVersion?: string
  converterBinaryHash?: string
  linearUnitRaw?: string
  angularUnitRaw?: string
  linearUnitCanonical?: string
  angularUnitCanonical?: string
  datumDeclared?: string | null
  heightSystemDeclared?: string | null
  summary?: { pointCount?: number; stationCount?: number; observationCount?: number; recordCount?: number; skippedRecordCount?: number }
  detection: { format: string; vendor: string; version?: string; method?: string; confidence: number; extension?: string; matchedSignatures: string[]; extensionConflict: boolean }
  disposition: SurveyImportDisposition
  parserId: string
  parserVersion: string
  recordCount: number
  diagnostics: Array<SurveyDiagnosticText & { code: string; severity: 'info' | 'warning' | 'blocking'; message: string; suggestedAction?: string; sourceRecord?: number; byteOffset?: number }>
  /** Canonical source-record index. Old Runtime records only have rawRecordAnchors. */
  records?: RawRecordAnchor[]
  rawRecordAnchors: RawRecordAnchor[]
  converter?: { id: string; version: string; license: string; executableHash: string; inputHash: string; outputHash?: string; networkAccess: 'none'; arguments: string[]; status: 'passed' | 'blocked' }
}
type CosaFileGroupMemberKind = 'in1' | 'in2' | 'net' | 'xyo' | 'ou1' | 'ou2'
type CosaFileGroupInspection = {
  groups: Array<{
    id: string
    normalizedStem: string
    normalizedDirectory: string
    state: 'ready' | 'blocked'
    members: Record<CosaFileGroupMemberKind, Array<{ name: string; sha256: string; size: number }>>
    diagnostics: Array<SurveyDiagnosticText & { code: string; severity: 'blocking'; message: string; suggestedAction: string; memberKind: CosaFileGroupMemberKind }>
  }>
  diagnostics: Array<SurveyDiagnosticText & { code: string; severity: 'blocking'; message: string; suggestedAction: string; memberKind: CosaFileGroupMemberKind }>
}
type Network = { id: string; revision: number; networkType: string; transformType?: string; coordinateSystem?: string; verticalDatum?: string; heightDatum?: string; knownPoints: SurveyPoint[]; unknownPoints: SurveyPoint[]; observations: SurveyObservation[]; qualityStatus: string; sourceFile?: SurveySourceFile; findings: Array<SurveyDiagnosticText & { code?: string; severity: string; message: string; row?: number }> }
type Adjustment = { observationEpoch?: string; networkType?: string; coordinateSystem?: string; verticalDatum?: string; /** Current, server-recomputed admission state; history without it must not power a new computation. */ rawSourceIntegrity?: RawSourceIntegrity; sourceEligibility?: SourceEligibility; run: { id: string; networkId: string; status: string; revision: number; createdAt?: string }; result: { id: string; validation: string; strategyId?: string; transformType?: string; algorithmVersion?: string; observationCount: number; unknownCount: number; redundancy: number; linearUnit?: 'm'; angularUnit?: 'rad'; unitWeightStdDev: number; unitWeightStdDevUnit?: 'dimensionless'; varianceFactor?: number; varianceFactorUnit?: 'dimensionless'; varianceFactorEstimated?: boolean; degreesOfFreedom?: number; closure?: { horizontal?: number; angular?: number; vertical?: number; heightDifference?: number; fx?: number; fy?: number; relativeClosure?: number; baseline?: number; baselineX?: number; baselineY?: number; baselineZ?: number; translationX?: number; translationY?: number; scalePpm?: number; rotationRad?: number }; closureUnits?: Record<string, 'm' | 'rad' | 'ppm' | 'ratio'>; parameters?: Record<string, number>; parameterUnits?: Record<string, 'm' | 'rad' | 'ppm' | 'ratio'>; precision: { maxPointStdDev: number; relativePrecision?: number; passed: boolean }; qualityFindings: Array<SurveyDiagnosticText & { severity: string; message: string }>; covariance?: number[][]; points?: Array<{ id: string; x?: number; y?: number; height?: number; latitude?: number; longitude?: number; correctionX?: number; correctionY?: number; correctionHeight?: number; standardError?: number; xyErrorEllipse?: { semiMajor: number; semiMinor: number; orientationRad: number | null; varianceBasis: 'a-priori' | 'a-posteriori' } }>; observations?: Array<{ observationId: string; correction?: number; residual: number; unit?: 'm' | 'rad'; standardizedResidual?: number; standardizedResidualUnit?: 'sigma'; outlier?: boolean; sourceRow?: number; /** Immutable raw-source anchor inherited from the adjusted observation. */ sourceRecordId?: string }> } }
type Deformation = { id: string; referenceAdjustmentId: string; currentAdjustmentId: string; referenceEpoch: string; currentEpoch: string; durationDays: number; algorithmVersion: string; inputHash: string; points: Array<{ pointId: string; dX?: number; dY?: number; dH?: number; settlement?: number; horizontalDisplacement?: number; spatialDisplacement: number; rates: { spatialPerDay: number }; trend: string; significant?: boolean; unit: 'm'; rateUnit: 'm/day' }>; pairs: Array<{ id: string; kind: 'tilt' | 'convergence'; firstPointId: string; secondPointId: string; convergence?: number; convergenceRatePerDay?: number; differentialSettlement?: number; tilt?: number; linearUnit: 'm'; rateUnit: 'm/day'; tiltUnit: 'ratio' }> }

/** A completed result remains visible for audit, but can only feed a new calculation after a current server admission check. */
function isAdmissibleCompletedAdjustment(adjustment: Adjustment): boolean {
  return adjustment.run.status === 'completed'
    && adjustment.result.validation === 'valid'
    && adjustment.sourceEligibility?.eligible === true
}

function isComparableEpoch(adjustment: Adjustment): boolean {
  return isAdmissibleCompletedAdjustment(adjustment) && Boolean(adjustment.observationEpoch)
}

const WORKWISE_SURVEY_SOURCE_FORMAT = 'workwise-survey-network'
const WORKWISE_SURVEY_SOURCE_FORMAT_VERSION = 1
const COSA_GROUP_MEMBER_PATTERN = /\.(?:in1|in2|net|xyo|ou1|ou2)$/i

const sampleNetwork = JSON.stringify({
  format: WORKWISE_SURVEY_SOURCE_FORMAT,
  formatVersion: WORKWISE_SURVEY_SOURCE_FORMAT_VERSION,
  network: {
    networkType: 'leveling',
    coordinateSystem: 'LOCAL-ENGINEERING',
    verticalDatum: 'PROJECT-HEIGHT-DATUM',
    unit: 'm',
    knownPoints: [{ id: 'BM-01', pointClass: 'known', height: 100, known: true }],
    unknownPoints: [{ id: 'P-01', pointClass: 'unknown', height: 100.2, known: false }],
    observations: [{ id: 'obs-1', type: 'height-difference', from: 'BM-01', to: 'P-01', value: 0.2, unit: 'm', sigma: 0.002, sigmaUnit: 'm' }]
  }
}, null, 2)

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body))
  if (!response.ok) throw new Error(response.body || `Runtime request failed (${response.status})`)
  return JSON.parse(response.body) as T
}

export function numberLabel(value: number | undefined, digits = 4): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value !== 0 && Math.abs(value) < 10 ** -digits) {
    return value.toExponential(Math.max(0, digits - 1)).replace(/\.0+(?=e)/, '')
  }
  return value.toLocaleString(appI18n.language.startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: digits })
}

function measurementLabel(t: TFunction, value: number | undefined, unit: string | undefined, digits = 4): string {
  const number = numberLabel(value, digits)
  return number === '—' ? number : `${number} ${unit ?? t('surveyUnitMissing')}`
}

function observationValueLabel(observation: SurveyObservation): string {
  if (observation.type === 'gnss-baseline' && observation.vectorX !== undefined && observation.vectorY !== undefined && observation.vectorZ !== undefined) {
    return `ΔX ${numberLabel(observation.vectorX, 6)} · ΔY ${numberLabel(observation.vectorY, 6)} · ΔZ ${numberLabel(observation.vectorZ, 6)}`
  }
  return numberLabel(observation.value, 6)
}

function pointLabel(t: TFunction, point: SurveyPoint): string {
  return point.known || point.pointClass === 'known' ? t('surveyKnown') : t('surveyUnknown')
}


function sourceFormatLabel(t: TFunction, value: string): string {
  return ({
    'workwise-json': t('surveyStructuredJson'), 'delimited-text': t('surveyDelimitedText'), xlsx: 'Excel OOXML',
    'leica-gsi8': 'Leica GSI-8', 'leica-gsi16': 'Leica GSI-16', 'leica-hexml': 'Leica HeXML',
    'trimble-jobxml': 'Trimble JobXML / JXL', 'trimble-m5': 'Trimble / Zeiss M5',
    'tds-raw': 'TDS RAW', 'carlson-rw5': 'Carlson RW5', 'sokkia-sdr': 'Sokkia SDR2x / SDR33',
    'topcon-gts7': 'Topcon GTS-7', 'topcon-fc5': 'Topcon FC-5', 'nikon-raw': 'Nikon RAW', 'spectra-survey-pro': 'Spectra Survey Pro', landxml: 'LandXML', 'survey-cloud-suc': t('surveySucArchive'),
    'rinex-observation': t('surveyRinexObservation'), 'rinex-navigation': t('surveyRinexNavigation'), 'rinex-meteorological': t('surveyRinexMeteorological'), 'rinex-clock': t('surveyRinexClock'), 'hatanaka-rinex': 'Hatanaka / CRINEX',
    sinex: 'SINEX', 'nmea-0183': 'NMEA 0183', rtcm2: 'RTCM 2', rtcm3: 'RTCM 3', sp3: t('surveySp3'), ionex: 'IONEX', antex: 'ANTEX',
    'ublox-ubx': 'u-blox UBX', 'novatel-oem': 'NovAtel OEM', 'septentrio-sbf': 'Septentrio SBF', binex: 'BINEX', 'javad-jps': 'Javad JPS', 'topcon-tps': 'Topcon TPS',
    'south-sth': t('surveySouth'), 'hitarget-zhd': t('surveyHitarget'), 'chcnav-hcn': t('surveyChcnav'), 'comnav-cnb': t('surveyComnav'),
    'trimble-t00': 'Trimble T00', 'trimble-t01': 'Trimble T01', 'trimble-t02': 'Trimble T02', 'trimble-t04': 'Trimble T04', 'trimble-job': 'Trimble JOB', 'leica-dbx': 'Leica DBX', 'leica-mdb': 'Leica MDB', unknown: t('surveyUnknownFormat')
  } as Record<string, string>)[value] ?? value
}

function detectionMethodLabel(t: TFunction, value: string | undefined): string {
  if (!value) return t('surveyLegacyMissing')
  return ({
    'content-signature': t('surveyContentSignature'),
    'structural-probe': t('surveyStructuralProbe'),
    'extension-fallback': t('surveyExtensionFallback')
  } as Record<string, string>)[value] ?? value
}

function dispositionLabel(t: TFunction, value: SurveyImportDisposition): string {
  return ({
    'adjustment-ready': t('surveyDispositionReady'),
    'gnss-processing-required': t('surveyDispositionGnss'),
    'converter-required': t('surveyDispositionConverter'),
    'archive-only': t('surveyDispositionArchive')
  } as Record<SurveyImportDisposition, string>)[value]
}

function dispositionTone(value: SurveyImportDisposition): string {
  if (value === 'adjustment-ready') return 'border-green-200 bg-green-50 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300'
  if (value === 'archive-only') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
  return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
}

function dispositionRecovery(t: TFunction, value: SurveyImportDisposition): string {
  return ({
    'adjustment-ready': t('surveyRecoveryReady'),
    'gnss-processing-required': t('surveyRecoveryGnss'),
    'converter-required': t('surveyRecoveryConverter'),
    'archive-only': t('surveyRecoveryArchive')
  } as Record<SurveyImportDisposition, string>)[value]
}

function canonicalUnitLabel(t: TFunction, value: string | undefined): string {
  if (!value) return t('surveyLegacyMissing')
  return value === 'unverified' ? t('surveyUnitUnverified') : value
}

type ResidualSourceAnchorResolution =
  | { status: 'exact'; sourceRecordId: string; anchor: RawRecordAnchor }
  | { status: 'unavailable'; sourceRecordId: string; reason: string }

/**
 * The Runtime emits `records` as the canonical index and keeps
 * `rawRecordAnchors` as a compatibility alias. A residual may only claim a
 * location when one, and only one, source record supplies an exact byte range.
 */
function resolveResidualSourceAnchor(t: TFunction, source: SurveySourceFile | undefined, sourceRecordId: string): ResidualSourceAnchorResolution {
  if (!source) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorNoSource') }
  }
  const anchors = source.records?.length ? source.records : source.rawRecordAnchors
  const sourceRecordCount = Math.max(source.records?.length ?? 0, source.rawRecordAnchors.length)
  const matches = anchors.filter((anchor) => anchor.id === sourceRecordId)
  if (matches.length === 0) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorMissing') }
  }
  if (matches.length > 1) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorAmbiguous') }
  }
  const anchor = matches[0]!
  const rawOffset = anchor.rawOffset
  const rawLength = anchor.rawLength
  if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0 || typeof rawLength !== 'number' || !Number.isInteger(rawLength) || rawLength <= 0) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorNoRange') }
  }
  if (!Number.isInteger(source.size) || source.size < 0 || rawOffset + rawLength > source.size) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorOutOfBounds') }
  }
  if (sourceRecordCount > 1 && rawOffset === 0 && rawLength >= source.size) {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorWholeFile') }
  }
  if (typeof anchor.rawSnippet !== 'string') {
    return { status: 'unavailable', sourceRecordId, reason: t('surveyAnchorNoSnippet') }
  }
  return { status: 'exact', sourceRecordId, anchor }
}

function Stat({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail: string; tone?: 'neutral' | 'good' | 'warn' | 'danger' }): ReactElement {
  const color = tone === 'good' ? 'text-green-700 dark:text-green-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'danger' ? 'text-red-700 dark:text-red-300' : 'text-ds-ink'
  return <div className="border border-ds-border-muted bg-ds-main px-3 py-2.5"><p className="text-[10px] text-ds-faint">{label}</p><p className={`mt-0.5 tabular-nums text-[17px] font-semibold ${color}`}>{value}</p><p className="mt-0.5 truncate text-[10px] text-ds-faint">{detail}</p></div>
}

export function SurveyAdjustmentPanel({ project, runtimeReady, refreshToken = 0, onAdjustmentComplete, onDeformationComplete, onOpenAi, onNetworkSelected, pendingFiles = [], onRemovePendingFile, preferredSection, navigationTarget }: { preferredSection?: SurveySection; project: Project; runtimeReady: boolean; refreshToken?: number; onAdjustmentComplete?: (id: string) => void; onDeformationComplete?: (id: string) => void; onOpenAi?: () => void; onNetworkSelected?: (id: string | null, revision?: number) => void; pendingFiles?: File[]; onRemovePendingFile?: (file: File) => void; navigationTarget?: SurveyEvidenceNavigationTarget | null }): ReactElement {
  const { t } = useTranslation('common')
  const [networkType, setNetworkType] = useState(({ 'control-network': 'plane-control', 'traverse-network': 'traverse', resection: 'cpiii-resection', gnss: 'gnss' } as Record<string, string>)[project.taskType ?? ''] ?? 'leveling')
  const [transformType, setTransformType] = useState('similarity-2d')
  const [knownPointsText, setKnownPointsText] = useState('')
  const [payload, setPayload] = useState(sampleNetwork)
  const [networks, setNetworks] = useState<Network[]>([])
  const [network, setNetwork] = useState<Network | null>(null)
  const [adjustment, setAdjustment] = useState<Adjustment | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [fileInputKey, setFileInputKey] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mappingBatch, setMappingBatch] = useState<{ id: string; files: readonly File[]; mappings: Map<File, CosaIn1Mapping> } | null>(null)
  const [section, setSection] = useState<SurveySection>(preferredSection ?? 'network')
  const preferredSectionRef = useRef(preferredSection)
  preferredSectionRef.current = preferredSection
  useEffect(() => { if (preferredSection) setSection(preferredSection) }, [preferredSection])
  const [showRaw, setShowRaw] = useState(false)
  const [adjustmentHistory, setAdjustmentHistory] = useState<Adjustment[]>([])
  const [referenceAdjustmentId, setReferenceAdjustmentId] = useState('')
  const [currentAdjustmentId, setCurrentAdjustmentId] = useState('')
  const [pairPayload, setPairPayload] = useState('[]')
  const [deformationRecord, setDeformationRecord] = useState<{ scope: string; value: Deformation } | null>(null)
  const deformationScope = JSON.stringify([project.workspace, project.id, project.revision])
  const deformation = deformationRecord?.scope === deformationScope ? deformationRecord.value : null
  const [formatFilter, setFormatFilter] = useState('all')
  const [readinessFilter, setReadinessFilter] = useState<'all' | SurveyImportDisposition>('all')
  const [showSourceRecords, setShowSourceRecords] = useState(false)
  const [selectedResidualSourceRecordId, setSelectedResidualSourceRecordId] = useState<string | null>(null)
  const [cosaFileGroupInspection, setCosaFileGroupInspection] = useState<CosaFileGroupInspection | null>(null)
  const panelElement = useRef<HTMLElement>(null)
  const focusedNavigation = useRef<SurveyEvidenceNavigationTarget | null>(null)
  const appliedNavigation = useRef<SurveyEvidenceNavigationTarget | null>(null)
  const [navigationDataReady, setNavigationDataReady] = useState(false)
  const [navigationLoadedTarget, setNavigationLoadedTarget] = useState<SurveyEvidenceNavigationTarget | null | undefined>()
  const loadedScope = useRef('')
  const appliedRefreshToken = useRef(refreshToken)
  const selectedNetworkRef = useRef(network?.id)
  selectedNetworkRef.current = network?.id
  const navigationLoadBusy = Boolean(busy && (navigationTarget || appliedRefreshToken.current !== refreshToken))
  const [locatedEvidence, setLocatedEvidence] = useState<SurveyEvidenceNavigationTarget | null>(null)
  const [navigationUnavailable, setNavigationUnavailable] = useState(false)

  useEffect(() => {
    onNetworkSelected?.(network?.id ?? null, network?.revision)
  }, [network?.id, network?.revision, onNetworkSelected])

  useEffect(() => {
    if (!project.workspace || !network) return
    const scope = JSON.stringify([project.workspace, project.id])
    if (loadedScope.current !== scope) return
    useEngineeringConversationDrafts.getState().update(scope, (draft) => ({
      ...draft, viewContext: { networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile?.sha256, ...(adjustment ? { adjustmentId: adjustment.run.id, algorithmVersion: adjustment.result.algorithmVersion } : {}), section }
    }))
  }, [project.workspace, project.id, network, adjustment, section])

  const points = useMemo(() => [...(network?.knownPoints ?? []), ...(network?.unknownPoints ?? [])], [network])
  const topology = useMemo(() => buildSurveyTopology(points, network?.observations ?? []), [network, points])
  const blockers = network?.findings.filter((finding) => finding.severity === 'blocking').length ?? 0
  const selectedType = network ? surveyNetworkTypeLabel(network.networkType, t) : surveyNetworkTypeLabel(networkType, t)
  const executionMethod = (network?.networkType ?? networkType) === 'coordinate-transform'
    ? t('surveySelectedTransform')
    : t('surveyWeightedLeastSquares')
  const completedAdjustments = useMemo(() => adjustmentHistory.filter(isComparableEpoch), [adjustmentHistory])
  const rawSourceIntegrity = (network as NetworkWithRawSourceIntegrity | null)?.rawSourceIntegrity
  const sourceEligibility = (network as NetworkWithRawSourceIntegrity | null)?.sourceEligibility
  // The service owns eligibility. Older payloads intentionally fail closed:
  // a file's disposition or its integrity note is not proof of admissibility.
  const sourceIsReady = sourceEligibility?.eligible === true
  const sourceEligibilityFindings = Array.isArray(sourceEligibility?.findings)
    ? sourceEligibility.findings.filter((finding) => typeof finding.message === 'string' && finding.message.trim())
    : []
  const sourceGateReason = !network
    ? t('surveySelectNetworkFirst')
    : !sourceEligibility
      ? t('surveyEligibilityPending')
      : sourceEligibility.eligible
        ? t('surveyEligibilityConfirmed')
        : sourceEligibilityFindings.map((finding) => surveyDiagnosticText(finding, appI18n.language).trim()).join('；') || t('surveyEligibilityDenied')
  const adjustmentIsAdmissible = adjustment ? isAdmissibleCompletedAdjustment(adjustment) : false
  const statisticalBinding: SurveyStatisticalBinding | null = network?.sourceFile && adjustment
    && adjustment.run.networkId === network.id && adjustment.result.algorithmVersion
    && 'inputHash' in adjustment.result && typeof adjustment.result.inputHash === 'string'
    ? { projectId: project.id, networkId: network.id, runId: adjustment.run.id, resultId: adjustment.result.id,
      inputHash: adjustment.result.inputHash, algorithmVersion: adjustment.result.algorithmVersion,
      sourceSha256: network.sourceFile.sha256 }
    : null
  const adjustmentEligibilityFindings = Array.isArray(adjustment?.sourceEligibility?.findings)
    ? adjustment.sourceEligibility.findings.filter((finding) => typeof finding.message === 'string' && finding.message.trim())
    : []
  const adjustmentAdmissionReason = !adjustment
    ? ''
    : !adjustment.sourceEligibility
      ? t('surveyHistoricalEligibilityMissing')
      : !adjustment.sourceEligibility.eligible
        ? adjustmentEligibilityFindings.map((finding) => surveyDiagnosticText(finding, appI18n.language).trim()).join('；') || t('surveyHistoricalEligibilityDenied')
        : adjustment.run.status !== 'completed' || adjustment.result.validation !== 'valid'
          ? t('surveyHistoricalIncomplete')
          : ''
  const formatOptions = useMemo(() => [...new Set(networks.map((item) => item.sourceFile?.detection.format).filter((value): value is string => Boolean(value)))].sort(), [networks])
  const filteredNetworks = useMemo(() => networks.filter((item) => {
    if (formatFilter !== 'all' && item.sourceFile?.detection.format !== formatFilter) return false
    if (readinessFilter !== 'all' && item.sourceFile?.disposition !== readinessFilter) return false
    return true
  }), [formatFilter, networks, readinessFilter])
  const selectedResidualSourceAnchor = useMemo(() => selectedResidualSourceRecordId
    ? resolveResidualSourceAnchor(t, network?.sourceFile, selectedResidualSourceRecordId)
    : null, [network?.sourceFile, selectedResidualSourceRecordId, t])

  const askAboutEvidence = (question: string, evidence: Partial<EngineeringEvidenceReference> = {}): void => {
    if (!project.workspace || !network || !onOpenAi || loadedScope.current !== JSON.stringify([project.workspace, project.id])) return
    prepareEngineeringQuestion(project.workspace, project.id, question, {
      projectId: project.id, projectRevision: project.revision,
      networkId: network.id, networkRevision: network.revision,
      sourceSha256: network.sourceFile?.sha256,
      parserId: network.sourceFile?.parserId, parserVersion: network.sourceFile?.parserVersion,
      parserSourceHash: network.sourceFile?.parserSourceHash,
      ...(adjustment ? { adjustmentId: adjustment.run.id, algorithmVersion: adjustment.result.algorithmVersion } : {}),
      section, ...evidence
    })
    onOpenAi()
  }
  const askAboutObservation = (observationId: string, sourceRecordId?: string): void => {
    askAboutEvidence(t('surveyExplainObservation', { observationId }), { observationId, sourceRecordId })
  }
  const askButton = (label: string, evidence: Partial<EngineeringEvidenceReference> = {}): ReactElement =>
    <button type="button" disabled={!project.workspace || !network || !onOpenAi} aria-label={t('surveyAskEvidence', { label })} onClick={() => askAboutEvidence(t('surveyExplainEvidence', { label }), evidence)} className="mt-1 inline-flex text-[10.5px] font-medium text-accent disabled:opacity-50">{t('surveyAskAgent')}</button>

  const refreshAdjustments = useCallback(async (): Promise<Adjustment[] | undefined> => {
    if (!runtimeReady || !project.id) return
    const result = await request<{ adjustments: Adjustment[] }>(`/v1/engineering/adjustments?projectId=${encodeURIComponent(project.id)}`, 'GET')
    setAdjustmentHistory(result.adjustments)
    const eligible = result.adjustments
      .filter(isComparableEpoch)
      .sort((left, right) => Date.parse(left.observationEpoch!) - Date.parse(right.observationEpoch!))
    setReferenceAdjustmentId((current) => eligible.some((item) => item.run.id === current) ? current : eligible[0]?.run.id ?? '')
    setCurrentAdjustmentId((current) => eligible.some((item) => item.run.id === current) ? current : eligible.at(-1)?.run.id ?? '')
    return result.adjustments
  }, [project.id, runtimeReady])

  useEffect(() => {
    let cancelled = false
    const scope = JSON.stringify([project.workspace, project.id])
    const preserveView = loadedScope.current === scope
    setNavigationDataReady(false)
    setNavigationLoadedTarget(undefined)
    setLocatedEvidence(null)
    setNavigationUnavailable(false)
    if (!runtimeReady || !project.id || navigationLoadBusy) return
    if (!navigationTarget && !preserveView) {
      setMappingBatch(null)
      setCosaFileGroupInspection(null)
    }
    void Promise.all([
      request<{ networks: Network[] }>(`/v1/engineering/survey/networks?projectId=${encodeURIComponent(project.id)}`, 'GET'),
      request<{ adjustments: Adjustment[] }>(`/v1/engineering/adjustments?projectId=${encodeURIComponent(project.id)}`, 'GET')
    ]).then(([networkResult, adjustmentResult]) => {
      if (cancelled) return
      setNetworks(networkResult.networks)
      setAdjustmentHistory(adjustmentResult.adjustments)
      const eligible = adjustmentResult.adjustments
        .filter(isComparableEpoch)
        .sort((left, right) => Date.parse(left.observationEpoch!) - Date.parse(right.observationEpoch!))
      setReferenceAdjustmentId(current => preserveView && eligible.some(item => item.run.id === current) ? current : eligible[0]?.run.id ?? '')
      setCurrentAdjustmentId(current => preserveView && eligible.some(item => item.run.id === current) ? current : eligible.at(-1)?.run.id ?? '')
      if (!navigationTarget || (preserveView && appliedNavigation.current === navigationTarget)) {
        const restoredNetwork = (preserveView ? networkResult.networks.find(item => item.id === selectedNetworkRef.current) : undefined) ?? networkResult.networks[0] ?? null
        const restoredAdjustment = restoredNetwork
          ? adjustmentResult.adjustments.find((item) => item.run.networkId === restoredNetwork.id) ?? null
          : null
        setNetwork(restoredNetwork)
        setAdjustment(restoredAdjustment)
        if (restoredNetwork) {
          setNetworkType(restoredNetwork.networkType)
          if (restoredNetwork.transformType) setTransformType(restoredNetwork.transformType)
        }
        if (!preserveView) setSection(preferredSectionRef.current ?? (restoredAdjustment ? 'result' : 'network'))
      }
      loadedScope.current = scope
      appliedRefreshToken.current = refreshToken
      setNavigationLoadedTarget(navigationTarget)
      setNavigationDataReady(true)
    }).catch((error) => { if (!cancelled) { setMessage(error instanceof Error ? error.message : String(error)); setNavigationUnavailable(Boolean(navigationTarget)) } })
    return () => { cancelled = true }
  }, [project.id, project.workspace, runtimeReady, navigationTarget, navigationLoadBusy, refreshToken])

  useEffect(() => {
    if (!navigationTarget) { setLocatedEvidence(null); setNavigationUnavailable(false); return }
    if (navigationLoadedTarget !== navigationTarget || !navigationDataReady || busy) return
    const target = navigationTarget
    const selected = networks.filter(item => item.id === target.networkId)
    const match = selected.length === 1 ? selected[0] : undefined
    const runs = target.adjustmentId ? adjustmentHistory.filter(item => item.run.id === target.adjustmentId && item.run.networkId === target.networkId) : []
    const run = runs.length === 1 ? runs[0] : undefined
    const observations = run ? run.result.observations : match?.observations
    const observation = target.observationId ? observations?.filter(item => ('observationId' in item ? item.observationId : item.id) === target.observationId) : undefined
    const pointMatches = target.pointId ? (run ? run.result.points : [...match?.knownPoints ?? [], ...match?.unknownPoints ?? []])?.filter(item => item.id === target.pointId) : undefined
    const anchor = target.sourceRecordId ? resolveResidualSourceAnchor(t, match?.sourceFile, target.sourceRecordId) : undefined
    const diagnostic = target.diagnosticIndex !== undefined ? match?.sourceFile?.diagnostics[target.diagnosticIndex] : undefined
    if (target.projectId !== project.id || target.projectRevision !== project.revision || target.workspaceRoot !== project.workspace
      || !match || match.revision !== target.networkRevision || match.sourceFile?.sha256 !== target.sourceSha256
      || target.adjustmentId && !run || target.section === 'result' && !run
      || target.observationId && observation?.length !== 1 || target.pointId && pointMatches?.length !== 1
      || target.sourceRecordId && (anchor?.status !== 'exact' || target.observationId && observation?.[0]?.sourceRecordId !== target.sourceRecordId)
      || target.diagnosticIndex !== undefined && (!Number.isSafeInteger(target.diagnosticIndex) || target.diagnosticIndex < 0 || !diagnostic)) {
      setLocatedEvidence(null)
      setNavigationUnavailable(true)
      return
    }
    setNavigationUnavailable(false)
    if (appliedNavigation.current === target) return
    appliedNavigation.current = target
    setFormatFilter('all'); setReadinessFilter('all')
    setNetwork(match); setNetworkType(match.networkType); setAdjustment(run ?? null)
    if (match.transformType) setTransformType(match.transformType)
    setSelectedResidualSourceRecordId(null)
    setSection(target.section)
    setLocatedEvidence(target)
  }, [navigationTarget, navigationLoadedTarget, navigationDataReady, networks, adjustmentHistory, project.id, project.revision, project.workspace, busy, t])

  useEffect(() => {
    if (!locatedEvidence || focusedNavigation.current === locatedEvidence || !panelElement.current || network?.id !== locatedEvidence.networkId || section !== locatedEvidence.section) return
    const target = locatedEvidence
    const key = target.observationId ? JSON.stringify(['observation', target.observationId]) : target.pointId ? JSON.stringify(['point', target.pointId]) : target.sourceRecordId ? 'source-record' : target.diagnosticIndex !== undefined ? 'diagnostic' : 'survey-selection'
    if (focusEvidenceElement(panelElement.current, key)) focusedNavigation.current = target
  }, [locatedEvidence, network?.id, section])

  const selectExistingNetwork = (networkId: string): void => {
    const selected = networks.find((item) => item.id === networkId)
    if (!selected) return
    setNetwork(selected)
    setLocatedEvidence(null)
    setNetworkType(selected.networkType)
    if (selected.transformType) setTransformType(selected.transformType)
    const restoredAdjustment = adjustmentHistory.find((item) => item.run.networkId === selected.id) ?? null
    setAdjustment(restoredAdjustment)
    setSelectedResidualSourceRecordId(null)
    setSection(preferredSectionRef.current ?? (restoredAdjustment ? 'result' : 'network'))
    setMessage(restoredAdjustment ? t('surveyRestoredResult') : t('surveyRestoredNetwork'))
  }

  const readFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(t('surveyReadFileFailed')))
    reader.onload = () => { const value = typeof reader.result === 'string' ? reader.result : ''; const comma = value.indexOf(','); resolve(comma >= 0 ? value.slice(comma + 1) : value) }
    reader.readAsDataURL(file)
  })

  const importNetwork = async (): Promise<void> => {
    if (!runtimeReady || busy) return
    setBusy(true); setMessage('')
    try {
      const parsed = JSON.parse(payload)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('surveyJsonObjectRequired'))
      const envelope = parsed as { format?: unknown; formatVersion?: unknown; network?: unknown }
      if (envelope.format !== WORKWISE_SURVEY_SOURCE_FORMAT || envelope.formatVersion !== WORKWISE_SURVEY_SOURCE_FORMAT_VERSION || !envelope.network || typeof envelope.network !== 'object' || Array.isArray(envelope.network)) {
        throw new Error(t('surveyJsonContract', { format: WORKWISE_SURVEY_SOURCE_FORMAT, version: WORKWISE_SURVEY_SOURCE_FORMAT_VERSION }))
      }
      const result = await request<{ network: Network }>('/v1/engineering/survey/networks/import', 'POST', { projectId: project.id, networkType, ...(networkType === 'coordinate-transform' ? { transformType } : {}), name: 'workwise-network.json', dataBase64: encodeUtf8Base64(payload), expectedRevision: project.revision, idempotencyKey: `survey-import-${project.id}-${Date.now()}` })
      setNetworks((current) => [result.network, ...current.filter((item) => item.id !== result.network.id)]); setNetwork(result.network); setAdjustment(null); setSelectedResidualSourceRecordId(null); setSection('network'); setMessage(t('surveyJsonImported'))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  const importFiles = async (files: readonly File[], mappings = new Map<File, CosaIn1Mapping>()): Promise<void> => {
    if (!runtimeReady || busy || !files.length) return
    if (files.some((file) => /\.in1$/i.test(file.name) && !mappings.has(file))) {
      setMappingBatch({ id: crypto.randomUUID(), files, mappings }); setSection('network')
      return
    }
    setMappingBatch(null)
    setBusy(true); setMessage('')
    try {
      let knownPoints: ReturnType<typeof parseSurveyKnownPoints>
      try { knownPoints = parseSurveyKnownPoints(knownPointsText) } catch (error) {
        throw new Error(t('surveyKnownPointsInvalid', { row: error instanceof Error ? error.message : '?' }))
      }
      const imported: Network[] = []
      const failures: string[] = []
      for (const file of files) {
        try {
          const dataBase64 = await readFile(file)
          const input = { networkType, ...(knownPoints.length ? { knownPoints } : {}), ...(networkType === 'coordinate-transform' ? { transformType } : {}), name: file.name, dataBase64, ...(mappings.has(file) ? { cosaIn1Mapping: mappings.get(file)! } : {}) }
          const idempotencyKey = await surveyImportKey(project.id, input)
          const result = await request<{ network: Network }>('/v1/engineering/survey/networks/import', 'POST', { projectId: project.id, ...input, expectedRevision: project.revision, idempotencyKey })
          imported.push(result.network)
          onRemovePendingFile?.(file)
        } catch (error) {
          failures.push(t('surveyFileFailure', { file: file.name, details: error instanceof Error ? error.message : String(error) }))
        }
      }

      const cosaSources = imported
        .map((item) => item.sourceFile)
        .filter((source): source is SurveySourceFile => Boolean(source && COSA_GROUP_MEMBER_PATTERN.test(source.name)))
        .map((source) => ({ name: source.name, sha256: source.sha256, size: source.size }))
      let groupInspection: CosaFileGroupInspection | null = null
      if (cosaSources.length) {
        try {
          const grouped = await request<{ inspection: CosaFileGroupInspection }>('/v1/engineering/survey/source-groups/cosa/inspect', 'POST', { files: cosaSources })
          groupInspection = grouped.inspection
        } catch (error) {
          failures.push(`${t('surveyCosaPreflight')}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      setCosaFileGroupInspection(groupInspection)

      if (imported.length) {
        const selected = imported.find((item) => item.sourceFile && /\.(?:in1|in2)$/i.test(item.sourceFile.name)) ?? imported[0]!
        setNetworks((current) => [...imported, ...current.filter((item) => !imported.some((candidate) => candidate.id === item.id))])
        setNetwork(selected); setAdjustment(null); setSelectedResidualSourceRecordId(null); setSection('network')
      }
      const groupBlockers = groupInspection?.diagnostics.length ?? 0
      const importedMessage = imported.length ? t('surveyImportCount', { count: imported.length }) : t('surveyImportNone')
      const groupMessage = cosaSources.length ? t('surveyCosaCount', { count: cosaSources.length }) : ''
      const failureMessage = failures.length ? t('surveyImportFailures', { count: failures.length, details: failures.join('; ') }) : ''
      setMessage([importedMessage, groupMessage, groupBlockers ? t('surveyCosaBlockers', { count: groupBlockers }) : '', failureMessage].filter(Boolean).join('; '))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false); setFileInputKey((value) => value + 1) }
  }

  const validate = async (): Promise<void> => {
    if (!runtimeReady || busy || !network || !sourceIsReady) return
    setBusy(true); setMessage('')
    try {
      const result = await request<{ network: Network }>(`/v1/engineering/survey/networks/${network.id}/validate`, 'POST', { expectedRevision: network.revision, idempotencyKey: `survey-validate-${network.id}-${network.revision}` })
      const currentEligibility = (result.network as NetworkWithRawSourceIntegrity).sourceEligibility
      const validationMessage = currentEligibility?.eligible !== true
        ? currentEligibility
          ? t('surveyValidationEligibilityLost')
          : t('surveyValidationEligibilityMissing')
        : result.network.qualityStatus === 'blocked'
          ? t('surveyValidationBlocked')
          : t('surveyValidationPassed')
      setNetworks((current) => current.map((item) => item.id === result.network.id ? result.network : item)); setNetwork(result.network); setMessage(validationMessage); setSection('network')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  const adjust = async (): Promise<void> => {
    if (!runtimeReady || busy || !network || !sourceIsReady || network.qualityStatus !== 'validated') return
    setBusy(true); setMessage('')
    try {
      const result = await request<Adjustment>('/v1/engineering/adjustments', 'POST', { networkId: network.id, expectedRevision: network.revision, idempotencyKey: `survey-adjust-${network.id}-${network.revision}` })
      const currentAdjustments = await refreshAdjustments()
      const currentAdjustment = currentAdjustments?.find((item) => item.run.id === result.run.id) ?? result
      setAdjustment(currentAdjustment); setSelectedResidualSourceRecordId(null); if (isAdmissibleCompletedAdjustment(currentAdjustment)) onAdjustmentComplete?.(result.run.id); setSection('result'); setMessage(result.run.status === 'completed' && isAdmissibleCompletedAdjustment(currentAdjustment) ? t('surveyAdjustmentComplete') : result.run.status === 'completed' ? t('surveyAdjustmentAuditOnly') : t('surveyAdjustmentIncomplete'))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  const compareDeformation = async (): Promise<void> => {
    if (!runtimeReady || busy) return
    if (!referenceAdjustmentId || !currentAdjustmentId || referenceAdjustmentId === currentAdjustmentId) {
      setMessage(t('surveyChooseDifferentEpochs'))
      return
    }
    setBusy(true); setMessage('')
    try {
      const parsedPairs = JSON.parse(pairPayload) as unknown
      if (!Array.isArray(parsedPairs)) throw new Error(t('surveyPairsArrayRequired'))
      const currentRun = completedAdjustments.find((item) => item.run.id === currentAdjustmentId)?.run
      if (!currentRun) throw new Error(t('surveyCurrentEpochUnavailable'))
      const result = await request<{ deformation: Deformation }>('/v1/engineering/deformations', 'POST', {
        projectId: project.id,
        adjustmentIds: [referenceAdjustmentId, currentAdjustmentId],
        pairs: parsedPairs,
        stabilityRateMPerDay: 0.0001,
        expectedRevision: currentRun.revision,
        idempotencyKey: `survey-deformation-${referenceAdjustmentId}-${currentAdjustmentId}-${JSON.stringify(parsedPairs)}`.slice(0, 200)
      })
      setDeformationRecord({ scope: deformationScope, value: result.deformation })
      onDeformationComplete?.(result.deformation.id)
      setSection('deformation')
      setMessage(t('surveyComparisonComplete'))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  const mappingFile = mappingBatch?.files.find((file) => /\.in1$/i.test(file.name) && !mappingBatch.mappings.has(file))
  return <EngineeringEvidenceQuestions scope={project.workspace && onOpenAi ? { workspace: project.workspace, projectId: project.id, projectRevision: project.revision, ready: runtimeReady && loadedScope.current === JSON.stringify([project.workspace, project.id]), focus: onOpenAi } : null}><section ref={panelElement} className="survey-adjustment-panel p-4 sm:p-5" aria-label={t('surveyWorkbenchTitle')}>
    {navigationUnavailable ? <p role="status" className="mb-3 border-l-2 border-amber-500 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">{t('engineeringEvidenceUnavailable')}</p> : null}
    {locatedEvidence ? <div tabIndex={-1} data-evidence-key="survey-selection" className="mb-3 border-l-2 border-accent px-3 py-2 text-[11px] focus:outline focus:outline-2 focus:outline-accent"><p>{t('engineeringEvidenceLocated')}</p><p className="break-all font-mono">{locatedEvidence.networkId} · {locatedEvidence.networkRevision}{locatedEvidence.adjustmentId ? ` · ${locatedEvidence.adjustmentId}` : ''}</p><p className="break-all font-mono text-ds-muted">{locatedEvidence.sourceSha256}</p>
      {locatedEvidence.diagnosticIndex !== undefined && network?.sourceFile?.diagnostics[locatedEvidence.diagnosticIndex] ? <p tabIndex={-1} data-evidence-key="diagnostic" className="mt-2 focus:outline focus:outline-2 focus:outline-accent">{surveyDiagnosticText(network.sourceFile.diagnostics[locatedEvidence.diagnosticIndex]!, appI18n.language)}</p> : null}
      {locatedEvidence.sourceRecordId ? <div tabIndex={-1} data-evidence-key="source-record" className="mt-2 focus:outline focus:outline-2 focus:outline-accent"><ResidualSourceAnchorPanel resolution={resolveResidualSourceAnchor(t, network?.sourceFile, locatedEvidence.sourceRecordId)} onDismiss={() => setLocatedEvidence(null)} /></div> : null}
    </div> : null}
    {mappingBatch && mappingFile ? <CosaIn1MappingForm key={`${project.id}-${mappingBatch.id}`} fileName={mappingFile.name} disabled={!runtimeReady || busy} onCancel={() => { setMappingBatch(null); setFileInputKey((value) => value + 1) }} onConfirm={(mapping) => {
        const mappings = new Map(mappingBatch.mappings).set(mappingFile, mapping)
        void importFiles(mappingBatch.files, mappings)
      }} /> : null}
    {pendingFiles.length ? <div className="mb-3 border-b border-ds-border-muted pb-3" aria-label={t('surveyPendingFiles')}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[12px] font-semibold">{t('surveyPendingFiles')}</h3><button type="button" disabled={!runtimeReady || busy} onClick={() => void importFiles(pendingFiles)} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] text-white disabled:opacity-50"><FileUp className="h-3.5 w-3.5" />{t('surveyImportPending', { type: surveyNetworkTypeLabel(networkType, t) })}</button></div>
      {pendingFiles.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center gap-2 text-[12px]"><span className="min-w-0 flex-1 break-all">{file.name}</span><button type="button" disabled={busy} onClick={() => onRemovePendingFile?.(file)} title={t('surveyRemovePending')} aria-label={`${t('surveyRemovePending')} ${file.name}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-ds-hover"><X className="h-3.5 w-3.5" /></button></div>)}
    </div> : null}
    <div className="survey-workbench-surface overflow-hidden border border-ds-border-muted bg-ds-card">
      <div className="survey-workbench-header flex flex-wrap items-start justify-between gap-4 border-b border-ds-border-muted px-4 py-4"><div className="min-w-0"><div className="flex items-center gap-2"><Compass className="h-4 w-4 text-accent" /><h3 className="text-[15px] font-semibold">{t('surveyWorkbenchTitle')}</h3><span className="border border-accent/25 bg-accent/5 px-2 py-0.5 text-[10px] font-medium text-accent">{t('surveyRuntimeDeterministic')}</span></div></div><div className="flex shrink-0 flex-wrap items-center justify-end gap-2"><button type="button" onClick={onOpenAi} disabled={!onOpenAi} className="inline-flex h-8 items-center gap-1.5 border border-accent/40 bg-accent/5 px-2.5 text-[11px] font-semibold text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"><Bot className="h-3.5 w-3.5" />{t('surveyAskAgent')}</button>{networks.length ? <><label className="sr-only" htmlFor="survey-existing-network">{t('surveyExistingNetwork')}</label><select id="survey-existing-network" aria-label={t('surveyExistingNetwork')} value={filteredNetworks.some((item) => item.id === network?.id) ? network?.id : ''} onChange={(event) => selectExistingNetwork(event.target.value)} className="h-8 max-w-64 rounded-md border border-ds-border bg-ds-card px-2 text-[11px] text-ds-ink outline-none focus:border-accent"><option value="" disabled>{filteredNetworks.length ? t('surveySelectNetwork') : t('surveyFilterEmpty')}</option>{filteredNetworks.map((item) => <option key={item.id} value={item.id}>{item.sourceFile ? `${sourceFormatLabel(t, item.sourceFile.detection.format)} · ${dispositionLabel(t, item.sourceFile.disposition)}` : surveyNetworkTypeLabel(item.networkType, t)} · {item.id.slice(-8)}</option>)}</select></> : null}<label className="sr-only" htmlFor="survey-network-type">{t('surveyNetworkType')}</label><select id="survey-network-type" aria-label={t('surveyNetworkType')} value={networkType} onChange={(event) => setNetworkType(event.target.value)} className="h-8 rounded-md border border-ds-border bg-ds-card px-2 text-[11px] text-ds-ink outline-none focus:border-accent"><option value="leveling">{t('surveyLeveling')}</option><option value="traverse">{t('surveyTraverse')}</option><option value="plane-control">{t('surveyPlaneControl')}</option><option value="triangulation">{t('surveyTriangulation')}</option><option value="cpiii-free-station">{t('surveyCpiiiStation')}</option><option value="cpiii-resection">{t('surveyCpiiiResection')}</option><option value="gnss">{t('surveyGnssBaseline')}</option><option value="coordinate-transform">{t('surveyCoordinateTransform')}</option></select>{networkType === 'coordinate-transform' ? <><label className="sr-only" htmlFor="survey-transform-type">{t('surveyTransformType')}</label><select id="survey-transform-type" aria-label={t('surveyTransformType')} value={transformType} onChange={(event) => setTransformType(event.target.value)} className="h-8 rounded-md border border-ds-border bg-ds-card px-2 text-[11px] text-ds-ink outline-none focus:border-accent"><option value="similarity-2d">{t('surveySimilarity2d')}</option><option value="helmert-7">{t('surveyHelmert7')}</option><option value="gauss-kruger-forward">{t('surveyGaussForward')}</option><option value="gauss-kruger-inverse">{t('surveyGaussInverse')}</option><option value="height-fit">{t('surveyHeightFit')}</option></select></> : null}<span className={`inline-flex h-8 items-center gap-1.5 px-2.5 text-[10.5px] font-medium ${runtimeReady ? 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'}`}><span className={`h-1.5 w-1.5 rounded-full ${runtimeReady ? 'bg-green-600' : 'bg-amber-500'}`} />{runtimeReady ? t('engineeringRuntimeOnline') : t('surveyRuntimeWaiting')}</span></div></div>

      <div className="survey-instrument-strip grid grid-cols-2 border-b border-ds-border-muted bg-ds-subtle sm:grid-cols-4" aria-label={t('surveyComputationStatus')}><div className="border-r border-ds-border-muted px-4 py-2.5"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ds-faint">{t('surveyNetworkKind')}</p><p className="mt-0.5 truncate text-[11px] font-medium text-ds-ink">{selectedType}</p></div><div id="survey-constraint-mode" className="border-r border-ds-border-muted px-4 py-2.5"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ds-faint">{t('surveyCurrentConstraint')}</p><p aria-label={t('surveyRuntimeConstraint')} className="mt-0.5 truncate text-[11px] font-medium text-ds-ink" title={t(section === 'free-trial' ? 'surveyFreeDatum' : 'surveyFixedPointsHint')}>{section === 'free-trial' ? 'Σ(H − H₀) = 0' : t('surveyFixedPoints')}</p></div><div id="survey-adjustment-method" className="border-r border-ds-border-muted px-4 py-2.5"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ds-faint">{t('surveyWeightModel')}</p><p aria-label={t('surveyRuntimeMethod')} className="mt-0.5 truncate text-[11px] font-medium text-ds-ink" title={t(section === 'free-trial' ? 'surveyFreeWeights' : 'surveyMethodHint')}>{section === 'free-trial' ? t('surveyFreeWeightUnverified') : executionMethod}</p></div><div className="px-4 py-2.5"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ds-faint">{t('surveySolvability')}</p><p className={`mt-0.5 truncate text-[11px] font-medium ${section === 'free-trial' ? 'text-amber-700 dark:text-amber-300' : blockers ? 'text-red-700 dark:text-red-300' : network?.qualityStatus === 'validated' ? 'text-green-700 dark:text-green-300' : 'text-ds-ink'}`}>{section === 'free-trial' ? t('surveyFreeTrialOnly') : blockers ? t('surveyStatBlocked', { count: blockers }) : network?.qualityStatus === 'validated' ? t('surveyValidated') : t('surveyNotValidated')}</p></div></div>

      <div className="survey-workbench-grid grid min-h-0 lg:grid-cols-[190px_minmax(0,1fr)] 2xl:grid-cols-[190px_minmax(0,1fr)_260px]">
        <nav className="survey-workbench-nav border-b border-ds-border-muted bg-ds-main p-2 lg:border-b-0 lg:border-r" aria-label={t('surveyNavigation')}><p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ds-faint">{t('surveyWorkspace')}</p>{([['network', t('surveySectionNetwork'), GitBranch], ['observations', t('surveySectionObservations'), Grid3X3], ['points', t('surveyNavPoints'), CircleDot], ['result', t('surveyNavResults'), CheckCircle2], ['free-trial', t('surveyFreeTitle'), SlidersHorizontal], ['deformation', t('surveyNavDeformation'), Activity]] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-current={section === value ? 'page' : undefined} onClick={() => { setSection(value); setLocatedEvidence(null) }} className={`flex min-h-10 w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] ${section === value ? 'bg-accent/10 font-semibold text-accent' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'}`}><Icon className="h-3.5 w-3.5 shrink-0" />{label}<span className="ml-auto text-[9px] text-ds-faint">{value === 'observations' ? network?.observations.length ?? 0 : value === 'points' ? points.length : value === 'deformation' ? completedAdjustments.length : ''}</span></button>)}</nav>

        <div className="survey-workbench-main min-w-0 bg-ds-card">

          {(!network?.sourceFile || network.sourceFile.detection.format === WORKWISE_SURVEY_SOURCE_FORMAT) ? <p role="note" className="border-b border-ds-border-muted bg-amber-50 px-4 py-2 text-[10px] leading-4 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">{t('surveySourceBoundary')}</p> : null}

          {section === 'network' ? <div className="p-4"><div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_260px]"><div className="border border-ds-border-muted bg-ds-main p-3"><div className="flex items-center justify-between gap-2"><div><p className="text-[12px] font-semibold">{t('surveyImportTitle')}</p><p className="mt-0.5 text-[10.5px] text-ds-muted">{t('surveyImportHint')}</p></div><FileUp className="h-4 w-4 text-accent" /></div><div className="mt-3 flex flex-wrap gap-2"><button type="button" aria-label={t('surveyChooseFilesAria')} disabled={!runtimeReady || busy} onClick={() => fileInputRef.current?.click()} className="inline-flex h-8 cursor-pointer items-center gap-1.5 border border-ds-border bg-ds-card px-2.5 text-[11px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-50"><FileUp className="h-3.5 w-3.5" />{t('surveyChooseFiles')}</button><input ref={fileInputRef} key={fileInputKey} type="file" multiple accept={SURVEY_FILE_ACCEPT} aria-label={t('surveyChooseFilesAria')} hidden aria-hidden="true" tabIndex={-1} disabled={!runtimeReady || busy} onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) void importFiles(files) }} /><button type="button" onClick={() => void importNetwork()} disabled={!runtimeReady || busy} className="inline-flex h-8 items-center gap-1.5 bg-accent px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"><FileCode2 className="h-3.5 w-3.5" />{t('surveyImportJson')}</button><button type="button" onClick={() => setShowRaw((value) => !value)} className="inline-flex h-8 items-center gap-1.5 border border-ds-border px-2.5 text-[11px] font-medium text-ds-muted hover:bg-ds-hover">{showRaw ? t('surveyHideJson') : t('surveyAdvancedJson')}</button></div>{showRaw ? <><label className="mt-3 block text-[10px] font-medium text-ds-muted" htmlFor="survey-network-json">{t('surveyJsonSource')}</label><textarea id="survey-network-json" value={payload} onChange={(event) => setPayload(event.target.value)} className="mt-1 min-h-[180px] w-full rounded-md border border-ds-border bg-ds-card p-3 font-mono text-[10.5px] leading-5 text-ds-ink outline-none focus:border-accent" spellCheck={false} /><p className="mt-1 text-[10px] leading-4 text-ds-faint">{t('surveyJsonUnits', { format: WORKWISE_SURVEY_SOURCE_FORMAT, version: WORKWISE_SURVEY_SOURCE_FORMAT_VERSION })}</p></> : <div className="mt-3 border border-dashed border-ds-border-muted px-3 py-3 text-[10.5px] leading-4 text-ds-muted">{t('surveyImportBoundary')}</div>}</div><div className="border border-ds-border-muted bg-ds-main p-3"><div className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-accent" /><p className="text-[12px] font-semibold">{t('surveyProjectDatum')}</p></div><dl className="mt-3 space-y-2 text-[10.5px]"><div className="flex justify-between gap-3"><dt className="text-ds-faint">{t('surveyNetworkType')}</dt><dd className="text-right font-medium text-ds-ink">{selectedType}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-faint">{t('surveyCoordinateSystem')}</dt><dd className="text-right text-ds-ink">{surveyDatumLabel(network?.coordinateSystem, t)}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-faint">{t('surveyHeightDatum')}</dt><dd className="text-right text-ds-ink">{surveyDatumLabel(network?.verticalDatum ?? network?.heightDatum, t)}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-faint">{t('surveyInputRevision')}</dt><dd className="font-mono text-ds-ink">{network?.revision ?? '—'}</dd></div></dl></div></div>
            <label className="mt-3 block text-[11px] text-ds-muted">{t('surveyKnownPointsInput')}<textarea aria-label={t('surveyKnownPointsInput')} value={knownPointsText} onChange={(event) => setKnownPointsText(event.target.value)} spellCheck={false} placeholder="BM-01,100.000" className="mt-1 min-h-20 w-full rounded border border-ds-border bg-ds-card p-2 font-mono text-[11px] text-ds-ink" /><span className="mt-1 block">{t('surveyKnownPointsHint')}</span></label>
            {cosaFileGroupInspection ? <CosaFileGroupInspectionPanel inspection={cosaFileGroupInspection} /> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2 border border-ds-border-muted bg-ds-main px-3 py-2" aria-label={t('surveySourceFilterAria')}><span className="text-[10px] font-semibold text-ds-muted">{t('surveyExistingSourceFilter')}</span><label className="sr-only" htmlFor="survey-format-filter">{t('surveyFormat')}</label><select id="survey-format-filter" aria-label={t('surveyFormatFilterAria')} value={formatFilter} onChange={(event) => setFormatFilter(event.target.value)} className="h-7 border border-ds-border bg-ds-card px-2 text-[10.5px] text-ds-ink"><option value="all">{t('surveyAllFormats', { count: networks.length })}</option>{formatOptions.map((format) => <option key={format} value={format}>{sourceFormatLabel(t, format)}</option>)}</select><label className="sr-only" htmlFor="survey-readiness-filter">{t('surveyReadiness')}</label><select id="survey-readiness-filter" aria-label={t('surveyReadinessFilterAria')} value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value as typeof readinessFilter)} className="h-7 border border-ds-border bg-ds-card px-2 text-[10.5px] text-ds-ink"><option value="all">{t('surveyAllStatuses')}</option><option value="adjustment-ready">{t('surveyAdjustmentReady')}</option><option value="gnss-processing-required">{t('surveyGnssPending')}</option><option value="converter-required">{t('surveyConverterRequired')}</option><option value="archive-only">{t('surveyArchiveOnly')}</option></select><span className="ml-auto text-[10px] text-ds-faint">{t('surveyShowing', { shown: filteredNetworks.length, total: networks.length })}</span></div>
            <RawSourceIntegrityNote integrity={rawSourceIntegrity} />
            {network && !sourceIsReady ? <p role="note" className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">{t('surveyLockedValidation', { reason: sourceGateReason })}</p> : null}
            {network && sourceEligibilityFindings.length ? <div aria-label={t('surveySourceGateTitle')} className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-[10.5px] leading-4 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100"><p className="font-semibold">{t('surveySourceGateTitle')}</p><ul className="mt-1 list-disc space-y-1 pl-4">{sourceEligibilityFindings.map((finding, index) => <li key={`${finding.code ?? 'source-eligibility'}-${surveyDiagnosticText(finding, appI18n.language)}-${index}`}>{typeof finding.code === 'string' ? <code className="mr-1 font-mono text-[9px]">{finding.code}</code> : null}{surveyDiagnosticText(finding, appI18n.language)}{typeof finding.suggestion === 'string' && finding.suggestion.trim() ? <span className="mt-0.5 block">{t('surveyNextStep')}{surveyDiagnosticText(finding, appI18n.language, 'action')}</span> : null}</li>)}</ul></div> : null}
            {network?.sourceFile ? <SurveySourcePreflight source={network.sourceFile} showRecords={showSourceRecords} onToggleRecords={() => setShowSourceRecords((value) => !value)} onAsk={project.workspace && onOpenAi ? (index) => {
              const diagnostic = network.sourceFile!.diagnostics[index]!
              const anchor = (network.sourceFile!.records ?? network.sourceFile!.rawRecordAnchors).find((item) =>
                diagnostic.byteOffset !== undefined ? item.rawOffset === diagnostic.byteOffset : diagnostic.sourceRecord !== undefined && item.sourceRecord === diagnostic.sourceRecord)
              askAboutEvidence(t('surveyExplainEvidence', { label: diagnostic.code }), { section: 'preflight', diagnosticCode: diagnostic.code, diagnosticIndex: index, sourceRecord: diagnostic.sourceRecord, byteOffset: diagnostic.byteOffset, sourceRecordId: anchor?.id })
            } : undefined} /> : <div className="mt-3 border border-dashed border-ds-border-muted px-3 py-3 text-[10.5px] leading-4 text-ds-muted">{t('surveyNoSourcePreflight')}</div>}
            <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4"><Stat label={t('surveyStatPoints')} value={`${points.length}`} detail={t('surveyStatKnownUnknown', { known: network?.knownPoints.length ?? 0, unknown: network?.unknownPoints.length ?? 0 })} /><Stat label={t('surveyStatObservations')} value={`${network?.observations.length ?? 0}`} detail={network ? t('surveyStatUnitsWeights') : t('surveyStatWaitingImport')} /><Stat label={t('surveyStatQuality')} value={surveyStatusLabel(network?.qualityStatus, t)} detail={blockers ? t('surveyStatBlocked', { count: blockers }) : network?.qualityStatus === 'validated' ? t('surveyValidated') : t('surveyStatNotValidated')} tone={blockers ? 'danger' : network?.qualityStatus === 'validated' ? 'good' : 'neutral'} /><Stat label={t('surveyStatRun')} value={surveyStatusLabel(adjustment?.run.status, t)} detail={adjustment?.run.id ?? t('surveyNotAdjusted')} tone={adjustment?.run.status === 'completed' ? 'good' : 'neutral'} /></div><div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void validate()} disabled={!runtimeReady || !network || busy || !sourceIsReady} title={!sourceIsReady && network?.sourceFile ? dispositionLabel(t, network.sourceFile.disposition) : undefined} className="inline-flex h-8 items-center gap-1.5 border border-ds-border px-3 text-[11px] font-medium text-ds-ink disabled:cursor-not-allowed disabled:opacity-50"><ShieldAlert className="h-3.5 w-3.5" />{t('engineeringTabQuality')}</button>{network && sourceIsReady && network.qualityStatus !== 'blocked' && blockers === 0 ? <button type="button" onClick={() => void adjust()} disabled={!runtimeReady || !network || busy || !sourceIsReady || network.qualityStatus !== 'validated'} title={!sourceIsReady && network?.sourceFile ? dispositionLabel(t, network.sourceFile.disposition) : undefined} className="inline-flex h-8 items-center gap-1.5 bg-green-700 px-3 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"><Play className="h-3.5 w-3.5" />{t('surveyRunAdjustment')}</button> : null}{!sourceIsReady && network?.sourceFile ? <><span role="note" className="max-w-xl text-[10.5px] text-amber-700 dark:text-amber-300">{t('surveyLockedCalculation', { reason: dispositionRecovery(t, network.sourceFile.disposition) })}</span><button type="button" onClick={() => askAboutEvidence(t('surveyPlanMissingData'), { section: 'preflight' })} disabled={!project.workspace || !onOpenAi} className="h-8 border border-accent/35 px-2.5 text-[10.5px] font-semibold text-accent disabled:opacity-50">{t('surveyPlanMissingData')}</button></> : null}</div></div> : null}

          {section === 'observations' ? <div className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-[13px] font-semibold">{t('surveySectionObservations')}</h4></div><button type="button" onClick={() => void validate()} disabled={!runtimeReady || !network || busy || !sourceIsReady} title={!sourceIsReady && network?.sourceFile ? `${dispositionLabel(t, network.sourceFile.disposition)}：${(appI18n.language.startsWith('en') ? network.sourceFile.dispositionReasonEn : undefined) ?? network.sourceFile.dispositionReason ?? t('surveyLegacyMissing')}` : undefined} className="inline-flex h-8 items-center gap-1.5 border border-ds-border px-2.5 text-[11px] font-medium disabled:opacity-50"><ShieldAlert className="h-3.5 w-3.5" />{t('surveyRevalidate')}</button></div>{network ? <div className="mt-4 overflow-x-auto border border-ds-border-muted"><table className="min-w-full text-left text-[11px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2 font-semibold">{t('surveyObservationId')}</th><th className="px-3 py-2 font-semibold">{t('surveyType')}</th><th className="px-3 py-2 font-semibold">{t('surveyStationTarget')}</th><th className="px-3 py-2 font-semibold">{t('surveyObservationValue')}</th><th className="px-3 py-2 font-semibold">{t('surveyUnit')}</th><th className="px-3 py-2 font-semibold">{t('surveyWeightCovariance')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{network.observations.map((observation) => <tr key={observation.id} tabIndex={-1} data-evidence-key={JSON.stringify(['observation', observation.id])} className="hover:bg-ds-hover focus:bg-accent/10 focus:outline focus:outline-2 focus:outline-accent"><td className="px-3 py-2.5 font-mono text-ds-ink">{observation.id}<button type="button" disabled={!project.workspace || !onOpenAi} aria-label={t('surveyAskObservation', { observationId: observation.id })} onClick={() => askAboutObservation(observation.id, observation.sourceRecordId)} className="mt-1 block text-accent disabled:opacity-50">{t('surveyAskAgent')}</button></td><td className="px-3 py-2.5 text-ds-muted">{observation.type ?? '—'}</td><td className="px-3 py-2.5 text-ds-ink">{observation.station ?? observation.from ?? '—'} <span className="text-ds-faint">→</span> {observation.target ?? observation.to ?? '—'}</td><td className="px-3 py-2.5 tabular-nums font-medium text-ds-ink">{observationValueLabel(observation)}</td><td className="px-3 py-2.5 text-ds-muted">{observation.unit ?? '—'}</td><td className="px-3 py-2.5 tabular-nums text-ds-muted">{observation.type === 'gnss-baseline' ? (observation.covariance?.length === 9 ? t('surveyCovarianceProvided') : t('surveyCovarianceMissing')) : numberLabel(observation.sigma, 6)}</td></tr>)}</tbody></table></div> : <div className="mt-4 border border-dashed border-ds-border-muted px-4 py-10 text-center text-[11px] text-ds-muted">{t('surveyObservationsEmpty')}</div>}</div> : null}

          {section === 'points' ? <div className="p-4"><div><h4 className="text-[13px] font-semibold">{t('surveySectionPoints')}{network ? <EngineeringEvidenceQuestion label={t('surveySectionPoints')} reference={{ kind: 'network', networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile?.sha256 ?? '' }} /> : null}</h4></div>{network ? <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]"><div className="border border-ds-border-muted bg-[#f8fafc] p-3 dark:bg-ds-main"><svg viewBox="0 0 520 230" className="h-[230px] w-full" role="img" aria-label={t('surveyTopologyAria', { layout: topology.hasCoordinateLayout ? t('surveyCoordinateLayout') : t('surveySchematicLayout') })}><g stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5">{topology.edges.map((edge) => { const from = topology.nodes.find((node) => node.id === edge.from); const to = topology.nodes.find((node) => node.id === edge.to); return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null })}</g>{topology.nodes.map((point) => <g key={`${point.index}:${point.id}`} transform={`translate(${point.x},${point.y})`}><circle r="14" fill={(point.known || point.pointClass === 'known') ? '#2563eb' : '#fff'} stroke="#2563eb" strokeWidth="2" /><text y="4" textAnchor="middle" fontSize="9" fill={(point.known || point.pointClass === 'known') ? '#fff' : '#2563eb'}>{point.index + 1}</text><text y="29" textAnchor="middle" fontSize="10" fill="currentColor">{point.id}</text></g>)}</svg><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ds-muted"><span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-blue-600" />{t('surveyKnownPoints')}</span><span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full border-2 border-blue-600 bg-white dark:bg-ds-main" />{t('surveyUnknownPoints')}</span><span className="text-ds-faint">{topology.hasCoordinateLayout ? t('surveyNormalizedLayout') : t('surveySchematicHint')}</span></div></div><div className="overflow-hidden border border-ds-border-muted"><table className="min-w-full text-left text-[10.5px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-2.5 py-2 font-semibold">{t('surveyPointId')}</th><th className="px-2.5 py-2 font-semibold">{t('surveyRole')}</th><th className="px-2.5 py-2 font-semibold">{t('surveyInitialHeight')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{points.map((point, index) => <tr key={`${index}:${point.id}`} tabIndex={-1} data-evidence-key={JSON.stringify(['point', point.id])} className="focus:bg-accent/10 focus:outline focus:outline-2 focus:outline-accent"><td className="px-2.5 py-2 font-medium text-ds-ink">{point.id}<EngineeringEvidenceQuestion label={point.id} reference={{ kind: 'network', networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile?.sha256 ?? '', selector: { path: index < network.knownPoints.length ? ['knownPoints', index] : ['unknownPoints', index - network.knownPoints.length], identity: { id: point.id } } }} /></td><td className="px-2.5 py-2 text-ds-muted">{pointLabel(t, point)}</td><td className="px-2.5 py-2 tabular-nums text-ds-muted">{numberLabel(point.height, 4)}</td></tr>)}</tbody></table></div></div> : <div className="mt-4 border border-dashed border-ds-border-muted px-4 py-10 text-center text-[11px] text-ds-muted">{t('surveyPointsEmpty')}</div>}</div> : null}

          {section === 'free-trial' ? <SurveyFreeLevelingTrial
            binding={network?.sourceFile ? { projectId: project.id, networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile.sha256 } : null}
            contextRevision={project.revision}
            runtimeReady={runtimeReady}
            eligible={sourceIsReady && !busy && (network?.networkType === 'leveling' || network?.networkType === 'height-control')}
            renderSourceRecord={(recordId, dismiss) => <ResidualSourceAnchorPanel resolution={resolveResidualSourceAnchor(t, network?.sourceFile, recordId)} onDismiss={dismiss} />}
          /> : null}
          {section === 'result' ? <div className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-[13px] font-semibold">{t('surveySectionResult')}</h4></div>{adjustment ? <div className="flex flex-wrap items-center justify-end gap-2"><span className="border border-ds-border-muted bg-ds-subtle px-2 py-1 font-mono text-[10px] text-ds-muted">{t('surveyStrategy')}{adjustment.result.strategyId ?? 'legacy'}{adjustment.result.transformType ? `/${adjustment.result.transformType}` : ''} · {adjustment.result.algorithmVersion ?? 'unknown'}</span><span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium ${adjustmentIsAdmissible && adjustment.result.precision.passed ? 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'}`}><CheckCircle2 className="h-3.5 w-3.5" />{adjustmentIsAdmissible ? adjustment.result.precision.passed ? t('surveyPrecisionPassed') : t('surveyReviewNeeded') : t('surveyAuditOnly')}</span></div> : null}</div>
            {adjustment ? <>
              {!adjustmentIsAdmissible ? <div aria-label={t('surveyHistoricalLocked')} className="mt-4 border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"><p className="font-semibold">{t('surveyHistoricalLocked')}</p><p className="mt-1">{adjustmentAdmissionReason} {t('surveyHistoricalRestriction')}</p>{adjustmentEligibilityFindings.length ? <ul className="mt-1 list-disc space-y-1 pl-4">{adjustmentEligibilityFindings.map((finding, index) => <li key={`${finding.code ?? 'adjustment-source-eligibility'}-${surveyDiagnosticText(finding, appI18n.language)}-${index}`}>{surveyDiagnosticText(finding, appI18n.language)}{typeof finding.suggestion === 'string' && finding.suggestion.trim() ? <span className="block">{t('surveyNextStep')}{surveyDiagnosticText(finding, appI18n.language, 'action')}</span> : null}</li>)}</ul> : null}</div> : null}
              <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4"><Stat label={t('surveyObservationsUnknowns')} value={`${adjustment.result.observationCount} / ${adjustment.result.unknownCount}`} detail={t('surveyRedundancy', { count: adjustment.result.redundancy })} /><Stat label={t('surveyDegreesOfFreedom')} value={`${adjustment.result.degreesOfFreedom ?? adjustment.result.redundancy}`} detail={t('surveyEquationSolvability')} /><Stat label={t('surveySigma0')} value={numberLabel(adjustment.result.unitWeightStdDev, 6)} detail={t('surveyVarianceFactor', { value: numberLabel(adjustment.result.varianceFactor, 6) })} /><Stat label={t('surveyMaxPointError')} value={measurementLabel(t, adjustment.result.precision.maxPointStdDev, adjustment.result.linearUnit ?? 'm', 6)} detail={adjustmentIsAdmissible ? adjustment.result.precision.passed ? t('surveyPrecisionMet') : t('surveyPrecisionExceeded') : t('surveyAuditNoComputation')} tone={adjustmentIsAdmissible && adjustment.result.precision.passed ? 'good' : 'warn'} /></div>
              {askButton(t('surveyMaxPointError'), { metric: 'precision' })}
              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]"><div className="overflow-hidden border border-ds-border-muted"><div className="border-b border-ds-border-muted bg-ds-subtle px-3 py-2 text-[11px] font-semibold text-ds-muted">{t('surveyResidualsOutliers')}</div>{adjustment.result.observations?.length ? <div className="overflow-x-auto"><table className="min-w-full text-left text-[10.5px]"><thead className="text-ds-muted"><tr><th className="px-3 py-2 font-semibold">{t('surveyStatObservations')}</th><th className="px-3 py-2 font-semibold">{t('surveyResidualCanonical')}</th><th className="px-3 py-2 font-semibold">{t('surveyStandardizedResidual')}</th><th className="px-3 py-2 font-semibold">{t('surveyRawRecord')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{adjustment.result.observations.map((residual) => <tr key={residual.observationId} tabIndex={-1} data-evidence-key={JSON.stringify(['observation', residual.observationId])} className="focus:bg-accent/10 focus:outline focus:outline-2 focus:outline-accent"><td className="px-3 py-2 font-mono text-ds-ink">{residual.observationId}<button type="button" disabled={!project.workspace || !onOpenAi} aria-label={t('surveyAskObservation', { observationId: residual.observationId })} onClick={() => askAboutObservation(residual.observationId, residual.sourceRecordId)} className="mt-1 block text-accent disabled:opacity-50">{t('surveyAskAgent')}</button></td><td className="px-3 py-2 tabular-nums text-ds-ink">{measurementLabel(t, residual.residual, residual.unit, 7)}</td><td className={`px-3 py-2 tabular-nums ${Math.abs(residual.standardizedResidual ?? 0) > 3 ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ds-muted'}`}>{measurementLabel(t, residual.standardizedResidual, 'σ', 4)}</td><td className="px-3 py-2">{residual.sourceRecordId ? <div className="flex min-w-40 flex-wrap items-center gap-1.5"><code className="max-w-40 truncate font-mono text-[9.5px] text-ds-ink" title={residual.sourceRecordId}>{residual.sourceRecordId}</code><button type="button" aria-label={t('surveyLocateRecordAria', { observation: residual.observationId, record: residual.sourceRecordId })} onClick={() => setSelectedResidualSourceRecordId(residual.sourceRecordId!)} className="border border-accent/35 px-1.5 py-1 text-[9.5px] font-medium text-accent hover:bg-accent/10">{t('surveyLocateRecord')}</button></div> : <span className="text-[10px] text-amber-700 dark:text-amber-300">{t('surveyRecordUnlinked')}</span>}</td></tr>)}</tbody></table></div> : <p className="px-3 py-6 text-[10.5px] text-ds-muted">{t('surveyResidualsMissing')}</p>}{selectedResidualSourceAnchor ? <ResidualSourceAnchorPanel resolution={selectedResidualSourceAnchor} onDismiss={() => setSelectedResidualSourceRecordId(null)} /> : null}</div>
                <div className="border border-ds-border-muted bg-ds-main p-3"><p className="text-[11px] font-semibold text-ds-ink">{t('surveyClosureReview')}</p>{askButton(t('surveyClosureReview'), { metric: 'closure' })}<dl className="mt-3 space-y-2 text-[10.5px]"><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyHorizontalNorm')}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, adjustment.result.closure?.horizontal, adjustment.result.closureUnits?.horizontal ?? 'm', 6)}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyAngularNorm')}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, adjustment.result.closure?.angular, adjustment.result.closureUnits?.angular ?? 'rad', 8)}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyHeightClosure')}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, adjustment.result.closure?.vertical ?? adjustment.result.closure?.heightDifference, adjustment.result.closureUnits?.vertical ?? adjustment.result.closureUnits?.heightDifference ?? 'm', 6)}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyTraverseClosure')}</dt><dd className="tabular-nums text-ds-ink">{adjustment.result.closure?.fx === undefined ? '—' : `${measurementLabel(t, adjustment.result.closure.fx, adjustment.result.closureUnits?.fx ?? 'm', 6)} / ${measurementLabel(t, adjustment.result.closure.fy, adjustment.result.closureUnits?.fy ?? 'm', 6)}`}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyRelativeClosure')}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, adjustment.result.closure?.relativeClosure, adjustment.result.closureUnits?.relativeClosure ?? 'ratio', 8)}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyBaselineNorm')}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, adjustment.result.closure?.baseline, adjustment.result.closureUnits?.baseline ?? 'm', 6)}</dd></div>{adjustment.result.closure?.baseline !== undefined ? <div className="flex justify-between gap-2"><dt className="text-ds-faint">GNSS X / Y / Z</dt><dd className="tabular-nums text-ds-ink">{[adjustment.result.closure.baselineX, adjustment.result.closure.baselineY, adjustment.result.closure.baselineZ].map((value) => numberLabel(value, 6)).join(' / ')} m</dd></div> : null}{Object.entries(adjustment.result.parameters ?? {}).map(([key, value]) => <div key={key} className="flex justify-between gap-2"><dt className="text-ds-faint">{key.startsWith('orientation:') ? t('surveyStationOrientation', { station: key.slice(12) }) : key}</dt><dd className="tabular-nums text-ds-ink">{measurementLabel(t, value, adjustment.result.parameterUnits?.[key], 8)}</dd></div>)}</dl><div className="mt-3 border-t border-ds-border-muted pt-3"><p className="font-mono text-[9.5px] text-ds-faint">{t('surveyRun')}{adjustment.run.id}</p><p className="mt-1 text-[10px] text-ds-muted">{adjustment.result.validation}</p></div></div></div>
              {network && ['leveling', 'height-control'].includes(network.networkType) ? <SurveyStatisticalDiagnostics
                binding={statisticalBinding} networkRevision={network.revision} contextRevision={`${project.revision}:${network.revision}:${adjustment.run.revision}`}
                runtimeReady={runtimeReady} eligible={adjustmentIsAdmissible && sourceIsReady && !busy} workspace={project.workspace}
                renderSourceRecord={(recordId, dismiss) => <ResidualSourceAnchorPanel resolution={resolveResidualSourceAnchor(t, network.sourceFile, recordId)} onDismiss={dismiss} />}
              /> : null}
              {adjustment.result.qualityFindings.length ? <div className="mt-4 space-y-2">{adjustment.result.qualityFindings.map((finding, index) => <div key={`${surveyDiagnosticText(finding, appI18n.language)}-${index}`} className="flex gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{surveyDiagnosticText(finding, appI18n.language)}</div>)}</div> : null}
            </> : <div className="mt-4 border border-dashed border-ds-border-muted px-4 py-12 text-center text-[11px] text-ds-muted">{t('surveyResultsEmpty')}</div>}
          </div> : null}

          {section === 'deformation' ? <div className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-[13px] font-semibold">{t('surveyDeformationTitle')}</h4></div><button type="button" onClick={() => void refreshAdjustments()} disabled={!runtimeReady || busy} className="inline-flex h-8 items-center gap-1.5 border border-ds-border px-2.5 text-[11px] font-medium text-ds-ink disabled:opacity-50"><Activity className="h-3.5 w-3.5" />{t('surveyRefreshEpochs')}</button></div>
            {completedAdjustments.length < 2 ? <div className="mt-4 border border-dashed border-ds-border-muted px-4 py-10 text-center text-[11px] text-ds-muted">{t('surveyEpochsRequired', { count: completedAdjustments.length })}</div> : <><div className="mt-4 grid gap-3 border border-ds-border-muted bg-ds-main p-3 lg:grid-cols-2"><label className="text-[10.5px] font-medium text-ds-muted">{t('surveyReferenceEpoch')}<select aria-label={t('surveyReferenceEpochAria')} value={referenceAdjustmentId} onChange={(event) => setReferenceAdjustmentId(event.target.value)} className="mt-1 h-9 w-full border border-ds-border bg-ds-card px-2 text-[11px] text-ds-ink outline-none focus:border-accent">{completedAdjustments.map((item) => <option key={item.run.id} value={item.run.id}>{item.observationEpoch} · {item.result.strategyId ?? 'legacy'} · {item.coordinateSystem}/{item.verticalDatum}</option>)}</select></label><label className="text-[10.5px] font-medium text-ds-muted">{t('surveyCurrentEpoch')}<select aria-label={t('surveyCurrentEpochAria')} value={currentAdjustmentId} onChange={(event) => setCurrentAdjustmentId(event.target.value)} className="mt-1 h-9 w-full border border-ds-border bg-ds-card px-2 text-[11px] text-ds-ink outline-none focus:border-accent">{completedAdjustments.map((item) => <option key={item.run.id} value={item.run.id}>{item.observationEpoch} · {item.result.strategyId ?? 'legacy'} · {item.coordinateSystem}/{item.verticalDatum}</option>)}</select></label><label className="lg:col-span-2 text-[10.5px] font-medium text-ds-muted">{t('surveyPairsJson')}<textarea aria-label={t('surveyPairsAria')} value={pairPayload} onChange={(event) => setPairPayload(event.target.value)} spellCheck={false} className="mt-1 min-h-20 w-full border border-ds-border bg-ds-card p-2 font-mono text-[10px] leading-4 text-ds-ink outline-none focus:border-accent" placeholder={'[{"id":"SECTION-1","firstPointId":"L","secondPointId":"R","kind":"convergence","distanceMode":"horizontal"}]'} /><span className="mt-1 block font-normal text-ds-faint">{t('surveyPairsHint')}</span></label><div className="lg:col-span-2 flex items-center justify-between gap-3 border-t border-ds-border-muted pt-3"><p className="text-[10px] text-ds-faint">{t('surveyStabilityThreshold')}</p><button type="button" onClick={() => void compareDeformation()} disabled={!runtimeReady || busy || referenceAdjustmentId === currentAdjustmentId} className="inline-flex h-8 items-center gap-1.5 bg-green-700 px-3 text-[11px] font-semibold text-white disabled:opacity-50"><Play className="h-3.5 w-3.5" />{t('surveyCompareEpochs')}</button></div></div>
              {deformation ? <div className="mt-4"><div className="grid grid-cols-2 gap-2 lg:grid-cols-4"><Stat label={t('surveyDuration')} value={`${numberLabel(deformation.durationDays, 3)} d`} detail={`${deformation.referenceEpoch} → ${deformation.currentEpoch}`} /><Stat label={t('surveyCommonPoints')} value={`${deformation.points.length}`} detail={t('surveyCommonPointsDetail')} /><Stat label={t('surveyPairResults')} value={`${deformation.pairs.length}`} detail={t('surveyTiltConvergence')} /><Stat label={t('surveySignificantDisplacement')} value={`${deformation.points.filter((point) => point.significant).length}`} detail={t('surveyCombinedError')} tone={deformation.points.some((point) => point.significant) ? 'warn' : 'good'} /></div><div className="mt-4 overflow-x-auto border border-ds-border-muted"><table className="min-w-full text-left text-[10.5px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2 font-semibold">{t('surveyPoint')}</th><th className="px-3 py-2 font-semibold">dX / dY / dH（m）</th><th className="px-3 py-2 font-semibold">{t('surveySettlement')}</th><th className="px-3 py-2 font-semibold">{t('surveyDisplacement')}</th><th className="px-3 py-2 font-semibold">{t('surveyRate')}</th><th className="px-3 py-2 font-semibold">{t('surveyTrend')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{deformation.points.map((point, index) => <tr key={point.pointId} className="hover:bg-ds-hover"><td className="px-3 py-2.5 font-medium text-ds-ink">{point.pointId}<EngineeringEvidenceQuestion label={point.pointId} reference={{ kind: 'deformation', comparisonId: deformation.id, referenceAdjustmentId: deformation.referenceAdjustmentId, currentAdjustmentId: deformation.currentAdjustmentId, inputHash: deformation.inputHash, algorithmVersion: deformation.algorithmVersion, selector: { path: ['points', index], identity: { pointId: point.pointId } } }} /></td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{[point.dX, point.dY, point.dH].map((value) => numberLabel(value, 7)).join(' / ')}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.settlement, 7)}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.horizontalDisplacement, 7)} / {numberLabel(point.spatialDisplacement, 7)}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.rates.spatialPerDay, 8)}</td><td className={`px-3 py-2.5 ${point.significant ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-ds-muted'}`}>{point.trend}{point.significant ? ' · >3σ' : ''}</td></tr>)}</tbody></table></div>{deformation.pairs.length ? <div className="mt-4 overflow-x-auto border border-ds-border-muted"><table className="min-w-full text-left text-[10.5px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2 font-semibold">{t('surveyGeometry')}</th><th className="px-3 py-2 font-semibold">{t('surveyPointPair')}</th><th className="px-3 py-2 font-semibold">{t('surveyDifferentialSettlement')}</th><th className="px-3 py-2 font-semibold">{t('surveyTilt')}</th><th className="px-3 py-2 font-semibold">{t('surveyConvergenceRate')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{deformation.pairs.map((pair, index) => <tr key={pair.id}><td className="px-3 py-2.5 font-medium text-ds-ink">{pair.id} · {pair.kind}<EngineeringEvidenceQuestion label={pair.id} reference={{ kind: 'deformation', comparisonId: deformation.id, referenceAdjustmentId: deformation.referenceAdjustmentId, currentAdjustmentId: deformation.currentAdjustmentId, inputHash: deformation.inputHash, algorithmVersion: deformation.algorithmVersion, selector: { path: ['pairs', index], identity: { id: pair.id } } }} /></td><td className="px-3 py-2.5 text-ds-muted">{pair.firstPointId} ↔ {pair.secondPointId}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(pair.differentialSettlement ?? pair.convergence, 7)}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(pair.tilt, 9)}</td><td className="px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(pair.convergenceRatePerDay, 8)}</td></tr>)}</tbody></table></div> : null}<p className="mt-3 break-all font-mono text-[9.5px] text-ds-faint">{deformation.algorithmVersion} · {deformation.inputHash}</p></div> : null}</>}
          </div> : null}
        </div>

        <aside className="survey-workbench-aside border-t border-ds-border-muted bg-ds-main p-3 lg:col-span-2 2xl:col-span-1 2xl:border-l 2xl:border-t-0"><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ds-faint">{t('surveyQualityGate')}</p><div className="mt-3 space-y-2">{network?.findings.length ? network.findings.slice(0, 6).map((finding, index) => <div key={`${surveyDiagnosticText(finding, appI18n.language)}-${index}`} className={`flex gap-2 border px-2.5 py-2 text-[10.5px] leading-4 ${finding.severity === 'blocking' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'}`}><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{surveyDiagnosticText(finding, appI18n.language)}{finding.row ? <span className="ml-auto shrink-0 font-mono text-[9px]">{t('surveyRecord')}{finding.row}</span> : null}</div>) : <div className="border border-dashed border-ds-border-muted px-2.5 py-3 text-[10.5px] leading-4 text-ds-muted">{t('surveyQualityEmpty')}</div>}</div><div className="mt-4 border-t border-ds-border-muted pt-3"><p className="text-[10px] font-semibold text-ds-ink">{t('surveyCurrentInput')}</p><dl className="mt-2 space-y-2 text-[10px]"><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveySource')}</dt><dd className="max-w-[145px] truncate text-right text-ds-ink">{network?.sourceFile?.name ?? network?.id ?? t('surveyNotImported')}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyFormat')}</dt><dd className="max-w-[145px] truncate text-right text-ds-ink">{network?.sourceFile ? sourceFormatLabel(t, network.sourceFile.detection.format) : t('surveyStructuredLegacy')}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyReadiness')}</dt><dd className={`max-w-[145px] text-right ${network?.sourceFile && !sourceIsReady ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-ds-ink'}`}>{network?.sourceFile ? dispositionLabel(t, network.sourceFile.disposition) : network ? t('surveyLegacyPath') : '—'}</dd></div><div className="flex justify-between gap-2"><dt className="text-ds-faint">{t('surveyBlockers')}</dt><dd className={blockers ? 'font-semibold text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}>{blockers}</dd></div></dl></div><div className="mt-4 border-t border-ds-border-muted pt-3"><p className="flex items-center gap-1.5 text-[10px] font-semibold text-ds-ink"><FileCode2 className="h-3.5 w-3.5 text-accent" />{t('surveyTraceability')}</p></div></aside>
      </div>
    </div>
    {section !== 'free-trial' ? <SurveyResultSummary adjustment={adjustment} onAskPoint={project.workspace && onOpenAi ? (pointId) => askAboutEvidence(t('surveyExplainEvidence', { label: pointId }), { section: 'result', pointId, metric: 'point-precision' }) : undefined} /> : null}
    {message ? <p role="status" className="mt-3 border border-ds-border-muted bg-ds-subtle px-3 py-2 text-[11px] text-ds-muted">{surveyRuntimeErrorText(message, appI18n.language)}</p> : null}
    {busy ? <p className="mt-2 text-[10.5px] text-ds-faint">{t('surveyProcessing')}</p> : null}
  </section></EngineeringEvidenceQuestions>
}

function RawSourceIntegrityNote({ integrity }: { integrity: RawSourceIntegrity | undefined }): ReactElement | null {
  const { t } = useTranslation('common')
  if (!integrity) return null
  if (integrity.status === 'verified') {
    return <div className="mt-3 border border-blue-200 bg-blue-50 px-3 py-2 text-[10.5px] leading-4 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100" role="status">{t('surveyIntegrityVerified', { count: integrity.ledgerEntryCount })}</div>
  }
  if (integrity.status === 'legacy-unverified') {
    return <div className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-[10.5px] leading-4 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" role="status">{t('surveyIntegrityLegacy')}</div>
  }
  return <div className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-[10.5px] leading-4 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100" role="alert">{t('surveyIntegrityFailed', { reason: integrity.errors.map(error => surveyLegacyDiagnosticText(error, appI18n.language)).join('; ') || t('surveyIntegrityRecovery') })}</div>
}

function CosaFileGroupInspectionPanel({ inspection }: { inspection: CosaFileGroupInspection }): ReactElement {
  const { t } = useTranslation('common')
  return <section aria-label={t('surveyCosaPreflight')} className="mt-3 border border-ds-border-muted bg-ds-main px-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-[11px] font-semibold text-ds-ink">{t('surveyCosaGroups')}</p><p className="mt-0.5 text-[10px] text-ds-muted">{t('surveyCosaHint')}</p></div>
      <span className={`border px-2 py-1 text-[10px] font-medium ${inspection.diagnostics.length ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200' : 'border-green-200 bg-green-50 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-200'}`}>{inspection.diagnostics.length ? t('surveyStatBlocked', { count: inspection.diagnostics.length }) : t('surveyGroupsLinked', { count: inspection.groups.length })}</span>
    </div>
    <div className="mt-3 space-y-2">
      {inspection.groups.map((group) => <div key={group.id} className="border border-ds-border-muted bg-ds-card px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[10px] text-ds-ink">{group.id}</p><span className={`text-[10px] font-medium ${group.state === 'blocked' ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}>{group.state === 'blocked' ? t('engineeringStatusNeedsAttention') : t('surveyLinked')}</span></div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{(['in1', 'in2', 'net', 'xyo', 'ou1', 'ou2'] as const).map((kind) => <div key={kind} className="flex min-w-0 items-center gap-2 text-[10px]"><span className="w-10 shrink-0 font-mono uppercase text-ds-faint">.{kind}</span><span className="truncate text-ds-muted" title={group.members[kind].map((item) => item.name).join(', ')}>{group.members[kind].length ? group.members[kind].map((item) => item.name).join(', ') : t('surveyNotSelected')}</span></div>)}</div>
        {group.diagnostics.length ? <div className="mt-2 space-y-1">{group.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.code}-${diagnostic.memberKind}-${index}`} className="border-l-2 border-red-500 bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-800 dark:bg-red-500/10 dark:text-red-200"><span className="mr-1 font-mono text-[9px]">{diagnostic.code}</span>{surveyDiagnosticText(diagnostic, appI18n.language)}<span className="mt-0.5 block font-medium">{t('surveyNextStep')}{surveyDiagnosticText(diagnostic, appI18n.language, 'action')}</span></div>)}</div> : null}
      </div>)}
    </div>
  </section>
}

function SurveySourcePreflight({ source, showRecords, onToggleRecords, onAsk }: { source: SurveySourceFile; showRecords: boolean; onToggleRecords: () => void; onAsk?: (index: number) => void }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const blocking = source.diagnostics.filter((item) => item.severity === 'blocking').length
  const warnings = source.diagnostics.filter((item) => item.severity === 'warning').length
  const anchors = source.rawRecordAnchors.slice(0, 50)
  return <section className="mt-3 border border-ds-border-muted bg-ds-card" aria-label={t('surveyPreflight')}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ds-border-muted px-3 py-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-[12px] font-semibold text-ds-ink">{source.name}</p><span className={`border px-2 py-0.5 text-[10px] font-semibold ${dispositionTone(source.disposition)}`}>{dispositionLabel(t, source.disposition)}</span></div><p className="mt-1 text-[10.5px] text-ds-muted">{i18n.language.startsWith('en') && source.detection.vendor === 'COSA(科傻)' ? 'COSA' : source.detection.vendor} · {sourceFormatLabel(t, source.detection.format)}{source.detection.version ? ` ${t('surveyVersion', { version: source.detection.version })}` : ''} · {t('surveyConfidence', { value: Math.round(source.detection.confidence * 100) })}</p></div>
      <div className="text-right text-[10px] text-ds-faint"><p>{t('surveySourceSize', { count: source.recordCount, size: (source.size / 1024).toLocaleString(i18n.language, { maximumFractionDigits: 1 }) })}</p><p className="mt-1">{t('surveyOriginal')}{source.originalPreserved ? t('surveyPreserved') : t('surveyAbnormalStatus')}</p></div>
    </div>
    <SurveySourceProvenance source={source} />
    <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 px-3 py-3">
        <dl className="grid gap-x-5 gap-y-2 text-[10.5px] sm:grid-cols-2"><div><dt className="text-ds-faint">SHA-256</dt><dd className="mt-0.5 break-all font-mono text-[9.5px] text-ds-ink">{source.sha256}</dd></div><div><dt className="text-ds-faint">{t('surveyParser')}</dt><dd className="mt-0.5 text-ds-ink">{source.parserId} · {source.parserVersion}</dd></div><div><dt className="text-ds-faint">{t('surveyContentSignature')}</dt><dd className="mt-0.5 text-ds-ink">{source.detection.matchedSignatures.join('、') || t('surveyUnmatched')}</dd></div><div><dt className="text-ds-faint">{t('surveyExtensionConsistency')}</dt><dd className={`mt-0.5 ${source.detection.extensionConflict ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ds-ink'}`}>{source.detection.extension ?? t('surveyNoExtension')} · {source.detection.extensionConflict ? t('surveyContentConflict') : t('surveyNoConflict')}</dd></div>{source.converter ? <><div><dt className="text-ds-faint">{t('surveyLocalConverter')}</dt><dd className="mt-0.5 text-ds-ink">{source.converter.id} {source.converter.version} · {source.converter.status}</dd></div><div><dt className="text-ds-faint">{t('surveyConverterPermissions')}</dt><dd className="mt-0.5 text-ds-ink">{t('surveyNetworkAccess')}{source.converter.networkAccess} · {source.converter.license}</dd></div></> : null}</dl>
        <div className="mt-3 border-t border-ds-border-muted pt-3"><div className="flex items-center justify-between gap-2"><p className="text-[10.5px] font-semibold text-ds-ink">{t('surveyDiagnostics')}</p><span className="text-[10px] text-ds-faint">{t('surveyDiagnosticCounts', { blocking, warnings })}</span></div><div className="mt-2 space-y-1.5">{source.diagnostics.length ? source.diagnostics.slice(0, 20).map((item, index) => <div key={`${item.code}-${item.sourceRecord ?? item.byteOffset ?? index}`} className={`flex items-start gap-2 border-l-2 px-2 py-1.5 text-[10px] leading-4 ${item.severity === 'blocking' ? 'border-red-500 bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200' : item.severity === 'warning' ? 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200' : 'border-ds-border bg-ds-subtle text-ds-muted'}`}><span className="shrink-0 font-mono text-[9px] uppercase">{item.code}</span><span><button type="button" disabled={!onAsk} aria-label={t('surveyAskEvidence', { label: `${item.code} #${index + 1}` })} onClick={() => onAsk?.(index)} className="mr-2 text-accent disabled:opacity-50">{t('surveyAskAgent')}</button>{surveyDiagnosticText(item, appI18n.language)}{item.sourceRecord ? ` · ${t('surveyRecordNumber', { number: item.sourceRecord })}` : ''}{item.byteOffset !== undefined ? ` · ${t('surveyByteNumber', { number: item.byteOffset })}` : ''}{item.suggestedAction ? <span className="mt-0.5 block font-medium">{t('surveyNextStep')}{surveyDiagnosticText(item, appI18n.language, 'action')}</span> : null}</span></div>) : <p className="text-[10px] text-ds-muted">{t('surveyNoDiagnostics')}</p>}</div></div>
      </div>
      <aside className="border-t border-ds-border-muted bg-ds-main px-3 py-3 lg:border-l lg:border-t-0"><div className="flex items-center justify-between gap-2"><p className="text-[10.5px] font-semibold text-ds-ink">{t('surveyRawAnchors')}</p><button type="button" onClick={onToggleRecords} disabled={!anchors.length} aria-expanded={showRecords} className="h-7 border border-ds-border px-2 text-[10px] text-ds-muted disabled:opacity-50">{showRecords ? t('engineeringCollapse') : t('surveyViewRecords', { count: source.rawRecordAnchors.length })}</button></div><p className="mt-1 text-[10px] leading-4 text-ds-faint">{t('surveyAnchorsHint')}</p>{showRecords ? <div className="mt-2 max-h-48 overflow-y-auto border border-ds-border-muted bg-ds-card"><table className="min-w-full text-left text-[9.5px]"><thead className="sticky top-0 bg-ds-subtle text-ds-faint"><tr><th className="px-2 py-1.5">{t('surveyRecord')}</th><th className="px-2 py-1.5">{t('surveyTypeSection')}</th><th className="px-2 py-1.5">{t('surveyLocation')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{anchors.map((item) => <tr key={item.id}><td className="px-2 py-1.5 font-mono text-ds-ink">{item.sourceRecord}</td><td className="px-2 py-1.5 text-ds-muted">{item.recordType ?? '—'}{item.section ? ` / ${item.section}` : ''}</td><td className="px-2 py-1.5 text-ds-muted">{item.line ? t('surveyLineNumber', { number: item.line }) : item.byteOffset !== undefined ? t('surveyByteNumber', { number: item.byteOffset }) : '—'}</td></tr>)}</tbody></table></div> : null}{source.rawRecordAnchors.length > anchors.length ? <p className="mt-2 text-[9.5px] text-ds-faint">{t('surveyAnchorLimit', { count: anchors.length })}</p> : null}</aside>
    </div>
  </section>
}

function ResidualSourceAnchorPanel({ resolution, onDismiss }: { resolution: ResidualSourceAnchorResolution; onDismiss: () => void }): ReactElement {
  const { t } = useTranslation('common')
  if (resolution.status === 'unavailable') {
    return <section aria-label={t('surveyResidualLocation')} role="status" className="border-t border-amber-200 bg-amber-50 px-3 py-3 text-[10.5px] leading-4 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{t('surveyRecordUnavailable')}</p><p className="mt-1">sourceRecordId：<code className="font-mono">{resolution.sourceRecordId}</code></p><p className="mt-1">{surveyLegacyDiagnosticText(resolution.reason, appI18n.language)}</p></div><button type="button" onClick={onDismiss} className="shrink-0 border border-amber-300 px-2 py-1 text-[10px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/20">{t('surveyClose')}</button></div></section>
  }

  const { anchor } = resolution
  return <section aria-label={t('surveyResidualLocation')} className="border-t border-blue-200 bg-blue-50 px-3 py-3 text-[10.5px] leading-4 text-blue-950 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-50"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{t('surveyRecordLocation')}</p><p className="mt-1 text-blue-800 dark:text-blue-100">{t('surveyRecordLocationHint')}</p></div><button type="button" onClick={onDismiss} className="shrink-0 border border-blue-300 px-2 py-1 text-[10px] font-medium text-blue-900 hover:bg-blue-100 dark:border-blue-500/40 dark:text-blue-100 dark:hover:bg-blue-500/20">{t('surveyClose')}</button></div><dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2"><div><dt className="text-blue-700 dark:text-blue-200">{t('surveyRawRecordId')}</dt><dd className="mt-0.5 break-all font-mono text-ds-ink dark:text-white">{resolution.sourceRecordId}</dd></div><div><dt className="text-blue-700 dark:text-blue-200">{t('surveySectionType')}</dt><dd className="mt-0.5 text-ds-ink dark:text-white">{anchor.section ?? t('surveyUndeclared')}{anchor.recordType ? ` / ${anchor.recordType}` : ''}</dd></div><div><dt className="text-blue-700 dark:text-blue-200">{t('surveyByteOffset')}</dt><dd className="mt-0.5 font-mono tabular-nums text-ds-ink dark:text-white">{anchor.rawOffset}</dd></div><div><dt className="text-blue-700 dark:text-blue-200">{t('surveyByteLength')}</dt><dd className="mt-0.5 font-mono tabular-nums text-ds-ink dark:text-white">{anchor.rawLength}</dd></div></dl><div className="mt-3"><p className="text-blue-700 dark:text-blue-200">{t('surveyRawExcerpt')}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words border border-blue-200 bg-ds-card p-2 font-mono text-[9.5px] leading-4 text-ds-ink dark:border-blue-500/30 dark:bg-ds-main dark:text-white">{anchor.rawSnippet || t('surveyExcerptMissing')}</pre></div></section>
}

function SurveySourceProvenance({ source }: { source: SurveySourceFile }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const sourceFormat = source.formatId ?? source.detection.format
  const sourceVendor = source.vendor ?? source.detection.vendor ?? t('surveyLegacyMissing')
  const formatVersion = source.formatVersion === null ? t('surveyUndeclared') : source.formatVersion ?? source.detection.version ?? t('surveyLegacyMissing')
  const declaredExtension = source.extensionClaimed ?? source.detection.extension ?? t('surveyUndeclared')
  const detectionMethod = source.detectionMethod ?? source.detection.method
  const detectionConfidence = source.detectionConfidence ?? source.detection.confidence
  const extensionConflict = source.extensionContentConflict ?? source.detection.extensionConflict
  const summaryCount = (value: number | undefined): string => value === undefined ? t('surveyLegacyMissing') : value.toLocaleString(i18n.language.startsWith('en') ? 'en-US' : 'zh-CN')
  const converterId = source.converterId ?? source.converter?.id
  const converterVersion = source.converterVersion ?? source.converter?.version
  const converterBinaryHash = source.converterBinaryHash ?? source.converter?.executableHash
  const hasConverter = Boolean(converterId || converterVersion || converterBinaryHash || source.converter)

  return <div className="border-b border-ds-border-muted bg-ds-main px-3 py-3" aria-label={t('surveyProvenance')}>
    <dl className="grid gap-x-5 gap-y-2.5 text-[10.5px] sm:grid-cols-2 xl:grid-cols-3">
      <div><dt className="text-ds-faint">{t('surveyDeclaredExtension')}</dt><dd className="mt-0.5 font-mono text-ds-ink">{declaredExtension}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyVendorFormat')}</dt><dd className="mt-0.5 text-ds-ink">{i18n.language.startsWith('en') && sourceVendor === 'COSA(科傻)' ? 'COSA' : sourceVendor} · {sourceFormatLabel(t, sourceFormat)} · {t('surveyVersion', { version: formatVersion })}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyDetectionConfidence')}</dt><dd className="mt-0.5 text-ds-ink">{detectionMethodLabel(t, detectionMethod)} · {typeof detectionConfidence === 'number' ? `${Math.round(detectionConfidence * 100)}%` : t('surveyLegacyMissing')}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyExtensionConfirmation')}</dt><dd className={`mt-0.5 ${extensionConflict ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ds-ink'}`}>{extensionConflict ? t('surveyContentConflict') : t('surveyNoConflict')} · {source.requiresManualConfirmation === undefined ? t('surveyLegacyMissing') : source.requiresManualConfirmation ? t('surveyConfirmationRequired') : t('surveyConfirmationNotRequired')}</dd></div>
      <div className="sm:col-span-2"><dt className="text-ds-faint">{t('surveyDispositionNext')}</dt><dd className="mt-0.5 leading-4 text-ds-ink"><span className="font-medium">{dispositionLabel(t, source.disposition)}</span> · {surveyDiagnosticText({ message: source.dispositionReason ?? t('surveyLegacyMissing'), ...(source.dispositionReasonEn ? { localized: { en: { message: source.dispositionReasonEn } } } : {}) }, i18n.language)}<span className="block text-ds-muted">{dispositionRecovery(t, source.disposition)}</span></dd></div>
      <div><dt className="text-ds-faint">{t('surveyLinearUnits')}</dt><dd className="mt-0.5 text-ds-ink">{source.linearUnitRaw ?? t('surveyLegacyMissing')} → {canonicalUnitLabel(t, source.linearUnitCanonical)}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyAngularUnits')}</dt><dd className="mt-0.5 text-ds-ink">{source.angularUnitRaw ?? t('surveyLegacyMissing')} → {canonicalUnitLabel(t, source.angularUnitCanonical)}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyDatums')}</dt><dd className="mt-0.5 text-ds-ink">{source.datumDeclared === null ? t('surveyUndeclared') : source.datumDeclared ?? t('surveyLegacyMissing')} / {source.heightSystemDeclared === null ? t('surveyUndeclared') : source.heightSystemDeclared ?? t('surveyLegacyMissing')}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyPointsStations')}</dt><dd className="mt-0.5 tabular-nums text-ds-ink">{summaryCount(source.summary?.pointCount)} / {summaryCount(source.summary?.stationCount)}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyObservationCounts')}</dt><dd className="mt-0.5 tabular-nums text-ds-ink">{summaryCount(source.summary?.observationCount)} / {summaryCount(source.summary?.recordCount ?? source.recordCount)} / {summaryCount(source.summary?.skippedRecordCount)}</dd></div>
      <div><dt className="text-ds-faint">{t('surveyParserHash')}</dt><dd className="mt-0.5 break-all font-mono text-[9.5px] text-ds-ink">{source.parserSourceHash ?? t('surveyLegacyMissing')}</dd></div>
      <div className="sm:col-span-2"><dt className="text-ds-faint">{t('surveyConverterIdentity')}</dt><dd className="mt-0.5 break-all text-ds-ink">{hasConverter ? <>{converterId ?? t('surveyLegacyMissing')} {converterVersion ?? t('surveyLegacyMissing')} · <span className="font-mono text-[9.5px]">{converterBinaryHash ?? t('surveyLegacyMissing')}</span></> : t('surveyNoConverter')}</dd></div>
    </dl>
  </div>
}

function SurveyResultSummary({ adjustment, onAskPoint }: { adjustment: Adjustment | null; onAskPoint?: (pointId: string) => void }): ReactElement | null {
  const { t } = useTranslation('common')
  // 粗差候选判定采用标准化残差 > 3σ，并同时尊重 Runtime 返回的 outlier 标记。
  if (!adjustment || !adjustment.result.points?.length) return null
  const admissible = isAdmissibleCompletedAdjustment(adjustment)
  const pointRows = adjustment.result.points
  const outlierCount = adjustment.result.observations?.filter((item) => item.outlier || Math.abs(item.standardizedResidual ?? 0) > 3).length ?? 0
  const linearUnit = adjustment.result.linearUnit ?? 'm'
  return <section className="survey-result-summary mt-3 border border-ds-border-muted bg-ds-card" aria-label={t('surveyPointResults')}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ds-border-muted px-4 py-3"><div><h4 className="text-[12.5px] font-semibold text-ds-ink">{t('surveyPointSummary')}</h4><p className="mt-0.5 text-[10.5px] text-ds-muted">{admissible ? t('surveyPointResultsValid') : t('surveyPointResultsAudit')}</p></div><div className="flex items-center gap-3 text-[10.5px] text-ds-faint"><span>{t('surveyLengthUnit')}{linearUnit}</span><span>{t('surveyCovariance')}{adjustment.result.covariance?.length ? t('surveyReturned') : t('surveyNotReturned')}</span><span className={outlierCount ? 'font-semibold text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}>{t('surveyOutliers')}{outlierCount}</span></div></div>
    <p className="px-4 py-2 text-[10.5px] text-ds-muted">{t('surveyErrorEllipseHint')}</p>
    <div role="region" aria-label={t('surveyPointResults')} tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"><table className="w-full min-w-[840px] text-left text-[10.5px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2 font-semibold">{t('surveyPointId')}</th><th className="px-3 py-2 font-semibold">{t('surveyAdjustedX', { unit: linearUnit })}</th><th className="px-3 py-2 font-semibold">{t('surveyAdjustedY', { unit: linearUnit })}</th><th className="px-3 py-2 font-semibold">{t('surveyLatitudeLongitude')}</th><th className="px-3 py-2 font-semibold">{t('surveyAdjustedHeight', { unit: linearUnit })}</th><th className="px-3 py-2 font-semibold">{t('surveyCorrection', { unit: linearUnit })}</th><th className="px-3 py-2 font-semibold">{t('surveyPointError', { unit: linearUnit })}</th><th className="px-3 py-2 font-semibold">{t('surveyErrorEllipse')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{pointRows.map((point) => <tr key={point.id} tabIndex={-1} data-evidence-key={JSON.stringify(['point', point.id])} className="hover:bg-ds-hover focus:bg-accent/10 focus:outline focus:outline-2 focus:outline-accent"><td className="min-w-28 px-3 py-2.5 font-medium text-ds-ink">{point.id}<button type="button" disabled={!onAskPoint} aria-label={t('surveyAskEvidence', { label: point.id })} onClick={() => onAskPoint?.(point.id)} className="mt-1 block whitespace-nowrap text-accent disabled:opacity-50">{t('surveyAskAgent')}</button></td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.x, 6)}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.y, 6)}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-ink">{point.latitude === undefined && point.longitude === undefined ? '—' : `${numberLabel(point.latitude, 8)} / ${numberLabel(point.longitude, 8)}`}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-ink">{numberLabel(point.height, 6)}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-muted">{numberLabel(point.correctionHeight ?? point.correctionX ?? point.correctionY, 7)}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-muted">{numberLabel(point.standardError, 6)}</td><td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-ds-muted">{point.xyErrorEllipse ? <div className="min-w-40" title={t('surveyErrorEllipseHint')}><p>{t('surveyErrorEllipseAxes', { major: numberLabel(point.xyErrorEllipse.semiMajor, 6), minor: numberLabel(point.xyErrorEllipse.semiMinor, 6) })}</p><p>{t('surveyErrorEllipseOrientation', { angle: point.xyErrorEllipse.orientationRad === null ? t('surveyErrorEllipseNoOrientation') : `${numberLabel(point.xyErrorEllipse.orientationRad * 180 / Math.PI, 4)}°` })}</p><p className="text-ds-faint">{t(point.xyErrorEllipse.varianceBasis === 'a-posteriori' ? 'surveyErrorEllipsePosterior' : 'surveyErrorEllipsePrior')}</p></div> : '—'}</td></tr>)}</tbody></table></div>
  </section>
}
