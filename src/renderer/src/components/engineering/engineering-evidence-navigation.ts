import type { EngineeringEvidenceReference } from './engineering-conversation-drafts'

type Scope = { projectId: string; projectRevision: number; workspaceRoot: string }
export type SurveyEvidenceNavigationTarget = Scope & {
  kind: 'survey'; networkId: string; networkRevision: number; sourceSha256: string
  section: 'network' | 'observations' | 'points' | 'result'
  adjustmentId?: string; observationId?: string; sourceRecordId?: string; pointId?: string; diagnosticIndex?: number
}
export type EngineeringEvidenceNavigationTarget = SurveyEvidenceNavigationTarget
  | Scope & { kind: 'dataset'; datasetId: string; datasetRevision: number; sourceSha256: string; findingId?: string }
  | Scope & { kind: 'analysis'; analysisId: string; datasetId: string; inputHash: string }
  | Scope & { kind: 'artifact'; manifestId: string; runId: string; outputPath: string; outputSha256: string }

export type NavigationStep = { tool: string; parameters?: Record<string, unknown>; parameterBindings?: Array<{ parameter: string }> }
export type NavigationCard = { id: string; kind: string; sourceHash?: string; locator?: string }
export type EngineeringNavigationContext = {
  workspaceRoot: string
  project: { id: string; revision: number }
  networks: Array<{ id: string; revision: number; sourceFile?: { sha256?: string } }>
  adjustments: Array<{ run: { id: string; networkId: string } }>
  datasets: Array<{ id: string; revision: number; sourceFileHash: string; findings: Array<{ id: string; code: string; row?: number }> }>
  analyses: Array<{ id: string; datasetId: string; inputHash: string }>
  manifests: Array<{ id: string; runId: string; outputs: Array<{ path: string; sha256: string }> }>
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const unique = <T>(items: T[]): T | undefined => items.length === 1 ? items[0] : undefined
const scope = (context: EngineeringNavigationContext): Scope => ({ workspaceRoot: context.workspaceRoot, projectId: context.project.id, projectRevision: context.project.revision })

export function surveyNavigationTarget(context: EngineeringNavigationContext, selected: EngineeringEvidenceReference): SurveyEvidenceNavigationTarget | null {
  if (selected.projectId !== context.project.id || selected.projectRevision !== context.project.revision || !digest(selected.sourceSha256)) return null
  const network = unique(context.networks.filter(item => item.id === selected.networkId && item.revision === selected.networkRevision && item.sourceFile?.sha256 === selected.sourceSha256))
  if (!network || selected.adjustmentId && !unique(context.adjustments.filter(item => item.run.id === selected.adjustmentId && item.run.networkId === network.id))) return null
  return { ...scope(context), kind: 'survey', networkId: network.id, networkRevision: network.revision, sourceSha256: selected.sourceSha256,
    section: selected.adjustmentId ? 'result' : selected.observationId ? 'observations' : selected.pointId ? 'points' : 'network',
    ...(selected.adjustmentId ? { adjustmentId: selected.adjustmentId } : {}),
    ...(selected.observationId ? { observationId: selected.observationId } : {}),
    ...(selected.sourceRecordId ? { sourceRecordId: selected.sourceRecordId } : {}),
    ...(selected.pointId ? { pointId: selected.pointId } : {}),
    ...(selected.diagnosticIndex !== undefined ? { diagnosticIndex: selected.diagnosticIndex } : {}) }
}

export function planStepNavigationTarget(context: EngineeringNavigationContext, projectId: string, step: NavigationStep): EngineeringEvidenceNavigationTarget | null {
  if (projectId !== context.project.id || !step.parameters || step.parameterBindings?.length) return null
  const params = step.parameters
  if (params.projectId !== undefined && params.projectId !== projectId) return null
  const tool = step.tool.startsWith('railwise.') ? step.tool.slice(9) : step.tool
  if (['survey_network_validate', 'survey_calculator', 'control_network', 'cpiii_adjustment', 'coord_transform', 'distance_calculator', 'angle_convert', 'survey_adjustment_read'].includes(tool)) {
    const network = unique(context.networks.filter(item => item.id === params.networkId))
    if (!network || !digest(network.sourceFile?.sha256)) return null
    if (tool === 'survey_adjustment_read' ? typeof params.adjustmentId !== 'string' : params.expectedRevision !== network.revision) return null
    return surveyNavigationTarget(context, { ...scope(context), networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile.sha256,
      section: tool === 'survey_adjustment_read' ? 'result' : 'network', ...(tool === 'survey_adjustment_read' ? { adjustmentId: params.adjustmentId as string } : {}) })
  }
  if (['monitoring_data_first_check', 'deformation_rate'].includes(tool)) {
    const dataset = unique(context.datasets.filter(item => item.id === params.datasetId && item.revision === params.expectedRevision && digest(item.sourceFileHash)))
    return dataset ? { ...scope(context), kind: 'dataset', datasetId: dataset.id, datasetRevision: dataset.revision, sourceSha256: dataset.sourceFileHash } : null
  }
  if (tool === 'chart_generator') {
    const analysis = unique(context.analyses.filter(item => item.id === params.analysisId && digest(item.inputHash)))
    return analysis ? { ...scope(context), kind: 'analysis', analysisId: analysis.id, datasetId: analysis.datasetId, inputHash: analysis.inputHash } : null
  }
  return null
}

/** Match the Runtime's exact evidence keys; titles and model prose never select a target. */
export function evidenceCardNavigationTarget(context: EngineeringNavigationContext, card: NavigationCard): EngineeringEvidenceNavigationTarget | null {
  if (!digest(card.sourceHash)) return null
  if (card.kind === 'status' || card.kind === 'finding') {
    const matches = context.datasets.flatMap(dataset => {
      if (dataset.sourceFileHash !== card.sourceHash) return []
      const base = { ...scope(context), kind: 'dataset' as const, datasetId: dataset.id, datasetRevision: dataset.revision, sourceSha256: dataset.sourceFileHash }
      if (card.kind === 'status') return card.id === dataset.id ? [base] : []
      return dataset.findings.filter(finding => card.id === `${dataset.id}:${finding.code}:${finding.row ?? 0}` && card.locator === (finding.row ? `row:${finding.row}` : undefined)).map(finding => ({ ...base, findingId: finding.id }))
    })
    return unique(matches) ?? null
  }
  if (card.kind === 'trend' || card.kind === 'metric') {
    const analysis = unique(context.analyses.filter(item => item.inputHash === card.sourceHash && card.id === (card.kind === 'metric' ? `${item.id}:metric` : item.id)))
    return analysis ? { ...scope(context), kind: 'analysis', analysisId: analysis.id, datasetId: analysis.datasetId, inputHash: analysis.inputHash } : null
  }
  if (card.kind === 'artifact') {
    const matches = context.manifests.flatMap(manifest => manifest.outputs.filter(output => card.id === `${manifest.id}:${output.path}` && card.locator === output.path && card.sourceHash === output.sha256).map(output => ({ ...scope(context), kind: 'artifact' as const, manifestId: manifest.id, runId: manifest.runId, outputPath: output.path, outputSha256: output.sha256 })))
    return unique(matches) ?? null
  }
  return null
}

export function focusEvidenceElement(root: HTMLElement, key: string): boolean {
  const element = Array.from(root.querySelectorAll<HTMLElement>('[data-evidence-key]')).find(item => item.dataset.evidenceKey === key)
  if (!element) return false
  element.focus({ preventScroll: true })
  element.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  return true
}

export function navigationTargetIsCurrent(context: EngineeringNavigationContext, target: EngineeringEvidenceNavigationTarget): boolean {
  if (target.workspaceRoot !== context.workspaceRoot || target.projectId !== context.project.id || target.projectRevision !== context.project.revision) return false
  if (target.kind === 'survey') return surveyNavigationTarget(context, target) !== null
  if (target.kind === 'dataset') return Boolean(unique(context.datasets.filter(item => item.id === target.datasetId && item.revision === target.datasetRevision && item.sourceFileHash === target.sourceSha256 && (!target.findingId || unique(item.findings.filter(finding => finding.id === target.findingId))))))
  if (target.kind === 'analysis') return Boolean(unique(context.analyses.filter(item => item.id === target.analysisId && item.datasetId === target.datasetId && item.inputHash === target.inputHash)))
  return Boolean(unique(context.manifests.filter(item => item.id === target.manifestId && item.runId === target.runId && unique(item.outputs.filter(output => output.path === target.outputPath && output.sha256 === target.outputSha256)))))
}
