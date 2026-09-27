import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import type { EngineeringService } from '../../engineering/engineering-service.js'
import type { SurveyService } from '../../engineering/survey-service.js'
import { CosaFileGroupInspectionRequestV1, SkillProvenanceV1, type EngineeringCapabilityV1 } from '../../contracts/survey.js'
import { identifyCosaFileGroups } from '../../engineering/survey-file-groups.js'
import { AUDITED_SPECIALIST_SKILLS, SPECIALIST_SKILL_ALIASES, SPECIALIST_SKILL_SOURCE } from '../../engineering/specialist-skill-provenance.generated.js'
import { MonitoringReplayVerificationV1 } from '../../contracts/engineering.js'

export async function listProjects(service: EngineeringService | undefined): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  return jsonResponse({ projects: service.listProjects() })
}
export async function createProject(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ project: service.createProject(body.value) }, 201) } catch (error) { return ERRORS.validation(errorMessage(error)) }
}
export async function getProjectOverview(service: EngineeringService | undefined, id: string): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  try { return jsonResponse(service.getProjectOverview(id)) } catch (error) { return mapError(error) }
}
export async function updateProject(service: EngineeringService | undefined, id: string, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ project: service.updateProject(id, body.value) }) } catch (error) { return mapError(error) }
}
export async function importDataset(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ dataset: await service.importDataset(body.value) }, 201) } catch (error) { return mapError(error) }
}
export async function validateDataset(service: EngineeringService | undefined, request: Request, pathDatasetId?: string): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ dataset: service.validateDataset({ ...(body.value as Record<string, unknown>), ...(pathDatasetId ? { datasetId: pathDatasetId } : {}) }) }) } catch (error) { return mapError(error) }
}
export async function acceptWarningFinding(service: EngineeringService | undefined, request: Request, pathDatasetId?: string, pathFindingId?: string): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ dataset: service.acceptWarningFinding({ ...(body.value as Record<string, unknown>), ...(pathDatasetId ? { datasetId: pathDatasetId } : {}), ...(pathFindingId ? { findingId: pathFindingId } : {}) }) }) } catch (error) { return mapError(error) }
}
export async function createAnalysis(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ analysis: service.createAnalysis(body.value) }, 201) } catch (error) { return mapError(error) }
}
export async function createChart(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ chart: await service.createChart(body.value) }, 201) } catch (error) { return mapError(error) }
}
export async function previewReport(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse(await service.previewReport(body.value), 201) } catch (error) { return mapError(error) }
}
export async function finalizeDeliverable(service: EngineeringService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ manifest: await service.finalize(body.value) }, 201) } catch (error) { return mapError(error) }
}
export async function verifyDeliverable(service: EngineeringService | undefined, projectId: string, manifestId: string): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  try { return jsonResponse({ verification: service.verifyDeliverable(projectId, manifestId) }) } catch (error) { return mapError(error) }
}
export async function replayMonitoringDeliverable(service: EngineeringService | undefined, request: Request, projectId: string, manifestId: string): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  if (new URL(request.url).search) return ERRORS.validation('monitoring replay does not accept query parameters')
  const body = await readJsonBody(request, 1024)
  if (!body.ok) return body.response
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) || Object.keys(body.value).length) return ERRORS.validation('monitoring replay accepts only an empty request object')
  try {
    const response = jsonResponse({ replay: MonitoringReplayVerificationV1.parse(await service.replayMonitoringDeliverable(projectId, manifestId)) })
    response.headers['cache-control'] = 'no-store'
    return response
  }
  catch { return ERRORS.unavailable('monitoring replay could not persist verification evidence') }
}
export async function getRun(service: EngineeringService | undefined, id: string): Promise<JsonResponse> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  const run = service.getRun(id); return run ? jsonResponse({ run }) : ERRORS.notFound(`run not found: ${id}`)
}
export async function cancelRun(service: EngineeringService | undefined, id: string, request?: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  try { const body = request ? await readJsonBody(request) : { ok: true as const, value: undefined }; if (!body.ok) return body.response; return jsonResponse({ run: service.cancelRun(id, body.value) }) } catch (error) { return mapError(error) }
}
export async function resumeRun(service: EngineeringService | undefined, id: string, request?: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('engineering workbench is unavailable')
  try { const body = request ? await readJsonBody(request) : { ok: true as const, value: undefined }; if (!body.ok) return body.response; return jsonResponse({ run: service.resumeRun(id, body.value) }) } catch (error) { return mapError(error) }
}

export async function importSurveyNetwork(service: SurveyService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  try {
    // Dispatch reaches this handler only after Runtime authorization. Transport
    // rejections carry no invented request identity and cannot prove a first task.
    let body
    try { body = await readJsonBody(request) } catch (error) {
      service.recordRejectedImport(undefined, 'body-read')
      throw error
    }
    if (!body.ok) {
      service.recordRejectedImport(undefined, body.response.status === 413 ? 'body-too-large' : 'invalid-json')
      return body.response
    }
    if (body.value && typeof body.value === 'object' && !Array.isArray(body.value) && Object.prototype.hasOwnProperty.call(body.value, 'network')) {
      service.recordRejectedImport(body.value, 'structured-http')
      return ERRORS.validation('结构化网络不能直接通过 Runtime 提交；请以 WorkWise JSON 源文件的 name 与 dataBase64 导入，以保留原始字节、SHA-256 与原始资料账本。')
    }
    const network = await service.importNetwork(body.value)
    return jsonResponse({ network: { ...network, rawSourceIntegrity: service.getRawSourceIntegrity(network.id), sourceEligibility: service.getSourceEligibility(network.id) } }, 201)
  } catch (error) { return mapSurveyError(error) }
}

export async function inspectCosaSurveyFileGroups(request: Request): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try {
    const input = CosaFileGroupInspectionRequestV1.parse(body.value)
    return jsonResponse({ inspection: identifyCosaFileGroups(input.files) })
  } catch (error) { return mapSurveyError(error) }
}

export function listSurveyNetworks(service: SurveyService | undefined, projectId?: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  return jsonResponse({
    networks: service.listNetworks(projectId).map((network) => ({
      ...network,
      rawSourceIntegrity: service.getRawSourceIntegrity(network.id),
      sourceEligibility: service.getSourceEligibility(network.id)
    }))
  })
}

export async function validateSurveyNetwork(service: SurveyService | undefined, request: Request, networkId: string): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try {
    const network = service.validateNetwork(networkId, body.value)
    return jsonResponse({ network: { ...network, rawSourceIntegrity: service.getRawSourceIntegrity(network.id), sourceEligibility: service.getSourceEligibility(network.id) } })
  } catch (error) { return mapSurveyError(error) }
}

/** Read-only evidence endpoint; correction writes remain server-trusted only. */
export function getSurveyDerivedCorrections(service: SurveyService | undefined, networkId: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  try {
    const replay = service.getDerivedCorrectionReplay(networkId)
    const rawSourceIntegrity = service.getRawSourceIntegrity(networkId)
    return jsonResponse({
      corrections: service.getDerivedCorrectionLedger(networkId),
      rawSourceIntegrity,
      replay
    })
  } catch (error) { return mapSurveyError(error) }
}

/** Read-only replay of the current or explicitly selected immutable chain head. */
export function replaySurveyDerivedCorrections(service: SurveyService | undefined, networkId: string, correctionHeadHash?: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  try {
    return jsonResponse({
      replay: service.getDerivedCorrectionReplay(networkId, correctionHeadHash),
      rawSourceIntegrity: service.getRawSourceIntegrity(networkId)
    })
  } catch (error) { return mapSurveyError(error) }
}

export async function createAdjustment(service: SurveyService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try {
    const created = service.createAdjustment(body.value)
    const adjustment = service.getAdjustment(created.run.id)
    // Do not make a just-created historical `validation: valid` result look
    // currently admissible merely because this write endpoint used to return
    // the bare stored payload. The read model attaches current source status.
    if (!adjustment?.rawSourceIntegrity || !adjustment.sourceEligibility) {
      return ERRORS.internal(`newly created adjustment ${created.run.id} is unavailable for current source-admission readback`)
    }
    return jsonResponse(adjustment, 201)
  } catch (error) { return mapSurveyError(error) }
}

export function getAdjustment(service: SurveyService | undefined, id: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const adjustment = service.getAdjustment(id); return adjustment ? jsonResponse(adjustment) : ERRORS.notFound(`adjustment not found: ${id}`)
}

export function listAdjustments(service: SurveyService | undefined, projectId?: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  return jsonResponse({ adjustments: service.listAdjustments(projectId) })
}

export async function cancelAdjustment(service: SurveyService | undefined, id: string, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ run: service.cancelAdjustment(id, body.value) }) } catch (error) { return mapSurveyError(error) }
}

export async function resumeAdjustment(service: SurveyService | undefined, id: string, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse(service.resumeAdjustment(id, body.value), 202) } catch (error) { return mapSurveyError(error) }
}

export function previewAdjustment(service: SurveyService | undefined, id: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const adjustment = service.previewAdjustment(id); return adjustment ? jsonResponse(adjustment) : ERRORS.notFound(`adjustment not found: ${id}`)
}

export async function compareDeformation(service: SurveyService | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const body = await readJsonBody(request); if (!body.ok) return body.response
  try { return jsonResponse({ deformation: service.compareDeformation(body.value) }, 201) } catch (error) { return mapSurveyError(error) }
}

export function getDeformation(service: SurveyService | undefined, id: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  const deformation = service.getDeformation(id); return deformation ? jsonResponse({ deformation }) : ERRORS.notFound(`deformation comparison not found: ${id}`)
}

export function listDeformations(service: SurveyService | undefined, projectId?: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  return jsonResponse({ deformations: service.listDeformations(projectId) })
}

export function engineeringCapabilities(service: SurveyService | undefined): JsonResponse {
  const available = Boolean(service)
  const capabilities: EngineeringCapabilityV1[] = [
    { id: 'survey-adjustment', label: '工程测量与平差', category: 'survey', skillIds: ['data-analysis', 'adjustment-report', 'rail-any-station-control-network'], toolIds: ['survey_network_validate', 'survey_calculator', 'control_network', 'cpiii_adjustment', 'coord_transform', 'survey_adjustment_read'], available, ...(available ? {} : { reason: 'survey runtime unavailable' }) },
    { id: 'third-party-monitoring', label: '地保与第三方监测', category: 'monitoring', skillIds: ['di-bao-monitoring', 'report-dibao', 'construction-monitoring', 'operational-monitoring'], toolIds: ['monitoring_csv', 'deformation_rate', 'alert_level'], available, ...(available ? {} : { reason: 'engineering runtime unavailable' }) },
    { id: 'engineering-delivery', label: '测绘成果交付', category: 'documents', skillIds: ['report-writing', 'docx-generation', 'excel-operations'], toolIds: ['report_export', 'excel_export', 'chart_generator'], available, ...(available ? {} : { reason: 'survey runtime unavailable' }) },
    { id: 'tender-master', label: '标书编制', category: 'documents', skillIds: ['tender-master', 'bidding-knowledge'], toolIds: ['standard_query'], available, ...(available ? {} : { reason: 'skill runtime unavailable' }) },
    { id: 'standards', label: '规范与知识库', category: 'standards', skillIds: ['standard-reference'], toolIds: ['standard_query', 'tool_norm_cite'], available, ...(available ? {} : { reason: 'skill runtime unavailable' }) }
  ]
  return jsonResponse({ schemaVersion: 1, product: { name: 'WorkWise Survey', subtitle: '工程测量工作台 · 测绘专业 AI Agent' }, capabilities })
}

export function skillsCatalog(): JsonResponse {
  const entries = [...AUDITED_SPECIALIST_SKILLS, ...SPECIALIST_SKILL_ALIASES].map((entry) => SkillProvenanceV1.parse(entry))
  return jsonResponse({
    schemaVersion: SPECIALIST_SKILL_SOURCE.schemaVersion,
    sourceRepository: SPECIALIST_SKILL_SOURCE.sourceRepository,
    commit: SPECIALIST_SKILL_SOURCE.sourceCommit,
    license: SPECIALIST_SKILL_SOURCE.sourceLicense,
    packagingPolicy: SPECIALIST_SKILL_SOURCE.packagingPolicy,
    skills: entries
  })
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function mapError(error: unknown): JsonResponse { const code = (error as { code?: string })?.code; if (code === 'stale_request') return ERRORS.staleRequest(errorMessage(error)); if (errorMessage(error).includes('not found')) return ERRORS.notFound(errorMessage(error)); if (errorMessage(error).includes('blocking findings') || errorMessage(error).includes('warnings require')) return ERRORS.conflict(errorMessage(error)); return ERRORS.validation(errorMessage(error)) }
function mapSurveyError(error: unknown): JsonResponse { const code = (error as { code?: string })?.code; if (code === 'survey_import_audit_unavailable') return ERRORS.unavailable('survey import audit could not be persisted'); if (code === 'survey_stale_request') return ERRORS.staleRequest(errorMessage(error)); if (errorMessage(error).includes('not found')) return ERRORS.notFound(errorMessage(error)); if (errorMessage(error).includes('exceeds limits') || errorMessage(error).includes('blocking')) return ERRORS.conflict(errorMessage(error)); return ERRORS.validation(errorMessage(error)) }
