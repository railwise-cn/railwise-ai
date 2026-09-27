import { createHash } from 'node:crypto'
import type { EngineeringService } from '../../engineering/engineering-service.js'
import type { EngineeringSurveyAdjustmentAdmissionV1 } from '../../contracts/engineering-ai.js'
import type { SurveyAdjustmentRead, SurveyRawSourceIntegrity, SurveyService, SurveySourceEligibility } from '../../engineering/survey-service.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import type { EngineeringAiOrchestrator } from '../../engineering/engineering-ai-orchestrator.js'

/**
 * Compatibility bridge for the reviewed RailWise tool IDs. The aliases call
 * the same deterministic EngineeringService used by the GUI, so a model can
 * explain results without becoming the source of numeric truth.
 */
export function buildRailwiseToolProviders(service: EngineeringService, survey?: SurveyService, getPlanGate?: () => Pick<EngineeringAiOrchestrator, 'authorizeToolCall' | 'recordToolResult'>): CapabilityToolProvider[] {
  const datasetSummary = (dataset: Awaited<ReturnType<EngineeringService['importDataset']>>) => ({
    id: dataset.id,
    projectId: dataset.projectId,
    sourceFileName: dataset.sourceFileName,
    sourceFileHash: dataset.sourceFileHash,
    rowCount: dataset.rowCount,
    observationCount: dataset.observationCount,
    status: dataset.status,
    revision: dataset.revision,
    unknownColumns: dataset.unknownColumns,
    findings: dataset.findings.map((finding) => ({ id: finding.id, code: finding.code, severity: finding.severity, status: finding.status, row: finding.row, message: finding.message, suggestion: finding.suggestion }))
  })
  const make = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: Record<string, unknown>) => Promise<{ output: unknown; isError?: boolean }>) => LocalToolHost.defineTool({ name, description, inputSchema, policy: 'auto', execute: async (args, context) => {
    const gate = getPlanGate?.()
    const authorization = await gate?.authorizeToolCall(context.threadId, context.turnId, name, args)
    const result = await execute(authorization?.parameters ?? args)
    if (authorization && !result.isError) gate!.recordToolResult(authorization, result.output)
    return result
  } })
  const analysis = async (args: Record<string, unknown>) => {
    if (typeof args.projectId !== 'string' || typeof args.datasetId !== 'string') return { output: { error: 'projectId and datasetId are required' }, isError: true }
    return { output: { analysis: service.createAnalysis({ projectId: args.projectId, datasetId: args.datasetId, expectedRevision: Number(args.expectedRevision ?? 0), idempotencyKey: String(args.idempotencyKey ?? `railwise-${args.datasetId}`) }) } }
  }
  const chart = async (args: Record<string, unknown>) => {
    if (typeof args.analysisId !== 'string') return { output: { error: 'analysisId is required' }, isError: true }
    return { output: { chart: await service.createChart({ analysisId: args.analysisId, chartType: String(args.chartType ?? 'trend'), expectedRevision: 0, idempotencyKey: String(args.idempotencyKey ?? `railwise-chart-${args.analysisId}`) }) } }
  }
  const surveyNetworkSummary = (network: NonNullable<ReturnType<SurveyService['getNetwork']>>) => ({
    id: network.id,
    projectId: network.projectId,
    networkType: network.networkType,
    transformType: network.transformType,
    coordinateSystem: network.coordinateSystem,
    verticalDatum: network.verticalDatum,
    pointCount: network.knownPoints.length + network.unknownPoints.length,
    observationCount: network.observations.length,
    qualityStatus: network.qualityStatus,
    revision: network.revision,
    findings: network.findings.slice(0, 200).map((finding) => ({ code: finding.code, severity: finding.severity, status: finding.status, message: finding.message, suggestion: finding.suggestion, row: finding.row }))
  })
  const currentSurveyAdjustmentAdmission = (
    rawSourceIntegrity: SurveyRawSourceIntegrity | undefined,
    sourceEligibility: SurveySourceEligibility | undefined
  ): EngineeringSurveyAdjustmentAdmissionV1 => {
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
  const adjustmentSummary = (adjustment: ReturnType<SurveyService['createAdjustment']> & Pick<SurveyAdjustmentRead, 'rawSourceIntegrity' | 'sourceEligibility'>) => ({
    run: adjustment.run,
    result: {
      id: adjustment.result.id,
      networkId: adjustment.result.networkId,
      strategyId: adjustment.result.strategyId,
      transformType: adjustment.result.transformType,
      algorithmVersion: adjustment.result.algorithmVersion,
      validation: adjustment.result.validation,
      observationCount: adjustment.result.observationCount,
      unknownCount: adjustment.result.unknownCount,
      redundancy: adjustment.result.redundancy,
      degreesOfFreedom: adjustment.result.degreesOfFreedom,
      linearUnit: adjustment.result.linearUnit,
      angularUnit: adjustment.result.angularUnit,
      unitWeightStdDev: adjustment.result.unitWeightStdDev,
      unitWeightStdDevUnit: adjustment.result.unitWeightStdDevUnit,
      varianceFactor: adjustment.result.varianceFactor,
      varianceFactorUnit: adjustment.result.varianceFactorUnit,
      varianceFactorEstimated: adjustment.result.varianceFactorEstimated,
      closure: adjustment.result.closure,
      closureUnits: adjustment.result.closureUnits,
      parameters: adjustment.result.parameters,
      parameterUnits: adjustment.result.parameterUnits,
      precision: adjustment.result.precision,
      solverDiagnostics: adjustment.result.solverDiagnostics,
      points: adjustment.result.points.slice(0, 200),
      observations: adjustment.result.observations.slice(0, 200),
      qualityFindings: adjustment.result.qualityFindings.slice(0, 200),
      inputHash: adjustment.result.inputHash,
      createdAt: adjustment.result.createdAt
    },
    boundedOutput: {
      pointsReturned: Math.min(adjustment.result.points.length, 200),
      pointsTotal: adjustment.result.points.length,
      observationsReturned: Math.min(adjustment.result.observations.length, 200),
      observationsTotal: adjustment.result.observations.length,
      covarianceStored: Boolean(adjustment.result.covariance?.length)
    },
    // Result validation is immutable historical evidence. This current state
    // is what governs whether the result may be used by a new operation.
    sourceAdmission: currentSurveyAdjustmentAdmission(adjustment.rawSourceIntegrity, adjustment.sourceEligibility)
  })
  const validateSurveyNetwork = async (args: Record<string, unknown>) => {
    if (!survey || typeof args.networkId !== 'string') return { output: { error: 'survey validation is unavailable; networkId is required' }, isError: true }
    try {
      return { output: { network: surveyNetworkSummary(survey.validateNetwork(args.networkId, { expectedRevision: Number(args.expectedRevision ?? 0), idempotencyKey: String(args.idempotencyKey ?? `railwise-validate-${args.networkId}`) })) } }
    } catch (error) { return { output: { error: error instanceof Error ? error.message : String(error) }, isError: true } }
  }
  const readSurveyAdjustment = async (args: Record<string, unknown>) => {
    if (!survey || typeof args.networkId !== 'string') return { output: { error: 'survey adjustment read is unavailable; networkId is required' }, isError: true }
    const network = survey.getNetwork(args.networkId)
    if (!network) return { output: { error: `survey network not found: ${args.networkId}` }, isError: true }
    const stored = typeof args.adjustmentId === 'string' ? survey.getAdjustment(args.adjustmentId) : survey.listAdjustments(network.projectId).find((candidate) => candidate.run.networkId === network.id)
    if (!stored?.result || stored.run.networkId !== network.id || stored.run.projectId !== network.projectId) return { output: { error: `survey adjustment not found for network: ${network.id}` }, isError: true }
    return { output: adjustmentSummary({
      run: stored.run,
      result: stored.result,
      rawSourceIntegrity: stored.rawSourceIntegrity,
      sourceEligibility: stored.sourceEligibility
    }) }
  }
  const adjustmentFor = (allowedTypes?: readonly string[]) => async (args: Record<string, unknown>) => {
    if (!survey || typeof args.networkId !== 'string') return { output: { error: 'survey adjustment is unavailable; networkId is required' }, isError: true }
    try {
      const network = survey.getNetwork(args.networkId)
      if (!network) return { output: { error: `survey network not found: ${args.networkId}` }, isError: true }
      if (allowedTypes && !allowedTypes.includes(network.networkType)) {
        return { output: { error: `tool does not support ${network.networkType}; expected ${allowedTypes.join(', ')}` }, isError: true }
      }
      const created = survey.createAdjustment({ networkId: args.networkId, expectedRevision: Number(args.expectedRevision ?? 0), method: typeof args.method === 'string' ? args.method : undefined, idempotencyKey: String(args.idempotencyKey ?? `railwise-adjustment-${args.networkId}`) })
      const current = survey.getAdjustment(created.run.id)
      return {
        output: adjustmentSummary({
          ...created,
          rawSourceIntegrity: current?.rawSourceIntegrity,
          sourceEligibility: current?.sourceEligibility
        })
      }
    } catch (error) { return { output: { error: error instanceof Error ? error.message : String(error) }, isError: true } }
  }
  const report = async (args: Record<string, unknown>) => {
    if (typeof args.projectId !== 'string') return { output: { error: 'projectId is required' }, isError: true }
    const adjustmentIds = Array.isArray(args.adjustmentIds) ? args.adjustmentIds.filter((id): id is string => typeof id === 'string') : undefined
    const deformationIds = Array.isArray(args.deformationIds) ? args.deformationIds.filter((id): id is string => typeof id === 'string') : undefined
    return { output: await service.previewReport({ projectId: args.projectId, datasetId: args.datasetId, ...(typeof args.analysisId === 'string' ? { analysisId: args.analysisId } : {}), ...(adjustmentIds?.length ? { adjustmentIds } : {}), ...(deformationIds?.length ? { deformationIds } : {}), expectedRevision: Number(args.expectedRevision ?? 0), idempotencyKey: String(args.idempotencyKey ?? `railwise-report-${createHash('sha256').update(JSON.stringify([args.projectId, args.datasetId, args.analysisId, adjustmentIds, deformationIds])).digest('hex')}`) }) }
  }
  const reportSchema = { type: 'object', properties: { projectId: { type: 'string' }, datasetId: { type: 'string' }, analysisId: { type: 'string' }, adjustmentIds: { type: 'array', items: { type: 'string' } }, deformationIds: { type: 'array', items: { type: 'string' } }, expectedRevision: { type: 'integer' } }, required: ['projectId'], anyOf: [{ required: ['datasetId'] }, { required: ['adjustmentIds'], properties: { adjustmentIds: { minItems: 1 } } }, { required: ['deformationIds'], properties: { deformationIds: { minItems: 1 } } }] }
  const tools = [
    make('monitoring_csv', 'Normalize a managed monitoring dataset without sending raw rows to a model.', { type: 'object', properties: { projectId: { type: 'string' }, datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['projectId', 'datasetId'] }, analysis),
    make('railwise.monitoring_csv', 'RailWise namespaced alias for monitoring_csv.', { type: 'object', properties: { projectId: { type: 'string' }, datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['projectId', 'datasetId'] }, analysis),
    make('deformation_rate', 'Calculate deterministic monitoring change rates and trends.', { type: 'object', properties: { projectId: { type: 'string' }, datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['projectId', 'datasetId'] }, analysis),
    make('railwise.deformation_rate', 'RailWise namespaced alias for deformation_rate.', { type: 'object', properties: { projectId: { type: 'string' }, datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['projectId', 'datasetId'] }, analysis),
    make('monitoring_data_first_check', 'Run deterministic quality checks for a monitoring dataset.', { type: 'object', properties: { datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['datasetId'] }, async (args) => ({ output: { dataset: datasetSummary(service.validateDataset({ datasetId: args.datasetId, expectedRevision: Number(args.expectedRevision ?? 0), idempotencyKey: String(args.idempotencyKey ?? `railwise-check-${args.datasetId}`) })) } })),
    make('railwise.monitoring_data_first_check', 'RailWise namespaced alias for monitoring_data_first_check.', { type: 'object', properties: { datasetId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['datasetId'] }, async (args) => ({ output: { dataset: datasetSummary(service.validateDataset({ datasetId: args.datasetId, expectedRevision: Number(args.expectedRevision ?? 0), idempotencyKey: String(args.idempotencyKey ?? `railwise-check-${args.datasetId}`) })) } })),
    make('chart_generator', 'Generate a validated SVG monitoring trend chart.', { type: 'object', properties: { analysisId: { type: 'string' }, chartType: { type: 'string' } }, required: ['analysisId'] }, chart),
    make('railwise.chart_generator', 'RailWise namespaced alias for chart_generator.', { type: 'object', properties: { analysisId: { type: 'string' }, chartType: { type: 'string' } }, required: ['analysisId'] }, chart),
    make('report_export', 'Export DOCX/PDF/XLSX from a monitoring dataset or selected survey results. Survey-only delivery does not require monitoring data.', reportSchema, report),
    make('railwise.report_export', 'RailWise namespaced alias for report_export.', reportSchema, report),
    make('excel_export', 'Export the XLSX evidence package from a monitoring dataset or selected survey results.', reportSchema, report),
    make('railwise.excel_export', 'RailWise namespaced alias for excel_export.', reportSchema, report),
    make('standard_query', 'Return a citation placeholder for a local standard or knowledge source.', { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }, async (args) => ({ output: { citation: { id: `cite_${Date.now()}`, sourceType: 'standard', source: String(args.source), locator: 'user-supplied' } } })),
    make('tool_norm_cite', 'Normalize a RailWise citation without changing source content.', { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }, async (args) => ({ output: { citation: { id: `cite_${Date.now()}`, sourceType: 'other', source: String(args.source) } } })),
    make('survey_network_validate', 'Validate a bounded survey-network summary without running an adjustment or returning raw observations.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, validateSurveyNetwork),
    make('survey_adjustment_read', 'Read the latest bounded deterministic result for a survey network with current source-admission evidence. A historical-non-admissible result is readable evidence only and must not be used for a new calculation, deformation analysis, or formal delivery. unitWeightStdDev and varianceFactor are dimensionless; standardizedResidual uses sigma multiples.', { type: 'object', properties: { networkId: { type: 'string' }, adjustmentId: { type: 'string' } }, required: ['networkId'] }, readSurveyAdjustment),
    make('survey_calculator', 'Adjust a leveling or height-control network deterministically. unitWeightStdDev and varianceFactor are dimensionless.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' }, method: { type: 'string' } }, required: ['networkId'] }, adjustmentFor(['leveling', 'height-control'])),
    make('control_network', 'Adjust a traverse, plane-control, triangulation or GNSS network through the shared survey Runtime.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['traverse', 'plane-control', 'triangulation', 'gnss'])),
    make('cpiii_adjustment', 'Adjust only a CPIII free-station or resection network deterministically.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['cpiii-free-station', 'cpiii-resection'])),
    make('coord_transform', 'Run only a configured coordinate transformation network.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['coordinate-transform'])),
    make('distance_calculator', 'Use the survey Runtime distance reduction pipeline.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor()),
    make('angle_convert', 'Use the survey Runtime angle conversion and adjustment pipeline.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor()),
    make('railwise.survey_network_validate', 'RailWise alias for survey_network_validate.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, validateSurveyNetwork),
    make('railwise.survey_adjustment_read', 'RailWise alias for survey_adjustment_read.', { type: 'object', properties: { networkId: { type: 'string' }, adjustmentId: { type: 'string' } }, required: ['networkId'] }, readSurveyAdjustment),
    make('railwise.survey_calculator', 'RailWise alias for leveling and height-control adjustment.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['leveling', 'height-control'])),
    make('railwise.control_network', 'RailWise alias for traverse, plane-control, triangulation and GNSS adjustment.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['traverse', 'plane-control', 'triangulation', 'gnss'])),
    make('railwise.cpiii_adjustment', 'RailWise alias for CPIII adjustment.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['cpiii-free-station', 'cpiii-resection'])),
    make('railwise.coord_transform', 'RailWise alias for coordinate transformation.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor(['coordinate-transform'])),
    make('railwise.distance_calculator', 'RailWise alias for distance_calculator.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor()),
    make('railwise.angle_convert', 'RailWise alias for angle_convert.', { type: 'object', properties: { networkId: { type: 'string' }, expectedRevision: { type: 'integer' } }, required: ['networkId'] }, adjustmentFor())
  ]
  return [{ id: 'railwise', kind: 'built-in', enabled: true, available: true, tools }]
}
