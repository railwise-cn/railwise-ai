import { SurveyQualityAssessmentWorkspace } from './SurveyQualityAssessmentWorkspace'
import { SurveyQualityScoringWorkspace } from './SurveyQualityScoringWorkspace'
import { SurveyQualitySamplingWorkspace } from './SurveyQualitySamplingWorkspace'
import { SurveyAdvancedModelWorkspace } from './SurveyAdvancedModelWorkspace'
import { SurveyQualityWorkspace } from './SurveyQualityWorkspace'
import './engineering-review.css'
import { focusEvidenceElement, navigationTargetIsCurrent, type EngineeringEvidenceNavigationTarget, type EngineeringNavigationContext } from './engineering-evidence-navigation'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Calculator,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Database,
  FileCheck2,
  FileOutput,
  FileSpreadsheet,
  FolderKanban,
  HardHat,
  Info,
  LineChart,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Upload,
  XCircle
} from 'lucide-react'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'
import { surveyDiagnosticText, surveyRuntimeErrorText } from './survey-diagnostic-text'
import { surveyDatumLabel } from './survey-summary'
import { ENGINEERING_TREND_RENDERER_VERSION, ENGINEERING_ANALYSIS_ALGORITHM_VERSION } from '@shared/engineering-chart'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { EngineeringAiCommandCenter } from './EngineeringAiCommandCenter'
import { SurveyAdjustmentPanel } from './SurveyAdjustmentPanel'
import { selectSurveyClosureKey, surveyReadiness, surveyMeasurementNumber } from './survey-summary'
import { engineeringTaskTypes, engineeringTaskLabel, surveyNetworkTypeLabel } from './engineering-task-types'
import { prepareEngineeringQuestion, type EngineeringEvidenceReference } from './engineering-conversation-drafts'
import { EngineeringEvidenceQuestion, EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { EngineeringSkillsPanel } from './EngineeringSkillsPanel'
import { EngineeringManifestVerification } from './EngineeringManifestVerification'
import { validEngineeringReportPeriod } from './engineering-report-period'
import {
  activeEngineeringProjectId,
  chooseEngineeringProjectId,
  consumeRequestedEngineeringProject,
  setActiveEngineeringProject
} from './engineering-project-navigation'

type Project = {
  id: string
  name: string
  taskContext?: Partial<Record<'networkType' | 'coordinateSystem' | 'verticalDatum' | 'measurementGrade' | 'standard' | 'standardVersion' | 'standardClause', string>>
  taskType?: string
  monitoringType: string
  unit: string
  signConvention: string
  thresholds: Record<string, number>
  reportPeriod: { start?: string; end?: string }
  workspace: string
  revision: number
  updatedAt: string
}

type Finding = {
  id: string
  code: string
  severity: 'blocking' | 'warning' | 'info'
  message: string
  suggestion: string
  status: 'open' | 'resolved' | 'accepted'
  row?: number
}

type Dataset = {
  id: string
  sourceFileName: string
  sourceFileHash: string
  fieldMapping: Record<string, string | undefined>
  unknownColumns: string[]
  rowCount: number
  columnCount: number
  observationCount: number
  timeRange: { start?: string; end?: string }
  status: 'imported' | 'validated' | 'failed' | 'cancelled'
  revision: number
  findings: Finding[]
  updatedAt: string
}

type AnalysisResult = {
  monitoringItem: string
  point: string
  currentValue?: number
  previousValue?: number
  cumulativeChange?: number
  changeRate?: number
  trend: 'rising' | 'falling' | 'stable' | 'unknown'
  anomaly: boolean
  thresholdStatus: 'normal' | 'warning' | 'alarm' | 'control' | 'unresolved'
}

type Analysis = {
  id: string
  datasetId: string
  inputHash: string
  algorithmVersion: string
  results: AnalysisResult[]
  createdAt: string
}

type Output = { path: string; mediaType: string; sha256: string; sizeBytes: number }
type Chart = { id: string; chartType: string; relativePath: string; sha256: string; validation: string }
type Citation = { id: string; sourceType: 'attachment' | 'knowledge-base' | 'standard' | 'other'; source: string; locator?: string }
type Run = { id: string; datasetId?: string; analysisId?: string; status: string; revision: number; createdAt: string; updatedAt: string; error?: string }
type Manifest = { id: string; runId: string; reviewStatus: string; outputs: Output[]; citations: Citation[]; adjustments?: Array<{ id: string; runId: string; networkId: string; validation: string }>; deformations?: Array<{ id: string; referenceEpoch: string; currentEpoch: string; points: Array<{ pointId: string }> }>; validation: { valid: boolean; errors: string[]; warnings: string[] }; finalizedAt?: string }
type ReportPreview = { run: Run; files: Output[]; charts: Chart[]; citations: Citation[]; adjustments?: Array<{ id: string; runId: string; networkId: string; validation: string; displacements?: Array<{ pointId: string; dX?: number; dY?: number; dH?: number; magnitude: number }> }>; deformations?: Array<{ id: string; referenceEpoch: string; currentEpoch: string; points: Array<{ pointId: string }> }> }
type Overview = { project: Project; datasets: Dataset[]; analyses: Analysis[]; runs: Run[]; manifests: Manifest[] }
type SurveyNetworkSummary = {
  id: string
  revision: number
  networkType: string
  coordinateSystem?: string
  verticalDatum?: string
  knownPoints?: Array<{ id: string }>
  unknownPoints?: Array<{ id: string }>
  observations?: Array<{ station?: string; from?: string; to?: string }>
  qualityStatus?: string
  sourceFile?: {
    name: string
    sha256?: string
    disposition: 'adjustment-ready' | 'gnss-processing-required' | 'converter-required' | 'archive-only'
    detection?: { format?: string }
    summary?: { pointCount?: number; stationCount?: number; observationCount?: number }
  }
}
type SurveyAdjustmentSummary = {
  run: { id: string; networkId: string; status: string; updatedAt?: string }
  result?: {
    observationCount?: number
    closure?: Record<string, number>
    closureUnits?: Record<string, string>
    precision?: { maxPointStdDev?: number; relativePrecision?: number; passed?: boolean }
    validation?: string
  }
  sourceEligibility?: { eligible: boolean }
}
type TabId = 'ai-command' | 'dashboard' | 'project' | 'data' | 'quality' | 'source' | 'survey' | 'advanced-models' | 'precision' | 'analysis' | 'deliverables' | 'review' | 'skills'
type Notice = { tone: 'success' | 'warning' | 'error' | 'info'; message: string }
type ProjectDraft = Pick<Project, 'name' | 'taskContext' | 'taskType' | 'monitoringType' | 'unit' | 'signConvention' | 'reportPeriod'> & { thresholdsText: string }

type TabDefinition = { id: TabId; labelKey: string; shortLabelKey: string; icon: typeof FolderKanban; group: 'agent' | 'compute' | 'delivery' }
const TABS: ReadonlyArray<TabDefinition> = [
  { id: 'ai-command', labelKey: 'engineeringTabAi', shortLabelKey: 'engineeringTabAiShort', icon: Sparkles, group: 'agent' },
  { id: 'dashboard', labelKey: 'engineeringTabDashboard', shortLabelKey: 'engineeringTabDashboardShort', icon: Activity, group: 'agent' },
  { id: 'project', labelKey: 'engineeringTabProject', shortLabelKey: 'engineeringTabProjectShort', icon: FolderKanban, group: 'compute' },
  { id: 'data', labelKey: 'engineeringTabData', shortLabelKey: 'engineeringTabDataShort', icon: Database, group: 'compute' },
  { id: 'quality', labelKey: 'engineeringTabQuality', shortLabelKey: 'engineeringTabQualityShort', icon: ShieldCheck, group: 'compute' },
  { id: 'source', labelKey: 'engineeringTabSource', shortLabelKey: 'engineeringTabSource', icon: Upload, group: 'compute' },
  { id: 'precision', labelKey: 'engineeringTabPrecision', shortLabelKey: 'engineeringTabPrecision', icon: LineChart, group: 'compute' },
  { id: 'survey', labelKey: 'engineeringTabSurvey', shortLabelKey: 'engineeringTabSurveyShort', icon: Calculator, group: 'compute' },
  { id: 'advanced-models', labelKey: 'advancedTitle', shortLabelKey: 'advancedTitle', icon: Calculator, group: 'compute' },
  { id: 'analysis', labelKey: 'engineeringTabAnalysis', shortLabelKey: 'engineeringTabAnalysisShort', icon: LineChart, group: 'compute' },
  { id: 'deliverables', labelKey: 'engineeringTabDeliverables', shortLabelKey: 'engineeringTabDeliverablesShort', icon: FileOutput, group: 'delivery' },
  { id: 'review', labelKey: 'engineeringTabReview', shortLabelKey: 'engineeringTabReviewShort', icon: ClipboardCheck, group: 'delivery' },
  { id: 'skills', labelKey: 'engineeringTabSkills', shortLabelKey: 'engineeringTabSkillsShort', icon: BookOpen, group: 'delivery' }
]
// The old tab ids remain valid for deep links and persisted sessions. The visible
// navigation is intentionally stage-oriented so operators follow the production
// chain instead of having to understand the implementation's former ten tabs.
type StageDefinition = { id: 'import' | 'adjustment' | 'analysis' | 'delivery'; labelKey: string; icon: typeof FolderKanban; tabs: readonly TabId[] }
const STAGES: ReadonlyArray<StageDefinition> = [
  { id: 'import', labelKey: 'engineeringStageImport', icon: Upload, tabs: ['source', 'project', 'data', 'quality'] },
  { id: 'adjustment', labelKey: 'engineeringStageAdjustment', icon: Calculator, tabs: ['survey', 'advanced-models'] },
  { id: 'analysis', labelKey: 'engineeringStageAnalysis', icon: LineChart, tabs: ['precision', 'analysis'] },
  { id: 'delivery', labelKey: 'engineeringStageDelivery', icon: FileOutput, tabs: ['deliverables', 'review', 'dashboard', 'skills'] }
]

function stageForTab(tab: TabId): StageDefinition {
  return STAGES.find((stage) => stage.tabs.includes(tab)) ?? STAGES[0]
}

const findingTone: Record<Finding['severity'], string> = {
  blocking: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200'
}

const thresholdTone: Record<AnalysisResult['thresholdStatus'], string> = {
  normal: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-300',
  alarm: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  control: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  unresolved: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-300'
}

async function runtimeRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body))
  if (!response.ok) {
    let detail = response.body
    try {
      const parsed = JSON.parse(response.body) as { message?: string }
      detail = parsed.message ?? detail
    } catch {
      /* Keep the Runtime response when it is not JSON. */
    }
    throw new Error(detail || `Runtime request failed (${response.status})`)
  }
  return JSON.parse(response.body) as T
}

function projectToDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    taskType: project.taskType,
    taskContext: project.taskContext,
    monitoringType: project.monitoringType,
    unit: project.unit,
    signConvention: project.signConvention,
    reportPeriod: project.reportPeriod,
    thresholdsText: Object.entries(project.thresholds).map(([name, value]) => `${name} = ${value}`).join('\n')
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

function parseThresholds(value: string, translate: Translate): Record<string, number> {
  const thresholds: Record<string, number> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) throw new Error(translate('engineeringThresholdFormatError', { line: trimmed }))
    const name = trimmed.slice(0, separator).trim()
    const numberValue = Number(trimmed.slice(separator + 1).trim())
    if (!name || !Number.isFinite(numberValue)) throw new Error(translate('engineeringThresholdValueError', { line: trimmed }))
    thresholds[name] = numberValue
  }
  return thresholds
}

function formatNumber(value: number | undefined, locale: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(locale, { maximumFractionDigits: 4 }) : '—'
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale, { hour12: false })
}

function formatBytes(value: number, locale: string): string {
  if (value < 1024) return `${value.toLocaleString(locale)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KB`
  return `${(value / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`
}

function fileToBase64(file: File, translate: Translate): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(translate('engineeringFileReadError')))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const separator = result.indexOf(',')
      if (separator < 0) {
        reject(new Error(translate('engineeringFileEncodeError')))
        return
      }
      resolve(result.slice(separator + 1))
    }
    reader.readAsDataURL(file)
  })
}

function statusLabel(status: string, translate: Translate): string {
  const key = ({ normal: 'engineeringStatusNormal', warning: 'engineeringStatusWarning', alarm: 'engineeringStatusAlarm', control: 'engineeringStatusControl', unresolved: 'engineeringStatusUnresolved', rising: 'engineeringStatusRising', falling: 'engineeringStatusFalling', stable: 'engineeringStatusStable', unknown: 'engineeringStatusUnknown', imported: 'engineeringStatusImported', validated: 'engineeringStatusValidated', completed: 'engineeringStatusCompleted', cancelled: 'engineeringStatusCancelled', draft: 'engineeringStatusDraft', approved: 'engineeringStatusApproved', archived: 'engineeringStatusArchived' } as Record<string, string>)[status]
  return key ? translate(key) : status
}

function PanelHeading({ title, description, action }: { title: string; description: string; action?: ReactElement }): ReactElement {
  return <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ds-border-muted px-5 py-4">
    <div className="min-w-0"><h2 className="text-[16px] font-semibold text-ds-ink">{title}</h2><p className="mt-1 text-[12.5px] leading-5 text-ds-muted">{description}</p></div>
    {action}
  </div>
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactElement }): ReactElement {
  return <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
    <HardHat className="h-9 w-9 text-ds-faint" strokeWidth={1.4} />
    <h3 className="mt-4 text-[15px] font-semibold text-ds-ink">{title}</h3>
    <p className="mt-1 max-w-md text-[12.5px] leading-5 text-ds-muted">{detail}</p>
    {action ? <div className="mt-5">{action}</div> : null}
  </div>
}

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: string | number; detail: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }): ReactElement {
  const toneClass = tone === 'success' ? 'text-green-700 dark:text-green-300' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : tone === 'danger' ? 'text-red-700 dark:text-red-300' : 'text-ds-ink'
  return <div className="border border-ds-border-muted bg-ds-card px-3 py-3">
    <p className="text-[11px] font-medium text-ds-muted">{label}</p>
    <p className={`mt-1 tabular-nums text-[24px] font-semibold leading-7 ${toneClass}`}>{value}</p>
    <p className="mt-1 truncate text-[11px] text-ds-faint">{detail}</p>
  </div>
}

function DeliveryStage({ index, icon: Icon, title, detail, state, attention = false, onOpen }: {
  index: number
  icon: typeof FolderKanban
  title: string
  detail: string
  state: string
  attention?: boolean
  onOpen: () => void
}): ReactElement {
  return <button type="button" onClick={onOpen} className="group grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-ds-border-muted px-4 py-3 text-left last:border-b-0 hover:bg-ds-hover">
    <span className={`flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold ${attention ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' : 'bg-ds-subtle text-ds-muted'}`}>{index}</span>
    <span className="min-w-0"><span className="flex items-center gap-2 text-[12.5px] font-medium text-ds-ink"><Icon className="h-3.5 w-3.5 text-accent" strokeWidth={1.7} />{title}</span><span className="mt-1 block truncate text-[11px] text-ds-muted">{detail}</span></span>
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${attention ? 'text-amber-800 dark:text-amber-200' : 'text-ds-muted'}`}>{state}<ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
  </button>
}

export function EngineeringWorkspaceView({ workspaceRoot, runtimeReady, leftSidebarCollapsed, onToggleLeftSidebar }: { workspaceRoot: string; runtimeReady: boolean; leftSidebarCollapsed?: boolean; onToggleLeftSidebar?: () => void }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US'
  const ensureEngineeringThread = useChatStore((state) => state.ensureEngineeringThread)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState(() => activeEngineeringProjectId())
  const [loadedOverview, setOverview] = useState<Overview | null>(null)
  const overview = loadedOverview?.project.id === selectedProjectId && loadedOverview.project.workspace === workspaceRoot ? loadedOverview : null
  const requestScope = useRef({ workspaceRoot, runtimeReady, projectId: selectedProjectId })
  const overviewRequest = useRef(0)
  const summaryRequest = useRef(0)
  const projectsRequest = useRef(0)
  const invalidateProjectReads = useCallback((): void => {
    requestScope.current = { ...requestScope.current }
    overviewRequest.current++
    summaryRequest.current++
  }, [])
  const invalidateProjectList = useCallback((): void => { projectsRequest.current++ }, [])
  const [surveyNetworks, setSurveyNetworks] = useState<SurveyNetworkSummary[]>([])
  const [surveyAdjustments, setSurveyAdjustments] = useState<SurveyAdjustmentSummary[]>([])
  const [surveyRefreshToken, setSurveyRefreshToken] = useState(0)
  const [selectedSurveyNetworkId, setSelectedSurveyNetworkId] = useState('')
  const [selectedDatasetId, setSelectedDatasetId] = useState('')
  const [selectedAnalysisId, setSelectedAnalysisId] = useState('')
  const [requestedSurveyAdjustmentIds, setSurveyAdjustmentIds] = useState<string[]>([])
  const [surveyDeformationIds, setSurveyDeformationIds] = useState<string[]>([])
  const stageScope = JSON.stringify([workspaceRoot, selectedProjectId])
  const [tabsByScope, setTabsByScope] = useState<Record<string, TabId>>({})
  const savedTab = readBrowserStorageItem(`workwise.survey.stage.v1:${stageScope}`)
  const tab: TabId = tabsByScope[stageScope] ?? (TABS.some((item) => item.id === savedTab) ? savedTab as TabId : 'source')
  const setTab = useCallback((next: TabId): void => {
    setTabsByScope((current) => ({ ...current, [stageScope]: next }))
    writeBrowserStorageItem(`workwise.survey.stage.v1:${stageScope}`, next)
  }, [stageScope])
  const [pendingSurveyFiles, setPendingSurveyFiles] = useState<Record<string, File[]>>({})
  const surveyFileScope = JSON.stringify([workspaceRoot, selectedProjectId])
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null)
  const [citations, setCitations] = useState<Citation[]>([])
  const [citationSource, setCitationSource] = useState('')
  const [citationType, setCitationType] = useState<Citation['sourceType']>('standard')
  const [citationLocator, setCitationLocator] = useState('')
  const [preview, setPreview] = useState<ReportPreview | null>(null)
  const [chart, setChart] = useState<Chart | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const creatingProject = useRef(false)
  const [selectedSurveyNetworkRevision, setSelectedSurveyNetworkRevision] = useState<number | undefined>()
  const workspaceElement = useRef<HTMLDivElement>(null)
  const focusedEvidence = useRef<EngineeringEvidenceNavigationTarget | null>(null)
  const [evidenceNavigation, setEvidenceNavigation] = useState<EngineeringEvidenceNavigationTarget | null>(null)
  const navigationContext = useMemo<EngineeringNavigationContext | null>(() => overview ? { workspaceRoot, project: overview.project, networks: surveyNetworks, adjustments: surveyAdjustments, datasets: overview.datasets, analyses: overview.analyses, manifests: overview.manifests } : null, [overview, workspaceRoot, surveyNetworks, surveyAdjustments])
  const openEvidence = (target: EngineeringEvidenceNavigationTarget): void => {
    if (!navigationContext || !navigationTargetIsCurrent(navigationContext, target)) {
      setNotice({ tone: 'warning', message: t('engineeringEvidenceUnavailable') })
      return
    }
    setEvidenceNavigation({ ...target })
    if (target.kind === 'survey') setTab(target.section === 'result' ? 'precision' : 'source')
    else if (target.kind === 'dataset') { setSelectedDatasetId(target.datasetId); setTab(target.findingId ? 'quality' : 'data') }
    else if (target.kind === 'analysis') { setSelectedDatasetId(target.datasetId); setSelectedAnalysisId(target.analysisId); setTab('analysis') }
    else setTab('review')
  }
  useEffect(() => {
    if (!evidenceNavigation || evidenceNavigation.kind === 'survey' || !workspaceElement.current) return
    if (!navigationContext || !navigationTargetIsCurrent(navigationContext, evidenceNavigation)) {
      setEvidenceNavigation(null)
      setNotice({ tone: 'warning', message: t('engineeringEvidenceUnavailable') })
      return
    }
    if (focusedEvidence.current === evidenceNavigation) return
    const key = evidenceNavigation.kind === 'dataset'
      ? JSON.stringify([evidenceNavigation.findingId ? 'finding' : 'dataset', evidenceNavigation.findingId ?? evidenceNavigation.datasetId])
      : evidenceNavigation.kind === 'analysis' ? JSON.stringify(['analysis', evidenceNavigation.analysisId]) : JSON.stringify(['artifact', evidenceNavigation.manifestId, evidenceNavigation.outputPath])
    if (focusEvidenceElement(workspaceElement.current, key)) focusedEvidence.current = evidenceNavigation
  }, [evidenceNavigation, navigationContext, tab, t])
  const handleSurveyNetworkSelected = useCallback((id: string | null, revision?: number): void => {
    setSelectedSurveyNetworkRevision(revision)
    setSelectedSurveyNetworkId(id ?? '')
  }, [])

  const selectProject = useCallback((projectId: string): void => {
    // Reopening a thread in the current task must not erase its loaded summary
    // or preview: no project-id change will trigger a reload in that case.
    if (projectId === selectedProjectId) return
    overviewRequest.current++
    summaryRequest.current++
    requestScope.current = { ...requestScope.current, projectId }
    setSelectedProjectId(projectId)
    setOverview(null)
    setProjectDraft(null)
    setSelectedDatasetId('')
    setSelectedAnalysisId('')
    setSelectedSurveyNetworkRevision(undefined)
    setNotice(null)
    setEvidenceNavigation(null)
    setSurveyAdjustmentIds([])
    setSurveyDeformationIds([])
    setSurveyNetworks([])
    setSurveyAdjustments([])
    setSelectedSurveyNetworkId('')
    setPreview(null)
    setChart(null)
  }, [selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) return
    setActiveEngineeringProject(selectedProjectId)
    window.dispatchEvent(new CustomEvent('workwise:engineering-active-project-changed'))
  }, [selectedProjectId])

  useLayoutEffect(() => {
    requestScope.current = { workspaceRoot, runtimeReady, projectId: selectedProjectId }
    // Invalidate even A -> B -> A requests before passive loads can complete.
    invalidateProjectReads()
    creatingProject.current = false
    setBusy(false)
    return invalidateProjectReads
  }, [workspaceRoot, runtimeReady, selectedProjectId, invalidateProjectReads])

  useLayoutEffect(() => {
    setSurveyNetworks([])
    setSurveyAdjustments([])
    setSelectedSurveyNetworkId('')
    setSelectedSurveyNetworkRevision(undefined)
    setEvidenceNavigation(null)
  }, [workspaceRoot, selectedProjectId])

  useLayoutEffect(() => {
    invalidateProjectList()
    return invalidateProjectList
  }, [workspaceRoot, runtimeReady, invalidateProjectList])

  useLayoutEffect(() => {
    setProjects([])
    setSelectedProjectId(activeEngineeringProjectId())
    setOverview(null)
    setSurveyNetworks([])
    setSurveyAdjustments([])
    setSelectedSurveyNetworkId('')
    setProjectDraft(null)
    setSelectedDatasetId('')
    setSelectedAnalysisId('')
    setSurveyAdjustmentIds([])
    setSurveyDeformationIds([])
    setPreview(null)
    setChart(null)
    setNotice(null)
  }, [workspaceRoot])

  const loadOverview = useCallback(async (projectId: string, preserveDraft = false): Promise<void> => {
    if (!runtimeReady || !projectId || requestScope.current.workspaceRoot !== workspaceRoot || !requestScope.current.runtimeReady || requestScope.current.projectId !== projectId) return
    const token = ++overviewRequest.current
    try {
      const next = await runtimeRequest<Overview>(`/v1/engineering/projects/${projectId}/overview`)
      if (token !== overviewRequest.current || next.project.id !== projectId || next.project.workspace !== workspaceRoot) return
      setOverview(next)
      if (!preserveDraft) setProjectDraft(projectToDraft(next.project))
      setSelectedDatasetId((current) => next.datasets.some((dataset) => dataset.id === current) ? current : next.datasets[0]?.id ?? '')
      setSelectedAnalysisId((current) => next.analyses.some((analysis) => analysis.id === current) ? current : next.analyses.find((analysis) => analysis.algorithmVersion === ENGINEERING_ANALYSIS_ALGORITHM_VERSION)?.id ?? '')
    } catch (error) {
      if (token !== overviewRequest.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [runtimeReady, workspaceRoot])

  const loadSurveySummary = useCallback(async (projectId: string): Promise<void> => {
    if (!runtimeReady || !projectId || requestScope.current.workspaceRoot !== workspaceRoot || !requestScope.current.runtimeReady || requestScope.current.projectId !== projectId) return
    const token = ++summaryRequest.current
    try {
      const [networkResult, adjustmentResult] = await Promise.all([
        runtimeRequest<{ networks: SurveyNetworkSummary[] }>(`/v1/engineering/survey/networks?projectId=${encodeURIComponent(projectId)}`),
        runtimeRequest<{ adjustments: SurveyAdjustmentSummary[] }>(`/v1/engineering/adjustments?projectId=${encodeURIComponent(projectId)}`)
      ])
      if (token !== summaryRequest.current) return
      setSurveyNetworks(networkResult.networks ?? [])
      setSurveyAdjustments(adjustmentResult.adjustments ?? [])
      setSelectedSurveyNetworkId((current) => networkResult.networks?.some((network) => network.id === current) ? current : networkResult.networks?.[0]?.id ?? '')
    } catch (error) {
      if (token !== summaryRequest.current) return
      // Survey is an optional companion to the monitoring chain. Keep the
      // existing overview usable when its read model is unavailable.
      setSurveyNetworks([])
      setSurveyAdjustments([])
    }
  }, [runtimeReady, workspaceRoot])

  const loadProjects = useCallback(async (): Promise<void> => {
    if (!runtimeReady || !requestScope.current.runtimeReady || requestScope.current.workspaceRoot !== workspaceRoot) return
    const token = ++projectsRequest.current
    try {
      const result = await runtimeRequest<{ projects: Project[] }>('/v1/engineering/projects')
      if (token !== projectsRequest.current) return
      const workspaceProjects = result.projects.filter((project) => project.workspace === workspaceRoot)
      setProjects(workspaceProjects)
      setSelectedProjectId((current) => chooseEngineeringProjectId(current, workspaceProjects, activeEngineeringProjectId()))
    } catch (error) {
      if (token !== projectsRequest.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [runtimeReady, workspaceRoot])

  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => { void loadOverview(selectedProjectId) }, [loadOverview, selectedProjectId])
  useEffect(() => { void loadSurveySummary(selectedProjectId) }, [loadSurveySummary, selectedProjectId])
  // A Survey panel can import or switch a network without changing the
  // classic route. Refresh the compact read model so the summary strip never
  // renders stale metadata for the newly selected network.
  useEffect(() => {
    if (!selectedSurveyNetworkId || !selectedProjectId) return
    void loadSurveySummary(selectedProjectId)
  }, [loadSurveySummary, selectedProjectId, selectedSurveyNetworkId, selectedSurveyNetworkRevision])
  useEffect(() => {
    if (!runtimeReady || !selectedProjectId) return
    const selectedProject = projects.find((project) => project.id === selectedProjectId)
    if (!selectedProject) return
    void ensureEngineeringThread(selectedProject.id, workspaceRoot, `Survey AI · ${selectedProject.name}`)
  }, [ensureEngineeringThread, projects, runtimeReady, selectedProjectId, workspaceRoot])
  useEffect(() => {
    const openRequestedProject = (): void => {
      const projectId = consumeRequestedEngineeringProject()
      if (!projectId) return
      selectProject(projectId)
    }
    window.addEventListener('workwise:engineering-open-project', openRequestedProject)
    const openAiCommand = (): void => setTab('ai-command')
    window.addEventListener('workwise:engineering-open-ai', openAiCommand)
    openRequestedProject()
    return () => {
      window.removeEventListener('workwise:engineering-open-project', openRequestedProject)
      window.removeEventListener('workwise:engineering-open-ai', openAiCommand)
    }
  }, [selectProject, setTab])

  const activeDataset = useMemo(
    () => overview?.datasets.find((dataset) => dataset.id === selectedDatasetId) ?? overview?.datasets[0] ?? null,
    [overview?.datasets, selectedDatasetId]
  )
  const activeAnalysis = useMemo(
    () => overview?.analyses.find((analysis) => analysis.id === selectedAnalysisId && analysis.datasetId === activeDataset?.id)
      ?? overview?.analyses.find((analysis) => analysis.datasetId === activeDataset?.id && analysis.algorithmVersion === ENGINEERING_ANALYSIS_ALGORITHM_VERSION)
      ?? null,
    [activeDataset?.id, overview?.analyses, selectedAnalysisId]
  )
  const openFindings = activeDataset?.findings.filter((finding) => finding.status === 'open') ?? []
  const blockingFindings = openFindings.filter((finding) => finding.severity === 'blocking')
  const warningFindings = openFindings.filter((finding) => finding.severity === 'warning')
  const acceptedWarnings = activeDataset?.findings.filter((finding) => finding.severity === 'warning' && finding.status === 'accepted').length ?? 0
  const analysisCounts = useMemo(() => {
    const initial: Record<AnalysisResult['thresholdStatus'], number> = { normal: 0, warning: 0, alarm: 0, control: 0, unresolved: 0 }
    for (const result of activeAnalysis?.results ?? []) initial[result.thresholdStatus] += 1
    return initial
  }, [activeAnalysis])
  const latestManifest = overview?.manifests[0] ?? null
  const latestRun = overview?.runs[0] ?? null
  const activeSurveyNetwork = selectedSurveyNetworkId
    ? surveyNetworks.find((network) => network.id === selectedSurveyNetworkId) ?? null
    : surveyNetworks[0] ?? null
  // A project's saved datum describes the task until a network exists. Once
  // selected, the network's own missing datum must remain visibly unresolved.
  const surveySummaryDatum = activeSurveyNetwork ?? overview?.project.taskContext
  const latestSurveyAdjustment = surveyAdjustments.find((item) => item.run.networkId === activeSurveyNetwork?.id) ?? null
  // Restore a completed one-off result after remount/restart. Admission comes
  // from the current Runtime read model; missing or revoked admission fails closed.
  const surveyAdjustmentIds = surveyAdjustments.filter((item) =>
    (requestedSurveyAdjustmentIds.includes(item.run.id) || item === latestSurveyAdjustment)
    && item.run.status === 'completed' && item.result?.validation === 'valid'
    && item.sourceEligibility?.eligible === true
  ).map((item) => item.run.id)
  const hasSurveyDeliveryInputs = surveyAdjustmentIds.length > 0 || surveyDeformationIds.length > 0
  const hasDeliveryInputs = Boolean(activeDataset || hasSurveyDeliveryInputs)
  const hasDeliveryAnalysis = Boolean(activeDataset ? activeAnalysis : hasSurveyDeliveryInputs)
  const surveySourceDisposition = activeSurveyNetwork?.sourceFile?.disposition
  const surveyPointCount = activeSurveyNetwork?.knownPoints && activeSurveyNetwork?.unknownPoints
    ? new Set([...activeSurveyNetwork.knownPoints, ...activeSurveyNetwork.unknownPoints].map((point) => point.id)).size
    : activeSurveyNetwork?.sourceFile?.summary?.pointCount
  const surveyStationCount = activeSurveyNetwork?.sourceFile?.summary?.stationCount
    ?? (activeSurveyNetwork?.observations?.length
      ? new Set(activeSurveyNetwork.observations.map((item) => item.station ?? item.from).filter(Boolean)).size
      : undefined)
  const surveyObservationCount = activeSurveyNetwork?.sourceFile?.summary?.observationCount
    ?? activeSurveyNetwork?.observations?.length
  const surveyClosure = latestSurveyAdjustment?.result?.closure
  const surveyClosureKey = selectSurveyClosureKey(activeSurveyNetwork?.networkType, surveyClosure)
  const surveyClosureValue = surveyClosureKey ? surveyClosure?.[surveyClosureKey] : undefined
  const surveyClosureUnit = surveyClosureKey ? latestSurveyAdjustment?.result?.closureUnits?.[surveyClosureKey] : undefined
  const surveyPrecision = latestSurveyAdjustment?.result?.precision
  const surveyHasBlockingAdmission = latestSurveyAdjustment?.sourceEligibility?.eligible === false
    || latestSurveyAdjustment?.result?.validation === 'invalid' || latestSurveyAdjustment?.run.status === 'failed'

  const refreshCurrent = async (preserveDraft = false): Promise<void> => {
    const operationScope = requestScope.current
    if (selectedProjectId) {
      await Promise.all([loadProjects(), loadOverview(selectedProjectId, preserveDraft), loadSurveySummary(selectedProjectId)])
    }
    else await loadProjects()
    if (operationScope !== requestScope.current) return
    setSurveyRefreshToken((value) => value + 1)
    window.dispatchEvent(new CustomEvent('workwise:engineering-projects-changed'))
    if (!preserveDraft) setNotice({ tone: 'info', message: t('engineeringNoticeRefreshed') })
  }

  const createProject = useCallback(async (): Promise<void> => {
    if (!runtimeReady || busy || creatingProject.current) return
    creatingProject.current = true
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ project: Project }>('/v1/engineering/projects', 'POST', {
        // Keep the legacy monitoringType field for Runtime compatibility while
        // starting with a neutral engineering task template.
        name: t('engineeringDefaultJobName'), taskType: 'control-network', monitoringType: 'control-network', unit: 'm', signConvention: 'positive', workspace: workspaceRoot,
        expectedRevision: 0, idempotencyKey: `engineering-project-${Date.now()}`
      })
      if (operationScope !== requestScope.current) return
      if (result.project.workspace !== workspaceRoot) return
      projectsRequest.current++
      setProjects((current) => [result.project, ...current.filter((project) => project.id !== result.project.id)])
      creatingProject.current = false
      setBusy(false)
      selectProject(result.project.id)
      setOverview({ project: result.project, datasets: [], analyses: [], runs: [], manifests: [] })
      setProjectDraft(projectToDraft(result.project))
      setPreview(null)
      setChart(null)
      const createdScope = JSON.stringify([workspaceRoot, result.project.id])
      setTabsByScope((current) => ({ ...current, [createdScope]: 'project' }))
      writeBrowserStorageItem(`workwise.survey.stage.v1:${createdScope}`, 'project')
      window.dispatchEvent(new CustomEvent('workwise:engineering-projects-changed'))
      setNotice({ tone: 'success', message: t('engineeringNoticeJobCreated') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) { creatingProject.current = false; setBusy(false) } }
  }, [runtimeReady, busy, selectProject, t, workspaceRoot])

  useEffect(() => {
    // Creation is an event, not persistent state replayed when the selected
    // project, language or Runtime readiness changes.
    const requestCreateProject = (): void => { void createProject() }
    window.addEventListener('workwise:engineering-create-project', requestCreateProject)
    return () => window.removeEventListener('workwise:engineering-create-project', requestCreateProject)
  }, [createProject])

  const saveProject = async (): Promise<void> => {
    if (!runtimeReady || !overview || !projectDraft) return
    if (!validEngineeringReportPeriod(projectDraft.reportPeriod)) {
      setNotice({ tone: 'error', message: t('engineeringReportPeriodInvalid') })
      return
    }
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const project = await runtimeRequest<{ project: Project }>(`/v1/engineering/projects/${overview.project.id}`, 'PATCH', {
        ...(projectDraft.taskContext ? { taskContext: projectDraft.taskContext } : {}),
        name: projectDraft.name.trim(), ...(projectDraft.taskType ? { taskType: projectDraft.taskType } : {}), monitoringType: projectDraft.monitoringType.trim(), unit: projectDraft.unit.trim(), signConvention: projectDraft.signConvention.trim(),
        thresholds: parseThresholds(projectDraft.thresholdsText, t), reportPeriod: projectDraft.reportPeriod,
        expectedRevision: overview.project.revision, idempotencyKey: `engineering-project-save-${overview.project.id}-${overview.project.revision}`
      })
      if (operationScope !== requestScope.current) return
      if (project.project.id !== overview.project.id || project.project.workspace !== workspaceRoot) return
      overviewRequest.current++
      projectsRequest.current++
      setOverview((current) => current?.project.id === project.project.id ? { ...current, project: project.project } : current)
      setProjects((current) => current.map((item) => item.id === project.project.id ? project.project : item))
      setProjectDraft(projectToDraft(project.project))
      window.dispatchEvent(new CustomEvent('workwise:engineering-projects-changed'))
      setNotice({ tone: 'success', message: t('engineeringNoticeProjectSaved') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const importDataset = async (file: File): Promise<void> => {
    if (!runtimeReady || !overview) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file, t)
      if (operationScope !== requestScope.current) return
      const result = await runtimeRequest<{ dataset: Dataset }>('/v1/engineering/datasets/import', 'POST', {
        projectId: overview.project.id, name: file.name, dataBase64,
        expectedRevision: overview.project.revision, idempotencyKey: `engineering-import-${overview.project.id}-${file.name}-${file.size}-${file.lastModified}`
      })
      if (operationScope !== requestScope.current) return
      setSelectedDatasetId(result.dataset.id)
      await loadOverview(overview.project.id)
      if (operationScope !== requestScope.current) return
      setTab('quality')
      setNotice({ tone: 'success', message: t('engineeringNoticeDatasetImported', { name: file.name, count: result.dataset.observationCount }) })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const replaceDataset = (dataset: Dataset): void => {
    setOverview((current) => current ? { ...current, datasets: current.datasets.map((item) => item.id === dataset.id ? dataset : item) } : current)
  }

  const validateDataset = async (): Promise<void> => {
    if (!runtimeReady || !activeDataset) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ dataset: Dataset }>(`/v1/engineering/datasets/${activeDataset.id}/validate`, 'POST', {
        expectedRevision: activeDataset.revision, idempotencyKey: `engineering-validate-${activeDataset.id}-${activeDataset.revision}`
      })
      if (operationScope !== requestScope.current) return
      replaceDataset(result.dataset)
      setNotice({ tone: result.dataset.findings.some((finding) => finding.status === 'open' && finding.severity === 'blocking') ? 'warning' : 'success', message: t('engineeringNoticeValidationComplete') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const acceptWarning = async (finding: Finding): Promise<void> => {
    if (!runtimeReady || !activeDataset) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ dataset: Dataset }>(`/v1/engineering/datasets/${activeDataset.id}/findings/${finding.id}/accept`, 'POST', {
        expectedRevision: activeDataset.revision, idempotencyKey: `engineering-accept-${activeDataset.id}-${finding.id}-${activeDataset.revision}`
      })
      if (operationScope !== requestScope.current) return
      replaceDataset(result.dataset)
      setNotice({ tone: 'success', message: t('engineeringNoticeWarningAccepted') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const runAnalysis = async (): Promise<void> => {
    if (!runtimeReady || !overview || !activeDataset) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ analysis: Analysis }>('/v1/engineering/analyses', 'POST', {
        projectId: overview.project.id, datasetId: activeDataset.id, expectedRevision: activeDataset.revision,
        idempotencyKey: `engineering-analysis-${ENGINEERING_ANALYSIS_ALGORITHM_VERSION}-${activeDataset.id}-${activeDataset.revision}`
      })
      if (operationScope !== requestScope.current) return
      setSelectedAnalysisId(result.analysis.id)
      await loadOverview(overview.project.id)
      if (operationScope !== requestScope.current) return
      setTab('analysis')
      setNotice({ tone: 'success', message: t('engineeringNoticeAnalysisComplete', { count: result.analysis.results.length }) })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const createChart = async (): Promise<void> => {
    if (!runtimeReady || !activeAnalysis) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ chart: Chart }>('/v1/engineering/charts', 'POST', {
        analysisId: activeAnalysis.id, chartType: 'trend', expectedRevision: 0, idempotencyKey: `engineering-chart-${ENGINEERING_TREND_RENDERER_VERSION}-${activeAnalysis.id}`
      })
      if (operationScope !== requestScope.current) return
      setChart(result.chart)
      setNotice({ tone: 'success', message: t('engineeringNoticeChartCreated') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const previewDeliverables = async (): Promise<void> => {
    if (!runtimeReady || !overview || !hasDeliveryInputs) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<ReportPreview>('/v1/engineering/reports/preview', 'POST', {
        projectId: overview.project.id, datasetId: activeDataset?.id, analysisId: activeDataset ? activeAnalysis?.id : undefined, adjustmentIds: surveyAdjustmentIds, deformationIds: surveyDeformationIds, citations,
        expectedRevision: activeDataset?.revision ?? overview.project.revision, idempotencyKey: `engineering-preview-${overview.project.id}-${Date.now()}`
      })
      if (operationScope !== requestScope.current) return
      setPreview(result)
      setChart(result.charts[0] ?? chart)
      await loadOverview(overview.project.id)
      if (operationScope !== requestScope.current) return
      setTab('deliverables')
      setNotice({ tone: 'success', message: t('engineeringNoticePreviewCreated') })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const finalizeDeliverables = async (): Promise<void> => {
    if (!runtimeReady || !overview || !hasDeliveryInputs || (activeDataset && !activeAnalysis)) return
    const operationScope = requestScope.current
    setBusy(true)
    try {
      const result = await runtimeRequest<{ manifest: Manifest }>('/v1/engineering/deliverables/finalize', 'POST', {
        projectId: overview.project.id, datasetId: activeDataset?.id, analysisId: activeDataset ? activeAnalysis?.id : undefined, adjustmentIds: surveyAdjustmentIds, deformationIds: surveyDeformationIds, citations,
        acknowledgeWarnings: false, expectedRevision: activeDataset?.revision ?? overview.project.revision,
        idempotencyKey: `engineering-finalize-${overview.project.id}-${Date.now()}`
      })
      if (operationScope !== requestScope.current) return
      await loadOverview(overview.project.id)
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'success', message: t('engineeringNoticeManifestCreated', { id: result.manifest.id }) })
    } catch (error) {
      if (operationScope !== requestScope.current) return
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { if (operationScope === requestScope.current) setBusy(false) }
  }

  const addCitation = (): void => {
    const source = citationSource.trim()
    if (!source) {
      setNotice({ tone: 'warning', message: t('engineeringNoticeCitationRequired') })
      return
    }
    setCitations((current) => [...current, { id: `citation-${Date.now()}`, sourceType: citationType, source, ...(citationLocator.trim() ? { locator: citationLocator.trim() } : {}) }])
    setCitationSource('')
    setCitationLocator('')
  }

  const finalizationBlocked = !hasDeliveryInputs || !hasDeliveryAnalysis || blockingFindings.length > 0 || warningFindings.length > 0
  const askAboutDelivery = (label: string, evidence: EngineeringEvidenceReference): void => {
    if (!overview) return
    prepareEngineeringQuestion(overview.project.workspace, overview.project.id,
      t('surveyExplainEvidence', { label }), { projectId: overview.project.id, projectRevision: overview.project.revision, ...evidence })
    document.querySelector<HTMLTextAreaElement>('.engineering-persistent-chat textarea')?.focus()
  }

  const manifestOutputs = preview?.files ?? latestManifest?.outputs ?? []
  const currentStage = stageForTab(tab)
  const sourceFormat = activeSurveyNetwork?.sourceFile?.detection?.format?.toUpperCase()
    ?? activeDataset?.sourceFileName.split('.').pop()?.toUpperCase()
    ?? '—'
  const readiness = surveyReadiness({
    blocked: surveyHasBlockingAdmission || blockingFindings.length > 0,
    disposition: surveySourceDisposition,
    networkValidated: activeSurveyNetwork?.qualityStatus === 'validated',
    datasetValidated: activeDataset?.status === 'validated',
    hasSource: Boolean(activeSurveyNetwork || activeDataset),
    hasResult: Boolean(activeAnalysis || (latestSurveyAdjustment && surveyAdjustmentIds.includes(latestSurveyAdjustment.run.id))),
    hasOutputs: manifestOutputs.length > 0,
    reviewStatus: latestManifest?.reviewStatus,
    manifestValid: latestManifest?.validation.valid === true
  })
  const readinessLabel = t(`engineeringReadiness.${readiness}`, { defaultValue: readiness })
  const surveyOnlyWorkflow = !activeDataset && (Boolean(activeSurveyNetwork) || ['control-network', 'leveling-network', 'traverse-network', 'resection', 'gnss'].includes(overview?.project.taskType ?? ''))
  const surveyResultCurrent = Boolean(latestSurveyAdjustment && surveyAdjustmentIds.includes(latestSurveyAdjustment.run.id))
  const surveyOverviewBlocked = surveyHasBlockingAdmission || Boolean(surveySourceDisposition && surveySourceDisposition !== 'adjustment-ready')
  const overviewSource = activeDataset?.sourceFileName ?? activeSurveyNetwork?.sourceFile?.name

  return <EngineeringEvidenceQuestions scope={overview ? { workspace: overview.project.workspace, projectId: overview.project.id, projectRevision: overview.project.revision, ready: runtimeReady, focus: () => document.querySelector<HTMLTextAreaElement>('.engineering-persistent-chat textarea')?.focus() } : null}><div ref={workspaceElement} className={`engineering-workspace ds-no-drag flex min-h-0 flex-1 flex-col bg-ds-main text-ds-ink ${tab === 'ai-command' ? 'engineering-agent-route' : 'engineering-classic-route'}`}>
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted bg-ds-card px-3 py-2" data-testid="engineering-workspace-header">
      {onToggleLeftSidebar ? <button type="button" onClick={onToggleLeftSidebar} title={t(leftSidebarCollapsed ? 'sidebarExpand' : 'sidebarCollapse')} aria-label={t(leftSidebarCollapsed ? 'sidebarExpand' : 'sidebarCollapse')} className="flex h-8 w-8 items-center justify-center rounded-md text-ds-muted hover:bg-ds-hover"><ChevronRight className="h-4 w-4" /></button> : null}
      <div className="mr-auto min-w-0">
        <h1 className="truncate text-[15px] font-semibold">{t('engineeringWorkbenchTitle')}</h1>
        <p className="truncate text-[10.5px] text-ds-muted">{t('engineeringWorkbenchSubtitle')}</p>
      </div>
      <label className="sr-only" htmlFor="engineering-project-select">{t('engineeringCurrentTask')}</label>
      <select id="engineering-project-select" value={selectedProjectId} disabled={!runtimeReady || busy} onChange={(event) => selectProject(event.target.value)} className="h-8 min-w-0 max-w-[220px] rounded-md border border-ds-border bg-ds-card px-2 text-[12px]">
        <option value="">{t('engineeringNoProject')}</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <label className="sr-only" htmlFor="engineering-view-select">{t('engineeringViewLabel')}</label>
      <select id="engineering-view-select" value={currentStage.id} onChange={(event) => {
        const next = event.target.value as StageDefinition['id']
        if (next === 'import') setTab('source')
        else if (next === 'adjustment') setTab('survey')
        else if (next === 'analysis') setTab('precision')
        else setTab(manifestOutputs.length ? 'review' : 'deliverables')
      }} className="h-8 min-w-0 max-w-[190px] rounded-md border border-ds-border bg-ds-card px-2 text-[12px]">
        {STAGES.map((stage) => <option key={stage.id} value={stage.id}>{t(stage.labelKey, { defaultValue: stage.id })}</option>)}
      </select>
      <button type="button" onClick={() => void createProject()} disabled={!runtimeReady || busy} title={t('engineeringNewProject')} aria-label={t('engineeringNewProject')} className="flex h-8 w-8 items-center justify-center rounded-md text-ds-muted hover:bg-ds-hover disabled:opacity-50"><Plus className="h-4 w-4" /></button>
    </header>

    {tab !== 'ai-command' && !runtimeReady ? <div className="border-b border-amber-300/40 bg-amber-50 px-5 py-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{t('engineeringRuntimeOfflineNotice')}</div> : null}
    {tab !== 'ai-command' && notice ? <div className={`mx-4 mt-3 flex items-start gap-2 border px-3 py-2 text-[12px] sm:mx-5 ${notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200' : notice.tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200' : notice.tone === 'success' ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-200' : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200'}`}><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{surveyRuntimeErrorText(notice.message, locale)}</span><button type="button" onClick={() => setNotice(null)} className="text-current/70 hover:text-current" aria-label={t('engineeringCloseNotice')}>×</button></div> : null}

    {overview ? <div className="engineering-command-strip grid shrink-0 grid-cols-2 gap-px border-b border-ds-border-muted bg-ds-border-muted text-[11px] sm:grid-cols-4 xl:grid-cols-7" data-testid="engineering-summary-strip">
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryTask')}</span><strong className="mt-0.5 block truncate text-ds-ink">{overview.project.name}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryStage')}</span><strong className="mt-0.5 block truncate text-ds-ink">{t(currentStage.labelKey)}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="flex items-center text-ds-faint">{t('engineeringSummarySource')}{activeSurveyNetwork ? <EngineeringEvidenceQuestion label={activeSurveyNetwork.sourceFile?.name ?? activeSurveyNetwork.id} reference={{ kind: 'network', networkId: activeSurveyNetwork.id, networkRevision: activeSurveyNetwork.revision, sourceSha256: activeSurveyNetwork.sourceFile?.sha256 ?? '' }} /> : activeDataset ? <EngineeringEvidenceQuestion label={activeDataset.sourceFileName} reference={{ kind: 'monitoring-dataset', datasetId: activeDataset.id, datasetRevision: activeDataset.revision, sourceFileHash: activeDataset.sourceFileHash }} /> : null}</span><strong className="mt-0.5 block truncate text-ds-ink">{activeSurveyNetwork?.sourceFile?.name ?? activeDataset?.sourceFileName ?? '—'} · {sourceFormat}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryReadiness')}</span><strong className={`mt-0.5 block truncate ${readiness === 'blocked' ? 'text-red-700 dark:text-red-300' : readiness === 'adjustment-ready' ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>{readinessLabel}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryDatum')}</span><strong className="mt-0.5 block truncate text-ds-ink">{surveyDatumLabel(surveySummaryDatum?.verticalDatum, t)} · {surveyDatumLabel(surveySummaryDatum?.coordinateSystem, t)}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryPoints')}</span><strong className="mt-0.5 block truncate tabular-nums text-ds-ink">{surveyPointCount?.toLocaleString(locale) ?? '—'}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryStations')}</span><strong className="mt-0.5 block truncate tabular-nums text-ds-ink">{surveyStationCount?.toLocaleString(locale) ?? '—'}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryObservations')}</span><strong className="mt-0.5 block truncate tabular-nums text-ds-ink">{(surveyObservationCount ?? activeDataset?.observationCount)?.toLocaleString(locale) ?? '—'}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryClosure')}</span><strong className="mt-0.5 block truncate tabular-nums text-ds-ink">{surveyClosureValue === undefined ? '—' : `${surveyMeasurementNumber(surveyClosureValue, locale)}${surveyClosureUnit ? ` ${surveyClosureUnit}` : ''}`}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryPrecision')}</span><strong className="mt-0.5 block truncate tabular-nums text-ds-ink">{surveyPrecision ? `${surveyMeasurementNumber(surveyPrecision.maxPointStdDev, locale)} m` : activeAnalysis ? t('engineeringSummaryComputed') : '—'}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryDeliverable')}</span><strong className="mt-0.5 block truncate text-ds-ink">{manifestOutputs.length ? t('engineeringSummaryCandidate') : '—'}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryNetwork')}</span><strong className="mt-0.5 block truncate text-ds-ink">{surveyNetworkTypeLabel(activeSurveyNetwork?.networkType ?? overview.project.taskContext?.networkType, t)}</strong></div>
      <div className="bg-ds-card px-3 py-2"><span className="block text-ds-faint">{t('engineeringSummaryReview')}</span><strong className="mt-0.5 block truncate text-ds-ink">{latestManifest ? statusLabel(latestManifest.reviewStatus, t) : '—'}</strong></div>
    </div> : null}

    <div className={`engineering-continuous-shell min-h-0 flex-1 overflow-hidden ${tab === 'ai-command' ? '' : 'engineering-with-data'}`}>
      <div className="engineering-persistent-chat h-full min-h-0 min-w-0 overflow-hidden" data-testid="engineering-persistent-chat">
        <EngineeringAiCommandCenter
          workspaceRoot={workspaceRoot}
          runtimeReady={runtimeReady}
          project={overview?.project.id === selectedProjectId ? overview.project : null}
          dataset={activeDataset}
          analysis={activeAnalysis}
          latestRun={latestRun}
          compact={tab !== 'ai-command'}
          onCreateProject={() => void createProject()}
          onImportData={() => { if (overview) setTab('source'); else void createProject() }}
          onSurveyFiles={(files) => { setPendingSurveyFiles((current) => ({ ...current, [surveyFileScope]: [...(current[surveyFileScope] ?? []), ...files] })); setTab('survey') }}
          onOpenTab={(nextTab) => setTab(nextTab)}
          onRefresh={() => void refreshCurrent()}
          onExecutionSettled={() => void refreshCurrent(true)}
          navigationContext={navigationContext}
          onNavigateEvidence={openEvidence}
        />
      </div>
      {tab !== 'ai-command' ? <div className="engineering-classic-shell grid h-full min-h-0 min-w-0 grid-cols-1 overflow-hidden border border-ds-border-muted bg-ds-card" data-testid="engineering-classic-shell">


        <main className="min-h-0 overflow-y-auto bg-ds-main">
          <nav aria-label={t('engineeringViewLabel')} className="flex flex-wrap gap-1 border-b border-ds-border-muted bg-ds-card p-2">
            {TABS.filter((item) => currentStage.tabs.includes(item.id)).map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)} className={`rounded px-3 py-2 text-[12px] ${tab === item.id ? 'bg-accent/10 text-accent' : 'text-ds-muted hover:bg-ds-hover'}`}>{t(item.labelKey)}</button>)}
          </nav>
          {overview === null ? <EmptyState title={t('engineeringEmptyTitle')} detail={t('engineeringEmptyDetail')} action={<button type="button" onClick={() => void createProject()} disabled={!runtimeReady || busy} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-95 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t('engineeringNewProject')}</button>} /> : <>
            {tab === 'dashboard' ? <div className="border-b border-ds-border-muted bg-ds-card px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ds-faint">{t(TABS.find((item) => item.id === tab)?.labelKey ?? 'engineeringTabDashboard')}</p><h2 className="mt-1 truncate text-[18px] font-semibold">{overview.project.name}</h2><p className="mt-1 text-[12px] text-ds-muted">{engineeringTaskLabel(overview.project.taskType ?? overview.project.monitoringType, t)} · {overview.project.unit} · {t('engineeringRevision')} {overview.project.revision} · {t('engineeringUpdatedAt')} {formatDate(overview.project.updatedAt, locale)}</p></div><button type="button" onClick={() => void createProject()} disabled={!runtimeReady || busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border bg-ds-card px-2.5 text-[12px] font-medium text-ds-muted hover:bg-ds-hover disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t('engineeringNewProjectShort')}</button></div>
              <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4"><Metric label={t('engineeringTabData')} value={overview.datasets.length + surveyNetworks.length} detail={overviewSource ?? t('engineeringSummaryNoDataset')} /><Metric label={t('engineeringFindingBlocking')} value={surveyOnlyWorkflow ? (surveyOverviewBlocked ? t('engineeringStatusBlocked') : t('engineeringSurveyReviewRequired')) : blockingFindings.length} detail={surveyOnlyWorkflow ? t('engineeringSurveyReviewRequired') : blockingFindings.length ? t('engineeringSummaryNeedsSourceFix') : t('engineeringSummaryNoBlockers')} tone={surveyOverviewBlocked || blockingFindings.length ? 'danger' : 'neutral'} /><Metric label={t('engineeringSummaryReadiness')} value={surveyOnlyWorkflow ? readinessLabel : analysisCounts.warning + analysisCounts.alarm + analysisCounts.control} detail={surveyOnlyWorkflow ? (surveyResultCurrent ? t('engineeringReviewSurveyAnalysis') : t('engineeringSummaryNoAnalysis')) : activeAnalysis ? t('engineeringSummaryResults', { count: activeAnalysis.results.length }) : t('engineeringSummaryNoAnalysis')} tone={analysisCounts.alarm + analysisCounts.control ? 'danger' : analysisCounts.warning ? 'warning' : 'neutral'} /><Metric label={t('engineeringSummaryDeliverable')} value={overview.manifests.length} detail={latestManifest ? latestManifest.id : t('engineeringSummaryNoArchive')} tone={latestManifest?.reviewStatus === 'approved' ? 'success' : 'neutral'} /></div>
            </div> : null}

            {tab === 'dashboard' ? <section>
              <PanelHeading title={t('engineeringDashboardConsoleTitle')} description={t('engineeringDashboardConsoleDescription')} action={<button type="button" onClick={() => setTab(surveyOnlyWorkflow ? (surveyResultCurrent ? 'review' : 'source') : activeDataset ? 'quality' : 'data')} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white"><ChevronRight className="h-3.5 w-3.5" />{activeDataset || activeSurveyNetwork ? t('engineeringContinueDelivery') : t('engineeringImportFirstData')}</button>} />
              <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
                <div className="overflow-hidden border border-ds-border-muted bg-ds-card">
                  <div className="border-b border-ds-border-muted px-4 py-3"><p className="text-[13px] font-semibold text-ds-ink">{t('engineeringDeliveryPath')}</p><p className="mt-1 text-[11px] leading-4 text-ds-muted">{t('engineeringDeliveryPathDescription')}</p></div>
                  <div>
                    {surveyOnlyWorkflow ? <>
                      <DeliveryStage index={1} icon={Database} title={t('engineeringStageImport')} detail={overviewSource ?? t('engineeringSummaryNoDataset')} state={readinessLabel} attention={!activeSurveyNetwork || surveyOverviewBlocked} onOpen={() => setTab('source')} />
                      <DeliveryStage index={2} icon={Calculator} title={t('engineeringStageAdjustment')} detail={surveyNetworkTypeLabel(activeSurveyNetwork?.networkType, t)} state={surveyOverviewBlocked ? t('engineeringStatusBlocked') : activeSurveyNetwork?.qualityStatus === 'validated' ? t('engineeringStatusValidated') : t('engineeringStatusNotStarted')} attention={surveyOverviewBlocked || activeSurveyNetwork?.qualityStatus !== 'validated'} onOpen={() => setTab('survey')} />
                      <DeliveryStage index={3} icon={LineChart} title={t('engineeringStageAnalysis')} detail={surveyResultCurrent ? t('engineeringReviewSurveyAnalysis') : t('engineeringSurveyAnalysisPending')} state={surveyOverviewBlocked ? t('engineeringStatusBlocked') : surveyResultCurrent ? t('engineeringStatusCompleted') : t('engineeringStatusPendingAnalysis')} attention={!surveyResultCurrent || surveyOverviewBlocked} onOpen={() => setTab('precision')} />
                      <DeliveryStage index={4} icon={ClipboardCheck} title={t('engineeringStageDelivery')} detail={manifestOutputs.length ? t('engineeringDetailReportOutputs', { count: manifestOutputs.length }) : t('engineeringDetailReportPending')} state={latestManifest ? statusLabel(latestManifest.reviewStatus, t) : t('engineeringStatusReviewPending')} attention={finalizationBlocked || surveyOverviewBlocked} onOpen={() => setTab('review')} />
                    </> : <>
                    <DeliveryStage index={1} icon={FolderKanban} title={t('engineeringStageProjectThresholds')} detail={Object.keys(overview.project.thresholds).length ? `${Object.keys(overview.project.thresholds).length} ${t('engineeringThresholds')} · ${t('engineeringRevision')} ${overview.project.revision}` : t('engineeringDetailConfirmProject')} state={Object.keys(overview.project.thresholds).length ? t('engineeringStatusConfigured') : t('engineeringStatusPendingConfiguration')} attention={!Object.keys(overview.project.thresholds).length} onOpen={() => setTab('project')} />
                    <DeliveryStage index={2} icon={Database} title={t('engineeringStageData')} detail={activeDataset ? `${activeDataset.sourceFileName} · ${t('engineeringObservationCount', { count: activeDataset.observationCount })}` : t('engineeringDetailInstrumentData')} state={activeDataset ? statusLabel(activeDataset.status, t) : t('engineeringSummaryNoDataset')} attention={!activeDataset} onOpen={() => setTab('data')} />
                    <DeliveryStage index={3} icon={ShieldCheck} title={t('engineeringStageQuality')} detail={activeDataset ? (blockingFindings.length ? t('engineeringDetailFixBlockers', { count: blockingFindings.length }) : warningFindings.length ? t('engineeringDetailConfirmWarnings', { count: warningFindings.length }) : t('engineeringDetailNoIssues')) : t('engineeringDetailQualityAutoCheck')} state={blockingFindings.length ? t('engineeringStatusBlocked') : warningFindings.length ? t('engineeringStatusUnresolved') : activeDataset ? t('engineeringStatusPassed') : t('engineeringStatusNotStarted')} attention={blockingFindings.length > 0 || warningFindings.length > 0} onOpen={() => setTab('quality')} />
                    <DeliveryStage index={4} icon={LineChart} title={t('engineeringStageTrend')} detail={activeAnalysis ? `${t('engineeringSummaryResults', { count: activeAnalysis.results.length })} · ${activeAnalysis.algorithmVersion}` : t('engineeringDetailAnalysisPending')} state={activeAnalysis ? t('engineeringStatusCompleted') : t('engineeringStatusPendingAnalysis')} attention={Boolean(activeDataset) && !activeAnalysis} onOpen={() => setTab('analysis')} />
                    <DeliveryStage index={5} icon={FileOutput} title={t('engineeringStageReports')} detail={manifestOutputs.length ? t('engineeringDetailReportOutputs', { count: manifestOutputs.length }) : t('engineeringDetailReportPending')} state={manifestOutputs.length ? t('engineeringStatusGenerated') : t('engineeringStatusPendingGeneration')} attention={Boolean(activeAnalysis) && !manifestOutputs.length} onOpen={() => setTab('deliverables')} />
                    <DeliveryStage index={6} icon={ClipboardCheck} title={t('engineeringStageHumanReview')} detail={latestManifest ? t('engineeringDetailLatestManifest', { id: latestManifest.id }) : finalizationBlocked ? t('engineeringDetailGateBlocked') : t('engineeringDetailManifestReady')} state={latestManifest ? statusLabel(latestManifest.reviewStatus, t) : finalizationBlocked ? t('engineeringStatusReviewPending') : t('engineeringStatusReviewable')} attention={!latestManifest && finalizationBlocked} onOpen={() => setTab('review')} />
                    </>}
                  </div>
                </div>
                <aside className="border border-ds-border-muted bg-ds-card">
                  <div className="border-b border-ds-border-muted px-4 py-3"><p className="text-[13px] font-semibold text-ds-ink">{t('engineeringDeliveryStatus')}</p><p className="mt-1 text-[11px] text-ds-faint">{t('engineeringDeliveryStatusUpdated', { revision: overview.project.revision, date: formatDate(overview.project.updatedAt, locale) })}</p></div>
                  <div className="space-y-4 px-4 py-4"><div className={`flex items-start gap-2 text-[12px] ${finalizationBlocked ? 'text-amber-800 dark:text-amber-200' : 'text-green-800 dark:text-green-300'}`}>{finalizationBlocked ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0" />}<span>{finalizationBlocked ? t('engineeringGateIncompleteShort') : t('engineeringGateCompleteShort')}</span></div><dl className="space-y-3 border-t border-ds-border-muted pt-3 text-[11px]"><div className="flex justify-between gap-3"><dt className="text-ds-muted">{t('engineeringCurrentDatasetShort')}</dt><dd className="max-w-[150px] truncate text-right font-medium text-ds-ink">{overviewSource ?? t('engineeringUnselectedShort')}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-muted">{t(surveyOnlyWorkflow ? 'engineeringSummaryReadiness' : 'engineeringBlockingShort')}</dt><dd className={surveyOverviewBlocked || blockingFindings.length ? 'font-medium text-red-700 dark:text-red-300' : 'font-medium text-green-700 dark:text-green-300'}>{surveyOnlyWorkflow ? readinessLabel : blockingFindings.length}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-muted">{t('engineeringManualWarningsShort')}</dt><dd className="font-medium text-ds-ink">{surveyOnlyWorkflow ? t('engineeringSurveyReviewRequired') : t('engineeringAcceptedPendingShort', { accepted: acceptedWarnings, pending: warningFindings.length })}</dd></div><div className="flex justify-between gap-3"><dt className="text-ds-muted">{t('engineeringDeliverableListShort')}</dt><dd className="font-medium text-ds-ink">{t('engineeringManifestCountShort', { count: overview.manifests.length })}</dd></div></dl><div className="border-t border-ds-border-muted pt-3 text-[11px] leading-5 text-ds-muted">{t('engineeringImmutableEvidenceShort')}</div></div>
                </aside>
              </div>
            </section> : null}

            {tab === 'project' ? <section>
              <PanelHeading title={t('engineeringProjectConfigTitle')} description={t('engineeringProjectConfigDescription')} action={<button type="button" onClick={() => void saveProject()} disabled={!runtimeReady || busy || !projectDraft} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{t('engineeringSaveConfig')}</button>} />
              {projectDraft ? <div className="grid gap-3 px-5 pt-4 lg:grid-cols-2">{(['networkType', 'coordinateSystem', 'verticalDatum', 'measurementGrade', 'standard', 'standardVersion', 'standardClause'] as const).map((field) => <label key={field} className="text-[12px] text-ds-muted">{t(`engineeringTaskContext.${field}`)}<input value={projectDraft.taskContext?.[field] ?? ''} maxLength={field === 'networkType' || field === 'measurementGrade' || field === 'standardVersion' ? 100 : 200} onChange={(event) => setProjectDraft((current) => current ? { ...current, taskContext: { ...current.taskContext, [field]: event.target.value } } : current)} className="mt-1 h-9 w-full rounded border border-ds-border bg-ds-card px-2 text-ds-ink" /></label>)}</div> : null}
              {projectDraft ? <div className="grid gap-x-5 gap-y-4 p-5 lg:grid-cols-2"><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringProjectName')}<input value={projectDraft.name} onChange={(event) => setProjectDraft((current) => current ? { ...current, name: event.target.value } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent" /></label><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringTaskType')}<select value={projectDraft.taskType ?? ''} onChange={(event) => setProjectDraft((current) => current ? { ...current, taskType: event.target.value } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent"><option value="" disabled>{projectDraft.monitoringType}</option>{engineeringTaskTypes.map((type) => <option key={type} value={type}>{engineeringTaskLabel(type, t)}</option>)}</select></label><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringUnit')}<input value={projectDraft.unit} onChange={(event) => setProjectDraft((current) => current ? { ...current, unit: event.target.value } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent" /></label><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringSignConvention')}<select value={projectDraft.signConvention} onChange={(event) => setProjectDraft((current) => current ? { ...current, signConvention: event.target.value } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent"><option value="positive">{t('engineeringSignPositiveOption')}</option><option value="negative">{t('engineeringSignNegativeOption')}</option><option value="custom">{t('engineeringSignCustomOption')}</option></select></label><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringReportStart')}<input type="text" inputMode="numeric" maxLength={10} placeholder={t('engineeringDatePlaceholder')} title={t('engineeringDateFormat')} value={projectDraft.reportPeriod.start ?? ''} onChange={(event) => setProjectDraft((current) => current ? { ...current, reportPeriod: { ...current.reportPeriod, start: event.target.value || undefined } } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent" /></label><label className="block text-[12px] font-medium text-ds-muted">{t('engineeringReportEnd')}<input type="text" inputMode="numeric" maxLength={10} placeholder={t('engineeringDatePlaceholder')} title={t('engineeringDateFormat')} value={projectDraft.reportPeriod.end ?? ''} onChange={(event) => setProjectDraft((current) => current ? { ...current, reportPeriod: { ...current.reportPeriod, end: event.target.value || undefined } } : current)} className="mt-1.5 h-9 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent" /></label><label className="block text-[12px] font-medium text-ds-muted lg:col-span-2">{t('engineeringThresholds')}<textarea value={projectDraft.thresholdsText} onChange={(event) => setProjectDraft((current) => current ? { ...current, thresholdsText: event.target.value } : current)} placeholder={'settlement = 10\ndefault = 8'} className="mt-1.5 min-h-28 w-full resize-y rounded-md border border-ds-border bg-ds-card px-2.5 py-2 text-[13px] leading-5 text-ds-ink outline-none focus:border-accent" /><span className="mt-1 block text-[11px] font-normal leading-4 text-ds-faint">{t('engineeringThresholdHint')}</span></label></div> : null}
            </section> : null}

            {tab === 'data' ? <section>
              <PanelHeading title={t('engineeringDataPanelTitle')} description={t('engineeringDataPanelDescription')} action={<label className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white ${busy || !runtimeReady ? 'pointer-events-none opacity-50' : ''}`}><Upload className="h-3.5 w-3.5" />{t('engineeringImportMonitoringData')}<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" disabled={!runtimeReady || busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDataset(file); event.target.value = '' }} /></label>} />
              <div className="p-5">{overview.datasets.length === 0 ? <EmptyState title={t('engineeringNoMonitoringData')} detail={t('engineeringDataEmptyDetail')} /> : <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]"><div className="overflow-hidden border border-ds-border-muted"><div className="overflow-x-auto"><table className="min-w-full text-left text-[12px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2.5 font-semibold">{t('engineeringTabData')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringSummaryObservations')}</th><th className="px-3 py-2.5 font-semibold">{t('surveyEpoch')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringDatasetStatus')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{overview.datasets.map((dataset) => <tr key={dataset.id} tabIndex={-1} data-evidence-key={JSON.stringify(['dataset', dataset.id])} onClick={() => setSelectedDatasetId(dataset.id)} className={`cursor-pointer transition hover:bg-accent/5 focus:outline focus:outline-2 focus:outline-accent ${dataset.id === activeDataset?.id ? 'bg-accent/8' : ''}`}><td className="max-w-[260px] px-3 py-3"><button type="button" onClick={() => setSelectedDatasetId(dataset.id)} aria-pressed={dataset.id === activeDataset?.id} className="max-w-full truncate rounded text-left font-medium text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{dataset.sourceFileName}</button><p className="mt-0.5 truncate font-mono text-[10px] text-ds-faint">{dataset.sourceFileHash.slice(0, 16)}…</p></td><td className="px-3 py-3 tabular-nums text-ds-ink">{dataset.observationCount.toLocaleString(locale)}<span className="ml-1 text-[10px] text-ds-faint">/ {dataset.rowCount}</span></td><td className="px-3 py-3 text-ds-muted">{formatDate(dataset.timeRange.start, locale)}<br />{formatDate(dataset.timeRange.end, locale)}</td><td className="px-3 py-3"><span className="rounded px-1.5 py-0.5 text-[11px] bg-ds-subtle text-ds-muted">{statusLabel(dataset.status, t)}</span></td></tr>)}</tbody></table></div></div><div className="border border-ds-border-muted bg-ds-card">{activeDataset ? <><div className="border-b border-ds-border-muted px-3 py-3"><p className="text-[12px] font-semibold text-ds-ink">{t('engineeringColumnMapping')}</p><p className="mt-1 text-[11px] text-ds-faint">{activeDataset.columnCount} {t('engineeringUnit')} · {activeDataset.unknownColumns.length} {t('engineeringUnknownColumns')}</p></div><dl className="max-h-64 overflow-y-auto divide-y divide-ds-border-muted">{Object.entries(activeDataset.fieldMapping).map(([canonical, source]) => <div key={canonical} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 px-3 py-2 text-[11px]"><dt className="text-ds-faint">{canonical}</dt><dd className="truncate font-medium text-ds-ink">{source || t('engineeringStatusUnmapped')}</dd></div>)}</dl>{activeDataset.unknownColumns.length ? <div className="border-t border-ds-border-muted px-3 py-3"><p className="text-[11px] font-medium text-ds-muted">{t('engineeringUnknownColumns')}</p><p className="mt-1 break-words text-[11px] leading-4 text-ds-faint">{activeDataset.unknownColumns.join('、')}</p></div> : null}</> : null}</div></div>}</div>
            </section> : null}

            {tab === 'quality' ? <section>
              <SurveyQualityScoringWorkspace binding={{ projectId: overview.project.id, projectRevision: overview.project.revision, workspaceRoot }} runtimeReady={runtimeReady} />
              <PanelHeading title={t('engineeringQualityPanelTitle')} description={t('engineeringQualityPanelDescription')} action={<button type="button" onClick={() => void validateDataset()} disabled={!runtimeReady || busy || !activeDataset} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-50"><ShieldCheck className="h-3.5 w-3.5" />{t('engineeringRecheck')}</button>} />
              {!activeDataset ? <EmptyState title={t('engineeringSelectOrImportDataset')} detail={t('engineeringQualityEmptyDetail')} /> : <div className="p-5"><div className="grid grid-cols-2 gap-2 lg:grid-cols-4"><Metric label={t('engineeringFindingBlocking')} value={blockingFindings.length} detail={t('engineeringMustFixSource')} tone={blockingFindings.length ? 'danger' : 'success'} /><Metric label={t('engineeringFindingWarning')} value={warningFindings.length} detail={t('engineeringNeedsHumanConfirmation')} tone={warningFindings.length ? 'warning' : 'success'} /><Metric label={t('engineeringFindingAccepted')} value={acceptedWarnings} detail={t('engineeringIncludedInReview')} tone={acceptedWarnings ? 'warning' : 'neutral'} /><Metric label={t('engineeringDatasetStatus')} value={statusLabel(activeDataset.status, t)} detail={t('engineeringObservationCount', { count: activeDataset.observationCount })} /></div><div className="mt-5 overflow-hidden border border-ds-border-muted"><div className="overflow-x-auto"><table className="min-w-full text-left text-[12px]"><thead className="bg-ds-subtle text-ds-muted"><tr><th className="w-24 px-3 py-2.5 font-semibold">{t('engineeringFindingLevel')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringFindingProblem')}</th><th className="w-24 px-3 py-2.5 font-semibold">{t('engineeringSourceRow')}</th><th className="w-28 px-3 py-2.5 font-semibold">{t('engineeringDisposition')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{activeDataset.findings.length ? activeDataset.findings.map((finding, index) => <tr key={finding.id} tabIndex={-1} data-evidence-key={JSON.stringify(['finding', finding.id])} className={`focus:bg-accent/10 focus:outline focus:outline-2 focus:outline-accent ${finding.status === 'open' && finding.severity === 'blocking' ? 'bg-red-50/60 dark:bg-red-500/5' : ''}`}><td className="px-3 py-3"><span className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${findingTone[finding.severity]}`}>{finding.severity === 'blocking' ? t('engineeringFindingBlocking') : finding.severity === 'warning' ? t('engineeringFindingWarning') : t('engineeringFindingInfo')}</span></td><td className="min-w-[310px] px-3 py-3"><p className="text-ds-ink">{surveyDiagnosticText(finding, locale)}<EngineeringEvidenceQuestion label={finding.id} reference={{ kind: 'monitoring-dataset', datasetId: activeDataset.id, datasetRevision: activeDataset.revision, sourceFileHash: activeDataset.sourceFileHash, selector: { path: ['findings', index], identity: { id: finding.id } } }} /></p><p className="mt-1 text-[11px] leading-4 text-ds-muted">{surveyDiagnosticText(finding, locale, 'action')}</p></td><td className="px-3 py-3 tabular-nums text-ds-muted">{finding.row ? t('engineeringRowNumber', { row: finding.row }) : '—'}</td><td className="px-3 py-3">{finding.status === 'accepted' ? <span className="inline-flex items-center gap-1 text-[11px] text-green-700 dark:text-green-300"><CheckCircle2 className="h-3.5 w-3.5" />{t('engineeringFindingAccepted')}</span> : finding.severity === 'warning' ? <button type="button" disabled={!runtimeReady || busy} onClick={() => void acceptWarning(finding)} className="rounded border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-200">{t('engineeringFindingAcceptWarning')}</button> : finding.severity === 'blocking' ? <span className="text-[11px] leading-4 text-red-700 dark:text-red-300">{t('engineeringFixSourceShort').split('\n').map((line) => <Fragment key={line}>{line}<br /></Fragment>)}</span> : <span className="text-[11px] text-ds-faint">{t('engineeringNoActionShort')}</span>}</td></tr>) : <tr><td colSpan={4} className="px-3 py-10 text-center text-ds-muted">{t('engineeringNoIssuesShort')}</td></tr>}</tbody></table></div></div></div>}
            </section> : null}

            {tab === 'advanced-models' ? <SurveyAdvancedModelWorkspace binding={{ projectId: overview.project.id, projectRevision: overview.project.revision, workspaceRoot }} runtimeReady={runtimeReady} /> : null}
            {(tab === 'source' || tab === 'survey' || tab === 'precision') ? <section>
              <SurveyAdjustmentPanel key={surveyFileScope} project={overview.project} runtimeReady={runtimeReady}
                refreshToken={surveyRefreshToken}
                navigationTarget={evidenceNavigation?.kind === 'survey' ? evidenceNavigation : null}
                preferredSection={tab === 'source' ? 'network' : tab === 'precision' ? 'result' : 'points'}
                onNetworkSelected={handleSurveyNetworkSelected}
                pendingFiles={pendingSurveyFiles[surveyFileScope] ?? []}
                onRemovePendingFile={(file) => setPendingSurveyFiles((current) => ({ ...current, [surveyFileScope]: (current[surveyFileScope] ?? []).filter((item) => item !== file) }))}
                onOpenAi={() => document.querySelector<HTMLTextAreaElement>('.engineering-persistent-chat textarea')?.focus()}
                onAdjustmentComplete={(id) => { setSurveyAdjustmentIds((current) => current.includes(id) ? current : [...current, id]); setTab('precision'); void Promise.all([loadOverview(selectedProjectId), loadSurveySummary(selectedProjectId)]) }} onDeformationComplete={(id) => setSurveyDeformationIds((current) => current.includes(id) ? current : [...current, id])} />
            </section> : null}

            {tab === 'skills' ? <section>
              <PanelHeading title={t('engineeringSkillsPanelTitle')} description={t('engineeringSkillsPanelDescription')} />
              <EngineeringSkillsPanel runtimeReady={runtimeReady} />
            </section> : null}

            {tab === 'analysis' ? <section tabIndex={-1} data-evidence-key={JSON.stringify(['analysis', activeAnalysis?.id])} className="focus:outline focus:outline-2 focus:outline-accent">
              <PanelHeading title={t('engineeringAnalysisPanelTitle')} description={t('engineeringAnalysisPanelDescription')} action={<div className="flex items-center gap-2"><button type="button" onClick={() => void createChart()} disabled={!runtimeReady || busy || !activeAnalysis} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border bg-ds-card px-2.5 text-[12px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-50"><BarChart3 className="h-3.5 w-3.5" />{t('engineeringTrendChart')}</button><button type="button" onClick={() => void runAnalysis()} disabled={!runtimeReady || busy || !activeDataset} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"><Activity className="h-3.5 w-3.5" />{t('engineeringRunAnalysis')}</button></div>} />
              {!activeDataset ? <EmptyState title={t('engineeringNoMonitoringSelected')} detail={t('engineeringAnalysisEmptyDetail')} /> : !activeAnalysis ? <EmptyState title={t('engineeringNoAnalysis')} detail={t('engineeringAnalysisResultDetail')} action={<button type="button" onClick={() => void runAnalysis()} disabled={!runtimeReady || busy} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50"><Activity className="h-3.5 w-3.5" />{t('engineeringRunDeterministicAnalysis')}</button>} /> : <div className="p-5"><div className="grid grid-cols-2 gap-2 lg:grid-cols-5"><Metric label={t('engineeringStatusNormal')} value={analysisCounts.normal} detail={t('engineeringBelowWarningThreshold')} tone="success" /><Metric label={t('engineeringStatusWarning')} value={analysisCounts.warning} detail={t('engineeringAttentionRange')} tone={analysisCounts.warning ? 'warning' : 'neutral'} /><Metric label={t('engineeringStatusAlarm')} value={analysisCounts.alarm} detail={t('engineeringAtOrAboveThreshold')} tone={analysisCounts.alarm ? 'danger' : 'neutral'} /><Metric label={t('engineeringStatusControl')} value={analysisCounts.control} detail={t('engineeringControlState')} tone={analysisCounts.control ? 'danger' : 'neutral'} /><Metric label={t('engineeringStatusUnresolved')} value={analysisCounts.unresolved} detail={t('engineeringThresholdMissing')} tone={analysisCounts.unresolved ? 'warning' : 'neutral'} /></div>{chart ? <div className="mt-4 flex items-center gap-2 border border-ds-border-muted bg-ds-card px-3 py-2 text-[12px]"><BarChart3 className="h-4 w-4 text-accent" /><span className="min-w-0 flex-1 truncate text-ds-muted">{t('engineeringChartCreated')} <span className="font-mono text-ds-ink">{chart.relativePath}</span></span><span className="rounded bg-green-100 px-1.5 py-0.5 text-[10.5px] text-green-800 dark:bg-green-500/15 dark:text-green-300">{chart.validation}</span></div> : null}<div className="mt-5 overflow-hidden border border-ds-border-muted"><div className="overflow-x-auto"><table className="min-w-full text-left text-[12px]"><thead className="sticky top-0 bg-ds-subtle text-ds-muted"><tr><th className="px-3 py-2.5 font-semibold">{t('engineeringAnalysisTableItemPoint')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringCurrentValue')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringCumulativeChange')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringChangeRate')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringTrend')}</th><th className="px-3 py-2.5 font-semibold">{t('engineeringThresholdStatus')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{activeAnalysis.results.map((result, index) => <tr key={`${result.monitoringItem}-${result.point}`} className={result.thresholdStatus === 'alarm' || result.thresholdStatus === 'control' ? 'bg-red-50/60 dark:bg-red-500/5' : result.thresholdStatus === 'warning' ? 'bg-amber-50/50 dark:bg-amber-500/5' : 'hover:bg-accent/5'}><td className="px-3 py-3"><p className="font-medium text-ds-ink">{result.point}<EngineeringEvidenceQuestion label={`${result.monitoringItem} / ${result.point}`} reference={{ kind: 'monitoring-analysis', analysisId: activeAnalysis.id, datasetId: activeAnalysis.datasetId, inputHash: activeAnalysis.inputHash, algorithmVersion: activeAnalysis.algorithmVersion, selector: { path: ['results', index], identity: { monitoringItem: result.monitoringItem, point: result.point } } }} /></p><p className="mt-0.5 text-[10.5px] text-ds-faint">{result.monitoringItem}</p></td><td className="px-3 py-3 tabular-nums font-medium text-ds-ink">{formatNumber(result.currentValue, locale)} <span className="text-[10.5px] font-normal text-ds-faint">{overview.project.unit}</span></td><td className="px-3 py-3 tabular-nums text-ds-ink">{formatNumber(result.cumulativeChange, locale)}</td><td className="px-3 py-3 tabular-nums text-ds-ink">{formatNumber(result.changeRate, locale)}</td><td className="px-3 py-3"><span className="text-ds-muted">{statusLabel(result.trend, t)}{result.anomaly ? <span className="ml-1.5 text-red-600 dark:text-red-300">{t('engineeringAnomaly')}</span> : null}</span></td><td className="px-3 py-3"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${thresholdTone[result.thresholdStatus]}`}>{statusLabel(result.thresholdStatus, t)}</span></td></tr>)}</tbody></table></div></div><p className="mt-3 text-[11px] text-ds-faint">{t('engineeringAlgorithmHash', { algorithm: activeAnalysis.algorithmVersion })} <span className="font-mono">{activeAnalysis.inputHash}</span></p></div>}
            </section> : null}

            {tab === 'deliverables' ? <section>
              <PanelHeading title={t('engineeringDeliverablesTitle')} description={t('engineeringDeliverablesDescription')} action={<button type="button" onClick={() => void previewDeliverables()} disabled={!runtimeReady || busy || !hasDeliveryInputs} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"><FileOutput className="h-3.5 w-3.5" />{t('engineeringGeneratePreview')}</button>} />
              {!hasDeliveryInputs ? <EmptyState title={t('engineeringChooseDataset')} detail={t('engineeringDeliverablesEmptyDetail')} /> : <div className="p-5"><div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]"><div><div className="border border-ds-border-muted"><div className="flex items-center justify-between border-b border-ds-border-muted px-3 py-3"><div><p className="text-[13px] font-semibold text-ds-ink">{t('engineeringPreviewOutput')}</p><p className="mt-0.5 text-[11px] text-ds-faint">{preview ? t('engineeringRunId', { id: preview.run.id }) : latestManifest && manifestOutputs.length ? t('engineeringLatestManifestOutputs', { id: latestManifest.id }) : t('engineeringPreviewNotGenerated')}</p></div>{preview ? <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10.5px] text-blue-800 dark:bg-blue-500/15 dark:text-blue-300">{t('engineeringNotArchived')}</span> : null}</div>{manifestOutputs.length ? <div className="divide-y divide-ds-border-muted">{manifestOutputs.map((output) => <div key={`${output.path}-${output.sha256}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3"><div className="min-w-0"><p className="truncate font-mono text-[11px] text-ds-ink">{output.path}</p><p className="mt-1 truncate font-mono text-[10px] text-ds-faint">SHA-256 {output.sha256}</p><button type="button" aria-label={t('surveyAskEvidence', { label: output.path })} onClick={() => askAboutDelivery(output.path, { section: 'deliverables', runId: preview?.run.id ?? latestManifest?.runId, manifestId: preview ? undefined : latestManifest?.id, outputPath: output.path, outputSha256: output.sha256 })} className="mt-1 text-[11px] text-accent">{t('surveyAskAgent')}</button></div><span className="self-center tabular-nums text-[11px] text-ds-muted">{formatBytes(output.sizeBytes, locale)}</span></div>)}</div> : <div className="px-3 py-12 text-center text-[12px] text-ds-muted">{t('engineeringPreviewEmpty')}</div>}</div>{latestRun ? <div className="mt-4 border border-ds-border-muted px-3 py-3 text-[12px]"><p className="font-medium text-ds-ink">{t('engineeringLatestRun')}</p><p className="mt-1 text-ds-muted"><span className="font-mono text-[11px]">{latestRun.id}</span> · {statusLabel(latestRun.status, t)} · {formatDate(latestRun.updatedAt, locale)}</p>{latestRun.error ? <p className="mt-1 text-red-700 dark:text-red-300">{surveyRuntimeErrorText(latestRun.error, locale)}</p> : null}</div> : null}</div><div className="border border-ds-border-muted bg-ds-card"><div className="border-b border-ds-border-muted px-3 py-3"><p className="text-[13px] font-semibold text-ds-ink">{t('engineeringCitations')}</p><p className="mt-1 text-[11px] leading-4 text-ds-faint">{t('engineeringCitationsDescription')}</p></div><div className="space-y-2 px-3 py-3"><select aria-label={t('engineeringCitationType')} value={citationType} onChange={(event) => setCitationType(event.target.value as Citation['sourceType'])} className="h-8 w-full rounded-md border border-ds-border bg-ds-card px-2 text-[12px] text-ds-ink outline-none focus:border-accent"><option value="standard">{t('engineeringStandardClause')}</option><option value="knowledge-base">{t('engineeringKnowledgeBase')}</option><option value="attachment">{t('engineeringLocalAttachment')}</option><option value="other">{t('engineeringOtherSource')}</option></select><input aria-label={t('engineeringSourceNamePlaceholder')} value={citationSource} onChange={(event) => setCitationSource(event.target.value)} placeholder={t('engineeringSourceNamePlaceholder')} className="h-8 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[12px] text-ds-ink outline-none focus:border-accent" /><input aria-label={t('engineeringLocatorPlaceholder')} value={citationLocator} onChange={(event) => setCitationLocator(event.target.value)} placeholder={t('engineeringLocatorPlaceholder')} className="h-8 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[12px] text-ds-ink outline-none focus:border-accent" /><button type="button" onClick={addCitation} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border px-2.5 text-[12px] font-medium text-ds-ink hover:bg-ds-hover"><Plus className="h-3.5 w-3.5" />{t('engineeringAddCitation')}</button></div><div className="divide-y divide-ds-border-muted border-t border-ds-border-muted">{citations.length ? citations.map((citation) => <div key={citation.id} className="group flex gap-2 px-3 py-2.5"><FileCheck2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium text-ds-ink">{citation.source}</p><p className="mt-0.5 truncate text-[10.5px] text-ds-faint">{citation.sourceType}{citation.locator ? ` · ${citation.locator}` : ''}</p></div><button type="button" onClick={() => setCitations((current) => current.filter((item) => item.id !== citation.id))} className="text-ds-faint opacity-0 transition hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t('engineeringRemoveCitation', { source: citation.source })}>×</button></div>) : <p className="px-3 py-4 text-[11px] text-ds-faint">{t('engineeringNoCitations')}</p>}</div></div></div></div>}
            </section> : null}

            {tab === 'review' ? <section>
              <PanelHeading
                title={t('engineeringReviewTitle')}
                description={t('engineeringReviewDescription')}
                action={<button type="button" onClick={() => void finalizeDeliverables()} disabled={!runtimeReady || busy || finalizationBlocked} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-700 px-3 text-[12px] font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"><FileCheck2 className="h-3.5 w-3.5" />{t('engineeringGenerateReviewManifest')}</button>}
              />
              <div className="p-5">
                <SurveyQualitySamplingWorkspace binding={{ projectId: overview.project.id, projectRevision: overview.project.revision, workspaceRoot }} runtimeReady={runtimeReady} />
                <SurveyQualityAssessmentWorkspace binding={{ projectId: overview.project.id, projectRevision: overview.project.revision, workspaceRoot }} runtimeReady={runtimeReady} manifests={overview.manifests} />
                <div className="engineering-review-layout">
                  <div>
                    <div className="overflow-hidden border border-ds-border-muted">
                      <div className="border-b border-ds-border-muted bg-ds-subtle px-3 py-2.5 text-[12px] font-semibold text-ds-muted">{t('engineeringReviewChecklist')}</div>
                      <div className="divide-y divide-ds-border-muted">
                        <ReviewRow ok={hasDeliveryInputs} label={t('engineeringReviewDatasetSelected')} detail={activeDataset ? `${activeDataset.sourceFileName} · ${activeDataset.observationCount.toLocaleString(locale)} ${t('engineeringObservationUnit')}` : hasSurveyDeliveryInputs ? t('engineeringReviewSurveyInputs', { adjustments: surveyAdjustmentIds.length, deformations: surveyDeformationIds.length }) : t('engineeringReviewChooseDataset')} />
                        <ReviewRow ok={blockingFindings.length === 0 && hasDeliveryInputs} label={t('engineeringReviewBlockersCleared')} detail={blockingFindings.length ? t('engineeringReviewBlockersRemaining', { count: blockingFindings.length }) : t('engineeringReviewNoBlockers')} />
                        <ReviewRow ok={warningFindings.length === 0 && hasDeliveryInputs} label={t('engineeringReviewWarningsConfirmed')} detail={warningFindings.length ? t('engineeringReviewWarningsRemaining', { count: warningFindings.length }) : acceptedWarnings ? t('engineeringReviewWarningsAccepted', { count: acceptedWarnings }) : t('engineeringReviewNoWarnings')} />
                        <ReviewRow ok={hasDeliveryAnalysis} label={t('engineeringReviewAnalysisDone')} detail={activeAnalysis ? `${activeAnalysis.results.length.toLocaleString(locale)} ${t('engineeringAnalysisResultUnit')} · ${activeAnalysis.algorithmVersion}` : hasDeliveryAnalysis ? t('engineeringReviewSurveyAnalysis') : t('engineeringReviewRunAnalysis')} />
                        <ReviewRow ok={manifestOutputs.length > 0} label={t('engineeringReviewDeliverablesReady')} detail={manifestOutputs.length ? t('engineeringReviewableOutputs', { count: manifestOutputs.length }) : t('engineeringReviewGenerateDeliverables')} />
                      </div>
                    </div>
                    <div className="mt-5 border border-ds-border-muted">
                      <div className="border-b border-ds-border-muted px-3 py-3">
                        <p className="text-[13px] font-semibold text-ds-ink">{t('engineeringReviewManifestTitle')}</p>
                        <p className="mt-1 text-[11px] text-ds-faint">{t('engineeringReviewManifestHint')}</p>
                      </div>
                      {overview.manifests.length ? <div className="divide-y divide-ds-border-muted">{overview.manifests.map((manifest) => <div key={manifest.id} className="px-3 py-3"><div className="flex items-start gap-2"><FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" /><div className="min-w-0"><p className="truncate font-mono text-[11px] font-medium text-ds-ink">{manifest.id}</p>{manifest.outputs.map(output => <div key={output.path} tabIndex={-1} data-evidence-key={JSON.stringify(['artifact', manifest.id, output.path])} className="my-1 break-all border-l-2 border-ds-border pl-2 text-[11px] focus:outline focus:outline-2 focus:outline-accent"><p>{output.path}</p><p className="font-mono text-[10px] text-ds-muted">{output.sha256}</p></div>)}<button type="button" aria-label={t('surveyAskEvidence', { label: manifest.id })} onClick={() => askAboutDelivery(manifest.id, { section: 'review', manifestId: manifest.id, runId: manifest.runId, reviewStatus: manifest.reviewStatus })} className="mt-1 text-[11px] text-accent">{t('surveyAskAgent')}</button><p className="mt-1 text-[11px] text-ds-muted">{t('engineeringReviewOutputs', { count: manifest.outputs.length })} · {statusLabel(manifest.reviewStatus, t)} · {formatDate(manifest.finalizedAt, locale)}</p><EngineeringManifestVerification projectId={overview.project.id} manifestId={manifest.id} reviewStatus={manifest.reviewStatus} contextRevision={overview.project.revision} runtimeReady={runtimeReady} request={runtimeRequest} /><SurveyQualityWorkspace binding={{ projectId: overview.project.id, projectRevision: overview.project.revision, manifestId: manifest.id, outputs: manifest.outputs }} runtimeReady={runtimeReady} />{manifest.validation.warnings.length ? <p className="mt-1 text-[10.5px] text-amber-700 dark:text-amber-300">{t('engineeringReviewNotes', { count: manifest.validation.warnings.length })}</p> : null}</div></div></div>)}</div> : <p className="px-3 py-8 text-center text-[12px] text-ds-muted">{t('engineeringReviewNone')}</p>}
                    </div>
                  </div>
                  <aside className="border border-ds-border-muted bg-ds-card">
                    <div className="border-b border-ds-border-muted px-3 py-3"><p className="text-[13px] font-semibold text-ds-ink">{t('engineeringReviewStatus')}</p><p className="mt-1 text-[11px] text-ds-faint">{t('engineeringReviewRevision', { revision: overview.project.revision })}</p></div>
                    <div className="space-y-3 px-3 py-4">
                      <div className={`flex items-center gap-2 text-[12px] ${finalizationBlocked ? 'text-amber-800 dark:text-amber-200' : 'text-blue-800 dark:text-blue-300'}`}>{finalizationBlocked ? <AlertTriangle className="h-4 w-4" /> : <FileCheck2 className="h-4 w-4" />}<span>{finalizationBlocked ? t('engineeringReviewGateBlocked') : t('engineeringReviewGateReady')}</span></div>
                      <p className="text-[11px] leading-5 text-ds-muted">{t('engineeringReviewManifestDescription')}</p>
                      {latestManifest ? <div className="border-t border-ds-border-muted pt-3"><p className="text-[10.5px] font-medium text-ds-faint">{t('engineeringLatestManifest')}</p><p className="mt-1 break-all font-mono text-[10.5px] text-ds-ink">{latestManifest.id}</p></div> : null}
                    </div>
                  </aside>
                </div>
              </div>
            </section> : null}
          </>}
        </main>
      </div> : null}
    </div>
    {busy ? <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center"><span className="inline-flex items-center gap-2 rounded-md border border-ds-border bg-ds-card px-3 py-2 text-[12px] text-ds-muted shadow-panel"><Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />{t('engineeringRuntimeProcessing')}</span></div> : null}
  </div></EngineeringEvidenceQuestions>
}

function ReviewRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }): ReactElement {
  const { t } = useTranslation('common')
  return <div className="flex gap-3 px-3 py-3"><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}`}>{ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}</span><div className="min-w-0"><p className="text-[12px] font-medium text-ds-ink">{label}<span className="sr-only"> · {t(ok ? 'engineeringReviewConditionMet' : 'engineeringReviewConditionUnmet')}</span></p><p className="mt-1 break-words text-[11px] leading-4 text-ds-muted">{detail}</p></div></div>
}

export default EngineeringWorkspaceView
