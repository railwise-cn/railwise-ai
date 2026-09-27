import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { EngineeringEvidenceCardV1, EngineeringWatchRuleV1, type EngineeringContextSnapshotV1, type EngineeringEvidenceSelectionV1, type EngineeringEvidenceCardV1 as EngineeringEvidenceCard, type EngineeringSurveyAdjustmentAdmissionV1, type EngineeringWatchRuleV1 as EngineeringWatchRule } from '../contracts/engineering-ai.js'
import type { EngineeringService } from './engineering-service.js'
import type { SurveyRawSourceIntegrity, SurveyService, SurveySourceEligibility } from './survey-service.js'

const MAX_FINDINGS_PER_DATASET = 200
const MAX_DATASETS = 20
const MAX_ANALYSES = 20
const MAX_RUNS = 20
const MAX_SURVEY_NETWORKS = 20
const MAX_SURVEY_ADJUSTMENTS = 20
const MAX_CITATIONS = 100

function currentSurveyAdjustmentAdmission(
  rawSourceIntegrity: SurveyRawSourceIntegrity | undefined,
  sourceEligibility: SurveySourceEligibility | undefined
): EngineeringSurveyAdjustmentAdmissionV1 {
  const integrity = rawSourceIntegrity
    ? {
      status: rawSourceIntegrity.status,
      ledgerEntryCount: rawSourceIntegrity.ledgerEntryCount,
      errors: rawSourceIntegrity.errors
        .filter((error) => typeof error === 'string' && error.trim().length > 0)
        .map((error) => error.trim())
        .slice(0, 20)
    }
    : {
      status: 'legacy-unverified' as const,
      ledgerEntryCount: 0,
      errors: ['当前调整记录未提供服务端原始资料完整性状态；只能作为历史记录。']
    }
  const eligibility = sourceEligibility
    ? {
      eligible: sourceEligibility.eligible,
      findings: sourceEligibility.findings.slice(0, 20).map((finding) => ({
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {})
      }))
    }
    : {
      eligible: false,
      findings: [{
        code: 'source_not_adjustment_ready',
        severity: 'blocking',
        message: '当前调整记录未提供服务端来源资格；不得用于新的平差、变形分析或正式交付。'
      }]
    }
  return {
    status: integrity.status === 'verified' && eligibility.eligible
      ? 'current-admissible'
      : 'historical-non-admissible',
    rawSourceIntegrity: integrity,
    sourceEligibility: eligibility
  }
}

function hashContext(value: Omit<EngineeringContextSnapshotV1, 'contextHash'>): string {
  const { generatedAt: _generatedAt, ...stableContext } = value
  return `sha256-${createHash('sha256').update(JSON.stringify(stableContext)).digest('hex')}`
}

/**
 * Builds the bounded, provenance-first context sent to an Engineering AI
 * turn. It deliberately exposes dataset statistics and findings, never the
 * raw observation array, so a large source file cannot become an accidental
 * prompt payload.
 */
export class EngineeringContextService {
  private readonly watchDrafts = new Map<string, EngineeringWatchRule[]>()
  private readonly loadedWatchProjects = new Set<string>()
  constructor(
    private readonly engineering: EngineeringService,
    private readonly nowIso: () => string = () => new Date().toISOString(),
    private readonly survey?: Pick<SurveyService, 'listNetworks' | 'listAdjustments'>
  ) {}

  async addWatchDraft(input: { projectId: string; name: string; expression: string; enabled?: boolean; idempotencyKey?: string }): Promise<EngineeringWatchRule> {
    const project = this.engineering.getProject(input.projectId)
    if (!project) throw new Error(`engineering project not found: ${input.projectId}`)
    this.loadWatchDrafts(input.projectId, project.workspace)
    const existing = this.watchDrafts.get(input.projectId) ?? []
    if (input.idempotencyKey) {
      const replay = existing.find((rule) => rule.id === `watch_${input.idempotencyKey}`)
      if (replay) return replay
    }
    const rule = EngineeringWatchRuleV1.parse({
      schemaVersion: 1,
      id: input.idempotencyKey ? `watch_${input.idempotencyKey}` : `watch_${cryptoRandomId()}`,
      projectId: input.projectId,
      name: input.name.trim(),
      expression: input.expression.trim(),
      enabled: input.enabled ?? true,
      revision: 1,
      updatedAt: this.nowIso()
    })
    this.watchDrafts.set(input.projectId, [...existing, rule].slice(-20))
    await this.persistWatchDrafts(input.projectId, project.workspace)
    return rule
  }

  snapshot(projectId: string): EngineeringContextSnapshotV1 {
    const overview = this.engineering.getProjectOverview(projectId)
    const surveyNetworks = this.survey?.listNetworks(projectId).slice(0, MAX_SURVEY_NETWORKS) ?? []
    const surveyAdjustments = this.survey?.listAdjustments(projectId).slice(0, MAX_SURVEY_ADJUSTMENTS) ?? []
    this.loadWatchDrafts(projectId, overview.project.workspace)
    const base: Omit<EngineeringContextSnapshotV1, 'contextHash'> = {
      schemaVersion: 1,
      projectId: overview.project.id,
      projectRevision: overview.project.revision,
      generatedAt: this.nowIso(),
      project: {
        name: overview.project.name,
        ...(overview.project.taskType ? { taskType: overview.project.taskType } : {}),
        ...(overview.project.taskContext ? { taskContext: overview.project.taskContext } : {}),
        monitoringType: overview.project.monitoringType,
        unit: overview.project.unit,
        reportPeriod: overview.project.reportPeriod,
        thresholds: overview.project.thresholds
      },
      datasets: overview.datasets.slice(0, MAX_DATASETS).map((dataset) => ({
        id: dataset.id,
        sourceFileName: dataset.sourceFileName,
        sourceFileHash: dataset.sourceFileHash,
        rowCount: dataset.rowCount,
        observationCount: dataset.observationCount,
        status: dataset.status,
        revision: dataset.revision,
        findings: dataset.findings.slice(0, MAX_FINDINGS_PER_DATASET).map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          status: finding.status,
          message: finding.message,
          ...(finding.row ? { row: finding.row } : {})
        }))
      })),
      analyses: overview.analyses.slice(0, MAX_ANALYSES).map((analysis) => ({
        id: analysis.id,
        datasetId: analysis.datasetId,
        algorithmVersion: analysis.algorithmVersion,
        resultCount: analysis.results.length,
        inputHash: analysis.inputHash
      })),
      runs: overview.runs.slice(0, MAX_RUNS).map((run) => ({
        id: run.id,
        status: run.status,
        datasetId: run.datasetId,
        ...(run.analysisId ? { analysisId: run.analysisId } : {}),
        revision: run.revision,
        updatedAt: run.updatedAt
      })),
      surveyNetworks: surveyNetworks.map((network) => ({
        id: network.id,
        networkType: network.networkType,
        ...(network.transformType ? { transformType: network.transformType } : {}),
        coordinateSystem: network.coordinateSystem,
        verticalDatum: network.verticalDatum,
        pointCount: network.knownPoints.length + network.unknownPoints.length,
        observationCount: network.observations.length,
        qualityStatus: network.qualityStatus,
        revision: network.revision,
        ...(network.inputAttachmentHash ? { inputAttachmentHash: network.inputAttachmentHash } : {}),
        ...(network.observationEpoch ? { observationEpoch: network.observationEpoch } : {})
      })),
      surveyAdjustments: surveyAdjustments.map((adjustment) => ({
        id: adjustment.run.id,
        networkId: adjustment.run.networkId,
        status: adjustment.run.status,
        revision: adjustment.run.revision,
        ...(adjustment.result?.strategyId ? { strategyId: adjustment.result.strategyId } : {}),
        algorithmVersion: adjustment.run.algorithmVersion,
        inputHash: adjustment.run.inputHash,
        ...(adjustment.result ? {
          validation: adjustment.result.validation,
          observationCount: adjustment.result.observationCount,
          unknownCount: adjustment.result.unknownCount,
          degreesOfFreedom: adjustment.result.degreesOfFreedom
        } : {}),
        sourceAdmission: currentSurveyAdjustmentAdmission(adjustment.rawSourceIntegrity, adjustment.sourceEligibility)
      })),
      citations: overview.manifests.flatMap((manifest) => manifest.citations).slice(0, MAX_CITATIONS).map((citation) => ({
        id: citation.id,
        source: citation.source,
        sourceType: citation.sourceType,
        ...(citation.locator ? { locator: citation.locator } : {})
      })),
      watchDrafts: (this.watchDrafts.get(projectId) ?? []).slice(0, 20)
    }
    return { ...base, contextHash: hashContext(base) }
  }

  workspace(projectId: string): string {
    return this.engineering.getProjectOverview(projectId).project.workspace
  }

  conversationEvidence(projectId: string, selection?: EngineeringEvidenceSelectionV1): unknown {
    const networks = this.survey?.listNetworks(projectId) ?? []
    const adjustments = this.survey?.listAdjustments(projectId) ?? []
    const selectedAdjustment = selection?.adjustmentId ? adjustments.find((item) => item.run.id === selection.adjustmentId) : undefined
    const networkId = selection?.networkId ?? selectedAdjustment?.run.networkId
    const network = networkId ? networks.find((item) => item.id === networkId) : undefined
    if (networkId && !network) throw new Error('network is not in the current Survey project')
    if (selection?.adjustmentId && (!selectedAdjustment || (network && selectedAdjustment.run.networkId !== network.id))) throw new Error('adjustment is not in the current Survey project/network')
    const needsNetwork = selection?.networkRevision !== undefined || selection?.sourceSha256 !== undefined || selection?.observationId !== undefined || selection?.sourceRecordId !== undefined || selection?.pointId !== undefined || selection?.diagnosticIndex !== undefined
    if (needsNetwork && !network) throw new Error('exact record selection requires a project-scoped network or adjustment')
    if (selection?.networkRevision !== undefined && network?.revision !== selection.networkRevision) throw new Error('selected network revision is stale; refresh the evidence')
    if (selection?.sourceSha256 !== undefined && network?.sourceFile?.sha256 !== selection.sourceSha256) throw new Error('selected source hash does not match the network')
    const observation = selection?.observationId ? network?.observations.find(item => item.id === selection.observationId) : undefined
    if (selection?.observationId && !observation) throw new Error('observation is not in the selected network')
    if (selection?.sourceRecordId && observation && observation.sourceRecordId !== selection.sourceRecordId) throw new Error('raw-record anchor does not match the selected observation')
    if (selection?.observationId && selectedAdjustment?.result && !selectedAdjustment.result.observations.some(item => item.observationId === selection.observationId)) throw new Error('observation is not in the selected adjustment result')
    const sourceRecordId = selection?.sourceRecordId ?? observation?.sourceRecordId
    const anchors = sourceRecordId ? (network?.sourceFile?.records ?? network?.sourceFile?.rawRecordAnchors ?? []).filter(item => item.id === sourceRecordId) : []
    if (sourceRecordId && anchors.length !== 1) throw new Error('raw-record anchor is missing or ambiguous in the selected source')
    const point = selection?.pointId ? [...(network?.knownPoints ?? []), ...(network?.unknownPoints ?? [])].find(item => item.id === selection.pointId) : undefined
    if (selection?.pointId && !point) throw new Error('point is not in the selected network')
    const diagnostic = selection?.diagnosticIndex !== undefined ? network?.sourceFile?.diagnostics[selection.diagnosticIndex] : undefined
    if (selection?.diagnosticIndex !== undefined && !diagnostic) throw new Error('diagnostic is not in the selected source')
    const overview = this.engineering.getProjectOverview(projectId)
    const manifest = selection?.manifestId ? overview.manifests.find(item => item.id === selection.manifestId) : undefined
    if (selection?.manifestId && !manifest) throw new Error('manifest is not in the current Survey project')
    if (manifest && selection?.runId && manifest.runId !== selection.runId) throw new Error('manifest does not match the selected run')
    const preview = selection?.runId && !manifest ? this.engineering.getPreviewEvidence(projectId, selection.runId) : undefined
    if (selection?.runId && !manifest && !preview) throw new Error('preview is not in the current Survey project')
    const outputs = manifest?.outputs ?? preview?.files
    const selectedOutputs = selection?.outputSha256 ? outputs?.filter(item => item.sha256 === selection.outputSha256).slice(0, 20) : outputs?.slice(0, 20)
    if (selection?.outputSha256 && !selectedOutputs?.length) throw new Error('output hash is not in the selected manifest or preview')
    return {
      context: this.snapshot(projectId),
      ...(observation ? { selectedObservation: observation } : {}),
      ...(anchors[0] ? { selectedRawRecord: { ...anchors[0], rawSnippet: anchors[0].rawSnippet?.slice(0, 2000), snippetTruncated: (anchors[0].rawSnippet?.length ?? 0) > 2000 } } : {}),
      ...(point ? { selectedPoint: point } : {}),
      ...(diagnostic ? { selectedDiagnostic: diagnostic } : {}),
      ...(outputs ? { selectedDelivery: {
        manifestId: manifest?.id, runId: manifest?.runId ?? preview?.run.id,
        reviewStatus: manifest?.reviewStatus ?? 'draft', verification: 'recorded-metadata-only',
        outputCount: outputs.length, outputs: selectedOutputs
      } } : {}),
      evidence: this.evidence(projectId).slice(0, 20),
      ...(network ? { selectedNetwork: {
        id: network.id, networkType: network.networkType, revision: network.revision,
        source: network.sourceFile ? { sha256: network.sourceFile.sha256, parserId: network.sourceFile.parserId, parserVersion: network.sourceFile.parserVersion, parserSourceHash: network.sourceFile.parserSourceHash } : undefined,
        observationCount: network.observations.length, observations: network.observations.slice(0, 20),
        pointCount: network.knownPoints.length + network.unknownPoints.length,
        points: [...network.knownPoints, ...network.unknownPoints].slice(0, 20)
      } } : {}),
      adjustments: (selectedAdjustment ? [selectedAdjustment] : adjustments.filter((item) => !network || item.run.networkId === network.id)).slice(0, 5).map(({ run, result, rawSourceIntegrity, sourceEligibility }) => ({
        runId: run.id, networkId: run.networkId, inputHash: run.inputHash,
        sourceAdmission: currentSurveyAdjustmentAdmission(rawSourceIntegrity, sourceEligibility),
        ...(result ? {
          validation: result.validation, algorithmVersion: result.algorithmVersion,
          closure: result.closure, closureUnits: result.closureUnits,
          precision: result.precision, linearUnit: result.linearUnit, angularUnit: result.angularUnit,
          unitWeightStdDev: result.unitWeightStdDev, unitWeightStdDevUnit: result.unitWeightStdDevUnit,
          varianceFactor: result.varianceFactor, varianceFactorUnit: result.varianceFactorUnit,
          degreesOfFreedom: result.degreesOfFreedom,
          qualityFindings: result.qualityFindings.slice(0, 20),
          residuals: selection?.observationId ? result.observations.filter(item => item.observationId === selection.observationId).slice(0, 20) : result.observations.slice(0, 20),
          ...(selection?.pointId ? { selectedAdjustedPoint: result.points.find(item => item.id === selection.pointId) } : {}),
          residualCount: result.observations.length
        } : {})
      }))
    }
  }

  private loadWatchDrafts(projectId: string, workspace: string): void {
    if (this.loadedWatchProjects.has(projectId)) return
    this.loadedWatchProjects.add(projectId)
    try {
      const parsed = JSON.parse(readFileSync(join(workspace, '.workwise', 'engineering', 'watch-drafts.json'), 'utf8')) as unknown
      if (!Array.isArray(parsed)) return
      const rules = parsed.filter((item): item is EngineeringWatchRule => {
        try { EngineeringWatchRuleV1.parse(item); return true } catch { return false }
      }).filter((item) => item.projectId === projectId).slice(-20)
      this.watchDrafts.set(projectId, rules)
    } catch {
      /* A missing or damaged optional draft file must not block the project context. */
    }
  }

  private async persistWatchDrafts(projectId: string, workspace: string): Promise<void> {
    try {
      const directory = join(workspace, '.workwise', 'engineering')
      const allRules: EngineeringWatchRule[] = []
      try {
        const persisted = JSON.parse(readFileSync(join(directory, 'watch-drafts.json'), 'utf8')) as unknown
        if (Array.isArray(persisted)) {
          for (const item of persisted) {
            try { allRules.push(EngineeringWatchRuleV1.parse(item)) } catch { /* ignore malformed optional draft */ }
          }
        }
      } catch { /* first write */ }
      for (const rules of this.watchDrafts.values()) allRules.push(...rules)
      const deduped = [...new Map(allRules.map((rule) => [rule.id, rule])).values()]
      await atomicWriteFile(join(directory, 'watch-drafts.json'), JSON.stringify(deduped.slice(-100), null, 2))
    } catch {
      /* Draft persistence is best-effort; the active Runtime context remains usable. */
    }
  }

  evidence(projectId: string): EngineeringEvidenceCard[] {
    const snapshot = this.snapshot(projectId)
    const cards: EngineeringEvidenceCard[] = []
    for (const dataset of snapshot.datasets) {
      for (const finding of dataset.findings.slice(0, 20)) {
        cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: `${dataset.id}:${finding.code}:${finding.row ?? 0}`, kind: 'finding', title: finding.code, summary: finding.message, sourceHash: dataset.sourceFileHash, locator: finding.row ? `row:${finding.row}` : undefined, createdAt: snapshot.generatedAt }))
      }
      cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: dataset.id, kind: 'status', title: dataset.sourceFileName, summary: `${dataset.observationCount.toLocaleString()} 条观测 · ${dataset.status}`, sourceHash: dataset.sourceFileHash, createdAt: snapshot.generatedAt }))
    }
    for (const analysis of snapshot.analyses) {
      cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: analysis.id, kind: 'trend', title: analysis.algorithmVersion, summary: `${analysis.resultCount.toLocaleString()} 条趋势与阈值分析结果`, sourceHash: analysis.inputHash, createdAt: snapshot.generatedAt }))
      cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: `${analysis.id}:metric`, kind: 'metric', title: '分析覆盖范围', summary: `本次运行覆盖 ${analysis.resultCount.toLocaleString()} 个监测项/测点组合`, sourceHash: analysis.inputHash, createdAt: snapshot.generatedAt }))
    }
    for (const citation of snapshot.citations) cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: citation.id, kind: 'citation', title: citation.sourceType, summary: citation.source, locator: citation.locator, createdAt: snapshot.generatedAt }))
    const manifests = this.engineering.getProjectOverview(projectId).manifests
    for (const manifest of manifests.slice(0, 10)) {
      for (const output of manifest.outputs.slice(0, 10)) cards.push(EngineeringEvidenceCardV1.parse({ schemaVersion: 1, id: `${manifest.id}:${output.path}`, kind: 'artifact', title: output.path.split('/').pop() ?? output.path, summary: `${output.mediaType} · ${output.sizeBytes.toLocaleString()} bytes · ${manifest.reviewStatus}`, sourceHash: output.sha256, locator: output.path, createdAt: manifest.finalizedAt ?? snapshot.generatedAt }))
    }
    return cards.slice(0, 100)
  }
}

function cryptoRandomId(): string {
  return randomUUID()
}
