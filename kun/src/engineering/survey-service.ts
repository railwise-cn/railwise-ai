import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { SurveyImportAudit, SurveyImportAuditError, type SurveyImportAttempt, type ImportRejection } from './survey-import-audit.js'
import JSZip from 'jszip'
import { atomicWriteFile, drainAtomicWrites } from '../adapters/file/atomic-write.js'
import {
  AdjustmentMutationRequestV1,
  AdjustmentRequestV1,
  AdjustmentResultV1,
  AdjustmentRunV1,
  AdjustmentDisplacementV1,
  CoordinateTransformTypeV1,
  DeformationComparisonRequestV1,
  DeformationComparisonV1,
  SurveyNetworkImportRequest,
  SurveyNetworkV1,
  SurveyNetworkValidateRequest,
  SurveyObservationV1,
  SurveyPointV1,
  type SurveyKnownPointInputV1,
  SurveyProjectV1,
  SurveyQualityFindingV1,
  SurveyDerivedCorrectionRecordV1,
  type SurveyDerivedCorrectionActorV1,
  type SurveyDerivedCorrectionBasisV1,
  type SurveyDerivedCorrectionOperationV1,
  type DeformationPairDefinitionV1,
  type SurveySourceFileV1
} from '../contracts/survey.js'
import { choleskyDecompose, iterativeWeightedLeastSquares, numericalJacobian, surveyMatrix, weightedLeastSquares, whitenCorrelatedEquations, wrapRadians, type Matrix } from './survey-adjustment-core.js'
import { applyHeightPlane, applyHelmert7, applySimilarity2d, fitHeightPlane, fitHelmert7, fitSimilarity2d, gaussKrugerForward, gaussKrugerInverse, resolveEllipsoid, type HeightPlaneParameters, type Helmert7Parameters, type Similarity2dParameters } from './survey-coordinate-transform.js'
import { compareAdjustedEpochs, DEFORMATION_ALGORITHM_VERSION } from './survey-deformation.js'
import { isGnssSurveyFormat, SurveyFormatRegistry, type SurveySourceEnvelope } from './survey-format-registry.js'
import type { CosaIn1Mapping } from './survey-cosa-in1.js'
import { levelingNetworkClosures } from './survey-leveling-closure.js'
import { surveyErrorEllipse } from './survey-error-ellipse.js'
import { SurveyStatisticalDiagnosticsV1 } from '../contracts/survey-statistics.js'
import { diagnoseDeletedResiduals } from './survey-statistical-diagnostics.js'
import { SurveyFreeLevelingTrialRequestV1, SurveyFreeLevelingTrialV1, SurveyFreeLevelingTrialSummaryV1, type SurveyFreeLevelingTrialListV1 } from '../contracts/survey-free-leveling.js'
import { solveFreeLevelingTrial, FREE_LEVELING_VERSION } from './survey-free-leveling.js'
import {
  rawAnchorDigest,
  recordRawSource,
  reverifyRawSource,
  verifyRawSourceLedger,
  type SurveyRawDataLedgerEntry,
  type SurveyRawSourceEvidence
} from './survey-raw-data-ledger.js'
import {
  recordDerivedObservationValueCorrection,
  replayDerivedCorrections,
  type SurveyDerivedCorrectionReplay
} from './survey-derived-correction-ledger.js'

type SurveyProjectLookup = (id: string) => { id: string; workspace: string; revision: number } | null
export class SurveyFreeLevelingServiceError extends Error {
  constructor(readonly reason: 'source-ineligible' | 'stale' | 'unsupported-network' | 'unsupported-observations' | 'mixed-weights' | 'dimension-limit' | 'idempotency-conflict') {
    super(`free_leveling_${reason}`)
    this.name = 'SurveyFreeLevelingServiceError'
  }
}
type StoredAdjustment = { run: AdjustmentRunV1; result?: AdjustmentResultV1 }
/**
 * An immutable admission record binds the mutable network projection to the
 * preserved raw file and parser-derived SourceFile facts that made it eligible
 * in the first place. A raw-file hash alone cannot prove that a later edit did
 * not relabel an archive-only source as adjustment-ready.
 */
type SurveySourceAdmissionRecord = Readonly<{
  schemaVersion: 1
  networkId: string
  projectId: string
  sourceSha256: string
  sourceFileHash: string
  solverInputHash: string
  recordedAt: string
  thisHash: string
}>
/** Immutable adjustment output evidence, distinct from the mutable result row. */
type SurveyAdjustmentEvidenceRecord = Readonly<{
  schemaVersion: 1
  adjustmentId: string
  projectId: string
  networkId: string
  inputHash: string
  sourceAdmissionHash: string
  calculationHash: string
  outputHash: string
  recordedAt: string
  thisHash: string
}>
type SurveySourceAdmissionVerification = Readonly<{
  valid: boolean
  errors: readonly string[]
  record?: SurveySourceAdmissionRecord
}>
type SurveyAdjustmentEvidenceVerification = Readonly<{
  valid: boolean
  errors: readonly string[]
  record?: SurveyAdjustmentEvidenceRecord
}>
type CurrentDeformationEpoch = Readonly<{
  adjustment: { run: AdjustmentRunV1; result: AdjustmentResultV1 }
  network: SurveyNetworkV1
}>
type AdjustmentExecution = Readonly<{
  method: AdjustmentRunV1['method']
  constraint: AdjustmentRunV1['constraint']
}>
type SurveyNetworkValidationRequest = Readonly<{
  expectedRevision: number
  idempotencyKey: string
}>
/**
 * A bare adjustment result is not sufficient idempotency evidence: the same
 * network can be requested with a different method/constraint or after its
 * source/network state changes.  Keep the exact execution semantics and the
 * current input fingerprint alongside the immutable historical result.
 */
type StoredAdjustmentIdempotency = Readonly<{
  kind: 'survey-adjustment'
  requestHash: string
  projectId: string
  networkId: string
  inputHash: string
  method: AdjustmentRunV1['method']
  constraint: AdjustmentRunV1['constraint']
  result: StoredAdjustment
}>
/**
 * Validation replay is a fresh read of the durable network, not an authority
 * carried in the mutable generic idempotency table. The envelope binds only
 * the request and a canonical projection that must match the current row.
 */
type StoredValidationNetworkIdempotency = Readonly<{
  kind: 'survey-network-validation'
  requestHash: string
  projectId: string
  networkId: string
  resultingRevision: number
  solverInputHash: string
  durableNetworkHash: string
  findingsHash: string
}>
/**
 * A stored adjustment plus current, non-persisted source-admission evidence.
 * The result itself is immutable historical evidence; the optional admission
 * fields only state whether its source could still enter a new computation.
 */
export type SurveyAdjustmentRead = StoredAdjustment & {
  rawSourceIntegrity?: SurveyRawSourceIntegrity
  sourceEligibility?: SurveySourceEligibility
}
export type SurveyAdjustmentSummary = SurveyAdjustmentRead & {
  observationEpoch?: string
  networkType?: SurveyNetworkV1['networkType']
  coordinateSystem?: string
  verticalDatum?: string
}
type StoredDerivedCorrectionIdempotency = Readonly<{
  networkId: string
  requestHash: string
  record: SurveyDerivedCorrectionRecordV1
}>
/**
 * A deformation result cannot by itself prove which request produced it: the
 * result records the canonical epoch order, while callers may submit IDs in a
 * different order and choose different pair definitions.  Bind the generic
 * idempotency slot to a canonical request fingerprint as well as the result.
 */
type StoredDeformationIdempotency = Readonly<{
  kind: 'deformation-comparison'
  requestHash: string
  result: DeformationComparisonV1
}>
type ImportRequestSourceBinding = Readonly<{
  mode: 'raw-source' | 'legacy-structured'
  name: string | null
  originalSha256: string | null
  originalByteLength: number | null
}>
type PreparedImportRequest = Readonly<{
  requestHash: string
  source: ImportRequestSourceBinding
  sourceBytes?: Buffer
}>
type StoredImportSourceProvenance = ImportRequestSourceBinding & Readonly<{
  format: string | null
  formatVersion: string | null
  parserId: string | null
  parserVersion: string | null
  parserSourceHash: string | null
}>
/**
 * Import records used to store a bare SurveyNetworkV1 in the global
 * idempotency table.  That made a key reusable across projects or source
 * files.  Keep an explicit versioned envelope so imported historical rows
 * remain readable through survey_networks but cannot be re-issued without
 * the request evidence that proves what they were imported from.
 */
type StoredImportNetworkIdempotency = Readonly<{
  kind: 'survey-network-import'
  requestHash: string
  projectId: string
  source: StoredImportSourceProvenance
  network: SurveyNetworkV1
  durableNetworkHash: string
}>
type SurveyPathOperations = Readonly<{
  relative: (from: string, to: string) => string
  isAbsolute: (value: string) => boolean
  sep: string
}>

export type SurveyRawSourceIntegrity = Readonly<{
  status: 'verified' | 'legacy-unverified' | 'failed'
  ledgerEntryCount: number
  errors: readonly string[]
}>

/**
 * Server-derived source admission state.  Renderers must consume this rather
 * than reconstructing readiness from only a disposition and hash status.
 */
export type SurveySourceEligibility = Readonly<{
  eligible: boolean
  findings: readonly SurveyQualityFindingV1[]
}>

/**
 * This is an internal/server-trusted command, not a renderer request body.
 * A future authenticated workflow must supply the actor from server identity
 * context rather than accepting an arbitrary browser-provided actor id.
 */
export type RecordTrustedSurveyDerivedObservationValueCorrection = Readonly<{
  id: string
  networkId: string
  expectedNetworkRevision: number
  idempotencyKey: string
  observationId: string
  afterValue: number
  reason: string
  basis: SurveyDerivedCorrectionBasisV1
  operation: SurveyDerivedCorrectionOperationV1
  actor: SurveyDerivedCorrectionActorV1
  /** Must be the current derived-correction head, or the raw genesis hash for the first record. */
  expectedCorrectionHeadHash: string
}>

const ALGORITHM_VERSION = 'workwise-survey-adjustment-7'
const LEGACY_ELLIPSE_FREE_ALGORITHM = 'workwise-survey-adjustment-6'

function pointErrorEllipse(run: AdjustmentRunV1, solved: { covariance: Matrix; varianceFactor: number; varianceFactorEstimated: boolean }, x: number, y: number) {
  return run.algorithmVersion === LEGACY_ELLIPSE_FREE_ALGORITHM ? {} : {
    xyErrorEllipse: surveyErrorEllipse(solved.covariance, x, y, solved.varianceFactor, solved.varianceFactorEstimated)
  }
}
const MAX_POINTS = 10_000
const MAX_OBSERVATIONS = 100_000
const MAX_UNKNOWN_PARAMETERS = 20_000
const MAX_MATRIX_NON_ZERO = 5_000_000
const nativeSurveyPathOperations: SurveyPathOperations = { relative, isAbsolute, sep }

/** Cross-platform containment check used before reading preserved source bytes. */
export function isSurveyRuntimePathContained(root: string, candidate: string, pathOperations: SurveyPathOperations = nativeSurveyPathOperations): boolean {
  const rel = pathOperations.relative(root, candidate)
  return rel !== '..' && !rel.startsWith(`..${pathOperations.sep}`) && !pathOperations.isAbsolute(rel)
}

/**
 * A correction idempotency key is bound to the exact trusted command.  This
 * prevents a caller from accidentally replaying a different observation edit
 * after a retry, while avoiding the public request-idempotency namespace.
 */
function derivedCorrectionRequestHash(input: RecordTrustedSurveyDerivedObservationValueCorrection): string {
  const value = {
    schemaVersion: 1,
    id: input.id,
    networkId: input.networkId,
    expectedNetworkRevision: input.expectedNetworkRevision,
    observationId: input.observationId,
    afterValue: input.afterValue,
    reason: input.reason,
    basis: {
      kind: input.basis.kind,
      referenceId: input.basis.referenceId,
      ...(input.basis.evidenceHash === undefined ? {} : { evidenceHash: input.basis.evidenceHash })
    },
    operation: {
      id: input.operation.id,
      version: input.operation.version,
      ...(input.operation.implementationHash === undefined ? {} : { implementationHash: input.operation.implementationHash })
    },
    actor: { id: input.actor.id, kind: input.actor.kind },
    expectedCorrectionHeadHash: input.expectedCorrectionHeadHash
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Epoch order is derived from observation time, so caller ordering is not a
 * separate calculation semantic. Pair-array order is retained because it is
 * reflected in the bounded result and may be meaningful to a caller.
 */
function deformationComparisonRequestHash(input: DeformationComparisonRequestV1): string {
  const value = {
    schemaVersion: 1,
    projectId: input.projectId,
    adjustmentIds: [...input.adjustmentIds].sort(),
    pairs: input.pairs.map((pair) => ({
      id: pair.id,
      firstPointId: pair.firstPointId,
      secondPointId: pair.secondPointId,
      kind: pair.kind,
      distanceMode: pair.distanceMode,
      ...(pair.baselineM === undefined ? {} : { baselineM: pair.baselineM })
    })),
    stabilityRateMPerDay: input.stabilityRateMPerDay
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Only methods that the deterministic kernel actually dispatches may be
 * recorded on a run.  In particular, conditional/free/minimum-constraint
 * adjustment is a planned capability, not an alternate label for the current
 * fixed-datum WLS implementation.
 */
function resolveAdjustmentExecution(
  network: SurveyNetworkV1,
  requestedMethod: AdjustmentExecution['method'] | undefined,
  requestedConstraint: AdjustmentExecution['constraint'] | undefined
): AdjustmentExecution {
  const transformType = network.networkType === 'coordinate-transform' ? resolveCoordinateTransformType(network) : null
  const method: AdjustmentExecution['method'] = transformType === 'helmert-7'
    ? 'helmert-seven-parameter'
    : transformType === 'height-fit'
      ? 'height-fit'
      : 'weighted-least-squares'
  const constraint: AdjustmentExecution['constraint'] = 'fixed-known-points'

  if (requestedMethod !== undefined && requestedMethod !== method) {
    throw new Error(`requested adjustment method ${requestedMethod} is not implemented for ${network.networkType}; the current deterministic execution is ${method}`)
  }
  if (requestedConstraint !== undefined && requestedConstraint !== constraint) {
    throw new Error(`requested adjustment constraint ${requestedConstraint} is not implemented; the current deterministic execution uses ${constraint}`)
  }
  return Object.freeze({ method, constraint })
}

function adjustmentRequestHash(network: SurveyNetworkV1, inputHash: string, execution: AdjustmentExecution): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    projectId: network.projectId,
    networkId: network.id,
    inputHash,
    method: execution.method,
    constraint: execution.constraint
  })).digest('hex')
}

/**
 * Idempotency evidence and its durable adjustment row must describe precisely
 * the same deterministic output.  This fingerprint intentionally includes
 * immutable run metadata as well as the result: reusing an idempotency key
 * must never silently turn one calculation into another historical run.
 */
function adjustmentOutputHash(value: StoredAdjustment): string {
  return sha256CanonicalSurveyValue({ run: value.run, result: value.result })
}

function validationRequestHash(networkId: string, expectedRevision: number): string {
  return sha256CanonicalSurveyValue({ schemaVersion: 1, networkId, expectedRevision })
}

/** Compare fresh validation meaning while ignoring generated finding IDs/times. */
function validationFindingsHash(findings: readonly SurveyQualityFindingV1[]): string {
  const stable = findings.map(({ id: _id, networkId: _networkId, createdAt: _createdAt, ...findingValue }) => findingValue)
    .sort((left, right) => canonicalImportRequestJson(left).localeCompare(canonicalImportRequestJson(right)))
  return sha256CanonicalSurveyValue(stable)
}

/** Serialize import semantics without relying on object insertion order. */
function canonicalImportRequestJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('import idempotency request contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalImportRequestJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalImportRequestJson(object[key])}`).join(',')}}`
  }
  throw new Error(`unsupported import idempotency value: ${typeof value}`)
}

function sha256CanonicalSurveyValue(value: unknown): string {
  return createHash('sha256').update(canonicalImportRequestJson(value)).digest('hex')
}

/** Fields that directly define a numerical calculation, excluding mutable lifecycle/UI state. */
function surveySolverInputHash(network: SurveyNetworkV1): string {
  return sha256CanonicalSurveyValue({
    schemaVersion: 1,
    projectId: network.projectId,
    networkId: network.id,
    networkType: network.networkType,
    transformType: network.transformType ?? null,
    coordinateSystem: network.coordinateSystem,
    projection: network.projection,
    centralMeridian: network.centralMeridian ?? null,
    ellipsoid: network.ellipsoid,
    verticalDatum: network.verticalDatum,
    heightDatum: network.heightDatum ?? null,
    unit: network.unit,
    knownPoints: network.knownPoints,
    unknownPoints: network.unknownPoints,
    observations: network.observations,
    instrumentParameters: network.instrumentParameters,
    observationEpoch: network.observationEpoch ?? null,
    inputAttachmentHash: network.inputAttachmentHash ?? null
  })
}

function surveySourceFileAdmissionHash(source: SurveySourceFileV1): string {
  // Preserve all parser, format, unit, diagnosis, disposition, and record
  // anchor facts. The source itself is protected separately by its raw hash.
  return sha256CanonicalSurveyValue({ schemaVersion: 1, source })
}

function sourceAdmissionRecordHash(record: Omit<SurveySourceAdmissionRecord, 'thisHash'>): string {
  return sha256CanonicalSurveyValue(record)
}

function adjustmentEvidenceRecordHash(record: Omit<SurveyAdjustmentEvidenceRecord, 'thisHash'>): string {
  return sha256CanonicalSurveyValue(record)
}

/**
 * Calculation equivalence ignores ephemeral output identity/time and finding
 * IDs, but retains every deterministic numerical field and finding meaning.
 */
function adjustmentCalculationHash(result: AdjustmentResultV1): string {
  const { id: _id, runId: _runId, createdAt: _createdAt, qualityFindings, ...stable } = result
  return sha256CanonicalSurveyValue({
    ...stable,
    qualityFindings: qualityFindings.map(({ id: _findingId, networkId: _networkId, createdAt: _findingCreatedAt, ...findingValue }) => findingValue)
  })
}

/**
 * expectedRevision is intentionally excluded: a successful import retry must
 * remain replayable after ordinary project revision changes. Everything that
 * can alter imported identity, provenance, parsing, or solver input is bound.
 */
function prepareImportRequest(request: SurveyNetworkImportRequest): PreparedImportRequest {
  const sourceBytes = request.dataBase64 === undefined ? undefined : Buffer.from(request.dataBase64, 'base64')
  const source: ImportRequestSourceBinding = Object.freeze({
    mode: request.network ? 'legacy-structured' : 'raw-source',
    name: request.name ?? null,
    originalSha256: sourceBytes ? createHash('sha256').update(sourceBytes).digest('hex') : null,
    originalByteLength: sourceBytes ? sourceBytes.length : null
  })
  const semanticRequest = {
    schemaVersion: 1,
    projectId: request.projectId,
    source,
    networkType: request.networkType ?? null,
    transformType: request.transformType ?? null,
    inputAttachmentHash: request.inputAttachmentHash ?? null,
    cosaIn1Mapping: request.cosaIn1Mapping ?? null,
    knownPoints: request.knownPoints ?? null,
    // Retain a canonical structural compatibility request too. It is not
    // publicly accepted by Runtime, but migrated in-process callers must not
    // be able to replay a different legacy network under the same key.
    network: request.network ?? null
  }
  return Object.freeze({
    requestHash: createHash('sha256').update(canonicalImportRequestJson(semanticRequest)).digest('hex'),
    source,
    ...(sourceBytes ? { sourceBytes } : {})
  })
}

function sameUniqueIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length) return false
  const orderedLeft = [...left].sort()
  const orderedRight = [...right].sort()
  return orderedLeft.every((id, index) => id === orderedRight[index])
}

/**
 * The database record carries an immutable historical identity, but a new
 * report or retry must also prove that its numerical payload still equals a
 * fresh comparison of the current adjustment evidence. Exclude only the
 * record identity/timestamp and the request-only input hash from this
 * calculation fingerprint; all derived numerical and epoch evidence remains
 * bound.
 */
function deformationCalculationHash(result: DeformationComparisonV1): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: result.schemaVersion,
    projectId: result.projectId,
    referenceAdjustmentId: result.referenceAdjustmentId,
    currentAdjustmentId: result.currentAdjustmentId,
    adjustmentIds: result.adjustmentIds,
    referenceEpoch: result.referenceEpoch,
    currentEpoch: result.currentEpoch,
    durationDays: result.durationDays,
    epochs: result.epochs,
    points: result.points,
    pairs: result.pairs,
    stabilityRateMPerDay: result.stabilityRateMPerDay,
    algorithmVersion: result.algorithmVersion
  })).digest('hex')
}

/**
 * A persisted pair result retains exactly the definition needed to recompute
 * it. For a tilt whose original baseline was implicit, recording the resolved
 * reference-epoch baseline is semantically equivalent and deliberately makes
 * historical re-verification independent of an omitted UI field.
 */
function deformationPairDefinitions(result: DeformationComparisonV1): DeformationPairDefinitionV1[] {
  return result.pairs.map((pair) => ({
    id: pair.id,
    firstPointId: pair.firstPointId,
    secondPointId: pair.secondPointId,
    kind: pair.kind,
    distanceMode: pair.distanceMode,
    ...(pair.kind === 'tilt' && pair.baselineM !== undefined ? { baselineM: pair.baselineM } : {})
  }))
}

function rawSourceEvidence(source: SurveySourceFileV1 | undefined): SurveyRawSourceEvidence | null {
  if (!source) return null
  return {
    sha256: source.sha256,
    fileSize: source.fileSize,
    originalPreserved: source.originalPreserved,
    // Legacy records may carry zero-length locators. They are not trusted as
    // record anchors, but the immutable source-file hash remains useful.
    records: source.records
      .filter((record) => record.rawLength > 0)
      .map((record) => ({
        id: record.id,
        rawOffset: record.rawOffset,
        rawLength: record.rawLength,
        ...(record.rawLineNo === undefined ? {} : { rawLineNo: record.rawLineNo })
      }))
  }
}

function pointMap(network: SurveyNetworkV1): Map<string, SurveyPointV1> {
  return new Map([...network.knownPoints, ...network.unknownPoints].map((point) => [point.id, point]))
}

function observationEndpointIds(observation: SurveyObservationV1): string[] {
  return [observation.from, observation.to, observation.station, observation.target, observation.left, observation.right].filter((id): id is string => Boolean(id))
}

function finding(networkId: string, code: SurveyQualityFindingV1['code'], severity: SurveyQualityFindingV1['severity'], message: string, suggestion: string, row?: number, nowIso = () => new Date().toISOString()): SurveyQualityFindingV1 {
  return SurveyQualityFindingV1.parse({ schemaVersion: 1, id: `survey_finding_${randomUUID()}`, networkId, code, severity, message, suggestion, ...(row === undefined ? {} : { row }), status: 'open', createdAt: nowIso() })
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

function applyKnownPointMappings(
  sourceKnownPoints: readonly SurveyPointV1[],
  sourceUnknownPoints: readonly SurveyPointV1[],
  mappings: readonly SurveyKnownPointInputV1[] | undefined
): { knownPoints: SurveyPointV1[]; unknownPoints: SurveyPointV1[] } {
  if (!mappings?.length) return { knownPoints: [...sourceKnownPoints], unknownPoints: [...sourceUnknownPoints] }
  const points = new Map<string, SurveyPointV1>([...sourceKnownPoints, ...sourceUnknownPoints].map((point) => [point.id, point]))
  for (const mapping of mappings) {
    const existing = points.get(mapping.id)
    const conflicting = existing && (['x', 'y', 'height', 'latitude', 'longitude'] as const).some((key) => {
      const requested = mapping[key]
      return requested !== undefined && existing[key] !== undefined && Math.abs(existing[key]! - requested) > 1e-12
    })
    if (conflicting) throw new Error(`known point mapping conflicts with source coordinates: ${mapping.id}`)
    points.set(mapping.id, SurveyPointV1.parse({
      ...(existing ?? {}),
      ...mapping,
      pointClass: 'known',
      known: true,
      sourceLocator: existing?.sourceLocator ?? `manual-known-point:${mapping.id}`
    }))
  }
  const all = [...points.values()]
  return {
    knownPoints: all.filter((point) => point.known || point.pointClass === 'known'),
    unknownPoints: all.filter((point) => !point.known && point.pointClass !== 'known')
  }
}

function angleValue(value: unknown): number | undefined {
  const numeric = asNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.trim().replace(/[º°]/g, ' ').replace(/[′']/g, ' ').replace(/[″"]/g, ' ')
  const parts = text.split(/\s+/).filter(Boolean).map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return undefined
  const sign = parts[0]! < 0 ? -1 : 1
  const degrees = Math.abs(parts[0]!)
  const minutes = Math.abs(parts[1] ?? 0)
  const seconds = Math.abs(parts[2] ?? 0)
  return sign * (degrees + minutes / 60 + seconds / 3600)
}

/**
 * Import diagnostics are a projection of the parser-derived SourceFile, not
 * mutable network UI state. Reconstruct them from the admitted source before
 * every validation/calculation so deleting `network.findings` cannot turn an
 * unresolved format condition into a solver-ready input.
 */
function sourceImportFindingsFromSourceFile(
  networkId: string,
  sourceFile: SurveySourceFileV1 | undefined,
  nowIso: () => string
): SurveyQualityFindingV1[] {
  if (!sourceFile) return []
  const diagnostics = sourceFile.diagnostics
    .filter((item) => item.severity !== 'info')
    .map((item) => ({ ...finding(
      networkId,
      item.code === 'format_detected' ? 'format_detected'
        : item.code === 'format_conflict' ? 'format_conflict'
        : item.code === 'unknown_format' ? 'unknown_format'
          : item.code === 'record_ignored' ? 'record_ignored'
          : item.code === 'gnss_processing_required' ? 'gnss_processing_required'
            : item.code === 'converter_required' ? 'converter_required'
              : item.code === 'mapping_required' ? 'mapping_required'
                : 'parse_error',
      item.severity,
      item.message,
      item.suggestedAction ?? (item.code === 'gnss_processing_required'
        ? '先完成 GNSS 基线解算并提供固定基准与完整协方差'
        : item.code === 'converter_required'
          ? '安装并授权受审计的本地格式转换器后重试'
          : item.code === 'mapping_required'
            ? '选择并确认列映射、线性单位和角度格式，保存映射方案后重新导入'
            : '检查文件格式、扩展名和原始记录后重试'),
      item.sourceRecord,
      nowIso
    ), ...(item.localized ? { localized: item.localized } : {}) }))
  const disposition = sourceFile.disposition === 'adjustment-ready'
    ? []
    : [finding(
      networkId,
      'source_not_adjustment_ready',
      'blocking',
      `源文件处置为 ${sourceFile.disposition}，不得进入平差：${sourceFile.dispositionReason}`,
      sourceFile.disposition === 'gnss-processing-required'
        ? '先完成 GNSS 后处理并重新导入带基线向量和协方差的结果。'
        : sourceFile.disposition === 'converter-required'
          ? '使用经审计的本地转换器生成受支持格式后重新导入。'
          : '保留原始文件；补充格式映射或验证证据后，通过显式重新检测/导入流程再进入平差。',
      undefined,
      nowIso
    )]
  return [...diagnostics, ...disposition]
}

function parseDelimited(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) return []
  const parseLine = (line: string): string[] => {
    const values: string[] = []; let current = ''; let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1 }
      else if (char === '"') quoted = !quoted
      else if (char === ',' && !quoted) { values.push(current.trim()); current = '' }
      else current += char
    }
    values.push(current.trim()); return values
  }
  const headers = parseLine(lines[0]!).map((value, index) => value || `column_${index + 1}`)
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] ?? ''])))
}

async function parseNetworkPayload(
  name: string,
  bytes: Buffer,
  projectId: string,
  nowIso: () => string,
  formatRegistry: SurveyFormatRegistry,
  networkType?: SurveyNetworkV1['networkType'],
  transformType?: SurveyNetworkV1['transformType'],
  cosaIn1Mapping?: CosaIn1Mapping,
  knownPointMappings?: readonly SurveyKnownPointInputV1[],
  persistSource?: (source: SurveySourceEnvelope) => Promise<void>
): Promise<SurveyNetworkV1> {
  const source = await formatRegistry.ingest({ name, bytes, networkType, cosaIn1Mapping })
  await persistSource?.(source)
  const mappedPoints = applyKnownPointMappings(source.knownPoints, source.unknownPoints, knownPointMappings)
  // Converted output, when present, is the active parser source. The original
  // input hash remains in sourceFile.conversionInput and cannot replace it.
  const sourceHash = source.sourceFile.sha256
  const sourceFindingsFor = (networkId: string): SurveyQualityFindingV1[] => sourceImportFindingsFromSourceFile(networkId, source.sourceFile, nowIso)
  const sourceQualityStatus = (findings: readonly SurveyQualityFindingV1[]): 'imported' | 'blocked' => findings.some((item) => item.severity === 'blocking') ? 'blocked' : 'imported'
  // Do not decode or parse frozen source bytes a second time here. The
  // registry has already decoded UTF-8/UTF-16 safely and schema-validated the
  // envelope; re-reading bytes as UTF-8 made the same UTF-16 source fall into
  // the generic importer and let request metadata change its survey meaning.
  // The registry also owns the observation arrays because it attaches the
  // immutable raw-record anchors used by residual provenance.
  const frozenNetwork = source.sourceFile.detection.format === 'workwise-json' ? source.frozenNetwork : undefined
  if (frozenNetwork) {
    const networkId = frozenNetwork.id ?? `network_${randomUUID()}`
    const findings = sourceFindingsFor(networkId)
    return SurveyNetworkV1.parse({
      schemaVersion: 1,
      id: networkId,
      projectId,
      // A frozen WorkWise source is the sole authority for its solver
      // semantics.  `networkType` and `transformType` in the import request
      // are only UI hints for non-frozen/vendor sources and must never fill a
      // missing declaration here.  The structural fallback keeps an
      // incomplete historical source readable, while the registry's blocking
      // diagnostic keeps it archive-only and out of every calculation path.
      networkType: frozenNetwork.networkType ?? 'leveling',
      transformType: frozenNetwork.transformType,
      coordinateSystem: frozenNetwork.coordinateSystem ?? source.coordinateSystem ?? '待确认',
      projection: frozenNetwork.projection ?? source.projection ?? '待确认',
      ...(frozenNetwork.centralMeridian !== undefined ? { centralMeridian: frozenNetwork.centralMeridian } : {}),
      ellipsoid: frozenNetwork.ellipsoid ?? source.ellipsoid ?? '待确认',
      verticalDatum: frozenNetwork.verticalDatum ?? frozenNetwork.heightDatum ?? source.verticalDatum ?? '待确认',
      unit: source.unit ?? frozenNetwork.unit ?? 'm',
      // The registry is the sole parser for frozen source records. Reusing
      // raw JSON arrays here would drop its sourceRecordId/sourceLocator and
      // sever residuals and derived corrections from immutable anchors.
      knownPoints: mappedPoints.knownPoints,
      unknownPoints: mappedPoints.unknownPoints,
      observations: source.observations,
      instrumentParameters: source.instrumentParameters ?? {},
      observationEpoch: source.observationEpoch,
      inputAttachmentHash: sourceHash,
      sourceFile: source.sourceFile,
      qualityStatus: sourceQualityStatus(findings), findings, revision: 1, createdAt: nowIso(), updatedAt: nowIso()
    })
  }
  const generalFormat = source.sourceFile.detection.format === 'xlsx' || source.sourceFile.detection.format === 'delimited-text'
  if (!generalFormat) {
    const selectedNetworkType = isGnssSurveyFormat(source.sourceFile.detection.format) ? 'gnss' : networkType ?? 'leveling'
    const networkId = `network_${randomUUID()}`
    const findings = sourceFindingsFor(networkId)
    return SurveyNetworkV1.parse({
      schemaVersion: 1,
      id: networkId,
      projectId,
      networkType: selectedNetworkType,
      ...(transformType ? { transformType } : {}),
      coordinateSystem: source.coordinateSystem ?? '待确认',
      projection: source.projection ?? '待确认',
      ellipsoid: source.ellipsoid ?? '待确认',
      verticalDatum: source.verticalDatum ?? '待确认',
      unit: source.unit ?? 'm',
      knownPoints: mappedPoints.knownPoints,
      unknownPoints: mappedPoints.unknownPoints,
      observations: source.observations,
      instrumentParameters: source.instrumentParameters ?? {},
      observationEpoch: source.observationEpoch,
      inputAttachmentHash: sourceHash,
      sourceFile: source.sourceFile,
      qualityStatus: findings.some((item) => item.severity === 'blocking') ? 'blocked' : 'imported',
      findings,
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso()
    })
  }
  const rows = source.sourceFile.detection.format === 'xlsx' ? await parseXlsxRows(source.effectiveBytes) : parseDelimited(source.effectiveText ?? new TextDecoder('utf-8').decode(source.effectiveBytes))
  const observations: SurveyObservationV1[] = rows.map((row, index) => {
    const type = String(row.type || row.observationType || (networkType === 'leveling' || networkType === 'height-control' ? 'height-difference' : networkType === 'coordinate-transform' ? 'coordinate-pair' : 'distance')) as SurveyObservationV1['type']
    const vectorX = asNumber(row.vectorX || row.vector_x || row.dx || row.deltaX || row.delta_x || row['ΔX'])
    const vectorY = asNumber(row.vectorY || row.vector_y || row.dy || row.deltaY || row.delta_y || row['ΔY'])
    const vectorZ = asNumber(row.vectorZ || row.vector_z || row.dz || row.deltaZ || row.delta_z || row['ΔZ'])
    const rawValue = row.value || row.heightDiff || row.distance || row.angle || row.direction
    const value = (type === 'gnss-baseline' && vectorX !== undefined && vectorY !== undefined && vectorZ !== undefined) || type === 'coordinate-pair'
      ? (asNumber(rawValue) ?? 0)
      : ['angle', 'direction', 'zenith'].includes(type) ? angleValue(rawValue) : asNumber(rawValue)
    if (value === undefined) throw new Error(`invalid observation value at row ${index + 2}`)
    return SurveyObservationV1.parse({ id: row.observationId || row.observation_id || row.id || `obs_${index + 1}`, type, from: row.from || row.start || row.station || (type === 'coordinate-pair' ? row.id : undefined), to: row.to || row.end || row.target, station: row.station, target: row.target, left: row.left, right: row.right, value, unit: row.unit || (['height-difference', 'distance', 'slope-distance', 'gnss-baseline', 'coordinate-pair'].includes(type) ? 'm' : 'deg'), vectorX, vectorY, vectorZ, sigma: asNumber(row.sigma), sigmaUnit: row.sigmaUnit || row.sigma_unit || undefined, covariance: row.covariance ? row.covariance.split(/[;,\s]+/).map(Number).filter(Number.isFinite) : undefined, targetX: asNumber(row.targetX || row.target_x), targetY: asNumber(row.targetY || row.target_y), targetHeight: asNumber(row.targetHeight || row.target_h), stationHeightOffset: asNumber(row.stationHeightOffset || row.instrumentHeight || row.instrument_height), targetHeightOffset: asNumber(row.targetHeightOffset || row.prismHeight || row.prism_height), routeLength: asNumber(row.routeLength), sourceRow: index + 2, sourceLocator: row.worksheet ? `${row.worksheet}!${index + 2}` : undefined })
  })
  const ids = [...new Set(observations.flatMap(observationEndpointIds))]
  const requestedNetworkType = networkType ?? 'leveling'
  const parsedTransformType = CoordinateTransformTypeV1.safeParse(transformType ?? rows[0]?.transformType ?? rows[0]?.transform_type)
  if (requestedNetworkType === 'coordinate-transform') {
    const sourcePoints = new Map<string, SurveyPointV1>()
    rows.forEach((row, index) => {
      const id = row.from || row.id || `point_${index + 1}`
      if (sourcePoints.has(id)) return
      sourcePoints.set(id, SurveyPointV1.parse({ id, pointClass: 'known', known: true, x: asNumber(row.sourceX || row.source_x || row.x), y: asNumber(row.sourceY || row.source_y || row.y), height: asNumber(row.sourceHeight || row.source_height || row.height || row.h), latitude: asNumber(row.latitude || row.lat), longitude: asNumber(row.longitude || row.lon || row.lng), sourceRow: index + 2 }))
    })
    const networkId = `network_${randomUUID()}`
    const findings = sourceFindingsFor(networkId)
    return SurveyNetworkV1.parse({ schemaVersion: 1, id: networkId, projectId, networkType: requestedNetworkType, ...(parsedTransformType.success ? { transformType: parsedTransformType.data } : {}), coordinateSystem: '待确认', projection: '待确认', centralMeridian: asNumber(rows[0]?.centralMeridian || rows[0]?.central_meridian), ellipsoid: rows[0]?.ellipsoid || '待确认', verticalDatum: '待确认', unit: rows[0]?.unit || 'm', knownPoints: [...sourcePoints.values()], unknownPoints: [], observations, inputAttachmentHash: sourceHash, sourceFile: source.sourceFile, qualityStatus: sourceQualityStatus(findings), findings, revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
  }
  const points = ids.map((id) => SurveyPointV1.parse({ id, pointClass: 'unknown', known: false }))
  const networkId = `network_${randomUUID()}`
  const findings = sourceFindingsFor(networkId)
  return SurveyNetworkV1.parse({ schemaVersion: 1, id: networkId, projectId, networkType: requestedNetworkType, coordinateSystem: '待确认', projection: '待确认', ellipsoid: '待确认', verticalDatum: '待确认', unit: 'm', knownPoints: [], unknownPoints: points, observations, inputAttachmentHash: sourceHash, sourceFile: source.sourceFile, qualityStatus: sourceQualityStatus(findings), findings, revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
}

async function parseXlsxRows(bytes: Buffer): Promise<Record<string, string>[]> {
  const zip = await JSZip.loadAsync(bytes)
  const sharedXml = zip.file('xl/sharedStrings.xml') ? await zip.file('xl/sharedStrings.xml')!.async('text') : ''
  const shared = [...sharedXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? ''))
  const files = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  const output: Record<string, string>[] = []
  for (const fileName of files) {
    const xml = await zip.file(fileName)!.async('text'); const rows: string[][] = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of rowMatch[1]!.matchAll(/<c[^>]*r="([A-Z]+)\d+"[^>]*?(?:t="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
        const index = lettersToIndex(cell[1]!); const value = decodeXml(cell[3]!.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? cell[3]!.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '')
        cells[index] = cell[2] === 's' ? (shared[Number(value)] ?? value) : value
      }
      rows.push(cells)
    }
    const headers = (rows[0] ?? []).map((value, index) => value || `column_${index + 1}`)
    for (const cells of rows.slice(1)) output.push({ ...Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])), worksheet: fileName })
  }
  return output
}

function lettersToIndex(value: string): number { let index = 0; for (const char of value) index = index * 26 + char.charCodeAt(0) - 64; return index - 1 }
function decodeXml(value: string): string { return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'") }

const LINEAR_UNIT_SCALES: Readonly<Record<string, number>> = Object.freeze({
  m: 1, meter: 1, meters: 1,
  km: 1_000,
  cm: 0.01,
  mm: 0.001
})

const ANGULAR_UNIT_SCALES: Readonly<Record<string, number>> = Object.freeze({
  rad: 1, radian: 1, radians: 1,
  gon: Math.PI / 200, grad: Math.PI / 200, grads: Math.PI / 200,
  deg: Math.PI / 180, degree: Math.PI / 180, degrees: Math.PI / 180, '°': Math.PI / 180,
  arcsec: 1 / 206264.806247, arcsecond: 1 / 206264.806247, arcseconds: 1 / 206264.806247,
  sec: 1 / 206264.806247, '″': 1 / 206264.806247
})

function normalizedUnitToken(unit: string): string { return unit.trim().toLowerCase() }
function isAngularObservation(observation: SurveyObservationV1): boolean { return ['direction', 'angle', 'zenith'].includes(observation.type) }
function linearUnitScale(unit: string): number | undefined { return LINEAR_UNIT_SCALES[normalizedUnitToken(unit)] }
function angularUnitScale(unit: string): number | undefined { return ANGULAR_UNIT_SCALES[normalizedUnitToken(unit)] }
function requireLinearUnitScale(unit: string): number {
  const scale = linearUnitScale(unit)
  if (scale === undefined) throw new Error(`unsupported linear unit: ${unit}`)
  return scale
}
function requireAngularUnitScale(unit: string): number {
  const scale = angularUnitScale(unit)
  if (scale === undefined) throw new Error(`unsupported angular unit: ${unit}`)
  return scale
}

function normalizeObservationValue(observation: SurveyObservationV1): number {
  return isAngularObservation(observation)
    ? observation.value * requireAngularUnitScale(observation.unit)
    : observation.value * requireLinearUnitScale(observation.unit)
}

function normalizedResidualUnit(observation: SurveyObservationV1): 'm' | 'rad' {
  return observation.type === 'direction' || observation.type === 'angle' || observation.type === 'zenith' ? 'rad' : 'm'
}

/** Maps a residual back to its source observation, including vector/control components. */
function sourceObservationForResidual(network: SurveyNetworkV1, observationId: string): SurveyObservationV1 | undefined {
  const exact = network.observations.find((observation) => observation.id === observationId)
  if (exact) return exact
  const component = /^(.*):(x|y|z|h)$/.exec(observationId)
  return component ? network.observations.find((observation) => observation.id === component[1]) : undefined
}

function retainResidualSourceAnchors(network: SurveyNetworkV1, result: AdjustmentResultV1): AdjustmentResultV1 {
  return AdjustmentResultV1.parse({
    ...result,
    observations: result.observations.map((residual) => {
      const source = sourceObservationForResidual(network, residual.observationId)
      return source?.sourceRecordId ? { ...residual, sourceRecordId: source.sourceRecordId } : residual
    })
  })
}

function inferredClosureUnits(closure: Record<string, number>): Record<string, 'm' | 'rad' | 'ppm' | 'ratio'> {
  const units: Record<string, 'm' | 'rad' | 'ppm' | 'ratio'> = {}
  for (const key of Object.keys(closure)) {
    if (key === 'rotationRad' || key === 'angular') units[key] = 'rad'
    else if (key === 'scalePpm') units[key] = 'ppm'
    else if (key === 'relativeClosure') units[key] = 'ratio'
    else units[key] = 'm'
  }
  return units
}

function normalizeLengthUncertainty(value: number, unit: string): number {
  return value * requireLinearUnitScale(unit)
}

function lengthUnitScale(unit: string): number {
  return requireLinearUnitScale(unit)
}

function gnssVectorMetres(observation: SurveyObservationV1): [number, number, number] | null {
  if (observation.vectorX === undefined || observation.vectorY === undefined || observation.vectorZ === undefined) return null
  const scale = lengthUnitScale(observation.unit)
  return [observation.vectorX * scale, observation.vectorY * scale, observation.vectorZ * scale]
}

function gnssCovarianceMetres(observation: SurveyObservationV1): Matrix | null {
  if (observation.covariance?.length !== 9) return null
  const scaleSquared = lengthUnitScale(observation.unit) ** 2
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => observation.covariance![row * 3 + column]! * scaleSquared))
}

function angleRadians(value: number, unit: string): number {
  return value * requireAngularUnitScale(unit)
}

function unitCompatibilityFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const findings: SurveyQualityFindingV1[] = []
  for (const observation of network.observations) {
    const angular = isAngularObservation(observation)
    const valid = angular ? angularUnitScale(observation.unit) !== undefined : linearUnitScale(observation.unit) !== undefined
    if (!valid) {
      findings.push(finding(
        network.id,
        'unit_conflict',
        'blocking',
        `观测 ${observation.id} 的单位 ${observation.unit} 没有已确认的 ${angular ? '角度' : '长度'}换算定义，不能进入平差。`,
        angular ? '选择并确认 deg、gon/grad、rad 或 arcsec。' : '选择并确认 m、km、cm 或 mm。',
        observation.sourceRow,
        nowIso
      ))
    }
    if (observation.sigmaUnit) {
      const validSigma = angular ? angularUnitScale(observation.sigmaUnit) !== undefined : linearUnitScale(observation.sigmaUnit) !== undefined
      if (!validSigma) {
        findings.push(finding(
          network.id,
          'unit_conflict',
          'blocking',
          `观测 ${observation.id} 的中误差单位 ${observation.sigmaUnit} 没有已确认的换算定义，不能进入平差。`,
          angular ? '选择并确认 deg、gon/grad、rad 或 arcsec。' : '选择并确认 m、km、cm 或 mm。',
          observation.sourceRow,
          nowIso
        ))
      }
    }
  }
  if (linearUnitScale(network.unit) === undefined) {
    findings.push(finding(
      network.id,
      'unit_conflict',
      'blocking',
      `网络长度单位 ${network.unit} 没有已确认的换算定义，不能进入平差。`,
      '选择并确认 m、km、cm 或 mm。',
      undefined,
      nowIso
    ))
  }
  return findings
}

/**
 * A source can be present and hash-verifiable yet still be unsafe to adjust:
 * the canonical unit claim may be absent, or observations may not resolve to
 * a one-to-one physical record in the preserved original.  Keep this check
 * separate from the raw-ledger check so historical records remain readable
 * while all mutating/derived paths fail closed.
 */
function sourceAdjustabilityFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const source = network.sourceFile
  if (!source) return [finding(
    network.id,
    'source_not_adjustment_ready',
    'blocking',
    '网络未记录可进入平差的原始资料来源。',
    '从保留的原始文件重新导入，并保留每条观测的精确原始记录锚点。',
    undefined,
    nowIso
  )]

  const findings: SurveyQualityFindingV1[] = []
  if (source.disposition !== 'adjustment-ready') {
    findings.push(finding(
      network.id,
      'source_not_adjustment_ready',
      'blocking',
      `源文件处置为 ${source.disposition}，不得进入平差：${source.dispositionReason}`,
      '请先完成来源文件要求的映射、验证、GNSS 后处理或受审计转换，并重新导入。',
      undefined,
      nowIso
    ))
  }
  const hasAuditableLinearEvidence = source.linearUnitCanonical === 'm'
    && !['legacy-unknown', 'not-declared'].includes(source.linearUnitRaw)
    && source.parserSourceHash !== 'legacy-unavailable'
  if (!hasAuditableLinearEvidence) {
    findings.push(finding(
      network.id,
      'unit_conflict',
      'blocking',
      `源文件未提供可审计的米制线性单位证据（linearUnitCanonical=${source.linearUnitCanonical}，linearUnitRaw=${source.linearUnitRaw}），不得进入平差。`,
      '保留原始单位声明，并通过受审计的换算或映射将线性量明确确认到 m 后重新导入。',
      undefined,
      nowIso
    ))
  }
  const hasAngularObservations = network.observations.some(isAngularObservation)
  const hasAuditableAngularEvidence = source.angularUnitCanonical === 'rad'
    && !['legacy-unknown', 'not-declared'].includes(source.angularUnitRaw)
    && source.parserSourceHash !== 'legacy-unavailable'
  if (hasAngularObservations && !hasAuditableAngularEvidence) {
    findings.push(finding(
      network.id,
      'unit_conflict',
      'blocking',
      `源文件未提供可审计的弧度角度单位证据（angularUnitCanonical=${source.angularUnitCanonical}，angularUnitRaw=${source.angularUnitRaw}），不得进入平差。`,
      '保留原始角度单位声明，并通过受审计的换算或映射将角度量明确确认到 rad 后重新导入。',
      undefined,
      nowIso
    ))
  }

  const anchorsById = new Map<string, typeof source.records>()
  for (const anchor of source.records) anchorsById.set(anchor.id, [...(anchorsById.get(anchor.id) ?? []), anchor])
  for (const observation of network.observations) {
    const sourceRecordId = observation.sourceRecordId
    if (!sourceRecordId) {
      findings.push(finding(
        network.id,
        'source_not_adjustment_ready',
        'blocking',
        `观测 ${observation.id} 未关联原始资料记录锚点，不得进入平差。`,
        '从保留的原始文件重新导入，并确保该观测的 sourceRecordId 可唯一解析至精确记录。',
        observation.sourceRow,
        nowIso
      ))
      continue
    }
    const anchors = anchorsById.get(sourceRecordId) ?? []
    if (anchors.length !== 1) {
      findings.push(finding(
        network.id,
        'source_not_adjustment_ready',
        'blocking',
        `观测 ${observation.id} 的原始资料记录锚点 ${sourceRecordId} 不存在或不唯一，不得进入平差。`,
        '从保留的原始文件重新导入，并确保该 sourceRecordId 可唯一解析至精确的原始资料记录锚点。',
        observation.sourceRow,
        nowIso
      ))
      continue
    }
    const anchor = anchors[0]!
    // One physical source record can legitimately emit multiple observations
    // (for example GSI direction/zenith/slope-distance), and a one-record
    // file may span its whole byte range.  What is unsafe is a whole-file
    // fallback used in a multi-record source instead of an exact locator.
    const isWholeFileAnchor = source.records.length > 1 && anchor.rawOffset === 0 && anchor.rawLength >= source.fileSize
    const hasExactRange = anchor.rawLength > 0 && anchor.rawOffset + anchor.rawLength <= source.fileSize && !isWholeFileAnchor
    if (!hasExactRange) {
      findings.push(finding(
        network.id,
        'source_not_adjustment_ready',
        'blocking',
        `观测 ${observation.id} 的原始资料记录锚点 ${sourceRecordId} 不是非整文件的精确字节范围，不得进入平差。`,
        '从保留的原始文件重新导入，并为该观测保存非零、非整文件的精确字节范围。',
        observation.sourceRow,
        nowIso
      ))
    }
  }
  return findings
}

function rawSourceIntegrityFindings(network: SurveyNetworkV1, integrity: SurveyRawSourceIntegrity, nowIso: () => string): SurveyQualityFindingV1[] {
  if (integrity.status === 'verified') return []
  return [finding(
    network.id,
    'raw_source_integrity',
    'blocking',
    integrity.status === 'legacy-unverified'
      ? `原始资料尚未验证：${integrity.errors.join('；')}`
      : `原始资料完整性校验失败：${integrity.errors.join('；')}`,
    '恢复或重新导入与来源哈希一致的原始文件；不得以结构化网络内容替代原始资料。',
    undefined,
    nowIso
  )]
}

/**
 * Solver maps are keyed by point/observation ID.  Persisted historical input
 * can contain duplicates that pass the structural schema but would otherwise
 * make those maps silently last-write-wins (or make residual provenance pick
 * the first observation).  Detect them before every eligibility decision.
 */
function identityAmbiguityFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const duplicateIds = (ids: readonly string[]): string[] => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id)
      seen.add(id)
    }
    return [...duplicates].sort()
  }
  const compact = (ids: readonly string[]) => `${ids.slice(0, 10).join('、')}${ids.length > 10 ? ` 等 ${ids.length} 个` : ''}`
  const findings: SurveyQualityFindingV1[] = []
  const duplicatePointIds = duplicateIds([...network.knownPoints, ...network.unknownPoints].map((point) => point.id))
  if (duplicatePointIds.length) {
    findings.push(finding(
      network.id,
      'invalid_observation',
      'blocking',
      `已知点/未知点中存在重复点号 ${compact(duplicatePointIds)}；点位映射不唯一，不能进入平差。`,
      '为每个已知点和未知点分配唯一点号后重新导入。',
      undefined,
      nowIso
    ))
  }
  const duplicateObservationIds = duplicateIds(network.observations.map((observation) => observation.id))
  if (duplicateObservationIds.length) {
    findings.push(finding(
      network.id,
      'invalid_observation',
      'blocking',
      `观测中存在重复观测编号 ${compact(duplicateObservationIds)}；残差与原始资料映射不唯一，不能进入平差。`,
      '为每条观测分配唯一编号并保留对应的原始资料记录锚点后重新导入。',
      undefined,
      nowIso
    ))
  }
  return findings
}

function positiveRadians(value: number): number {
  const wrapped = wrapRadians(value)
  return wrapped < 0 ? wrapped + 2 * Math.PI : wrapped
}

function mergeFindings(...groups: SurveyQualityFindingV1[][]): SurveyQualityFindingV1[] {
  const unique = new Map<string, SurveyQualityFindingV1>()
  for (const item of groups.flat()) {
    const key = `${item.code}:${item.message}:${item.row ?? ''}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
}

function levelingRouteClosure(network: SurveyNetworkV1, observations: SurveyObservationV1[], points = pointMap(network)): number | undefined {
  const first = observations[0]
  const last = observations[observations.length - 1]
  if (!first?.from || !last?.to) return undefined
  const ordered = observations.every((observation, index) => Boolean(observation.from && observation.to) && (index === 0 || observations[index - 1]!.to === observation.from))
  if (!ordered) return undefined
  const observed = observations.reduce((sum, observation) => sum + normalizeObservationValue(observation), 0)
  const declaredClosed = network.instrumentParameters.closedLoop === 1 || first.from === last.to
  if (declaredClosed) return first.from === last.to ? observed : undefined
  const start = points.get(first.from)
  const end = points.get(last.to)
  return start?.known && end?.known && start.height !== undefined && end.height !== undefined
    ? observed - (end.height - start.height)
    : undefined
}

function levelingClosures(network: SurveyNetworkV1, observations: SurveyObservationV1[], points = pointMap(network)): Record<string, number> {
  const route = levelingRouteClosure(network, observations, points)
  if (route !== undefined) return { heightDifference: route }
  const controls = new Map([...points].filter(([, point]) => point.known && point.height !== undefined).map(([id, point]) => [id, point.height!]))
  const cycles = levelingNetworkClosures(controls, observations.flatMap((observation) => observation.from && observation.to
    ? [{ id: observation.id, from: observation.from, to: observation.to, heightDifferenceMetres: normalizeObservationValue(observation) }]
    : []))
  if (!cycles.length) return {}
  return {
    heightDifference: Math.max(...cycles.map((cycle) => Math.abs(cycle.misclosureMetres))),
    ...Object.fromEntries(cycles.map((cycle) => [`leveling-cycle:${cycle.observationId}`, cycle.misclosureMetres]))
  }
}

function levelingStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const observations = network.observations.filter((item) => item.type === 'height-difference')
  const points = pointMap(network)
  const findings: SurveyQualityFindingV1[] = []
  if (!observations.length) findings.push(finding(network.id, 'invalid_observation', 'blocking', '水准网没有高差观测', '导入包含 from、to 和高差值的水准观测', undefined, nowIso))
  const unsupported = network.observations.find((item) => item.type !== 'height-difference')
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `水准网不支持观测类型 ${unsupported.type}`, '水准/高程控制网仅导入高差观测，其他观测请使用对应网型', unsupported.sourceRow, nowIso))
  if (!network.knownPoints.some((point) => point.known && point.height !== undefined)) findings.push(finding(network.id, 'missing_datum', 'blocking', '水准网缺少已知高程基准点', '至少提供一个已知点高程并标记为已知', undefined, nowIso))
  const malformed = observations.find((item) => !item.from || !item.to)
  if (malformed) findings.push(finding(network.id, 'malformed_geometry', 'blocking', `水准观测 ${malformed.id} 缺少起点或终点`, '补充 from/to 点号后重新导入', malformed.sourceRow, nowIso))
  const missingPoint = observations.flatMap(observationEndpointIds).find((id) => !points.has(id))
  if (missingPoint) findings.push(finding(network.id, 'missing_point', 'blocking', `水准观测引用了不存在的点 ${missingPoint}`, '补充点记录或修正观测点号', undefined, nowIso))
  if (network.instrumentParameters.closedLoop === 1 && observations.length) {
    const first = observations[0]!
    const last = observations[observations.length - 1]!
    const ordered = observations.every((observation, index) => index === 0 || observations[index - 1]!.to === observation.from)
    if (!ordered || !first.from || first.from !== last.to) findings.push(finding(network.id, 'malformed_geometry', 'blocking', '声明的水准闭合路线不是首尾相接的连续观测序列', '按测段顺序整理观测，并确保最后一点回到起点', undefined, nowIso))
  }
  return findings
}

function traverseAzimuths(network: SurveyNetworkV1, distances: SurveyObservationV1[], angular: SurveyObservationV1[]): number[] | null {
  const routePointIds = [distances[0]?.from, ...distances.map((item) => item.to)]
  const startAzimuth = network.instrumentParameters.startAzimuthRad
    ?? (network.instrumentParameters.startAzimuthDeg === undefined ? undefined : network.instrumentParameters.startAzimuthDeg * Math.PI / 180)
  const azimuths: number[] = []
  for (let index = 0; index < distances.length; index += 1) {
    const edge = distances[index]!
    const direction = angular.find((item) => item.type === 'direction' && (item.from ?? item.station) === edge.from && (item.to ?? item.target) === edge.to)
    if (direction) {
      azimuths.push(angleRadians(direction.value, direction.unit))
      continue
    }
    if (index === 0) {
      if (startAzimuth === undefined) return null
      azimuths.push(startAzimuth)
      continue
    }
    const turn = angular.find((item) => item.type === 'angle' && item.station === routePointIds[index] && item.left === routePointIds[index - 1] && item.right === routePointIds[index + 1])
    if (!turn) return null
    azimuths.push(azimuths[index - 1]! + Math.PI + angleRadians(turn.value, turn.unit))
  }
  return azimuths
}

function traverseStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const distances = network.observations.filter((item) => item.type === 'distance')
  const angular = network.observations.filter((item) => ['angle', 'direction'].includes(item.type))
  const findings: SurveyQualityFindingV1[] = []
  const unsupported = network.observations.find((item) => !['distance', 'angle', 'direction'].includes(item.type))
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `导线网不能把 ${unsupported.type} 直接作为水平边长或角度参与平差`, '先完成斜距化平/天顶距处理，或改用水平距离、方向和转折角', unsupported.sourceRow, nowIso))
  if (distances.length < 2 || !angular.length) findings.push(finding(network.id, 'invalid_observation', 'blocking', '导线平差至少需要两条有序边长和完整角度/方向观测', '补充导线边长及转折角或绝对方向观测', undefined, nowIso))
  if (distances.some((item) => !item.from || !item.to) || distances.some((item, index) => index > 0 && distances[index - 1]!.to !== item.from)) {
    findings.push(finding(network.id, 'malformed_geometry', 'blocking', '导线边长必须按 from→to 连续有序排列', '按导线行进顺序整理边长观测，确保上一边终点等于下一边起点', undefined, nowIso))
    return findings
  }
  if (!distances.length) return findings
  const points = pointMap(network)
  const start = points.get(distances[0]!.from!)
  const end = points.get(distances[distances.length - 1]!.to!)
  if (!start?.known || !end?.known || start.x === undefined || start.y === undefined || end.x === undefined || end.y === undefined) {
    findings.push(finding(network.id, 'missing_datum', 'blocking', '附合/闭合导线必须有已知起点和已知终点坐标', '将首尾控制点标记为已知并提供 X/Y 坐标', undefined, nowIso))
  }
  const routePointIds = [distances[0]!.from!, ...distances.map((item) => item.to!)]
  const missingCoordinate = routePointIds.find((id) => {
    const point = points.get(id)
    return !point || point.x === undefined || point.y === undefined
  })
  if (missingCoordinate) findings.push(finding(network.id, 'missing_point', 'blocking', `导线点 ${missingCoordinate} 缺少平面近似坐标`, '为路线内每个已知点和未知点提供 X/Y 坐标', undefined, nowIso))
  const interiorIds = new Set(routePointIds.slice(1, -1))
  if (!network.unknownPoints.some((point) => interiorIds.has(point.id))) findings.push(finding(network.id, 'invalid_observation', 'blocking', '导线没有需要平差的中间未知点', '至少提供一个位于有序导线中的未知点及其近似坐标', undefined, nowIso))
  const unmatchedAngular = angular.find((item) => {
    if (item.type === 'direction') return !distances.some((edge) => (item.from ?? item.station) === edge.from && (item.to ?? item.target) === edge.to)
    return !distances.slice(1).some((_, index) => item.station === routePointIds[index + 1] && item.left === routePointIds[index] && item.right === routePointIds[index + 2])
  })
  if (unmatchedAngular) findings.push(finding(network.id, 'malformed_geometry', 'blocking', `导线角度/方向观测 ${unmatchedAngular.id} 与有序路线不匹配`, '使用路线相邻点填写 direction 的 from/to，或 angle 的 station/left/right', unmatchedAngular.sourceRow, nowIso))
  if (!traverseAzimuths(network, distances, angular)) findings.push(finding(network.id, 'malformed_geometry', 'blocking', '导线缺少完整定向：每条边必须有绝对方向，或由起始方位角和连续转折角推算', '补充逐边方向，或设置 startAzimuthDeg 并按相邻点填写转折角', undefined, nowIso))
  return findings
}

function planeControlStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const supported = network.observations.filter((item) => ['distance', 'direction', 'angle'].includes(item.type))
  const points = pointMap(network)
  const findings: SurveyQualityFindingV1[] = []
  if (supported.length < 2) findings.push(finding(network.id, 'invalid_observation', 'blocking', '平面控制网至少需要两条距离、绝对方向或测站角观测', '补充能够独立确定未知坐标的平面观测', undefined, nowIso))
  const unsupported = network.observations.find((item) => !['distance', 'direction', 'angle'].includes(item.type))
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `平面控制网不支持直接使用 ${unsupported.type}`, '先完成观测预处理，再导入水平距离、绝对方向或测站角', unsupported.sourceRow, nowIso))
  if (!network.unknownPoints.some((point) => !point.known)) findings.push(finding(network.id, 'invalid_observation', 'blocking', '平面控制网没有待平差未知点', '至少提供一个含 X/Y 近似坐标的未知点', undefined, nowIso))
  if (!network.knownPoints.some((point) => point.known && point.x !== undefined && point.y !== undefined)) findings.push(finding(network.id, 'missing_datum', 'blocking', '平面控制网缺少已知坐标约束', '至少提供一个已知平面控制点，或使用明确的自由网约束', undefined, nowIso))
  for (const observation of supported) {
    const fromId = observation.from ?? observation.station
    const toId = observation.to ?? observation.target
    if ((observation.type === 'distance' || observation.type === 'direction') && (!fromId || !toId)) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `观测 ${observation.id} 缺少 from/to 或 station/target`, '补充观测起点和目标点', observation.sourceRow, nowIso))
    }
    if (observation.type === 'angle' && (!observation.station || !observation.left || !observation.right || new Set([observation.station, observation.left, observation.right]).size < 3)) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `角度观测 ${observation.id} 缺少有效的 station/left/right 几何`, '填写三个互不相同且存在坐标的点号', observation.sourceRow, nowIso))
    }
    if (observation.type === 'angle' && observation.station && observation.left && observation.right) {
      const station = points.get(observation.station)
      const left = points.get(observation.left)
      const right = points.get(observation.right)
      if (station?.x !== undefined && station.y !== undefined && left?.x !== undefined && left.y !== undefined && right?.x !== undefined && right.y !== undefined
        && (Math.hypot(left.x - station.x, left.y - station.y) < 1e-9 || Math.hypot(right.x - station.x, right.y - station.y) < 1e-9)) {
        findings.push(finding(network.id, 'malformed_geometry', 'blocking', `角度观测 ${observation.id} 的测站与照准点坐标重合`, '修正点号或近似坐标，使两条照准方向具有有效长度', observation.sourceRow, nowIso))
      }
    }
    for (const id of observationEndpointIds(observation)) {
      const point = points.get(id)
      if (!point || point.x === undefined || point.y === undefined) findings.push(finding(network.id, 'missing_point', 'blocking', `平面观测 ${observation.id} 的点 ${id} 缺少 X/Y 坐标`, '补充已知坐标或未知点近似坐标', observation.sourceRow, nowIso))
    }
  }
  return mergeFindings(findings)
}

function triangulationStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const angles = network.observations.filter((item) => item.type === 'angle')
  const supported = network.observations.filter((item) => ['angle', 'direction', 'distance'].includes(item.type))
  const points = pointMap(network)
  const findings: SurveyQualityFindingV1[] = []
  if (angles.length < 2) findings.push(finding(network.id, 'invalid_observation', 'blocking', angles.length === 0 ? '三角网不能使用纯距离观测冒充角度网络' : '三角网至少需要两条独立测站角观测', '提供采用 station/left/right 表达的三角网角度观测', undefined, nowIso))
  const unsupported = network.observations.find((item) => !['angle', 'direction', 'distance'].includes(item.type))
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `三角网不支持直接使用 ${unsupported.type}`, '先完成观测预处理，再导入测站角及必要的方向/尺度观测', unsupported.sourceRow, nowIso))
  if (network.knownPoints.filter((point) => point.known && point.x !== undefined && point.y !== undefined).length < 2) findings.push(finding(network.id, 'missing_datum', 'blocking', '三角网缺少两个已知平面控制点来固定基准和尺度', '至少提供两个不重合的已知控制点坐标', undefined, nowIso))
  const knownCoordinateKeys = new Set(network.knownPoints.filter((point) => point.known && point.x !== undefined && point.y !== undefined).map((point) => `${point.x}:${point.y}`))
  if (network.knownPoints.filter((point) => point.known && point.x !== undefined && point.y !== undefined).length >= 2 && knownCoordinateKeys.size < 2) findings.push(finding(network.id, 'malformed_geometry', 'blocking', '三角网已知控制点坐标重合，无法固定基准和尺度', '提供至少两个坐标不同的已知控制点', undefined, nowIso))
  if (!network.unknownPoints.some((point) => !point.known)) findings.push(finding(network.id, 'invalid_observation', 'blocking', '三角网没有待平差未知点', '至少提供一个含 X/Y 近似坐标的未知点', undefined, nowIso))
  for (const observation of supported) {
    const fromId = observation.from ?? observation.station
    const toId = observation.to ?? observation.target
    if (observation.type === 'angle' && (!observation.station || !observation.left || !observation.right || new Set([observation.station, observation.left, observation.right]).size < 3)) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `三角网角度 ${observation.id} 缺少有效的 station/left/right 几何`, '填写三个互不相同且存在坐标的点号', observation.sourceRow, nowIso))
    }
    if (observation.type === 'angle' && observation.station && observation.left && observation.right) {
      const station = points.get(observation.station)
      const left = points.get(observation.left)
      const right = points.get(observation.right)
      if (station?.x !== undefined && station.y !== undefined && left?.x !== undefined && left.y !== undefined && right?.x !== undefined && right.y !== undefined
        && (Math.hypot(left.x - station.x, left.y - station.y) < 1e-9 || Math.hypot(right.x - station.x, right.y - station.y) < 1e-9)) {
        findings.push(finding(network.id, 'malformed_geometry', 'blocking', `三角网角度 ${observation.id} 的测站与照准点坐标重合`, '修正点号或近似坐标，使两条照准方向具有有效长度', observation.sourceRow, nowIso))
      }
    }
    if ((observation.type === 'distance' || observation.type === 'direction') && (!fromId || !toId)) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `三角网观测 ${observation.id} 缺少起点或目标点`, '补充 from/to 或 station/target 点号', observation.sourceRow, nowIso))
    }
    for (const id of observationEndpointIds(observation)) {
      const point = points.get(id)
      if (!point || point.x === undefined || point.y === undefined) findings.push(finding(network.id, 'missing_point', 'blocking', `三角网观测 ${observation.id} 的点 ${id} 缺少 X/Y 坐标`, '补充已知坐标或未知点近似坐标', observation.sourceRow, nowIso))
    }
  }
  return mergeFindings(findings)
}

function cpiiiStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const stations = network.unknownPoints.filter((point) => !point.known && point.pointClass === 'station')
  const stationIds = new Set(stations.map((point) => point.id))
  const points = pointMap(network)
  const findings: SurveyQualityFindingV1[] = []
  const supportedTypes: SurveyObservationV1['type'][] = ['distance', 'slope-distance', 'direction', 'zenith']
  const unsupported = network.observations.find((item) => !supportedTypes.includes(item.type))
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `CPIII 自由测站不支持观测类型 ${unsupported.type}`, '导入方向、水平距离、斜距和天顶距观测；测站角应先转换为方向读数', unsupported.sourceRow, nowIso))
  if (!stations.length) findings.push(finding(network.id, 'invalid_observation', 'blocking', 'CPIII 网络没有 pointClass=station 的未知测站', '至少提供一个含 X/Y 近似坐标的未知测站', undefined, nowIso))
  if (network.unknownPoints.some((point) => !point.known && point.pointClass !== 'station')) findings.push(finding(network.id, 'invalid_observation', 'blocking', 'CPIII 自由测站策略只允许测站坐标为未知参数', '将照准目标设置为已知 CPIII 控制点，其他未知点使用平面控制网策略', undefined, nowIso))
  for (const observation of network.observations.filter((item) => supportedTypes.includes(item.type))) {
    const stationId = observation.station ?? observation.from
    const targetId = observation.target ?? observation.to
    if (!stationId || !targetId || stationId === targetId) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `CPIII 观测 ${observation.id} 缺少有效 station/target`, '填写互不相同的测站和固定目标点号', observation.sourceRow, nowIso))
      continue
    }
    if (!stationIds.has(stationId)) findings.push(finding(network.id, 'malformed_geometry', 'blocking', `CPIII 观测 ${observation.id} 的测站 ${stationId} 不是未知 station 点`, '将测站定义为 pointClass=station 的未知点', observation.sourceRow, nowIso))
    const station = points.get(stationId)
    const target = points.get(targetId)
    if (!station || station.x === undefined || station.y === undefined) findings.push(finding(network.id, 'missing_point', 'blocking', `CPIII 测站 ${stationId} 缺少 X/Y 近似坐标`, '补充测站平面近似坐标', observation.sourceRow, nowIso))
    if (!target?.known || target.x === undefined || target.y === undefined) findings.push(finding(network.id, 'missing_datum', 'blocking', `CPIII 目标 ${targetId} 不是含 X/Y 坐标的固定控制点`, '补充固定 CPIII 目标坐标并标记为已知', observation.sourceRow, nowIso))
    if ((observation.type === 'slope-distance' || observation.type === 'zenith') && (station?.height === undefined || target?.height === undefined)) findings.push(finding(network.id, 'missing_datum', 'blocking', `CPIII 垂直观测 ${observation.id} 缺少测站或目标高程`, '补充测站近似高程和固定目标高程', observation.sourceRow, nowIso))
  }
  for (const station of stations) {
    const stationObservations = network.observations.filter((item) => (item.station ?? item.from) === station.id && supportedTypes.includes(item.type))
    const directions = stationObservations.filter((item) => item.type === 'direction')
    const directionTargets = new Set(directions.map((item) => item.target ?? item.to).filter((id): id is string => Boolean(id)))
    if (directions.length < 3 || directionTargets.size < 3) findings.push(finding(network.id, 'malformed_geometry', 'blocking', `CPIII 测站 ${station.id} 少于三个独立固定方向目标`, '每个测站至少观测三个不同的固定 CPIII 目标方向', undefined, nowIso))
    const verticalTargets = new Set(stationObservations.filter((item) => item.type === 'slope-distance' || item.type === 'zenith').map((item) => item.target ?? item.to).filter((id): id is string => Boolean(id)))
    for (const targetId of verticalTargets) {
      const hasSlope = stationObservations.some((item) => item.type === 'slope-distance' && (item.target ?? item.to) === targetId)
      const hasZenith = stationObservations.some((item) => item.type === 'zenith' && (item.target ?? item.to) === targetId)
      if (!hasSlope || !hasZenith) findings.push(finding(network.id, 'malformed_geometry', 'blocking', `CPIII 测站 ${station.id} 至目标 ${targetId} 的斜距/天顶距证据不成对`, '为同一 station/target 同时提供 slope-distance 和 zenith', undefined, nowIso))
    }
  }
  return mergeFindings(findings)
}

function gnssStrategyFindings(network: SurveyNetworkV1, nowIso: () => string): SurveyQualityFindingV1[] {
  const baselines = network.observations.filter((item) => item.type === 'gnss-baseline')
  const points = pointMap(network)
  const findings: SurveyQualityFindingV1[] = []
  const unsupported = network.observations.find((item) => item.type !== 'gnss-baseline')
  if (unsupported) findings.push(finding(network.id, 'invalid_observation', 'blocking', `GNSS 网络不支持观测类型 ${unsupported.type}`, 'GNSS 平差仅导入带 ΔX/ΔY/ΔZ 和 3×3 协方差的基线向量', unsupported.sourceRow, nowIso))
  if (!baselines.length) findings.push(finding(network.id, 'missing_baseline', 'blocking', 'GNSS 网络没有基线向量观测', '导入至少一条含 from、to、ΔX、ΔY、ΔZ 和 3×3 协方差的基线', undefined, nowIso))
  if (!network.unknownPoints.some((point) => !point.known)) findings.push(finding(network.id, 'invalid_observation', 'blocking', 'GNSS 网络没有待平差三维未知点', '至少提供一个 GNSS 未知点', undefined, nowIso))
  if (!network.knownPoints.some((point) => point.known && point.x !== undefined && point.y !== undefined && point.height !== undefined)) {
    findings.push(finding(network.id, 'missing_datum', 'blocking', 'GNSS 平差缺少含 X/Y/H 的固定三维基准点', '至少提供一个标记为已知且含 X、Y、高程的固定基准点', undefined, nowIso))
  }
  for (const baseline of baselines) {
    if (!['m', 'meter', 'meters', 'mm', 'cm', 'km'].includes(baseline.unit.trim().toLowerCase())) {
      findings.push(finding(network.id, 'unit_conflict', 'blocking', `GNSS 基线 ${baseline.id} 的单位 ${baseline.unit} 无法安全换算为米`, '使用 m、km、cm 或 mm，并确保协方差采用同一单位的平方', baseline.sourceRow, nowIso))
    }
    const hasValidEndpoints = Boolean(baseline.from && baseline.to && baseline.from !== baseline.to)
    if (!hasValidEndpoints) {
      findings.push(finding(network.id, 'malformed_geometry', 'blocking', `GNSS 基线 ${baseline.id} 缺少互不相同的 from/to 端点`, '补充有效基线起点和终点', baseline.sourceRow, nowIso))
    }
    const from = baseline.from ? points.get(baseline.from) : undefined
    const to = baseline.to ? points.get(baseline.to) : undefined
    if (hasValidEndpoints && (!from || !to)) {
      findings.push(finding(network.id, 'missing_point', 'blocking', `GNSS 基线 ${baseline.id} 引用了不存在的端点`, '补充端点记录或修正点号', baseline.sourceRow, nowIso))
    }
    if (!gnssVectorMetres(baseline)) {
      findings.push(finding(network.id, 'invalid_observation', 'blocking', `GNSS 基线 ${baseline.id} 只有标量值或缺少 ΔX/ΔY/ΔZ 分量`, '提供完整三分量基线；标量距离不能替代 GNSS 基线向量', baseline.sourceRow, nowIso))
    }
    const covariance = gnssCovarianceMetres(baseline)
    if (!covariance) {
      findings.push(finding(network.id, 'missing_covariance', 'blocking', `GNSS 基线 ${baseline.id} 缺少完整 3×3 协方差`, '按行主序提供 9 个协方差元素，单位为观测单位平方', baseline.sourceRow, nowIso))
    } else if (!choleskyDecompose(covariance)) {
      findings.push(finding(network.id, 'invalid_observation', 'blocking', `GNSS 基线 ${baseline.id} 的 3×3 协方差不对称或非正定`, '复核协方差矩阵的对称性、单位和正定性', baseline.sourceRow, nowIso))
    }
    for (const point of [from, to].filter((item): item is SurveyPointV1 => Boolean(item))) {
      if (point.known && (point.x === undefined || point.y === undefined || point.height === undefined)) {
        findings.push(finding(network.id, 'missing_datum', 'blocking', `GNSS 固定点 ${point.id} 缺少 X/Y/H 三维坐标`, '补齐固定基准点的 X、Y 和高程', point.sourceRow ?? baseline.sourceRow, nowIso))
      }
    }
  }
  return mergeFindings(findings)
}

function levelingEquations(network: SurveyNetworkV1) {
  const points = pointMap(network); const unknown = network.unknownPoints.filter((point) => !point.known)
  const unknownIds = unknown.map((point) => point.id); const index = new Map(unknownIds.map((id, i) => [id, i]))
  const rows: Array<{ coefficients: number[]; misclosure: number; weight: number; observation: SurveyObservationV1 }> = []
  for (const observation of network.observations) {
    if (observation.type !== 'height-difference') continue
    if (!observation.from || !observation.to) continue
    const from = points.get(observation.from); const to = points.get(observation.to); if (!from || !to) continue
    const fromApprox = from.height ?? 0; const toApprox = to.height ?? 0
    const coefficients = Array.from({ length: unknownIds.length }, () => 0)
    const fromIndex = index.get(observation.from); const toIndex = index.get(observation.to)
    if (fromIndex !== undefined) coefficients[fromIndex] = -1
    if (toIndex !== undefined) coefficients[toIndex] = 1
    const weight = observation.sigma === undefined
      ? 1 / (observation.routeLength ?? 1)
      : 1 / normalizeLengthUncertainty(observation.sigma, observation.sigmaUnit ?? observation.unit) ** 2
    rows.push({ coefficients, misclosure: normalizeObservationValue(observation) - (toApprox - fromApprox), weight, observation })
  }
  return { points, unknownIds, index, rows }
}

function buildLevelingResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), levelingStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const { points, unknownIds, index, rows } = levelingEquations(network)
  const solved = weightedLeastSquares(rows)
  if (!solved) return invalidAdjustmentResult(network, run, baseFindings.concat(finding(network.id, 'rank_deficient', 'blocking', '水准网法方程秩亏或网形不连通', '补充已知点或观测，检查点号和网形')), nowIso)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const i = index.get(point.id); const correction = i === undefined ? 0 : solved.corrections[i]!
    const q = i === undefined ? undefined : solved.covariance[i]?.[i]
    return { id: point.id, ...(point.height === undefined ? {} : { height: point.height }), ...(i === undefined ? {} : { correctionHeight: correction, height: (point.height ?? 0) + correction, standardError: Math.sqrt(Math.max(0, (q ?? 0) * solved.varianceFactor)), covariance: solved.covariance[i] }) }
  })
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  const observationResults = rows.map((row, i) => ({ observationId: row.observation.id, correction: solved.residuals[i]!, residual: solved.residuals[i]!, unit: 'm' as const, standardizedResidual: Math.abs(solved.residuals[i]!) / Math.max(1e-12, Math.sqrt(1 / row.weight)), outlier: Math.abs(solved.residuals[i]!) / Math.max(1e-12, Math.sqrt(1 / row.weight)) > 3, sourceRow: row.observation.sourceRow }))
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `观测 ${item.observationId} 的标准化残差超过 3σ`, '复核原始观测、仪器和录入值', item.sourceRow, nowIso))
  const maxStd = pointResults.reduce((max, point) => Math.max(max, point.standardError ?? 0), 0)
  const closure = levelingClosures(network, rows.map((row) => row.observation), points)
  const closureUnits = Object.fromEntries(Object.keys(closure).map((key) => [key, 'm' as const]))
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', '水准网没有多余观测，单位权中误差采用先验值，不能进行后验精度检验', '增加独立复测路线或闭合观测', undefined, nowIso)]
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: rows.length, unknownCount: unknownIds.length, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure, closureUnits, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, passed: outlierFindings.length === 0 }, qualityFindings: [...baseFindings, ...outlierFindings, ...reliabilityFindings], inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: 1, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function displacement(point: SurveyPointV1, adjusted: { x?: number; y?: number; height?: number }): AdjustmentDisplacementV1 {
  const dX = adjusted.x === undefined || point.x === undefined ? undefined : adjusted.x - point.x
  const dY = adjusted.y === undefined || point.y === undefined ? undefined : adjusted.y - point.y
  const dH = adjusted.height === undefined || point.height === undefined ? undefined : adjusted.height - point.height
  const magnitude = Math.sqrt((dX ?? 0) ** 2 + (dY ?? 0) ** 2 + (dH ?? 0) ** 2)
  const kind = dH !== undefined && (dX !== undefined || dY !== undefined) ? 'three-dimensional' : dH !== undefined ? 'vertical' : 'horizontal'
  return AdjustmentDisplacementV1.parse({ pointId: point.id, ...(dX === undefined ? {} : { dX }), ...(dY === undefined ? {} : { dY }), ...(dH === undefined ? {} : { dH }), magnitude, kind })
}

/** GNSS vector-baseline adjustment with full correlated 3 x 3 covariance. */
function buildGnssResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const points = pointMap(network)
  const unknown = network.unknownPoints.filter((point) => !point.known)
  const unknownIds = unknown.map((point) => point.id)
  const index = new Map(unknownIds.flatMap((id, i) => [[`${id}:x`, i * 3], [`${id}:y`, i * 3 + 1], [`${id}:h`, i * 3 + 2]]))
  const baselines = network.observations.filter((item) => item.type === 'gnss-baseline')
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), gnssStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const parameterCount = unknownIds.length * 3
  const rows: Array<{ coefficients: number[]; misclosure: number; weight: number }> = []
  const blocks: Array<{ observation: SurveyObservationV1; design: Matrix; misclosures: [number, number, number]; covariance: Matrix }> = []
  for (const observation of baselines) {
    const fromId = observation.from!
    const toId = observation.to!
    const from = points.get(fromId)!
    const to = points.get(toId)!
    const observed = gnssVectorMetres(observation)!
    const covariance = gnssCovarianceMetres(observation)!
    const initialFrom = [from.x ?? 0, from.y ?? 0, from.height ?? 0]
    const initialTo = [to.x ?? 0, to.y ?? 0, to.height ?? 0]
    const design = Array.from({ length: 3 }, (_, component) => {
      const coefficients = Array.from({ length: parameterCount }, () => 0)
      const fromIndex = index.get(`${fromId}:${component === 0 ? 'x' : component === 1 ? 'y' : 'h'}`)
      const toIndex = index.get(`${toId}:${component === 0 ? 'x' : component === 1 ? 'y' : 'h'}`)
      if (fromIndex !== undefined) coefficients[fromIndex] = -1
      if (toIndex !== undefined) coefficients[toIndex] = 1
      return coefficients
    })
    const misclosures = observed.map((value, component) => value - (initialTo[component]! - initialFrom[component]!)) as [number, number, number]
    const whitened = whitenCorrelatedEquations({ coefficients: design, misclosures, covariance })
    if (!whitened) return invalidAdjustmentResult(network, run, mergeFindings(baseFindings, [finding(network.id, 'invalid_observation', 'blocking', `GNSS 基线 ${observation.id} 的协方差无法白化`, '复核协方差矩阵的对称性和正定性', observation.sourceRow, nowIso)]), nowIso)
    rows.push(...whitened)
    blocks.push({ observation, design, misclosures, covariance })
  }
  const solved = weightedLeastSquares(rows)
  if (!solved) return invalidAdjustmentResult(network, run, baseFindings.concat(finding(network.id, 'rank_deficient', 'blocking', 'GNSS 基线法方程秩亏或基准不完整', '补充独立基线或检查固定点约束', undefined, nowIso)), nowIso)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const ix = index.get(`${point.id}:x`); const iy = index.get(`${point.id}:y`); const ih = index.get(`${point.id}:h`)
    if (ix === undefined || iy === undefined || ih === undefined) return { id: point.id, x: point.x, y: point.y, height: point.height }
    const correctionX = solved.corrections[ix]!
    const correctionY = solved.corrections[iy]!
    const correctionHeight = solved.corrections[ih]!
    const parameterIndices = [ix, iy, ih]
    const covariance = parameterIndices.flatMap((row) => parameterIndices.map((column) => (solved.covariance[row]?.[column] ?? 0) * solved.varianceFactor))
    const variance = parameterIndices.reduce((sum, parameterIndex) => sum + (solved.covariance[parameterIndex]?.[parameterIndex] ?? 0) * solved.varianceFactor, 0)
    return { id: point.id, x: (point.x ?? 0) + correctionX, y: (point.y ?? 0) + correctionY, height: (point.height ?? 0) + correctionHeight, correctionX, correctionY, correctionHeight, standardError: Math.sqrt(Math.max(0, variance)), covariance, ...pointErrorEllipse(run, solved, ix, iy) }
  })
  const observationResults = blocks.flatMap((block) => {
    const physicalResiduals = block.design.map((coefficients, component) => coefficients.reduce((sum, coefficient, parameterIndex) => sum + coefficient * solved.corrections[parameterIndex]!, 0) - block.misclosures[component]!)
    const propagated = surveyMatrix.multiply(surveyMatrix.multiply(block.design, solved.covariance), surveyMatrix.transpose(block.design))
    const residualVariances = block.covariance.map((row, component) => Math.max(0, row[component]! - (propagated[component]?.[component] ?? 0)) * solved.varianceFactor)
    return physicalResiduals.map((residual, component) => ({
      observationId: `${block.observation.id}:${component === 0 ? 'x' : component === 1 ? 'y' : 'z'}`,
      correction: residual,
      residual,
      unit: 'm' as const,
      standardizedResidual: residualVariances[component]! > 1e-24 ? Math.abs(residual) / Math.sqrt(residualVariances[component]!) : 0,
      outlier: residualVariances[component]! > 1e-24 && Math.abs(residual) / Math.sqrt(residualVariances[component]!) > 3,
      sourceRow: block.observation.sourceRow
    }))
  })
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `GNSS 基线 ${item.observationId} 的标准化残差超过 3σ`, '复核基线解算、天线高和协方差', item.sourceRow, nowIso))
  const componentNorm = (suffix: ':x' | ':y' | ':z'): number => Math.sqrt(observationResults.filter((item) => item.observationId.endsWith(suffix)).reduce((sum, item) => sum + item.residual ** 2, 0))
  const baselineX = componentNorm(':x'); const baselineY = componentNorm(':y'); const baselineZ = componentNorm(':z')
  const closure = Math.hypot(baselineX, baselineY, baselineZ)
  const maxStd = pointResults.reduce((max, point) => Math.max(max, point.standardError ?? 0), 0)
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', 'GNSS 网络没有多余基线分量，不能进行后验方差因子检验', '增加连接固定基准的独立冗余基线', undefined, nowIso)]
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: rows.length, unknownCount: parameterCount, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure: { baseline: closure, baselineX, baselineY, baselineZ }, closureUnits: { baseline: 'm', baselineX: 'm', baselineY: 'm', baselineZ: 'm' }, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, passed: outlierFindings.length === 0 }, qualityFindings: mergeFindings(baseFindings, outlierFindings, reliabilityFindings), inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: 1, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function buildPlaneControlResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), planeControlStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const points = pointMap(network)
  const observations = network.observations.filter((item) => ['distance', 'direction', 'angle'].includes(item.type))
  const unknownIds = network.unknownPoints.filter((point) => !point.known).map((point) => point.id)
  const coordinateIndexes = new Map(unknownIds.map((id, index) => [id, { x: index * 2, y: index * 2 + 1 }]))
  const circleStationIds = [...new Set(observations
    .filter((item) => item.type === 'direction' && item.rawFields?.directionReference === 'cosa-station-circle')
    .map((item) => item.station ?? item.from)
    .filter((id): id is string => Boolean(id)))]
  const orientationIndexes = new Map(circleStationIds.map((id, index) => [id, unknownIds.length * 2 + index]))
  const initialParameters = unknownIds.flatMap((id) => [points.get(id)!.x!, points.get(id)!.y!])
  const coordinates = (parameters: readonly number[]): Map<string, { x: number; y: number }> => new Map([...points].map(([id, point]) => {
    const index = coordinateIndexes.get(id)
    return [id, !index ? { x: point.x!, y: point.y! } : { x: parameters[index.x]!, y: parameters[index.y]! }]
  }))
  const bearing = (from: { x: number; y: number }, to: { x: number; y: number }): number => Math.atan2(to.x - from.x, to.y - from.y)
  const coordinate = (id: string, parameters: readonly number[]): { x: number; y: number } | undefined => {
    const point = points.get(id)
    const index = coordinateIndexes.get(id)
    if (!point) return undefined
    return index
      ? { x: parameters[index.x]!, y: parameters[index.y]! }
      : point.x === undefined || point.y === undefined ? undefined : { x: point.x, y: point.y }
  }
  const addCoordinateCoefficients = (coefficients: number[], id: string, x: number, y: number): void => {
    const index = coordinateIndexes.get(id)
    if (!index) return
    coefficients[index.x] = (coefficients[index.x] ?? 0) + x
    coefficients[index.y] = (coefficients[index.y] ?? 0) + y
  }
  const bearingCoefficients = (
    coefficients: number[],
    fromId: string,
    toId: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    scale = 1
  ): boolean => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const squared = dx * dx + dy * dy
    if (!(squared > 1e-18)) return false
    addCoordinateCoefficients(coefficients, fromId, scale * -dy / squared, scale * dx / squared)
    addCoordinateCoefficients(coefficients, toId, scale * dy / squared, scale * -dx / squared)
    return true
  }
  // COSA uses X=north/Y=east; other explicitly supported inputs retain their
  // existing axis convention. Legacy COSA is read-only until reimported.
  const directionBearing = (observation: SurveyObservationV1, from: { x: number; y: number }, to: { x: number; y: number }): number =>
    observation.rawFields?.coordinateAxisOrder === 'north-east' ? Math.atan2(to.y - from.y, to.x - from.x) : bearing(from, to)
  const modelWithCoefficients = (observation: SurveyObservationV1, parameters: readonly number[]): { computed: number; coefficients: number[]; angular: boolean } | null => {
    const coefficients = Array.from({ length: initialParameters.length }, () => 0)
    if (observation.type === 'angle') {
      if (!observation.station || !observation.left || !observation.right) return null
      const station = coordinate(observation.station, parameters)
      const left = coordinate(observation.left, parameters)
      const right = coordinate(observation.right, parameters)
      if (!station || !left || !right) return null
      if (!bearingCoefficients(coefficients, observation.station, observation.right, station, right, 1)
        || !bearingCoefficients(coefficients, observation.station, observation.left, station, left, -1)) return null
      const value = bearing(station, right) - bearing(station, left)
      return { computed: value < 0 ? value + 2 * Math.PI : value, coefficients, angular: true }
    }
    const fromId = observation.from ?? observation.station
    const toId = observation.to ?? observation.target
    if (!fromId || !toId) return null
    const from = coordinate(fromId, parameters)
    const to = coordinate(toId, parameters)
    if (!from || !to) return null
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (!(length > 1e-9)) return null
    if (observation.type === 'direction') {
      if (!bearingCoefficients(coefficients, fromId, toId, from, to, observation.rawFields?.coordinateAxisOrder === 'north-east' ? -1 : 1)) return null
      const stationId = observation.station ?? observation.from
      const orientationIndex = observation.rawFields?.directionReference === 'cosa-station-circle' && stationId
        ? orientationIndexes.get(stationId)
        : undefined
      if (orientationIndex !== undefined) coefficients[orientationIndex] = -1
      return {
        computed: orientationIndex === undefined
          ? directionBearing(observation, from, to)
          : positiveRadians(directionBearing(observation, from, to) - parameters[orientationIndex]!),
        coefficients,
        angular: true
      }
    }
    addCoordinateCoefficients(coefficients, fromId, -dx / length, -dy / length)
    addCoordinateCoefficients(coefficients, toId, dx / length, dy / length)
    return { computed: length, coefficients, angular: false }
  }
  for (const stationId of circleStationIds) {
    const firstDirection = observations.find((item) => item.type === 'direction' && (item.station ?? item.from) === stationId && item.rawFields?.directionReference === 'cosa-station-circle')
    const station = points.get(stationId)
    const target = firstDirection ? points.get(firstDirection.target ?? firstDirection.to ?? '') : undefined
    const orientationIndex = orientationIndexes.get(stationId)!
    let initialOrientation = 0
    if (firstDirection && station?.x !== undefined && station.y !== undefined && target?.x !== undefined && target.y !== undefined) {
      initialOrientation = positiveRadians(
        directionBearing(firstDirection, { x: station.x, y: station.y }, { x: target.x, y: target.y })
        - angleRadians(firstDirection.value, firstDirection.unit)
      )
    }
    initialParameters[orientationIndex] = initialOrientation
  }
  const buildEquations = (parameters: readonly number[]) => observations.map((observation) => {
    const model = modelWithCoefficients(observation, parameters)
    // Preserve row identity and make the kernel reject undefined geometry.
    if (!model) return { coefficients: initialParameters.map(() => 0), misclosure: Number.NaN, weight: 1 }
    const observed = model.angular ? angleRadians(observation.value, observation.unit) : normalizeObservationValue(observation)
    const sigma = model.angular
      ? angleRadians(observation.sigma ?? 2, observation.sigmaUnit ?? 'arcsec')
      : normalizeLengthUncertainty(observation.sigma ?? 0.002, observation.sigmaUnit ?? observation.unit)
    return { coefficients: model.coefficients, misclosure: model.angular ? wrapRadians(observed - model.computed) : observed - model.computed, weight: 1 / Math.max(1e-18, sigma * sigma) }
  })
  const objective = (parameters: readonly number[]) => observations.reduce((sum, observation) => {
    const model = modelWithCoefficients(observation, parameters)
    if (!model) return Number.POSITIVE_INFINITY
    const observed = model.angular ? angleRadians(observation.value, observation.unit) : normalizeObservationValue(observation)
    const sigma = model.angular
      ? angleRadians(observation.sigma ?? 2, observation.sigmaUnit ?? 'arcsec')
      : normalizeLengthUncertainty(observation.sigma ?? 0.002, observation.sigmaUnit ?? observation.unit)
    const misclosure = model.angular ? wrapRadians(observed - model.computed) : observed - model.computed
    return sum + misclosure * misclosure / Math.max(1e-18, sigma * sigma)
  }, 0)
  const solved = iterativeWeightedLeastSquares(initialParameters, buildEquations, { maxIterations: 15, convergence: 1e-7, objective })
  if (!solved) return invalidAdjustmentResult(network, run, mergeFindings(baseFindings, [finding(network.id, 'rank_deficient', 'blocking', '平面控制网法方程秩亏或观测几何不足', '增加独立方向、测站角或距离观测，并检查固定控制点', undefined, nowIso)]), nowIso)
  const adjusted = coordinates(solved.parameters)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const coordinate = adjusted.get(point.id)!
    const index = coordinateIndexes.get(point.id)
    if (!index) return { id: point.id, x: coordinate.x, y: coordinate.y }
    const qx = solved.covariance[index.x]?.[index.x] ?? 0
    const qy = solved.covariance[index.y]?.[index.y] ?? 0
    const original = points.get(point.id)!
    return { id: point.id, x: coordinate.x, y: coordinate.y, correctionX: coordinate.x - original.x!, correctionY: coordinate.y - original.y!, standardError: Math.sqrt(Math.max(0, (qx + qy) * solved.varianceFactor)), covariance: [...(solved.covariance[index.x] ?? []), ...(solved.covariance[index.y] ?? [])], ...pointErrorEllipse(run, solved, index.x, index.y) }
  })
  const equations = buildEquations(solved.parameters)
  const observationResults = observations.map((observation, index) => {
    const residual = -(equations[index]?.misclosure ?? 0)
    const sigma = Math.sqrt(1 / (equations[index]?.weight ?? 1))
    const standardizedResidual = Math.abs(residual) / Math.max(1e-12, sigma)
    return { observationId: observation.id, correction: residual, residual, unit: normalizedResidualUnit(observation), standardizedResidual, outlier: standardizedResidual > 3, sourceRow: observation.sourceRow }
  })
  const linearResiduals = observationResults.filter((item) => item.unit === 'm')
  const angularResiduals = observationResults.filter((item) => item.unit === 'rad')
  const closure = {
    ...(linearResiduals.length ? { horizontal: Math.sqrt(linearResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {}),
    ...(angularResiduals.length ? { angular: Math.sqrt(angularResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {})
  }
  const closureUnits = { ...(linearResiduals.length ? { horizontal: 'm' as const } : {}), ...(angularResiduals.length ? { angular: 'rad' as const } : {}) }
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `平面控制观测 ${item.observationId} 的标准化残差超过 3σ`, '复核原始观测、对中和定向', item.sourceRow, nowIso))
  const convergenceFindings = solved.converged ? [] : [finding(network.id, 'not_converged', 'blocking', `平面控制网在 ${solved.iterations} 次迭代后未收敛`, '检查近似坐标、粗差和网形后重试', undefined, nowIso)]
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', '平面控制网没有多余观测，不能进行后验精度检验', '增加独立复测方向、角度或边长', undefined, nowIso)]
  const maxStd = pointResults.reduce((max, point) => Math.max(max, point.standardError ?? 0), 0)
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  const parameters = Object.fromEntries(circleStationIds.map((id) => [`orientation:${id}`, positiveRadians(solved.parameters[orientationIndexes.get(id)!]!)]))
  const parameterUnits = Object.fromEntries(circleStationIds.map((id) => [`orientation:${id}`, 'rad' as const]))
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: initialParameters.length, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure, closureUnits, parameters, parameterUnits, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, passed: outlierFindings.length === 0 && convergenceFindings.length === 0 }, qualityFindings: [...baseFindings, ...outlierFindings, ...convergenceFindings, ...reliabilityFindings], inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length || convergenceFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: solved.iterations, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function buildTraverseResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const distances = network.observations.filter((item) => item.type === 'distance')
  const angular = network.observations.filter((item) => ['angle', 'direction'].includes(item.type))
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), traverseStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const points = pointMap(network)
  const start = points.get(distances[0]!.from!)
  const end = points.get(distances[distances.length - 1]!.to!)
  const routePointIds = [distances[0]!.from!, ...distances.map((item) => item.to!)]

  const unknownIds = network.unknownPoints.filter((point) => !point.known).map((point) => point.id)
  const initialParameters = unknownIds.flatMap((id) => {
    const point = points.get(id)!
    return [point.x ?? 0, point.y ?? 0]
  })
  const coordinates = (parameters: readonly number[]): Map<string, { x: number; y: number }> => new Map([...points].map(([id, point]) => {
    const index = unknownIds.indexOf(id)
    return [id, index < 0 ? { x: point.x ?? 0, y: point.y ?? 0 } : { x: parameters[index * 2]!, y: parameters[index * 2 + 1]! }]
  }))
  const bearing = (from: { x: number; y: number }, to: { x: number; y: number }): number => Math.atan2(to.x - from.x, to.y - from.y)
  const model = (observation: SurveyObservationV1, parameters: readonly number[]): number | null => {
    const map = coordinates(parameters)
    if (observation.type === 'angle') {
      if (!observation.station || !observation.left || !observation.right) return null
      const station = map.get(observation.station); const left = map.get(observation.left); const right = map.get(observation.right)
      if (!station || !left || !right) return null
      const value = bearing(station, right) - bearing(station, left)
      return value < 0 ? value + 2 * Math.PI : value
    }
    const fromId = observation.from ?? observation.station; const toId = observation.to ?? observation.target
    const from = fromId ? map.get(fromId) : undefined; const to = toId ? map.get(toId) : undefined
    if (!from || !to) return null
    return observation.type === 'direction' ? bearing(from, to) : Math.hypot(to.x - from.x, to.y - from.y)
  }
  const usedObservations = [
    ...distances,
    ...angular.filter((item) => item.type === 'direction'
      ? distances.some((edge) => (item.from ?? item.station) === edge.from && (item.to ?? item.target) === edge.to)
      : distances.slice(1).some((_, index) => item.station === routePointIds[index + 1] && item.left === routePointIds[index] && item.right === routePointIds[index + 2]))
  ]
  const buildEquations = (parameters: readonly number[]) => usedObservations.flatMap((observation) => {
    const computed = model(observation, parameters)
    if (computed === null) return []
    const isAngular = observation.type === 'angle' || observation.type === 'direction'
    const observed = isAngular ? angleRadians(observation.value, observation.unit) : normalizeObservationValue(observation)
    const sigma = isAngular
      ? angleRadians(observation.sigma ?? 2, observation.sigmaUnit ?? 'arcsec')
      : normalizeLengthUncertainty(observation.sigma ?? 0.002, observation.sigmaUnit ?? observation.unit)
    return [{ coefficients: numericalJacobian((candidate) => model(observation, candidate) ?? computed, parameters, { angular: isAngular }), misclosure: isAngular ? wrapRadians(observed - computed) : observed - computed, weight: 1 / Math.max(1e-18, sigma * sigma) }]
  })
  const solved = iterativeWeightedLeastSquares(initialParameters, buildEquations, { maxIterations: 12, convergence: 1e-7 })
  if (!solved) return invalidAdjustmentResult(network, run, [finding(network.id, 'rank_deficient', 'blocking', '导线法方程秩亏，边长与方向/角度不足以确定全部坐标', '增加独立方向、角度或边长观测并检查固定端点', undefined, nowIso)], nowIso)

  const adjustedCoordinates = coordinates(solved.parameters)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const adjusted = adjustedCoordinates.get(point.id)
    const index = unknownIds.indexOf(point.id)
    if (!adjusted || index < 0) return { id: point.id, x: point.x, y: point.y }
    const qx = solved.covariance[index * 2]?.[index * 2] ?? 0; const qy = solved.covariance[index * 2 + 1]?.[index * 2 + 1] ?? 0
    return { id: point.id, x: adjusted.x, y: adjusted.y, correctionX: adjusted.x - (point.x ?? 0), correctionY: adjusted.y - (point.y ?? 0), standardError: Math.sqrt(Math.max(0, (qx + qy) * solved.varianceFactor)), covariance: [...(solved.covariance[index * 2] ?? []), ...(solved.covariance[index * 2 + 1] ?? [])], ...pointErrorEllipse(run, solved, index * 2, index * 2 + 1) }
  })
  const equations = buildEquations(solved.parameters)
  const observationResults = usedObservations.map((observation, index) => {
    const residual = -(equations[index]?.misclosure ?? 0)
    const sigma = Math.sqrt(1 / (equations[index]?.weight ?? 1))
    const standardizedResidual = Math.abs(residual) / Math.max(1e-12, sigma)
    return { observationId: observation.id, correction: residual, residual, unit: normalizedResidualUnit(observation), standardizedResidual, outlier: standardizedResidual > 3, sourceRow: observation.sourceRow }
  })
  const azimuths = traverseAzimuths(network, distances, angular)!
  let sumX = 0; let sumY = 0; let totalLength = 0
  distances.forEach((observation, index) => { const length = normalizeObservationValue(observation); sumX += length * Math.sin(azimuths[index]!); sumY += length * Math.cos(azimuths[index]!); totalLength += Math.abs(length) })
  const targetDeltaX = end!.x! - start!.x!
  const targetDeltaY = end!.y! - start!.y!
  const fx = sumX - targetDeltaX; const fy = sumY - targetDeltaY
  const relativeClosure = totalLength > 0 ? Math.hypot(fx, fy) / totalLength : 0
  const endAzimuth = network.instrumentParameters.endAzimuthRad ?? (network.instrumentParameters.endAzimuthDeg === undefined ? undefined : network.instrumentParameters.endAzimuthDeg * Math.PI / 180)
  const angularClosure = endAzimuth === undefined ? undefined : wrapRadians(azimuths[azimuths.length - 1]! - endAzimuth)
  const closure = { fx, fy, relativeClosure, ...(angularClosure === undefined ? {} : { angular: angularClosure }) }
  const closureUnits = { fx: 'm' as const, fy: 'm' as const, relativeClosure: 'ratio' as const, ...(angularClosure === undefined ? {} : { angular: 'rad' as const }) }
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `导线观测 ${item.observationId} 的标准化残差超过 3σ`, '复核原始角度、边长、对中和定向', item.sourceRow, nowIso))
  const convergenceFindings = solved.converged ? [] : [finding(network.id, 'not_converged', 'blocking', `导线平差在 ${solved.iterations} 次迭代后未收敛`, '检查近似坐标、粗差和网形后重试', undefined, nowIso)]
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', '导线没有多余观测，精度仅能按先验权评定', '增加独立复测边或方向观测', undefined, nowIso)]
  const maxStd = pointResults.reduce((max, point) => Math.max(max, point.standardError ?? 0), 0)
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: usedObservations.length, unknownCount: unknownIds.length * 2, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure, closureUnits, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, ...(relativeClosure > 0 ? { relativePrecision: 1 / relativeClosure } : {}), passed: outlierFindings.length === 0 && convergenceFindings.length === 0 }, qualityFindings: [...baseFindings, ...outlierFindings, ...convergenceFindings, ...reliabilityFindings], inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length || convergenceFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: solved.iterations, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function buildTriangulationResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), triangulationStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const points = pointMap(network)
  const observations = network.observations.filter((item) => ['angle', 'direction', 'distance'].includes(item.type))
  const unknownIds = network.unknownPoints.filter((point) => !point.known).map((point) => point.id)
  const initialParameters = unknownIds.flatMap((id) => [points.get(id)!.x!, points.get(id)!.y!])
  const coordinates = (parameters: readonly number[]): Map<string, { x: number; y: number }> => new Map([...points].map(([id, point]) => {
    const index = unknownIds.indexOf(id)
    return [id, index < 0 ? { x: point.x!, y: point.y! } : { x: parameters[index * 2]!, y: parameters[index * 2 + 1]! }]
  }))
  const bearing = (from: { x: number; y: number }, to: { x: number; y: number }): number => Math.atan2(to.x - from.x, to.y - from.y)
  const model = (observation: SurveyObservationV1, parameters: readonly number[]): number | null => {
    const map = coordinates(parameters)
    if (observation.type === 'angle') {
      const station = observation.station ? map.get(observation.station) : undefined
      const left = observation.left ? map.get(observation.left) : undefined
      const right = observation.right ? map.get(observation.right) : undefined
      if (!station || !left || !right) return null
      const result = bearing(station, right) - bearing(station, left)
      return result < 0 ? result + 2 * Math.PI : result
    }
    const from = map.get((observation.from ?? observation.station)!)
    const to = map.get((observation.to ?? observation.target)!)
    if (!from || !to) return null
    return observation.type === 'direction' ? bearing(from, to) : Math.hypot(to.x - from.x, to.y - from.y)
  }
  const buildEquations = (parameters: readonly number[]) => observations.flatMap((observation) => {
    const computed = model(observation, parameters)
    if (computed === null) return []
    const angular = observation.type === 'angle' || observation.type === 'direction'
    const observed = angular ? angleRadians(observation.value, observation.unit) : normalizeObservationValue(observation)
    const sigma = angular
      ? angleRadians(observation.sigma ?? 2, observation.sigmaUnit ?? 'arcsec')
      : normalizeLengthUncertainty(observation.sigma ?? 0.002, observation.sigmaUnit ?? observation.unit)
    return [{ coefficients: numericalJacobian((candidate) => model(observation, candidate) ?? computed, parameters, { angular }), misclosure: angular ? wrapRadians(observed - computed) : observed - computed, weight: 1 / Math.max(1e-18, sigma * sigma) }]
  })
  const solved = iterativeWeightedLeastSquares(initialParameters, buildEquations, { maxIterations: 15, convergence: 1e-7 })
  if (!solved) return invalidAdjustmentResult(network, run, mergeFindings(baseFindings, [finding(network.id, 'rank_deficient', 'blocking', '三角网角度方程秩亏或交会几何不足', '增加独立测站角并检查已知基线、点号和近似坐标', undefined, nowIso)]), nowIso)
  const adjusted = coordinates(solved.parameters)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const coordinate = adjusted.get(point.id)!
    const index = unknownIds.indexOf(point.id)
    if (index < 0) return { id: point.id, x: coordinate.x, y: coordinate.y }
    const qx = solved.covariance[index * 2]?.[index * 2] ?? 0
    const qy = solved.covariance[index * 2 + 1]?.[index * 2 + 1] ?? 0
    return { id: point.id, x: coordinate.x, y: coordinate.y, correctionX: coordinate.x - point.x!, correctionY: coordinate.y - point.y!, standardError: Math.sqrt(Math.max(0, (qx + qy) * solved.varianceFactor)), covariance: [...(solved.covariance[index * 2] ?? []), ...(solved.covariance[index * 2 + 1] ?? [])], ...pointErrorEllipse(run, solved, index * 2, index * 2 + 1) }
  })
  const equations = buildEquations(solved.parameters)
  const observationResults = observations.map((observation, index) => {
    const residual = -(equations[index]?.misclosure ?? 0)
    const sigma = Math.sqrt(1 / (equations[index]?.weight ?? 1))
    const standardizedResidual = Math.abs(residual) / Math.max(1e-12, sigma)
    return { observationId: observation.id, correction: residual, residual, unit: normalizedResidualUnit(observation), standardizedResidual, outlier: standardizedResidual > 3, sourceRow: observation.sourceRow }
  })
  const linearResiduals = observationResults.filter((item) => item.unit === 'm')
  const angularResiduals = observationResults.filter((item) => item.unit === 'rad')
  const closure = {
    ...(linearResiduals.length ? { horizontal: Math.sqrt(linearResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {}),
    ...(angularResiduals.length ? { angular: Math.sqrt(angularResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {})
  }
  const closureUnits = { ...(linearResiduals.length ? { horizontal: 'm' as const } : {}), ...(angularResiduals.length ? { angular: 'rad' as const } : {}) }
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `三角网观测 ${item.observationId} 的标准化残差超过 3σ`, '复核测回、归零差和观测点号', item.sourceRow, nowIso))
  const convergenceFindings = solved.converged ? [] : [finding(network.id, 'not_converged', 'blocking', `三角网在 ${solved.iterations} 次迭代后未收敛`, '检查近似坐标、病态交会和粗差后重试', undefined, nowIso)]
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', '三角网没有多余观测，不能进行后验精度检验', '增加独立测站角或复测测回', undefined, nowIso)]
  const maxStd = pointResults.reduce((max, point) => Math.max(max, point.standardError ?? 0), 0)
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: unknownIds.length * 2, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure, closureUnits, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, passed: outlierFindings.length === 0 && convergenceFindings.length === 0 }, qualityFindings: [...baseFindings, ...outlierFindings, ...convergenceFindings, ...reliabilityFindings], inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length || convergenceFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: solved.iterations, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function buildCpiiiResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), cpiiiStrategyFindings(network, nowIso))
  if (baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const points = pointMap(network)
  const stations = network.unknownPoints.filter((point) => !point.known && point.pointClass === 'station')
  const observations = network.observations.filter((item) => ['distance', 'slope-distance', 'direction', 'zenith'].includes(item.type))
  type StationIndex = { x: number; y: number; height?: number; orientation: number }
  const stationIndexes = new Map<string, StationIndex>()
  let parameterCount = 0
  for (const station of stations) {
    const hasVerticalEvidence = observations.some((item) => (item.station ?? item.from) === station.id && (item.type === 'slope-distance' || item.type === 'zenith'))
    const index: StationIndex = { x: parameterCount++, y: parameterCount++, ...(hasVerticalEvidence ? { height: parameterCount++ } : {}), orientation: parameterCount++ }
    stationIndexes.set(station.id, index)
  }
  const bearing = (from: { x: number; y: number }, to: { x: number; y: number }): number => Math.atan2(to.x - from.x, to.y - from.y)
  const initialParameters = Array.from({ length: parameterCount }, () => 0)
  for (const station of stations) {
    const index = stationIndexes.get(station.id)!
    initialParameters[index.x] = station.x!
    initialParameters[index.y] = station.y!
    if (index.height !== undefined) initialParameters[index.height] = station.height!
    const firstDirection = observations.find((item) => item.type === 'direction' && (item.station ?? item.from) === station.id)!
    const target = points.get((firstDirection.target ?? firstDirection.to)!)!
    initialParameters[index.orientation] = positiveRadians(bearing({ x: station.x!, y: station.y! }, { x: target.x!, y: target.y! }) - angleRadians(firstDirection.value, firstDirection.unit))
  }
  const stationState = (stationId: string, parameters: readonly number[]) => {
    const point = points.get(stationId)!
    const index = stationIndexes.get(stationId)!
    return { x: parameters[index.x]!, y: parameters[index.y]!, height: index.height === undefined ? point.height : parameters[index.height]!, orientation: parameters[index.orientation]! }
  }
  const model = (observation: SurveyObservationV1, parameters: readonly number[]): number | null => {
    const stationId = observation.station ?? observation.from
    const targetId = observation.target ?? observation.to
    if (!stationId || !targetId) return null
    const station = stationState(stationId, parameters)
    const target = points.get(targetId)
    if (!target || target.x === undefined || target.y === undefined) return null
    const dx = target.x - station.x
    const dy = target.y - station.y
    const horizontal = Math.hypot(dx, dy)
    if (observation.type === 'direction') return positiveRadians(bearing(station, { x: target.x, y: target.y }) - station.orientation)
    if (observation.type === 'distance') return horizontal
    const instrumentHeight = (station.height ?? 0) + (observation.stationHeightOffset ?? 0)
    const targetHeight = (target.height ?? 0) + (observation.targetHeightOffset ?? 0)
    const deltaHeight = targetHeight - instrumentHeight
    return observation.type === 'slope-distance' ? Math.hypot(horizontal, deltaHeight) : Math.atan2(horizontal, deltaHeight)
  }
  const buildEquations = (parameters: readonly number[]) => observations.flatMap((observation) => {
    const computed = model(observation, parameters)
    if (computed === null) return []
    const angular = observation.type === 'direction' || observation.type === 'zenith'
    const observed = angular ? angleRadians(observation.value, observation.unit) : normalizeObservationValue(observation)
    const sigma = angular
      ? angleRadians(observation.sigma ?? 2, observation.sigmaUnit ?? 'arcsec')
      : normalizeLengthUncertainty(observation.sigma ?? 0.002, observation.sigmaUnit ?? observation.unit)
    return [{ coefficients: numericalJacobian((candidate) => model(observation, candidate) ?? computed, parameters, { angular }), misclosure: angular ? wrapRadians(observed - computed) : observed - computed, weight: 1 / Math.max(1e-18, sigma * sigma) }]
  })
  const solved = iterativeWeightedLeastSquares(initialParameters, buildEquations, { maxIterations: 20, convergence: 1e-7 })
  if (!solved) return invalidAdjustmentResult(network, run, mergeFindings(baseFindings, [finding(network.id, 'rank_deficient', 'blocking', 'CPIII 自由测站法方程秩亏或目标几何不足', '增加分布合理的固定目标方向/距离，检查测站近似坐标', undefined, nowIso)]), nowIso)
  const pointResults: AdjustmentResultV1['points'] = [...network.knownPoints, ...network.unknownPoints].map((point) => {
    const index = stationIndexes.get(point.id)
    if (!index) return { id: point.id, x: point.x, y: point.y, height: point.height }
    const state = stationState(point.id, solved.parameters)
    const qx = solved.covariance[index.x]?.[index.x] ?? 0
    const qy = solved.covariance[index.y]?.[index.y] ?? 0
    const covarianceRows = [index.x, index.y, ...(index.height === undefined ? [] : [index.height])].flatMap((row) => solved.covariance[row] ?? [])
    return { id: point.id, x: state.x, y: state.y, ...(index.height === undefined ? {} : { height: state.height, correctionHeight: state.height! - point.height! }), correctionX: state.x - point.x!, correctionY: state.y - point.y!, standardError: Math.sqrt(Math.max(0, (qx + qy) * solved.varianceFactor)), covariance: covarianceRows, ...pointErrorEllipse(run, solved, index.x, index.y) }
  })
  const equations = buildEquations(solved.parameters)
  const observationResults = observations.map((observation, index) => {
    const residual = -(equations[index]?.misclosure ?? 0)
    const sigma = Math.sqrt(1 / (equations[index]?.weight ?? 1))
    const standardizedResidual = Math.abs(residual) / Math.max(1e-12, sigma)
    return { observationId: observation.id, correction: residual, residual, unit: normalizedResidualUnit(observation), standardizedResidual, outlier: standardizedResidual > 3, sourceRow: observation.sourceRow }
  })
  const linearResiduals = observationResults.filter((item) => item.unit === 'm')
  const angularResiduals = observationResults.filter((item) => item.unit === 'rad')
  const closure = {
    ...(linearResiduals.length ? { horizontal: Math.sqrt(linearResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {}),
    ...(angularResiduals.length ? { angular: Math.sqrt(angularResiduals.reduce((sum, item) => sum + item.residual ** 2, 0)) } : {})
  }
  const closureUnits = { ...(linearResiduals.length ? { horizontal: 'm' as const } : {}), ...(angularResiduals.length ? { angular: 'rad' as const } : {}) }
  const parameters = Object.fromEntries(stations.map((station) => [`orientation:${station.id}`, positiveRadians(solved.parameters[stationIndexes.get(station.id)!.orientation]!)]))
  const parameterUnits = Object.fromEntries(stations.map((station) => [`orientation:${station.id}`, 'rad' as const]))
  const outlierFindings = observationResults.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `CPIII 观测 ${item.observationId} 的标准化残差超过 3σ`, '复核目标识别、对中、棱镜高和测回', item.sourceRow, nowIso))
  const convergenceFindings = solved.converged ? [] : [finding(network.id, 'not_converged', 'blocking', `CPIII 自由测站在 ${solved.iterations} 次迭代后未收敛`, '检查近似坐标、目标分布和粗差后重试', undefined, nowIso)]
  const reliabilityFindings = solved.varianceFactorEstimated ? [] : [finding(network.id, 'insufficient_redundancy', 'warning', 'CPIII 自由测站没有多余观测，不能进行后验精度检验', '增加固定目标或独立测回', undefined, nowIso)]
  const maxStd = pointResults.reduce((max, point) => Math.max(max, 'standardError' in point ? point.standardError ?? 0 : 0), 0)
  const displacements = [...network.knownPoints, ...network.unknownPoints].map((point) => displacement(point, pointResults.find((candidate) => candidate.id === point.id) ?? {}))
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: parameterCount, redundancy: solved.dof, degreesOfFreedom: solved.dof, linearUnit: 'm', angularUnit: 'rad', closure, closureUnits, parameters, parameterUnits, unitWeightStdDev: solved.unitWeightStdDev, varianceFactor: solved.varianceFactor, varianceFactorEstimated: solved.varianceFactorEstimated, points: pointResults, observations: observationResults, displacements, covariance: solved.covariance, precision: { maxPointStdDev: maxStd, passed: outlierFindings.length === 0 && convergenceFindings.length === 0 }, qualityFindings: [...baseFindings, ...outlierFindings, ...convergenceFindings, ...reliabilityFindings], inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outlierFindings.length || convergenceFindings.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: solved.iterations, rank: solved.rank, conditionEstimate: solved.conditionEstimate }, createdAt: nowIso() })
}

function invalidAdjustmentResult(network: SurveyNetworkV1, run: AdjustmentRunV1, findings: SurveyQualityFindingV1[], nowIso: () => string): AdjustmentResultV1 {
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: network.observations.length, unknownCount: network.unknownPoints.length, redundancy: 0, degreesOfFreedom: 0, closure: {}, unitWeightStdDev: 0, varianceFactor: 0, varianceFactorEstimated: false, points: [], observations: [], displacements: [], qualityFindings: findings, inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, precision: { maxPointStdDev: 0, passed: false }, validation: 'invalid', createdAt: nowIso() })
}

function adjustmentDimensionIssue(network: SurveyNetworkV1): string | null {
  const coordinateTypes = ['plane-control', 'traverse', 'triangulation', 'cpiii-free-station', 'cpiii-resection']
  const unknownPointCount = network.unknownPoints.filter((point) => !point.known).length
  const transformType = network.networkType === 'coordinate-transform' ? resolveCoordinateTransformType(network) : null
  const parameterCount = network.networkType === 'gnss' ? unknownPointCount * 3
    : transformType === 'helmert-7' ? 7
      : transformType === 'similarity-2d' ? 4
        : transformType === 'height-fit' ? 3
          : coordinateTypes.includes(network.networkType) ? unknownPointCount * 2 : unknownPointCount
  if (parameterCount > MAX_UNKNOWN_PARAMETERS) return `未知参数数量 ${parameterCount} 超过上限 ${MAX_UNKNOWN_PARAMETERS}`
  if (network.observations.length > MAX_OBSERVATIONS) return `观测记录数量 ${network.observations.length} 超过上限 ${MAX_OBSERVATIONS}`
  // Bound the dense normal matrix before coefficient arrays are allocated.
  const equationCount = network.networkType === 'gnss' || transformType === 'helmert-7' ? network.observations.length * 3 : transformType === 'similarity-2d' ? network.observations.length * 2 : network.observations.length
  const estimatedNonZero = Math.min(Number.MAX_SAFE_INTEGER, equationCount * Math.max(1, parameterCount))
  if (estimatedNonZero > MAX_MATRIX_NON_ZERO) return `预计矩阵非零元素 ${estimatedNonZero} 超过上限 ${MAX_MATRIX_NON_ZERO}`
  return null
}

type CoordinateTransformType = NonNullable<SurveyNetworkV1['transformType']>

function finiteParameter(parameters: Record<string, number>, keys: string[]): number | undefined {
  for (const key of keys) if (typeof parameters[key] === 'number' && Number.isFinite(parameters[key])) return parameters[key]
  return undefined
}

function hasAnyParameter(parameters: Record<string, number>, keys: string[]): boolean {
  return keys.some((key) => typeof parameters[key] === 'number' && Number.isFinite(parameters[key]))
}

function rotationParameter(parameters: Record<string, number>, axis: 'rx' | 'ry' | 'rz' | 'rotation'): number | undefined {
  const radians = finiteParameter(parameters, [`${axis}Rad`])
  if (radians !== undefined) return radians
  const degrees = finiteParameter(parameters, [`${axis}Deg`, axis])
  return degrees === undefined ? undefined : degrees * Math.PI / 180
}

function explicitSimilarityParameters(network: SurveyNetworkV1): Similarity2dParameters | null {
  const parameters = network.instrumentParameters
  const tx = finiteParameter(parameters, ['tx', 'translationX'])
  const ty = finiteParameter(parameters, ['ty', 'translationY'])
  const rotation = rotationParameter(parameters, 'rotation') ?? rotationParameter(parameters, 'rz')
  const scaleFactor = finiteParameter(parameters, ['scaleFactor'])
  const scalePpm = finiteParameter(parameters, ['scalePpm'])
  if (tx === undefined || ty === undefined || rotation === undefined || (scaleFactor === undefined && scalePpm === undefined)) return null
  return {
    tx: normalizeLengthUncertainty(tx, network.unit),
    ty: normalizeLengthUncertainty(ty, network.unit),
    rotation,
    scale: scaleFactor ?? 1 + scalePpm! * 1e-6
  }
}

function explicitHelmertParameters(network: SurveyNetworkV1): Helmert7Parameters | null {
  const parameters = network.instrumentParameters
  const tx = finiteParameter(parameters, ['tx', 'translationX'])
  const ty = finiteParameter(parameters, ['ty', 'translationY'])
  const tz = finiteParameter(parameters, ['tz', 'translationZ'])
  const rx = rotationParameter(parameters, 'rx')
  const ry = rotationParameter(parameters, 'ry')
  const rz = rotationParameter(parameters, 'rz')
  const scaleFactor = finiteParameter(parameters, ['scaleFactor'])
  const scalePpm = finiteParameter(parameters, ['scalePpm'])
  if ([tx, ty, tz, rx, ry, rz].some((value) => value === undefined) || (scaleFactor === undefined && scalePpm === undefined)) return null
  return {
    tx: normalizeLengthUncertainty(tx!, network.unit),
    ty: normalizeLengthUncertainty(ty!, network.unit),
    tz: normalizeLengthUncertainty(tz!, network.unit),
    rx: rx!,
    ry: ry!,
    rz: rz!,
    scale: scaleFactor ?? 1 + scalePpm! * 1e-6
  }
}

function explicitHeightParameters(network: SurveyNetworkV1): HeightPlaneParameters | null {
  const parameters = network.instrumentParameters
  const offset = finiteParameter(parameters, ['heightOffset', 'offset'])
  const slopeX = finiteParameter(parameters, ['heightSlopeX', 'slopeX'])
  const slopeY = finiteParameter(parameters, ['heightSlopeY', 'slopeY'])
  return offset === undefined || slopeX === undefined || slopeY === undefined
    ? null
    : { offset: normalizeLengthUncertainty(offset, network.unit), slopeX, slopeY }
}

function canonicalTransformPoint(network: SurveyNetworkV1, point: SurveyPointV1): SurveyPointV1 {
  const scale = lengthUnitScale(network.unit)
  return SurveyPointV1.parse({
    ...point,
    ...(point.x === undefined ? {} : { x: point.x * scale }),
    ...(point.y === undefined ? {} : { y: point.y * scale }),
    ...(point.height === undefined ? {} : { height: point.height * scale })
  })
}

function transformControls(network: SurveyNetworkV1) {
  const points = new Map([...network.knownPoints, ...network.unknownPoints].map((point) => [point.id, canonicalTransformPoint(network, point)]))
  return network.observations.map((observation) => ({ observation, source: observation.from ? points.get(observation.from) : undefined }))
}

function resolveCoordinateTransformType(network: SurveyNetworkV1, run?: AdjustmentRunV1): CoordinateTransformType | null {
  if (network.transformType) return network.transformType
  if (run?.method === 'height-fit') return 'height-fit'
  if (explicitHeightParameters(network)) return 'height-fit'
  if (explicitHelmertParameters(network)) return 'helmert-7'
  if (explicitSimilarityParameters(network)) return 'similarity-2d'
  const controls = transformControls(network)
  if (controls.filter(({ observation, source }) => source?.height !== undefined && observation.targetX !== undefined && observation.targetY !== undefined && observation.targetHeight !== undefined).length >= 3) return 'helmert-7'
  if (controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetHeight !== undefined && observation.targetX === undefined && observation.targetY === undefined).length >= 3) return 'height-fit'
  if (controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && observation.targetX !== undefined && observation.targetY !== undefined).length >= 2) return 'similarity-2d'
  return null
}

function coordinateTransformStrategyFindings(network: SurveyNetworkV1, nowIso: () => string, run?: AdjustmentRunV1): SurveyQualityFindingV1[] {
  const transformType = resolveCoordinateTransformType(network, run)
  const allPoints = [...network.knownPoints, ...network.unknownPoints]
  const controls = transformControls(network)
  const findings: SurveyQualityFindingV1[] = []
  if (!transformType) return [finding(network.id, 'missing_datum', 'blocking', '坐标转换缺少明确类型、完整参数或足够控制点', '选择二维相似、三维七参数、高斯正反算或高程拟合，并提供对应参数/控制点', undefined, nowIso)]
  if (!allPoints.length) findings.push(finding(network.id, 'missing_point', 'blocking', '坐标转换没有待转换点', '至少提供一个源坐标点', undefined, nowIso))
  if (transformType === 'similarity-2d') {
    const explicit = explicitSimilarityParameters(network)
    if (!explicit && hasAnyParameter(network.instrumentParameters, ['tx', 'translationX', 'ty', 'translationY', 'rotationRad', 'rotationDeg', 'rotation', 'rzRad', 'rzDeg', 'rz', 'scaleFactor', 'scalePpm'])) findings.push(finding(network.id, 'invalid_observation', 'blocking', '二维相似参数只提供了一部分，不能用零值补齐', '完整提供平移、旋转和尺度参数，或删除部分参数后由控制点估计', undefined, nowIso))
    const validControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && observation.targetX !== undefined && observation.targetY !== undefined)
    const malformed = controls.find(({ observation, source }) => observation.type === 'coordinate-pair' && (source?.x === undefined || source.y === undefined || observation.targetX === undefined || observation.targetY === undefined))
    if (malformed) findings.push(finding(network.id, 'invalid_observation', 'blocking', `二维控制对 ${malformed.observation.id} 缺少源 X/Y 或目标 X/Y`, '补齐同一控制点的源坐标和目标坐标', malformed.observation.sourceRow, nowIso))
    if (!explicit && validControls.length < 2) findings.push(finding(network.id, 'missing_datum', 'blocking', '二维相似变换至少需要两组源/目标平面控制点', '提供两个以上坐标不同的控制点对，或完整四参数', undefined, nowIso))
    if (!explicit && validControls.length >= 2 && !fitSimilarity2d(validControls.map(({ observation, source }) => ({ sourceX: source!.x!, sourceY: source!.y!, targetX: normalizeLengthUncertainty(observation.targetX!, observation.unit), targetY: normalizeLengthUncertainty(observation.targetY!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) })))) findings.push(finding(network.id, 'rank_deficient', 'blocking', '二维相似控制点退化，四参数不可解', '提供源坐标不重合的控制点对', undefined, nowIso))
    if (allPoints.some((point) => point.x === undefined || point.y === undefined)) findings.push(finding(network.id, 'missing_point', 'blocking', '二维相似变换存在缺少 X/Y 的源点', '补齐全部待转换点的平面坐标', undefined, nowIso))
  }
  if (transformType === 'helmert-7') {
    const explicit = explicitHelmertParameters(network)
    if (!explicit && hasAnyParameter(network.instrumentParameters, ['tx', 'translationX', 'ty', 'translationY', 'tz', 'translationZ', 'rxRad', 'rxDeg', 'rx', 'ryRad', 'ryDeg', 'ry', 'rzRad', 'rzDeg', 'rz', 'scaleFactor', 'scalePpm'])) findings.push(finding(network.id, 'invalid_observation', 'blocking', '三维七参数只提供了一部分，不能以零值代替缺失参数', '完整提供三个平移、三个旋转和尺度参数，或删除部分参数后由控制点估计', undefined, nowIso))
    const validControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetX !== undefined && observation.targetY !== undefined && observation.targetHeight !== undefined)
    const malformed = controls.find(({ observation, source }) => observation.type === 'coordinate-pair' && (source?.x === undefined || source.y === undefined || source.height === undefined || observation.targetX === undefined || observation.targetY === undefined || observation.targetHeight === undefined))
    if (malformed) findings.push(finding(network.id, 'invalid_observation', 'blocking', `三维控制对 ${malformed.observation.id} 缺少源/目标 X/Y/H`, '补齐完整三维同名控制点坐标', malformed.observation.sourceRow, nowIso))
    if (!explicit && validControls.length < 3) findings.push(finding(network.id, 'missing_datum', 'blocking', '三维七参数估计至少需要三组完整 X/Y/H 控制点对', '提供三组以上非退化三维控制点，或完整七参数', undefined, nowIso))
    if (!explicit && validControls.length >= 3 && !fitHelmert7(validControls.map(({ observation, source }) => ({ sourceX: source!.x!, sourceY: source!.y!, sourceZ: source!.height!, targetX: normalizeLengthUncertainty(observation.targetX!, observation.unit), targetY: normalizeLengthUncertainty(observation.targetY!, observation.unit), targetZ: normalizeLengthUncertainty(observation.targetHeight!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) })))) findings.push(finding(network.id, 'rank_deficient', 'blocking', '三维控制点几何退化，七参数不可解', '增加空间分布良好的三维控制点', undefined, nowIso))
    if (allPoints.some((point) => point.x === undefined || point.y === undefined || point.height === undefined)) findings.push(finding(network.id, 'missing_point', 'blocking', '三维七参数变换存在缺少 X/Y/H 的源点', '补齐全部待转换点的三维坐标', undefined, nowIso))
  }
  if (transformType === 'height-fit') {
    const explicit = explicitHeightParameters(network)
    if (!explicit && hasAnyParameter(network.instrumentParameters, ['heightOffset', 'offset', 'heightSlopeX', 'slopeX', 'heightSlopeY', 'slopeY'])) findings.push(finding(network.id, 'invalid_observation', 'blocking', '高程拟合参数只提供了一部分，不能以零值补齐', '完整提供高程常数项和 X/Y 坡度，或删除部分参数后由控制点估计', undefined, nowIso))
    const validControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetHeight !== undefined)
    const malformed = controls.find(({ observation, source }) => observation.type === 'coordinate-pair' && (source?.x === undefined || source.y === undefined || source.height === undefined || observation.targetHeight === undefined))
    if (malformed) findings.push(finding(network.id, 'invalid_observation', 'blocking', `高程控制对 ${malformed.observation.id} 缺少平面位置或源/目标高程`, '补齐 X/Y、源高程和目标高程', malformed.observation.sourceRow, nowIso))
    if (!explicit && validControls.length < 3) findings.push(finding(network.id, 'missing_datum', 'blocking', '高程拟合至少需要三组含平面位置的源/目标高程控制点', '提供三组以上不共线控制点，或完整平面改正参数', undefined, nowIso))
    if (!explicit && validControls.length >= 3 && !fitHeightPlane(validControls.map(({ observation, source }) => ({ x: source!.x!, y: source!.y!, sourceHeight: source!.height!, targetHeight: normalizeLengthUncertainty(observation.targetHeight!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) })))) findings.push(finding(network.id, 'rank_deficient', 'blocking', '高程控制点平面位置退化，拟合面不可解', '提供至少三个不共线的高程控制点', undefined, nowIso))
    if (allPoints.some((point) => point.x === undefined || point.y === undefined || point.height === undefined)) findings.push(finding(network.id, 'missing_point', 'blocking', '高程拟合存在缺少 X/Y/H 的源点', '补齐全部待转换点的平面坐标和源高程', undefined, nowIso))
  }
  if (transformType === 'gauss-kruger-forward' || transformType === 'gauss-kruger-inverse') {
    if (network.centralMeridian === undefined) findings.push(finding(network.id, 'missing_datum', 'blocking', '高斯—克吕格转换缺少中央子午线', '在网络元数据中明确 centralMeridian（十进制度）', undefined, nowIso))
    if (!resolveEllipsoid(network.ellipsoid)) findings.push(finding(network.id, 'missing_datum', 'blocking', `不支持椭球 ${network.ellipsoid}`, '使用 CGCS2000、WGS84、Xian80 或 Beijing54 椭球', undefined, nowIso))
    if (transformType === 'gauss-kruger-forward' && allPoints.some((point) => point.latitude === undefined || point.longitude === undefined)) findings.push(finding(network.id, 'missing_point', 'blocking', '高斯正算存在缺少纬度/经度的点', '为全部待转换点提供十进制度 latitude/longitude', undefined, nowIso))
    if (transformType === 'gauss-kruger-inverse' && allPoints.some((point) => point.x === undefined || point.y === undefined)) findings.push(finding(network.id, 'missing_point', 'blocking', '高斯反算存在缺少平面 X/Y 的点', '为全部待转换点提供北坐标 X 和东坐标 Y', undefined, nowIso))
  }
  return mergeFindings(findings)
}

function buildCoordinateTransformResult(network: SurveyNetworkV1, run: AdjustmentRunV1, nowIso: () => string): AdjustmentResultV1 {
  const transformType = resolveCoordinateTransformType(network, run)
  const baseFindings = mergeFindings(network.findings.filter((item) => item.status === 'open'), coordinateTransformStrategyFindings(network, nowIso, run))
  if (!transformType || baseFindings.some((item) => item.severity === 'blocking')) return invalidAdjustmentResult(network, run, baseFindings, nowIso)
  const sourcePoints = [...network.knownPoints, ...network.unknownPoints].map((point) => canonicalTransformPoint(network, point))
  const controls = transformControls(network)
  if (transformType === 'similarity-2d') {
    const fitControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && observation.targetX !== undefined && observation.targetY !== undefined).map(({ observation, source }) => ({ sourceX: source!.x!, sourceY: source!.y!, targetX: normalizeLengthUncertainty(observation.targetX!, observation.unit), targetY: normalizeLengthUncertainty(observation.targetY!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) }))
    const fitted = explicitSimilarityParameters(network) ? null : fitSimilarity2d(fitControls)
    const parameters = explicitSimilarityParameters(network) ?? fitted!.parameters
    const points = sourcePoints.map((point) => { const target = applySimilarity2d(point.x!, point.y!, parameters); return { id: point.id, x: target.x, y: target.y, ...(point.height === undefined ? {} : { height: point.height }), correctionX: target.x - point.x!, correctionY: target.y - point.y! } })
    const observations = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && observation.targetX !== undefined && observation.targetY !== undefined).flatMap(({ observation, source }) => { const target = applySimilarity2d(source!.x!, source!.y!, parameters); const targetX = normalizeLengthUncertainty(observation.targetX!, observation.unit); const targetY = normalizeLengthUncertainty(observation.targetY!, observation.unit); const sigma = normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit); return [{ observationId: `${observation.id}:x`, correction: target.x - targetX, residual: target.x - targetX, unit: 'm' as const, standardizedResidual: Math.abs(target.x - targetX) / sigma, outlier: Math.abs(target.x - targetX) / sigma > 3, sourceRow: observation.sourceRow }, { observationId: `${observation.id}:y`, correction: target.y - targetY, residual: target.y - targetY, unit: 'm' as const, standardizedResidual: Math.abs(target.y - targetY) / sigma, outlier: Math.abs(target.y - targetY) / sigma > 3, sourceRow: observation.sourceRow }] })
    const residualNorm = Math.sqrt(observations.reduce((sum, item) => sum + item.residual ** 2, 0)); const outliers = observations.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `二维相似控制分量 ${item.observationId} 超过 3σ`, '复核控制点同名关系和坐标单位', item.sourceRow, nowIso)); const displacements = sourcePoints.map((point) => displacement(point, points.find((item) => item.id === point.id)!))
    return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: fitted ? 4 : 0, redundancy: fitted?.adjustment.dof ?? 0, degreesOfFreedom: fitted?.adjustment.dof ?? 0, linearUnit: 'm', angularUnit: 'rad', transformType, closure: { translationX: parameters.tx, translationY: parameters.ty, scalePpm: (parameters.scale - 1) * 1e6, rotationRad: parameters.rotation, horizontal: residualNorm }, closureUnits: { translationX: 'm', translationY: 'm', scalePpm: 'ppm', rotationRad: 'rad', horizontal: 'm' }, parameters: { translationX: parameters.tx, translationY: parameters.ty, scalePpm: (parameters.scale - 1) * 1e6, rotationRad: parameters.rotation }, parameterUnits: { translationX: 'm', translationY: 'm', scalePpm: 'ppm', rotationRad: 'rad' }, unitWeightStdDev: fitted?.adjustment.unitWeightStdDev ?? 0, varianceFactor: fitted?.adjustment.varianceFactor ?? 0, varianceFactorEstimated: fitted?.adjustment.varianceFactorEstimated ?? false, points, observations, displacements, covariance: fitted?.adjustment.covariance, precision: { maxPointStdDev: observations.length ? residualNorm / Math.sqrt(observations.length) : 0, passed: outliers.length === 0 }, qualityFindings: mergeFindings(baseFindings, outliers), inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outliers.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: fitted ? 1 : 0, rank: fitted?.adjustment.rank ?? 0, conditionEstimate: fitted?.adjustment.conditionEstimate }, createdAt: nowIso() })
  }
  if (transformType === 'helmert-7') {
    const fitControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetX !== undefined && observation.targetY !== undefined && observation.targetHeight !== undefined).map(({ observation, source }) => ({ sourceX: source!.x!, sourceY: source!.y!, sourceZ: source!.height!, targetX: normalizeLengthUncertainty(observation.targetX!, observation.unit), targetY: normalizeLengthUncertainty(observation.targetY!, observation.unit), targetZ: normalizeLengthUncertainty(observation.targetHeight!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) }))
    const fitted = explicitHelmertParameters(network) ? null : fitHelmert7(fitControls)
    const parameters = explicitHelmertParameters(network) ?? fitted!.parameters
    const points = sourcePoints.map((point) => { const target = applyHelmert7(point.x!, point.y!, point.height!, parameters); return { id: point.id, x: target.x, y: target.y, height: target.z, correctionX: target.x - point.x!, correctionY: target.y - point.y!, correctionHeight: target.z - point.height! } })
    const observations = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetX !== undefined && observation.targetY !== undefined && observation.targetHeight !== undefined).flatMap(({ observation, source }) => { const target = applyHelmert7(source!.x!, source!.y!, source!.height!, parameters); const sigma = normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit); const residuals = [target.x - normalizeLengthUncertainty(observation.targetX!, observation.unit), target.y - normalizeLengthUncertainty(observation.targetY!, observation.unit), target.z - normalizeLengthUncertainty(observation.targetHeight!, observation.unit)]; return residuals.map((residual, component) => ({ observationId: `${observation.id}:${component === 0 ? 'x' : component === 1 ? 'y' : 'z'}`, correction: residual, residual, unit: 'm' as const, standardizedResidual: Math.abs(residual) / sigma, outlier: Math.abs(residual) / sigma > 3, sourceRow: observation.sourceRow })) })
    const residualNorm = Math.sqrt(observations.reduce((sum, item) => sum + item.residual ** 2, 0)); const outliers = observations.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `七参数控制分量 ${item.observationId} 超过 3σ`, '复核三维控制点、轴序和旋转约定', item.sourceRow, nowIso)); const displacements = sourcePoints.map((point) => displacement(point, points.find((item) => item.id === point.id)!))
    const parameterValues = { translationX: parameters.tx, translationY: parameters.ty, translationZ: parameters.tz, scalePpm: (parameters.scale - 1) * 1e6, rotationX: parameters.rx, rotationY: parameters.ry, rotationZ: parameters.rz }
    return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: fitted ? 7 : 0, redundancy: fitted?.adjustment.dof ?? 0, degreesOfFreedom: fitted?.adjustment.dof ?? 0, linearUnit: 'm', angularUnit: 'rad', transformType, closure: { translationX: parameters.tx, translationY: parameters.ty, vertical: parameters.tz, scalePpm: (parameters.scale - 1) * 1e6, rotationRad: Math.hypot(parameters.rx, parameters.ry, parameters.rz), horizontal: residualNorm }, closureUnits: { translationX: 'm', translationY: 'm', vertical: 'm', scalePpm: 'ppm', rotationRad: 'rad', horizontal: 'm' }, parameters: parameterValues, parameterUnits: { translationX: 'm', translationY: 'm', translationZ: 'm', scalePpm: 'ppm', rotationX: 'rad', rotationY: 'rad', rotationZ: 'rad' }, unitWeightStdDev: fitted?.adjustment.unitWeightStdDev ?? 0, varianceFactor: fitted?.adjustment.varianceFactor ?? 0, varianceFactorEstimated: fitted?.adjustment.varianceFactorEstimated ?? false, points, observations, displacements, covariance: fitted?.adjustment.covariance, precision: { maxPointStdDev: observations.length ? residualNorm / Math.sqrt(observations.length) : 0, passed: outliers.length === 0 }, qualityFindings: mergeFindings(baseFindings, outliers), inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outliers.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: fitted ? 1 : 0, rank: fitted?.adjustment.rank ?? 0, conditionEstimate: fitted?.adjustment.conditionEstimate }, createdAt: nowIso() })
  }
  if (transformType === 'height-fit') {
    const fitControls = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetHeight !== undefined).map(({ observation, source }) => ({ x: source!.x!, y: source!.y!, sourceHeight: source!.height!, targetHeight: normalizeLengthUncertainty(observation.targetHeight!, observation.unit), sigma: normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit) }))
    const fitted = explicitHeightParameters(network) ? null : fitHeightPlane(fitControls)
    const parameters = explicitHeightParameters(network) ?? fitted!.parameters
    const points = sourcePoints.map((point) => { const height = applyHeightPlane(point.x!, point.y!, point.height!, parameters); return { id: point.id, x: point.x, y: point.y, height, correctionHeight: height - point.height! } })
    const observations = controls.filter(({ observation, source }) => source?.x !== undefined && source.y !== undefined && source.height !== undefined && observation.targetHeight !== undefined).map(({ observation, source }) => { const height = applyHeightPlane(source!.x!, source!.y!, source!.height!, parameters); const residual = height - normalizeLengthUncertainty(observation.targetHeight!, observation.unit); const sigma = normalizeLengthUncertainty(observation.sigma ?? 1, observation.sigmaUnit ?? observation.unit); return { observationId: `${observation.id}:h`, correction: residual, residual, unit: 'm' as const, standardizedResidual: Math.abs(residual) / sigma, outlier: Math.abs(residual) / sigma > 3, sourceRow: observation.sourceRow } })
    const residualNorm = Math.sqrt(observations.reduce((sum, item) => sum + item.residual ** 2, 0)); const outliers = observations.filter((item) => item.outlier).map((item) => finding(network.id, 'outlier_candidate', 'warning', `高程控制点 ${item.observationId} 超过 3σ`, '复核高程基准、控制点和单位', item.sourceRow, nowIso)); const displacements = sourcePoints.map((point) => displacement(point, points.find((item) => item.id === point.id)!))
    return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: observations.length, unknownCount: fitted ? 3 : 0, redundancy: fitted?.adjustment.dof ?? 0, degreesOfFreedom: fitted?.adjustment.dof ?? 0, linearUnit: 'm', angularUnit: 'rad', transformType, closure: { vertical: residualNorm }, closureUnits: { vertical: 'm' }, parameters: { heightOffset: parameters.offset, heightSlopeX: parameters.slopeX, heightSlopeY: parameters.slopeY }, parameterUnits: { heightOffset: 'm', heightSlopeX: 'ratio', heightSlopeY: 'ratio' }, unitWeightStdDev: fitted?.adjustment.unitWeightStdDev ?? 0, varianceFactor: fitted?.adjustment.varianceFactor ?? 0, varianceFactorEstimated: fitted?.adjustment.varianceFactorEstimated ?? false, points, observations, displacements, covariance: fitted?.adjustment.covariance, precision: { maxPointStdDev: observations.length ? residualNorm / Math.sqrt(observations.length) : 0, passed: outliers.length === 0 }, qualityFindings: mergeFindings(baseFindings, outliers), inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: outliers.length ? 'invalid' : 'valid', solverDiagnostics: { iterations: fitted ? 1 : 0, rank: fitted?.adjustment.rank ?? 0, conditionEstimate: fitted?.adjustment.conditionEstimate }, createdAt: nowIso() })
  }
  const ellipsoid = resolveEllipsoid(network.ellipsoid)!
  const centralMeridian = network.centralMeridian!
  const hasFalseEasting = network.instrumentParameters.falseEasting !== 0
  const hasZonePrefix = network.instrumentParameters.zonePrefix === 1
  const zone = Math.round(centralMeridian / 3)
  const points = sourcePoints.map((point) => {
    if (transformType === 'gauss-kruger-forward') {
      const projected = gaussKrugerForward(point.latitude!, point.longitude!, centralMeridian, ellipsoid)
      const y = projected.y + (hasFalseEasting ? 500_000 : 0) + (hasZonePrefix ? zone * 1_000_000 : 0)
      return { id: point.id, x: projected.x, y, ...(point.height === undefined ? {} : { height: point.height }), latitude: point.latitude, longitude: point.longitude }
    }
    let y = point.y!
    if (hasZonePrefix) y %= 1_000_000
    if (hasFalseEasting) y -= 500_000
    const geodetic = gaussKrugerInverse(point.x!, y, centralMeridian, ellipsoid)
    return { id: point.id, x: point.x, y: point.y, ...(point.height === undefined ? {} : { height: point.height }), latitude: geodetic.latitude, longitude: geodetic.longitude }
  })
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: `adjustment_result_${randomUUID()}`, runId: run.id, networkId: network.id, observationCount: sourcePoints.length * 2, unknownCount: 0, redundancy: 0, degreesOfFreedom: 0, linearUnit: 'm', angularUnit: 'rad', transformType, closure: {}, closureUnits: {}, parameters: { centralMeridianRad: centralMeridian * Math.PI / 180, falseEasting: hasFalseEasting ? 500_000 : 0, zonePrefix: hasZonePrefix ? zone : 0 }, parameterUnits: { centralMeridianRad: 'rad', falseEasting: 'm', zonePrefix: 'ratio' }, unitWeightStdDev: 0, varianceFactor: 0, varianceFactorEstimated: false, points, observations: [], displacements: [], precision: { maxPointStdDev: 0, passed: true }, qualityFindings: baseFindings, inputHash: run.inputHash, algorithmVersion: ALGORITHM_VERSION, validation: 'valid', solverDiagnostics: { iterations: transformType === 'gauss-kruger-inverse' ? 12 : 0, rank: 0 }, createdAt: nowIso() })
}

export class SurveyRevisionConflictError extends Error { readonly code = 'survey_stale_request' }

export class SurveyService {
  private readonly db: Database.Database
  private readonly importAudit: SurveyImportAudit
  private readonly nowIso: () => string
  private readonly pendingPersistence = new Set<Promise<void>>()
  private readonly formatRegistry: SurveyFormatRegistry
  constructor(private readonly options: { rootDir: string; getProject?: SurveyProjectLookup; nowIso?: () => string; formatRegistry?: SurveyFormatRegistry }) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.formatRegistry = options.formatRegistry ?? new SurveyFormatRegistry()
   mkdirSync(resolve(options.rootDir), { recursive: true })
   this.db = new Database(resolve(options.rootDir, 'survey.sqlite3'))
   this.db.pragma('journal_mode = WAL')
    // Every writer must see delete triggers fired by conflict handling; the
    // insert guards below also protect the ledger when a different SQLite
    // client uses the default recursive_triggers=OFF.
    this.db.pragma('recursive_triggers = ON')
    this.db.pragma('busy_timeout = 5000')
    this.importAudit = new SurveyImportAudit(this.db, this.nowIso)
   this.db.exec(`CREATE TABLE IF NOT EXISTS survey_projects (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS survey_networks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS survey_raw_source_ledger (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, sequence INTEGER NOT NULL, source_sha256 TEXT NOT NULL, data_json TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(network_id, sequence));
      CREATE INDEX IF NOT EXISTS survey_raw_source_ledger_network_idx ON survey_raw_source_ledger(network_id, sequence);
      CREATE TABLE IF NOT EXISTS survey_source_admissions (network_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_file_hash TEXT NOT NULL, solver_input_hash TEXT NOT NULL, data_json TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS survey_adjustment_evidence (adjustment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, network_id TEXT NOT NULL, input_hash TEXT NOT NULL, source_admission_hash TEXT NOT NULL, calculation_hash TEXT NOT NULL, output_hash TEXT NOT NULL, data_json TEXT NOT NULL, recorded_at TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS survey_derived_corrections (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, sequence INTEGER NOT NULL, raw_source_ledger_initial_hash TEXT NOT NULL, data_json TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(network_id, sequence));
     CREATE INDEX IF NOT EXISTS survey_derived_corrections_network_idx ON survey_derived_corrections(network_id, sequence);
      CREATE TABLE IF NOT EXISTS survey_derived_correction_idempotency (key TEXT PRIMARY KEY, network_id TEXT NOT NULL, request_hash TEXT NOT NULL, correction_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS survey_adjustments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, network_id TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS survey_deformations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, reference_adjustment_id TEXT NOT NULL, current_adjustment_id TEXT NOT NULL, input_hash TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS survey_deformations_project_created_idx ON survey_deformations(project_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS survey_deformations_project_input_idx ON survey_deformations(project_id, input_hash);
      CREATE TABLE IF NOT EXISTS survey_idempotency (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS survey_free_leveling_trials (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, network_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, network_id, idempotency_key));
      CREATE INDEX IF NOT EXISTS survey_free_leveling_trials_scope_idx ON survey_free_leveling_trials(project_id, network_id, created_at DESC, id DESC);
      CREATE TRIGGER IF NOT EXISTS survey_free_leveling_trials_no_update BEFORE UPDATE ON survey_free_leveling_trials BEGIN SELECT RAISE(ABORT, 'survey_free_leveling_trials is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS survey_free_leveling_trials_no_delete BEFORE DELETE ON survey_free_leveling_trials BEGIN SELECT RAISE(ABORT, 'survey_free_leveling_trials is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS survey_free_leveling_trials_no_replace BEFORE INSERT ON survey_free_leveling_trials WHEN EXISTS (SELECT 1 FROM survey_free_leveling_trials WHERE id = NEW.id OR (project_id = NEW.project_id AND network_id = NEW.network_id AND idempotency_key = NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT, 'survey_free_leveling_trials is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_raw_source_ledger_no_update BEFORE UPDATE ON survey_raw_source_ledger BEGIN SELECT RAISE(ABORT, 'survey_raw_source_ledger is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_raw_source_ledger_no_delete BEFORE DELETE ON survey_raw_source_ledger BEGIN SELECT RAISE(ABORT, 'survey_raw_source_ledger is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_raw_source_ledger_no_replace_id BEFORE INSERT ON survey_raw_source_ledger WHEN EXISTS (SELECT 1 FROM survey_raw_source_ledger WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'survey_raw_source_ledger is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_raw_source_ledger_no_replace_sequence BEFORE INSERT ON survey_raw_source_ledger WHEN EXISTS (SELECT 1 FROM survey_raw_source_ledger WHERE network_id = NEW.network_id AND sequence = NEW.sequence) BEGIN SELECT RAISE(ABORT, 'survey_raw_source_ledger is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_source_admissions_no_update BEFORE UPDATE ON survey_source_admissions BEGIN SELECT RAISE(ABORT, 'survey_source_admissions is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_source_admissions_no_delete BEFORE DELETE ON survey_source_admissions BEGIN SELECT RAISE(ABORT, 'survey_source_admissions is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_source_admissions_no_replace BEFORE INSERT ON survey_source_admissions WHEN EXISTS (SELECT 1 FROM survey_source_admissions WHERE network_id = NEW.network_id) BEGIN SELECT RAISE(ABORT, 'survey_source_admissions is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_adjustment_evidence_no_update BEFORE UPDATE ON survey_adjustment_evidence BEGIN SELECT RAISE(ABORT, 'survey_adjustment_evidence is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_adjustment_evidence_no_delete BEFORE DELETE ON survey_adjustment_evidence BEGIN SELECT RAISE(ABORT, 'survey_adjustment_evidence is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_adjustment_evidence_no_replace BEFORE INSERT ON survey_adjustment_evidence WHEN EXISTS (SELECT 1 FROM survey_adjustment_evidence WHERE adjustment_id = NEW.adjustment_id) BEGIN SELECT RAISE(ABORT, 'survey_adjustment_evidence is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_corrections_no_update BEFORE UPDATE ON survey_derived_corrections BEGIN SELECT RAISE(ABORT, 'survey_derived_corrections is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_corrections_no_delete BEFORE DELETE ON survey_derived_corrections BEGIN SELECT RAISE(ABORT, 'survey_derived_corrections is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_corrections_no_replace_id BEFORE INSERT ON survey_derived_corrections WHEN EXISTS (SELECT 1 FROM survey_derived_corrections WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'survey_derived_corrections is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_corrections_no_replace_sequence BEFORE INSERT ON survey_derived_corrections WHEN EXISTS (SELECT 1 FROM survey_derived_corrections WHERE network_id = NEW.network_id AND sequence = NEW.sequence) BEGIN SELECT RAISE(ABORT, 'survey_derived_corrections is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_correction_idempotency_no_update BEFORE UPDATE ON survey_derived_correction_idempotency BEGIN SELECT RAISE(ABORT, 'survey_derived_correction_idempotency is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_correction_idempotency_no_delete BEFORE DELETE ON survey_derived_correction_idempotency BEGIN SELECT RAISE(ABORT, 'survey_derived_correction_idempotency is append-only'); END;
     CREATE TRIGGER IF NOT EXISTS survey_derived_correction_idempotency_no_replace BEFORE INSERT ON survey_derived_correction_idempotency WHEN EXISTS (SELECT 1 FROM survey_derived_correction_idempotency WHERE key = NEW.key) BEGIN SELECT RAISE(ABORT, 'survey_derived_correction_idempotency is append-only'); END;`)
  }
  close(): void { this.db.close() }

  /** Wait for recoverable sidecar projections before a workspace is closed or removed. */
  async flush(): Promise<void> {
    while (this.pendingPersistence.size > 0) {
      await Promise.all([...this.pendingPersistence])
    }
    await drainAtomicWrites()
  }

  createProject(input: unknown): SurveyProjectV1 {
    const parsed = SurveyProjectV1.parse({ ...input as Record<string, unknown>, schemaVersion: 1, id: (input as { id?: string }).id ?? `survey_project_${randomUUID()}`, revision: 1, createdAt: this.nowIso(), updatedAt: this.nowIso() })
    this.db.prepare('INSERT OR REPLACE INTO survey_projects(id, project_id, revision, data_json, updated_at) VALUES (?, ?, ?, ?, ?)').run(parsed.id, parsed.projectId, parsed.revision, JSON.stringify(parsed), parsed.updatedAt)
    return parsed
  }

  listNetworks(projectId?: string): SurveyNetworkV1[] {
    const rows = projectId ? this.db.prepare('SELECT data_json FROM survey_networks WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) : this.db.prepare('SELECT data_json FROM survey_networks ORDER BY updated_at DESC').all()
    return (rows as Array<{ data_json: string }>).map((row) => SurveyNetworkV1.parse(JSON.parse(row.data_json)))
  }
  getNetwork(id: string): SurveyNetworkV1 | null { const row = this.db.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(id) as { data_json: string } | undefined; return row ? SurveyNetworkV1.parse(JSON.parse(row.data_json)) : null }

  /**
   * Return an append-only source ledger exactly as persisted.  Existing
   * networks without a ledger remain readable; callers receive an explicit
   * `legacy-unverified` status through `getRawSourceIntegrity` instead of a
   * fabricated proof record.
   */
  getRawSourceLedger(networkId: string): SurveyRawDataLedgerEntry[] {
    return (this.db.prepare('SELECT data_json FROM survey_raw_source_ledger WHERE network_id = ? ORDER BY sequence ASC').all(networkId) as Array<{ data_json: string }>)
      .map((row) => JSON.parse(row.data_json) as SurveyRawDataLedgerEntry)
  }

  getRawSourceIntegrity(networkId: string): SurveyRawSourceIntegrity {
    const network = this.getNetwork(networkId)
    if (!network) throw new Error(`survey network not found: ${networkId}`)
    return this.checkRawSourceIntegrity(network, false)
  }

  getSourceEligibility(networkId: string): SurveySourceEligibility {
    const network = this.getNetwork(networkId)
    if (!network) throw new Error(`survey network not found: ${networkId}`)
    return this.sourceEligibility(network)
  }

  private sourceEligibility(network: SurveyNetworkV1, rawSourceIntegrity = this.checkRawSourceIntegrity(network, false)): SurveySourceEligibility {
    const admission = this.verifySourceAdmission(network)
    const sourceImportFindings = sourceImportFindingsFromSourceFile(network.id, network.sourceFile, this.nowIso)
      .filter((item) => item.severity === 'blocking')
    const findings = mergeFindings(
      sourceImportFindings,
      rawSourceIntegrityFindings(network, rawSourceIntegrity, this.nowIso),
      !admission.valid
        ? admission.errors.slice(0, 10).map((message) => finding(
            network.id,
            'raw_source_integrity',
            'blocking',
            `来源准入证据无效：${message}`,
            '从保留的原始文件重新导入；历史网络仅可审计查看，不能用于新的平差、变形或正式交付。',
            undefined,
            this.nowIso
          ))
        : [],
      sourceAdjustabilityFindings(network, this.nowIso),
      network.sourceFile?.parserId === 'leica-gsi-leveling-block-parser' && (
        network.sourceFile.parserVersion !== '0.4.0' || network.observations.some((observation) =>
          observation.rawFields?.heightDifferenceSource !== 'adjacent-WI83-cumulative-height-difference')
      )
        ? [finding(network.id, 'source_not_adjustment_ready', 'blocking',
            '旧版 Leica GSI 水准网络未验证累计高程转相邻高差的语义，不能用于新的计算或交付。',
            '从保留的完整原始 GSI 重新导入；旧网络、原件和平差结果保持可查看，不会自动改写。', undefined, this.nowIso)]
        : [],
      network.sourceFile?.detection.format === 'cosa-in2' && network.observations.some((observation) =>
        observation.type === 'direction' && observation.rawFields?.coordinateAxisOrder !== 'north-east')
        ? [finding(network.id, 'source_not_adjustment_ready', 'blocking',
            '旧版 COSA 网络未记录 X=北、Y=东的坐标轴定义，不能用于新的计算或交付。',
            '从保留的原始 .in2 文件重新导入；历史网络和平差成果仍可查看，不会改写。', undefined, this.nowIso)]
        : [],
      unitCompatibilityFindings(network, this.nowIso),
      identityAmbiguityFindings(network, this.nowIso)
    )
    return Object.freeze({ eligible: findings.length === 0, findings: Object.freeze(findings) })
  }

  /**
   * Deterministically re-evaluate all findings that the numerical kernel can
   * consume. Persisted `network.findings` is an audit/UI projection and may
   * be stale or tampered with; it must never be the authority deciding
   * whether a raw observation may reach a solver.
   */
  private evaluateCurrentNetworkFindings(
    network: SurveyNetworkV1,
    rawSourceIntegrity: SurveyRawSourceIntegrity = this.checkRawSourceIntegrity(network, false),
    options: { includeConnectivity?: boolean } = {}
  ): SurveyQualityFindingV1[] {
    const points = pointMap(network)
    const findings: SurveyQualityFindingV1[] = [
      ...sourceImportFindingsFromSourceFile(network.id, network.sourceFile, this.nowIso),
      ...this.sourceEligibility(network, rawSourceIntegrity).findings
    ]
    for (const observation of network.observations) {
      for (const id of observationEndpointIds(observation)) {
        if (!points.has(id)) findings.push(finding(network.id, 'missing_point', 'blocking', `观测 ${observation.id} 引用了不存在的点 ${id}`, '补充点坐标/高程或修正点号', observation.sourceRow, this.nowIso))
      }
      if (observation.covariance && observation.covariance.some((value) => !Number.isFinite(value))) {
        findings.push(finding(network.id, 'invalid_observation', 'blocking', `观测 ${observation.id} 协方差包含非法数值`, '修正协方差后重新导入', observation.sourceRow, this.nowIso))
      }
      const angular = isAngularObservation(observation)
      const unit = normalizedUnitToken(observation.unit)
      if (!angular && network.unit && unit !== network.unit.trim().toLowerCase() && !(network.unit === 'm' && ['meter', 'meters'].includes(unit))) {
        findings.push(finding(network.id, 'unit_conflict', 'warning', `观测 ${observation.id} 的单位 ${observation.unit} 与网络单位 ${network.unit} 不一致`, '确认单位并在导入前统一，换算不会静默丢失', observation.sourceRow, this.nowIso))
      }
      if (['plane-control', 'traverse', 'triangulation', 'cpiii-free-station', 'cpiii-resection'].includes(network.networkType)) {
        for (const id of observationEndpointIds(observation)) {
          const point = points.get(id)
          if (point && (point.x === undefined || point.y === undefined)) {
            findings.push(finding(network.id, 'missing_point', 'blocking', `平面观测 ${observation.id} 的点 ${id} 缺少平面坐标`, '补充 X/Y 初始坐标后重新导入', observation.sourceRow, this.nowIso))
          }
        }
      }
    }
    if (!network.observations.length && network.networkType !== 'coordinate-transform') {
      findings.push(finding(network.id, 'invalid_observation', 'blocking', '网络没有观测记录', '导入至少一条有效观测', undefined, this.nowIso))
    }
    if (network.networkType === 'leveling' || network.networkType === 'height-control') findings.push(...levelingStrategyFindings(network, this.nowIso))
    if (network.networkType === 'traverse') findings.push(...traverseStrategyFindings(network, this.nowIso))
    if (network.networkType === 'plane-control') findings.push(...planeControlStrategyFindings(network, this.nowIso))
    if (network.networkType === 'triangulation') findings.push(...triangulationStrategyFindings(network, this.nowIso))
    if (network.networkType === 'cpiii-free-station' || network.networkType === 'cpiii-resection') findings.push(...cpiiiStrategyFindings(network, this.nowIso))
    if (network.networkType === 'gnss') findings.push(...gnssStrategyFindings(network, this.nowIso))
    if (network.networkType === 'coordinate-transform') findings.push(...coordinateTransformStrategyFindings(network, this.nowIso))
    if (network.networkType !== 'coordinate-transform' && options.includeConnectivity !== false) {
      if (network.knownPoints.length === 0 && network.unknownPoints.length > 0) {
        findings.push(finding(network.id, 'missing_datum', 'blocking', '网络没有已知约束点', '提供已知点或明确自由网约束', undefined, this.nowIso))
      }
      const adjacency = new Map<string, Set<string>>()
      for (const id of points.keys()) adjacency.set(id, new Set())
      for (const observation of network.observations) {
        const ids = observationEndpointIds(observation)
        for (const a of ids) for (const b of ids) if (a !== b) adjacency.get(a)?.add(b)
      }
      const roots = [...network.knownPoints].map((point) => point.id)
      const seen = new Set<string>(roots)
      const queue = [...roots]
      while (queue.length) {
        for (const next of adjacency.get(queue.shift()!) ?? []) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      if (network.unknownPoints.some((point) => !seen.has(point.id))) {
        findings.push(finding(network.id, 'disconnected_network', 'blocking', '存在与已知点不连通的网段', '检查点号、观测方向和缺失边', undefined, this.nowIso))
      }
    }
    const tolerance = network.instrumentParameters.closureTolerance
    if (typeof tolerance === 'number' && Number.isFinite(tolerance) && tolerance >= 0
      && (network.networkType === 'leveling' || network.networkType === 'height-control')) {
      const closure = levelingClosures(network, network.observations.filter((item) => item.type === 'height-difference'), points).heightDifference
      if (closure !== undefined && Math.abs(closure) > tolerance) {
        findings.push(finding(network.id, 'closure_exceeded', 'blocking', `水准闭合差 ${closure} 超过限差 ${tolerance}`, '复核附合/闭合路线观测、单位和权值', undefined, this.nowIso))
      }
    }
    return mergeFindings(findings)
  }

  private createSourceAdmissionRecord(network: SurveyNetworkV1, recordedAt: string): SurveySourceAdmissionRecord {
    const source = network.sourceFile
    if (!source) throw new Error('source admission requires a parser-derived SurveySourceFile')
    const payload: Omit<SurveySourceAdmissionRecord, 'thisHash'> = {
      schemaVersion: 1,
      networkId: network.id,
      projectId: network.projectId,
      sourceSha256: source.sha256,
      sourceFileHash: surveySourceFileAdmissionHash(source),
      solverInputHash: surveySolverInputHash(network),
      recordedAt
    }
    return Object.freeze({ ...payload, thisHash: sourceAdmissionRecordHash(payload) })
  }

  private insertSourceAdmission(record: SurveySourceAdmissionRecord): void {
    this.db.prepare('INSERT INTO survey_source_admissions(network_id, project_id, source_sha256, source_file_hash, solver_input_hash, data_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.networkId, record.projectId, record.sourceSha256, record.sourceFileHash, record.solverInputHash, JSON.stringify(record), record.recordedAt)
  }

  /**
   * Rebind current network/source metadata to the append-only admission
   * record. Existing pre-admission networks remain readable but intentionally
   * fail new-use eligibility instead of being silently backfilled.
   */
  private verifySourceAdmission(network: SurveyNetworkV1): SurveySourceAdmissionVerification {
    const row = this.db.prepare('SELECT network_id, project_id, source_sha256, source_file_hash, solver_input_hash, data_json FROM survey_source_admissions WHERE network_id = ?').get(network.id) as {
      network_id: string
      project_id: string
      source_sha256: string
      source_file_hash: string
      solver_input_hash: string
      data_json: string
    } | undefined
    if (!row) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze(['该网络缺少不可变来源准入记录（兼容/历史导入不可被自动升级）。'])
      })
    }
    try {
      const record = JSON.parse(row.data_json) as Partial<SurveySourceAdmissionRecord>
      const hashFieldsValid = [record.sourceSha256, record.sourceFileHash, record.solverInputHash, record.thisHash]
        .every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
      if (record.schemaVersion !== 1
        || typeof record.networkId !== 'string'
        || typeof record.projectId !== 'string'
        || typeof record.recordedAt !== 'string'
        || !hashFieldsValid) {
        throw new Error('持久化记录结构或哈希字段无效。')
      }
      const { thisHash, ...hashable } = record as SurveySourceAdmissionRecord
      if (sourceAdmissionRecordHash(hashable) !== thisHash) throw new Error('持久化记录哈希不匹配。')
      const source = network.sourceFile
      if (!source) throw new Error('当前网络缺少 parser-derived 来源文件。')
      const sourceFileHash = surveySourceFileAdmissionHash(source)
      const solverInputHash = surveySolverInputHash(network)
      if (row.network_id !== record.networkId
        || row.project_id !== record.projectId
        || row.source_sha256 !== record.sourceSha256
        || row.source_file_hash !== record.sourceFileHash
        || row.solver_input_hash !== record.solverInputHash
        || record.networkId !== network.id
        || record.projectId !== network.projectId
        || record.sourceSha256 !== source.sha256
        || record.sourceFileHash !== sourceFileHash
        || record.solverInputHash !== solverInputHash) {
        throw new Error('当前网络、来源文件或求解输入与初始准入证据不一致。')
      }
      return Object.freeze({ valid: true, errors: Object.freeze([]), record: Object.freeze(record as SurveySourceAdmissionRecord) })
    } catch (error) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze([error instanceof Error ? error.message : String(error)])
      })
    }
  }

  /**
   * Write the immutable evidence record only after the durable adjustment row
   * has been inserted in the same transaction. The record intentionally binds
   * both the calculation-equivalent result and the full run/result payload:
   * a later change to either numerical content or run provenance is visible.
   */
  private createAdjustmentEvidenceRecord(
    output: StoredAdjustment,
    sourceAdmission: SurveySourceAdmissionRecord,
    recordedAt: string
  ): SurveyAdjustmentEvidenceRecord {
    if (!output.result) throw new Error('adjustment evidence requires a deterministic result')
    const payload: Omit<SurveyAdjustmentEvidenceRecord, 'thisHash'> = {
      schemaVersion: 1,
      adjustmentId: output.run.id,
      projectId: output.run.projectId,
      networkId: output.run.networkId,
      inputHash: output.run.inputHash,
      sourceAdmissionHash: sourceAdmission.thisHash,
      calculationHash: adjustmentCalculationHash(output.result),
      outputHash: adjustmentOutputHash(output),
      recordedAt
    }
    return Object.freeze({ ...payload, thisHash: adjustmentEvidenceRecordHash(payload) })
  }

  private insertAdjustmentEvidence(record: SurveyAdjustmentEvidenceRecord): void {
    this.db.prepare('INSERT INTO survey_adjustment_evidence(adjustment_id, project_id, network_id, input_hash, source_admission_hash, calculation_hash, output_hash, data_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.adjustmentId,
        record.projectId,
        record.networkId,
        record.inputHash,
        record.sourceAdmissionHash,
        record.calculationHash,
        record.outputHash,
        JSON.stringify(record),
        record.recordedAt
      )
  }

  /**
   * Checks the append-only record against the live, currently admissible
   * source admission and the durable run/result payload. This does not try to
   * make legacy rows valid: absence is a reason to retain them for audit only.
   */
  private verifyAdjustmentEvidence(
    stored: StoredAdjustment,
    network: SurveyNetworkV1,
    sourceAdmission: SurveySourceAdmissionRecord
  ): SurveyAdjustmentEvidenceVerification {
    if (!stored.result) {
      return Object.freeze({ valid: false, errors: Object.freeze(['平差记录缺少确定性结果。']) })
    }
    const row = this.db.prepare('SELECT adjustment_id, project_id, network_id, input_hash, source_admission_hash, calculation_hash, output_hash, data_json FROM survey_adjustment_evidence WHERE adjustment_id = ?').get(stored.run.id) as {
      adjustment_id: string
      project_id: string
      network_id: string
      input_hash: string
      source_admission_hash: string
      calculation_hash: string
      output_hash: string
      data_json: string
    } | undefined
    if (!row) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze(['该平差缺少不可变结果证据记录（兼容/历史结果不可被自动升级）。'])
      })
    }
    try {
      const record = JSON.parse(row.data_json) as Partial<SurveyAdjustmentEvidenceRecord>
      const hashFieldsValid = [
        record.inputHash,
        record.sourceAdmissionHash,
        record.calculationHash,
        record.outputHash,
        record.thisHash
      ].every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
      if (record.schemaVersion !== 1
        || typeof record.adjustmentId !== 'string'
        || typeof record.projectId !== 'string'
        || typeof record.networkId !== 'string'
        || typeof record.recordedAt !== 'string'
        || !hashFieldsValid) {
        throw new Error('持久化结果证据结构或哈希字段无效。')
      }
      const { thisHash, ...hashable } = record as SurveyAdjustmentEvidenceRecord
      if (adjustmentEvidenceRecordHash(hashable) !== thisHash) throw new Error('持久化结果证据哈希不匹配。')
      const calculationHash = adjustmentCalculationHash(stored.result)
      const outputHash = adjustmentOutputHash(stored)
      if (row.adjustment_id !== record.adjustmentId
        || row.project_id !== record.projectId
        || row.network_id !== record.networkId
        || row.input_hash !== record.inputHash
        || row.source_admission_hash !== record.sourceAdmissionHash
        || row.calculation_hash !== record.calculationHash
        || row.output_hash !== record.outputHash
        || record.adjustmentId !== stored.run.id
        || record.projectId !== stored.run.projectId
        || record.networkId !== stored.run.networkId
        || record.networkId !== network.id
        || record.inputHash !== stored.run.inputHash
        || record.inputHash !== stored.result.inputHash
        || record.sourceAdmissionHash !== sourceAdmission.thisHash
        || record.calculationHash !== calculationHash
        || record.outputHash !== outputHash) {
        throw new Error('当前平差运行、数值结果或来源准入与不可变结果证据不一致。')
      }
      return Object.freeze({ valid: true, errors: Object.freeze([]), record: Object.freeze(record as SurveyAdjustmentEvidenceRecord) })
    } catch (error) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze([error instanceof Error ? error.message : String(error)])
      })
    }
  }

  private rawSourceLedger(networkId: string): SurveyRawDataLedgerEntry[] {
    return this.getRawSourceLedger(networkId)
  }

 private rawSourceOriginalPath(sha256: string): string {
   const root = resolve(this.options.rootDir)
   const path = resolve(root, 'sources', sha256, 'original')
    if (!isSurveyRuntimePathContained(root, path)) throw new Error('raw source path escapes Survey runtime root')
   return path
 }

  private insertRawSourceLedgerEntry(entry: SurveyRawDataLedgerEntry): void {
    this.db.prepare('INSERT INTO survey_raw_source_ledger(id, network_id, sequence, source_sha256, data_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.networkId, entry.sequence, entry.sourceSha256, JSON.stringify(entry), entry.occurredAt)
  }

  private initialRawSourceLedgerEntry(network: SurveyNetworkV1): SurveyRawDataLedgerEntry {
    const source = rawSourceEvidence(network.sourceFile)
    if (!source) throw new Error('raw source evidence is required to create an integrity ledger')
    return recordRawSource({
      id: `raw_source_${randomUUID()}`,
      networkId: network.id,
      source,
      occurredAt: network.createdAt
    })
  }

  /**
   * Check both the durable hash chain and the content-addressed original
   * written by the dataBase64 import path.  This is deliberately not used to
   * upgrade legacy/structured inputs: a missing original remains explicitly
   * unverified until it is re-imported from preserved source bytes.
   */
 private checkRawSourceIntegrity(network: SurveyNetworkV1, appendVerification: boolean): SurveyRawSourceIntegrity {
    let entries: SurveyRawDataLedgerEntry[]
    try {
      entries = this.rawSourceLedger(network.id)
    } catch (error) {
      return Object.freeze({
        status: 'failed' as const,
        ledgerEntryCount: 0,
        errors: Object.freeze([`原始资料账本无法解析：${error instanceof Error ? error.message : String(error)}`])
      })
    }
   if (!entries.length) return Object.freeze({
      status: 'legacy-unverified' as const,
      ledgerEntryCount: 0,
      errors: Object.freeze(['原始资料未由当前导入链路验证；请从保留的原始文件重新导入后再用于正式交付。'])
    })

    const chain = verifyRawSourceLedger(entries)
    if (!chain.valid) return Object.freeze({ status: 'failed' as const, ledgerEntryCount: entries.length, errors: chain.errors })
    const initial = entries[0]!
    const source = rawSourceEvidence(network.sourceFile)
    if (!source) return Object.freeze({
      status: 'failed' as const,
      ledgerEntryCount: entries.length,
      errors: Object.freeze(['网络缺少与原始资料账本对应的来源证据。'])
    })
    try {
      const originalBytes = readFileSync(this.rawSourceOriginalPath(initial.sourceSha256))
      const contentHash = createHash('sha256').update(originalBytes).digest('hex')
      if (contentHash !== initial.sourceSha256) throw new Error('保存的原始文件哈希与账本记录不一致。')
      if (source.sha256 !== initial.sourceSha256 || source.fileSize !== initial.sourceSize) throw new Error('网络中的来源证据与原始资料账本不一致。')
      if (rawAnchorDigest(source) !== initial.rawAnchorDigest) throw new Error('网络中的原始记录锚点与原始资料账本不一致。')
      if (appendVerification) {
        const reverified = reverifyRawSource({
          ledger: entries,
          id: `raw_source_${randomUUID()}`,
          source,
          occurredAt: this.nowIso()
        })
        this.insertRawSourceLedgerEntry(reverified)
      }
      return Object.freeze({ status: 'verified' as const, ledgerEntryCount: entries.length + (appendVerification ? 1 : 0), errors: Object.freeze([]) })
    } catch (error) {
      return Object.freeze({
        status: 'failed' as const,
        ledgerEntryCount: entries.length,
        errors: Object.freeze([error instanceof Error ? error.message : String(error)])
      })
    }
  }

  /** Read the separate, append-only derived-correction ledger for one network. */
  getDerivedCorrectionLedger(networkId: string): SurveyDerivedCorrectionRecordV1[] {
    if (!this.getNetwork(networkId)) throw new Error(`survey network not found: ${networkId}`)
    return (this.db.prepare('SELECT data_json FROM survey_derived_corrections WHERE network_id = ? ORDER BY sequence ASC').all(networkId) as Array<{ data_json: string }>)
      .map((row) => SurveyDerivedCorrectionRecordV1.parse(JSON.parse(row.data_json)))
  }

  /**
   * Replay a historical correction head against the unchanged source network.
   * Re-hashing the preserved original is mandatory here; structural ledger
   * verification alone is not a claim that the source bytes still exist.
   */
  getDerivedCorrectionReplay(networkId: string, correctionHeadHash?: string): SurveyDerivedCorrectionReplay {
    const network = this.getNetwork(networkId)
    if (!network) throw new Error(`survey network not found: ${networkId}`)
    const integrity = this.checkRawSourceIntegrity(network, false)
    if (integrity.status !== 'verified') {
      return Object.freeze({
        valid: false,
        errors: Object.freeze([`无法回放派生修正：原始资料完整性为 ${integrity.status}${integrity.errors.length ? `（${integrity.errors.join('；')}）` : ''}`]),
        correctionCount: 0,
       steps: Object.freeze([])
     })
   }
    // A byte-for-byte preserved attachment is necessary but not sufficient
    // evidence for a numerical correction. An archive-only parser result,
    // ambiguous anchor, or missing canonical-unit proof must remain readable
    // as historical evidence without producing a corrected computational view.
    const eligibility = this.sourceEligibility(network, integrity)
    if (!eligibility.eligible) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze([`无法回放派生修正：原始资料不满足可平差门禁（${eligibility.findings.map((item) => item.message).join('；')}）`]),
        correctionCount: 0,
        steps: Object.freeze([])
      })
    }
    let rawLedger: SurveyRawDataLedgerEntry[]
    let corrections: SurveyDerivedCorrectionRecordV1[]
    try {
      rawLedger = this.rawSourceLedger(networkId)
      corrections = this.getDerivedCorrectionLedger(networkId)
    } catch (error) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze([`无法回放派生修正：持久化账本无法解析（${error instanceof Error ? error.message : String(error)}）`]),
        correctionCount: 0,
        steps: Object.freeze([])
      })
    }
   const initialHead = rawLedger[0]?.thisHash
    let selected = corrections
    if (correctionHeadHash !== undefined) {
      if (correctionHeadHash === initialHead) selected = []
      else {
        const index = corrections.findIndex((record) => record.thisHash === correctionHeadHash)
        if (index < 0) {
          return Object.freeze({
            valid: false,
            errors: Object.freeze(['请求的派生修正链头不存在于该网络。']),
            correctionCount: 0,
            rawSourceLedgerInitialHash: initialHead,
            steps: Object.freeze([])
          })
        }
        selected = corrections.slice(0, index + 1)
      }
    }
    return replayDerivedCorrections({ network, rawLedger, corrections: selected })
  }

  /**
   * Append one server-trusted scalar observation correction. No IPC/HTTP write
   * route calls this method yet: callers must supply actor identity from a
   * trusted server context. The corrected view is intentionally not passed to
   * saveNetwork(), so the imported observation remains byte-for-byte intact.
   */
 recordTrustedDerivedObservationValueCorrection(input: RecordTrustedSurveyDerivedObservationValueCorrection): SurveyDerivedCorrectionRecordV1 {
   if (!Number.isSafeInteger(input.expectedNetworkRevision) || input.expectedNetworkRevision <= 0) throw new Error('expected network revision must be a positive safe integer')
   if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new Error('derived correction idempotency key must be 8–200 characters')
    if (!Number.isFinite(input.afterValue)) throw new Error('derived correction afterValue must be finite')
    const idempotencyKey = input.idempotencyKey
   const requestHash = derivedCorrectionRequestHash(input)

   return this.db.transaction(() => {
      // This check is intentionally inside BEGIN IMMEDIATE. A second service
      // waits for the first writer, then replays its committed evidence rather
      // than appending another correction for the same trusted command.
      const existing = this.replayTrustedDerivedCorrection(idempotencyKey, input, requestHash)
      if (existing) return existing

     const network = this.getNetwork(input.networkId)
      if (!network) throw new Error(`survey network not found: ${input.networkId}`)
      if (network.revision !== input.expectedNetworkRevision) throw new SurveyRevisionConflictError(`network revision conflict: expected ${input.expectedNetworkRevision}, actual ${network.revision}`)
      const integrity = this.checkRawSourceIntegrity(network, false)
      if (integrity.status !== 'verified') throw new Error(`cannot record a derived correction while raw source integrity is ${integrity.status}: ${integrity.errors.join('；')}`)
      const eligibility = this.sourceEligibility(network, integrity)
      if (!eligibility.eligible) throw new Error(`cannot record a derived correction while source eligibility is failed: ${eligibility.findings.map((item) => item.message).join('；')}`)

      const rawLedger = this.rawSourceLedger(network.id)
      const initial = rawLedger[0]
      if (!initial) throw new Error('verified raw source ledger unexpectedly has no initial entry')
      const corrections = this.getDerivedCorrectionLedger(network.id)
      const replayed = replayDerivedCorrections({ network, rawLedger, corrections })
      if (!replayed.valid || !replayed.derivedNetwork) throw new Error(`cannot append to an invalid derived-correction ledger: ${replayed.errors.join('；')}`)
      const currentHead = replayed.correctionLedgerHeadHash ?? initial.thisHash
      if (input.expectedCorrectionHeadHash !== currentHead) throw new SurveyRevisionConflictError(`derived correction head conflict: expected ${input.expectedCorrectionHeadHash}, actual ${currentHead}`)

      const observation = network.observations.find((item) => item.id === input.observationId)
      if (!observation) throw new Error(`survey observation not found: ${input.observationId}`)
      const sourceAnchor = network.sourceFile?.records.find((item) => item.id === observation.sourceRecordId && item.rawLength > 0)
      if (!sourceAnchor || !observation.sourceRecordId) throw new Error(`survey observation ${input.observationId} has no verifiable raw-source anchor`)
      const effectiveObservation = replayed.derivedNetwork.observations.find((item) => item.id === observation.id)
      if (!effectiveObservation) throw new Error(`derived replay omitted survey observation: ${input.observationId}`)
      if (input.afterValue === effectiveObservation.value) throw new Error('derived correction must change the effective observation value')

      const record = recordDerivedObservationValueCorrection({
        id: input.id,
        networkId: network.id,
        sequence: corrections.length + 1,
        initialRawSourceLedgerEntry: initial,
        previousHash: currentHead,
        observation,
        beforeValue: effectiveObservation.value,
        afterValue: input.afterValue,
        sourceAnchorId: sourceAnchor.id,
        reason: input.reason,
        basis: input.basis,
        operation: input.operation,
       actor: input.actor,
       occurredAt: this.nowIso()
     })
      // Reserve the idempotency mapping first. Any subsequent ledger insert
      // failure rolls both rows back with this IMMEDIATE transaction.
      this.rememberDerivedCorrection(idempotencyKey, requestHash, record)
     this.db.prepare('INSERT INTO survey_derived_corrections(id, network_id, sequence, raw_source_ledger_initial_hash, data_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
       .run(record.id, record.networkId, record.sequence, record.rawSource.rawSourceLedgerInitialHash, JSON.stringify(record), record.occurredAt)
     return record
   }).immediate()
 }

  private getDerivedCorrectionIdempotency(key: string): StoredDerivedCorrectionIdempotency | null {
    const row = this.db.prepare('SELECT network_id, request_hash, correction_id, result_json FROM survey_derived_correction_idempotency WHERE key = ?').get(key) as { network_id: string; request_hash: string; correction_id: string; result_json: string } | undefined
    if (!row) return null
    const record = SurveyDerivedCorrectionRecordV1.parse(JSON.parse(row.result_json))
    if (record.networkId !== row.network_id || record.id !== row.correction_id) throw new Error('derived correction idempotency evidence is inconsistent')
    return Object.freeze({ networkId: row.network_id, requestHash: row.request_hash, record })
  }

  /** Verify an idempotent replay against the current immutable source and chain. */
  private replayTrustedDerivedCorrection(key: string, input: RecordTrustedSurveyDerivedObservationValueCorrection, requestHash: string): SurveyDerivedCorrectionRecordV1 | null {
    const stored = this.getDerivedCorrectionIdempotency(key)
    if (!stored) return null
    if (stored.networkId !== input.networkId) throw new Error('derived correction idempotency key belongs to another network')
    if (stored.requestHash !== requestHash) throw new Error('derived correction idempotency key was reused with a different request payload')
    const network = this.getNetwork(stored.networkId)
    if (!network) throw new Error(`survey network not found: ${stored.networkId}`)
    const integrity = this.checkRawSourceIntegrity(network, false)
    if (integrity.status !== 'verified') throw new Error(`cannot replay a derived correction while raw source integrity is ${integrity.status}: ${integrity.errors.join('；')}`)
    const eligibility = this.sourceEligibility(network, integrity)
    if (!eligibility.eligible) throw new Error(`cannot replay a derived correction while source eligibility is failed: ${eligibility.findings.map((item) => item.message).join('；')}`)
    const replayed = this.getDerivedCorrectionReplay(network.id)
    if (!replayed.valid) throw new Error(`cannot replay an invalid derived-correction ledger: ${replayed.errors.join('；')}`)
    const persisted = this.getDerivedCorrectionLedger(network.id).find((record) => record.id === stored.record.id)
    if (!persisted || persisted.thisHash !== stored.record.thisHash) throw new Error('derived correction idempotency result is missing from the immutable correction ledger')
    return stored.record
  }

  private rememberDerivedCorrection(key: string, requestHash: string, record: SurveyDerivedCorrectionRecordV1): void {
    this.db.prepare('INSERT INTO survey_derived_correction_idempotency(key, network_id, request_hash, correction_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, record.networkId, requestHash, record.id, JSON.stringify(record), record.occurredAt)
  }

  recordRejectedImport(input: unknown, reason: Extract<ImportRejection, 'invalid-json' | 'body-too-large' | 'body-read' | 'structured-http'>): void {
    const attempt = this.importAudit.begin(input)
    this.importAudit.finish(attempt, reason)
  }

  async importNetwork(input: unknown): Promise<SurveyNetworkV1> {
    const attempt = this.importAudit.begin(input)
    let network: SurveyNetworkV1
    try {
      network = await this.importNetworkTracked(input, attempt)
    } catch (error) {
      // A failed audit write leaves explicit incomplete evidence. Never claim
      // success, or fabricate a terminal receipt after persistence failed.
      if (!(error instanceof SurveyImportAuditError)) this.importAudit.finish(attempt, attempt.stage)
      throw error
    }
    this.importAudit.finish(attempt, null)
    return network
  }

  private async importNetworkTracked(input: unknown, attempt: SurveyImportAttempt): Promise<SurveyNetworkV1> {
    const req = SurveyNetworkImportRequest.parse(input)
    attempt.stage = 'preparation'
    const prepared = prepareImportRequest(req)
    attempt.stage = 'replay'
    const replay = this.replayImportNetwork(req, prepared)
    if (replay) {
      this.importAudit.committed(attempt, true, replay.sourceFile?.disposition)
      // The SQLite record is authoritative. Replaying a request also gives a
      // previously failed sidecar projection an opportunity to recover, but
      // a secondary file or project-lookup error must never turn a durable
      // idempotency result into another failed import attempt.
      try {
        const workspace = this.options.getProject?.(req.projectId)?.workspace
        await this.persist(replay, 'networks', workspace)
      } catch {
        // The original request already surfaced a projection failure. Keep
        // this retry safe and let normal projection/recovery work retry it.
      }
      return replay
    }
    attempt.stage = 'project'
    const project = this.options.getProject?.(req.projectId)
    if (project && req.expectedRevision !== 0 && req.expectedRevision !== project.revision) throw new SurveyRevisionConflictError(`project revision conflict: expected ${req.expectedRevision}, actual ${project.revision}`)
    let network: SurveyNetworkV1
    let persistedRawOriginal = false
    attempt.stage = 'parse'
    if (req.network) {
      // This read-only compatibility path keeps migrated records accessible.
      // It deliberately creates no original-byte ledger, so validation and
      // adjustment lock the record until it is re-imported through the file
      // source path. The public Runtime handler also rejects raw `network`
      // payloads outright.
      const { heightDatum: legacyHeightDatum, ...networkWithoutLegacyDatum } = req.network as SurveyNetworkV1 & { heightDatum?: string }
      const requestedVerticalDatum = req.network.verticalDatum && req.network.verticalDatum !== '待确认' ? req.network.verticalDatum : legacyHeightDatum
      network = SurveyNetworkV1.parse({ ...networkWithoutLegacyDatum, schemaVersion: 1, id: req.network.id ?? `network_${randomUUID()}`, projectId: req.projectId, networkType: req.network.networkType ?? req.networkType ?? 'leveling', transformType: req.network.transformType ?? req.transformType, coordinateSystem: req.network.coordinateSystem ?? '待确认', projection: req.network.projection ?? '待确认', ellipsoid: req.network.ellipsoid ?? '待确认', verticalDatum: requestedVerticalDatum ?? '待确认', unit: req.network.unit ?? 'm', knownPoints: req.network.knownPoints ?? [], unknownPoints: req.network.unknownPoints ?? [], observations: req.network.observations ?? [], instrumentParameters: req.network.instrumentParameters ?? {}, qualityStatus: 'imported', findings: [], revision: 1, createdAt: this.nowIso(), updatedAt: this.nowIso(), inputAttachmentHash: req.inputAttachmentHash ?? req.network.inputAttachmentHash })
    }
    else {
      const sourceBytes = prepared.sourceBytes
      if (!sourceBytes || !prepared.source.originalSha256) throw new Error('source import is missing bound original bytes')
      network = await parseNetworkPayload(
        req.name ?? 'survey.json',
        sourceBytes,
        req.projectId,
        this.nowIso,
        this.formatRegistry,
        req.networkType,
        req.transformType,
        req.cosaIn1Mapping as CosaIn1Mapping | undefined,
        req.knownPoints,
        async (source) => {
          const original = source.originalSourceFile
          if (original && source.originalBytes) {
            await atomicWriteFile(this.rawSourceOriginalPath(original.sha256), source.originalBytes)
          }
          await atomicWriteFile(this.rawSourceOriginalPath(source.sourceFile.sha256), source.effectiveBytes)
        }
      )
      persistedRawOriginal = true
    }
    if (network.knownPoints.length + network.unknownPoints.length > MAX_POINTS || network.observations.length > MAX_OBSERVATIONS) throw new Error(`survey network exceeds limits (${MAX_POINTS} points, ${MAX_OBSERVATIONS} observations)`)
    const parsed = SurveyNetworkV1.parse(network)
    const initialLedger = persistedRawOriginal ? this.initialRawSourceLedgerEntry(parsed) : null
    // The admission is committed with the raw ledger and mutable network
    // projection. Never backfill it for legacy structured data: without the
    // original import evidence, that would silently promote a history row.
    const initialAdmission = persistedRawOriginal ? this.createSourceAdmissionRecord(parsed, parsed.createdAt) : null
    attempt.stage = 'commit'
    const committed = this.db.transaction(() => {
      // Parsing and preserving the content-addressed source can happen before
      // this lock.  The durable state must not: another service may have
      // committed the same key while this request was parsing.
      const existing = this.replayImportNetwork(req, prepared)
      if (existing) {
        this.importAudit.committed(attempt, true, existing.sourceFile?.disposition)
        return existing
      }

      // Recheck mutable project state only after acquiring the writer lock.
      // A successful earlier request remains replayable regardless of later
      // project revision changes because the replay check is deliberately
      // first.
      const currentProject = this.options.getProject?.(req.projectId)
      if (currentProject && req.expectedRevision !== 0 && req.expectedRevision !== currentProject.revision) {
        throw new SurveyRevisionConflictError(`project revision conflict: expected ${req.expectedRevision}, actual ${currentProject.revision}`)
      }

      this.db.prepare('INSERT INTO survey_networks(id, project_id, revision, data_json, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(parsed.id, parsed.projectId, parsed.revision, JSON.stringify(parsed), parsed.updatedAt)
      if (initialLedger) this.insertRawSourceLedgerEntry(initialLedger)
      if (initialAdmission) this.insertSourceAdmission(initialAdmission)

      // Do not use INSERT OR IGNORE here.  A missing reservation would make a
      // second network look successful after a duplicate-key race; the
      // IMMEDIATE transaction plus strict insert instead commits one complete
      // network/ledger/idempotency unit or rolls all of it back.
      this.rememberImportNetwork(req.idempotencyKey, prepared, parsed)
      this.importAudit.committed(attempt, false, parsed.sourceFile?.disposition)
      return parsed
    }).immediate()

    // The sidecar is a recoverable projection of committed SQLite state.  If
    // it fails, this method rejects but the retry above replays the durable
    // result (and attempts the projection again) rather than creating a
    // second network or source ledger.
    attempt.stage = 'projection'
    await this.persist(committed, 'networks', project?.workspace)
    return committed
  }

  validateNetwork(networkId: string, input: unknown): SurveyNetworkV1 {
    const req = SurveyNetworkValidateRequest.parse(input)
    return this.db.transaction(() => {
      // A retry must replay before its revision is checked; the first
      // validation advances the revision as part of the same transaction.
      // It must still re-establish current source admission first: validation
      // is a new-use operation, not merely a historical-record read.
      const network = this.getNetwork(networkId)
      if (!network) throw new Error(`survey network not found: ${networkId}`)
      const replayIntegrity = this.checkRawSourceIntegrity(network, false)
      const replay = this.replayValidation(network, req, replayIntegrity)
      if (replay) {
        return replay
      }
      if (req.expectedRevision !== 0 && req.expectedRevision !== network.revision) throw new SurveyRevisionConflictError(`network revision conflict: expected ${req.expectedRevision}, actual ${network.revision}`)
      const rawSourceIntegrity = this.checkRawSourceIntegrity(network, true)
      const uniqueFindings = this.evaluateCurrentNetworkFindings(network, rawSourceIntegrity)
      const next = SurveyNetworkV1.parse({ ...network, findings: uniqueFindings, qualityStatus: uniqueFindings.some((item) => item.severity === 'blocking') ? 'blocked' : 'validated', revision: network.revision + 1, updatedAt: this.nowIso() })
      this.saveNetwork(next, network.revision)
      this.rememberValidation(req.idempotencyKey, req, next)
      return next
    }).immediate()
  }

  /**
   * A validation retry returns the *current durable row* only after proving
   * its stored status/findings still equal a fresh evaluation. Generic
   * `survey_idempotency.result_json` remains mutable compatibility state and
   * cannot manufacture a validated response.
   */
  private replayValidation(network: SurveyNetworkV1, request: SurveyNetworkValidationRequest, rawSourceIntegrity: SurveyRawSourceIntegrity): SurveyNetworkV1 | null {
    const raw = this.replay(request.idempotencyKey)
    if (!raw) return null
    const stored = raw as Partial<StoredValidationNetworkIdempotency>
    if (stored.kind !== 'survey-network-validation'
      || typeof stored.requestHash !== 'string'
      || typeof stored.projectId !== 'string'
      || typeof stored.networkId !== 'string'
      || !Number.isInteger(stored.resultingRevision)
      || typeof stored.solverInputHash !== 'string'
      || typeof stored.durableNetworkHash !== 'string'
      || typeof stored.findingsHash !== 'string') {
      throw new Error('survey validation idempotency replay has no bound durable validation evidence')
    }
    if (stored.requestHash !== validationRequestHash(network.id, request.expectedRevision)) {
      throw new Error('survey validation idempotency key was reused with a different validation request')
    }
    if (stored.projectId !== network.projectId || stored.networkId !== network.id) {
      throw new Error('survey validation idempotency key belongs to another network')
    }
    if (stored.resultingRevision !== network.revision
      || stored.solverInputHash !== surveySolverInputHash(network)
      || stored.durableNetworkHash !== sha256CanonicalSurveyValue(network)) {
      throw new Error(`historical validation ${network.id} no longer matches its durable network record`)
    }
    const eligibility = this.sourceEligibility(network, rawSourceIntegrity)
    if (!eligibility.eligible) {
      throw new Error(`历史校核 ${network.id} 的原始资料不再满足可平差门禁：${eligibility.findings.map((item) => item.message).join('；')}`)
    }
    const freshFindings = this.evaluateCurrentNetworkFindings(network, rawSourceIntegrity)
    const freshStatus = freshFindings.some((item) => item.severity === 'blocking') ? 'blocked' : 'validated'
    if (network.qualityStatus !== freshStatus
      || stored.findingsHash !== validationFindingsHash(freshFindings)
      || validationFindingsHash(network.findings) !== validationFindingsHash(freshFindings)) {
      throw new Error(`historical validation ${network.id} no longer matches fresh current checks`)
    }
    return network
  }

  private rememberValidation(key: string, request: SurveyNetworkValidationRequest, network: SurveyNetworkV1): void {
    const stored: StoredValidationNetworkIdempotency = {
      kind: 'survey-network-validation',
      requestHash: validationRequestHash(network.id, request.expectedRevision),
      projectId: network.projectId,
      networkId: network.id,
      resultingRevision: network.revision,
      solverInputHash: surveySolverInputHash(network),
      durableNetworkHash: sha256CanonicalSurveyValue(network),
      findingsHash: validationFindingsHash(network.findings)
    }
    this.db.prepare('INSERT INTO survey_idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(stored), this.nowIso())
  }

  /**
   * The only dispatch point for the current deterministic adjustment kernel.
   * Reusing it when a stored result is admitted for new work makes an output
   * row tamper-evident even if its input/run IDs still look internally valid.
   */
  private calculateAdjustmentResult(
    network: SurveyNetworkV1,
    run: AdjustmentRunV1
  ): AdjustmentResultV1 {
    // Connectivity is retained by validation, but not injected before the
    // solver's own rank diagnosis. That preserves the more specific numerical
    // cause (for example `rank_deficient`) while all raw/source and closure
    // gates are still freshly re-evaluated.
    const currentFindings = this.evaluateCurrentNetworkFindings(network, undefined, { includeConnectivity: false })
    const solverNetwork = SurveyNetworkV1.parse({ ...network, findings: currentFindings })
    const dimensionIssue = adjustmentDimensionIssue(solverNetwork)
    let result: AdjustmentResultV1
    if (currentFindings.some((item) => item.severity === 'blocking')) {
      result = invalidAdjustmentResult(solverNetwork, run, currentFindings, this.nowIso)
    } else if (dimensionIssue) {
      result = invalidAdjustmentResult(solverNetwork, run, [finding(solverNetwork.id, 'dimension_limit', 'blocking', dimensionIssue, '减少输入规模或拆分网络后重试', undefined, this.nowIso)], this.nowIso)
    } else if (solverNetwork.networkType === 'gnss') {
      result = buildGnssResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'coordinate-transform') {
      result = buildCoordinateTransformResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'leveling' || solverNetwork.networkType === 'height-control') {
      result = buildLevelingResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'plane-control') {
      result = buildPlaneControlResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'traverse') {
      result = buildTraverseResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'triangulation') {
      result = buildTriangulationResult(solverNetwork, run, this.nowIso)
    } else if (solverNetwork.networkType === 'cpiii-free-station' || solverNetwork.networkType === 'cpiii-resection') {
      result = buildCpiiiResult(solverNetwork, run, this.nowIso)
    } else {
      result = invalidAdjustmentResult(solverNetwork, run, [finding(solverNetwork.id, 'invalid_observation', 'blocking', `暂不支持网型 ${solverNetwork.networkType} 的确定性平差`, '选择受支持的测量网型或补充适配策略', undefined, this.nowIso)], this.nowIso)
    }
    return retainResidualSourceAnchors(solverNetwork, AdjustmentResultV1.parse({ ...result, algorithmVersion: run.algorithmVersion, strategyId: solverNetwork.networkType }))
  }

  createAdjustment(input: unknown): { run: AdjustmentRunV1; result: AdjustmentResultV1 } {
    const req = AdjustmentRequestV1.parse(input)
    const committed = this.db.transaction(() => {
      const network = this.getNetwork(req.networkId)
      if (!network) throw new Error(`survey network not found: ${req.networkId}`)
      if (req.expectedRevision !== 0 && req.expectedRevision !== network.revision) throw new SurveyRevisionConflictError(`network revision conflict: expected ${req.expectedRevision}, actual ${network.revision}`)

      // The exact frozen network state and executable strategy are part of the
      // request identity.  A matching key cannot replay a result calculated
      // under a different constraint, method, or source/network fingerprint.
      const inputHash = surveySolverInputHash(network)
      const execution = resolveAdjustmentExecution(network, req.method, req.constraint)
      const replay = this.replayAdjustment(req.idempotencyKey, network, inputHash, execution)
      if (replay) return { output: replay, workspace: this.options.getProject?.(network.projectId)?.workspace }

      // Re-evaluate the complete source and calculation gate before every
      // new run. Historical results stay readable, but persisted findings
      // cannot turn a changed raw network into a fresh calculation input.
      const project = this.options.getProject?.(network.projectId)
      const run = AdjustmentRunV1.parse({
        schemaVersion: 1,
        id: `adjustment_${randomUUID()}`,
        projectId: network.projectId,
        networkId: network.id,
        method: execution.method,
        constraint: execution.constraint,
        algorithmVersion: ALGORITHM_VERSION,
        inputHash,
        status: 'running',
        revision: 1,
        idempotencyKey: req.idempotencyKey,
        createdAt: this.nowIso(),
        updatedAt: this.nowIso()
      })

      let output: { run: AdjustmentRunV1; result: AdjustmentResultV1 }
      try {
        const result = this.calculateAdjustmentResult(network, run)
        const completedRun = AdjustmentRunV1.parse({ ...run, status: result.validation === 'invalid' ? 'needs_attention' : 'completed', updatedAt: this.nowIso(), completedAt: this.nowIso() })
        output = { run: completedRun, result }
      } catch (error) {
        const failed = AdjustmentRunV1.parse({ ...run, status: 'failed', updatedAt: this.nowIso(), cancellationReason: error instanceof Error ? error.message : String(error) })
        output = { run: failed, result: invalidAdjustmentResult(network, failed, [finding(network.id, 'invalid_observation', 'blocking', failed.cancellationReason ?? '平差失败', '修正输入后重试')], this.nowIso) }
      }

      // A strict insert is intentional. The IMMEDIATE transaction ensures a
      // winner is wholly durable; a conflicting key cannot be hidden by an
      // INSERT OR IGNORE and leave a second output claiming success.
      this.db.prepare('INSERT INTO survey_adjustments(id, project_id, network_id, data_json, updated_at) VALUES (?, ?, ?, ?, ?)').run(output.run.id, output.run.projectId, output.run.networkId, JSON.stringify(output), output.run.updatedAt)
      if (output.run.status === 'completed' && output.result.validation === 'valid') {
        const admission = this.verifySourceAdmission(network)
        if (!admission.valid || !admission.record) {
          throw new Error(`completed adjustment ${output.run.id} cannot be admitted without immutable source evidence: ${admission.errors.join('；')}`)
        }
        this.insertAdjustmentEvidence(this.createAdjustmentEvidenceRecord(
          output,
          admission.record,
          output.run.completedAt ?? output.run.updatedAt
        ))
      }
      this.rememberAdjustment(req.idempotencyKey, network, inputHash, execution, output)
      return { output, workspace: project?.workspace }
    }).immediate()

    // The sidecar is a recoverable projection of the committed row. Its
    // failure cannot produce a second run because the idempotency envelope is
    // already atomically stored above.
    this.trackPersistence(committed.output, 'adjustments', committed.workspace)
    return committed.output
  }

  private withCurrentSourceAdmission(stored: StoredAdjustment, network = this.getNetwork(stored.run.networkId)): SurveyAdjustmentRead {
    if (!network) return stored
    const rawSourceIntegrity = this.checkRawSourceIntegrity(network, false)
    return {
      ...stored,
      rawSourceIntegrity,
      sourceEligibility: this.sourceEligibility(network, rawSourceIntegrity)
    }
  }

  getAdjustment(id: string): SurveyAdjustmentRead | null {
    const row = this.db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ? OR json_extract(data_json, \'$.result.id\') = ?').get(id, id) as { data_json: string } | undefined
    if (!row) return null
    const stored = this.normalizeStoredAdjustment(JSON.parse(row.data_json))
    return this.withCurrentSourceAdmission(stored)
  }

  /**
   * Resolve a new-use adjustment by its durable row, not just JSON embedded
   * identity. A result ID remains a supported read alias, but it must resolve
   * to exactly one row whose SQL ownership columns agree with the run.
   */
  private getAdjustmentForNewUseScoped(id: string, expectedProjectId?: string): SurveyAdjustmentRead | null {
    const rows = (expectedProjectId === undefined
      ? this.db.prepare('SELECT id, project_id, network_id, data_json FROM survey_adjustments WHERE id = ? OR json_extract(data_json, \'$.result.id\') = ?').all(id, id)
      : this.db.prepare('SELECT id, project_id, network_id, data_json FROM survey_adjustments WHERE project_id = ? AND (id = ? OR json_extract(data_json, \'$.result.id\') = ?)').all(expectedProjectId, id, id)
    ) as Array<{ id: string; project_id: string; network_id: string; data_json: string }>
    if (!rows.length) return null
    if (rows.length !== 1) throw new Error(`adjustment ${id} is ambiguous in durable storage and cannot be used as fresh evidence`)
    const row = rows[0]!
    const stored = this.normalizeStoredAdjustment(JSON.parse(row.data_json))
    if (!stored.result) throw new Error(`adjustment ${id} has no deterministic result`)
    if (row.id !== stored.run.id
      || row.project_id !== stored.run.projectId
      || row.network_id !== stored.run.networkId
      || (expectedProjectId !== undefined && row.project_id !== expectedProjectId)
      || (id !== stored.run.id && id !== stored.result.id)) {
      throw new Error(`adjustment ${id} has inconsistent durable run/result provenance`)
    }
    const network = this.getNetwork(stored.run.networkId)
    if (!network) throw new Error(`survey network not found: ${stored.run.networkId}`)
    // Explain a revoked source admission before reporting any derivative
    // fingerprint difference caused by that source/network mutation. It is
    // both more actionable and prevents callers from mistaking the gate for
    // a benign stale-cache condition.
    const eligibility = this.sourceEligibility(network)
    if (!eligibility.eligible) {
      throw new Error(`adjustment ${id} source is not currently eligible: ${eligibility.findings.map((item) => item.message).join('；')}`)
    }
    const inputHash = surveySolverInputHash(network)
    if (stored.run.projectId !== network.projectId
      || stored.run.networkId !== network.id
      || stored.result.runId !== stored.run.id
      || stored.result.networkId !== network.id
      || stored.run.inputHash !== inputHash
      || stored.result.inputHash !== inputHash
      || ![ALGORITHM_VERSION, LEGACY_ELLIPSE_FREE_ALGORITHM].includes(stored.run.algorithmVersion)
      || stored.result.algorithmVersion !== stored.run.algorithmVersion
      || stored.run.status !== 'completed'
      || stored.result.validation !== 'valid') {
      throw new Error(`adjustment ${id} no longer matches its current deterministic execution`)
    }
    const admission = this.verifySourceAdmission(network)
    if (!admission.valid || !admission.record) {
      throw new Error(`adjustment ${id} source admission evidence is invalid: ${admission.errors.join('；')}`)
    }
    const evidence = this.verifyAdjustmentEvidence(stored, network, admission.record)
    if (!evidence.valid) {
      throw new Error(`adjustment ${id} immutable result evidence is invalid: ${evidence.errors.join('；')}`)
    }
    let rebuilt: AdjustmentResultV1
    try {
      rebuilt = this.calculateAdjustmentResult(network, stored.run)
    } catch (error) {
      throw new Error(`adjustment ${id} cannot be deterministically recomputed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (rebuilt.validation !== 'valid'
      || rebuilt.inputHash !== stored.result.inputHash
      || adjustmentCalculationHash(rebuilt) !== adjustmentCalculationHash(stored.result)) {
      throw new Error(`adjustment ${id} no longer matches a fresh deterministic calculation`)
    }
    return this.withCurrentSourceAdmission(stored, network)
  }

  /**
   * Historical adjustments remain inspectable through getAdjustment(). This
   * stricter accessor is for a *new* deformation/report/delivery operation:
   * it rebinds the stored run/result to the current frozen network payload
   * and source admission before exposing it as computational evidence.
   */
  getAdjustmentForNewUse(id: string): SurveyAdjustmentRead | null {
    return this.getAdjustmentForNewUseScoped(id)
  }

  /** Project-scoped strict lookup for delivery providers; never probe another project's evidence. */
  getAdjustmentForProjectNewUse(projectId: string, id: string): SurveyAdjustmentRead | null {
    return this.getAdjustmentForNewUseScoped(id, projectId)
  }

  /** Recomputable diagnostic supplement. Never mutates historical results,
   * their hashes, or the existing outlier/quality classification. */
  private freeLevelingContext(projectId: string, networkId: string) {
    const row = this.db.prepare('SELECT project_id, revision, data_json FROM survey_networks WHERE id = ? AND project_id = ?').get(networkId, projectId) as { project_id: string; revision: number; data_json: string } | undefined
    if (!row) return null
    const network = SurveyNetworkV1.parse(JSON.parse(row.data_json))
    if (network.id !== networkId || network.projectId !== projectId || network.revision !== row.revision) throw new SurveyFreeLevelingServiceError('stale')
    if (!this.sourceEligibility(network).eligible) throw new SurveyFreeLevelingServiceError('source-ineligible')
    const admission = this.verifySourceAdmission(network)
    if (!admission.valid || !admission.record || !network.sourceFile) throw new SurveyFreeLevelingServiceError('source-ineligible')
    return { network, sourceSha256: network.sourceFile.sha256, sourceAdmissionHash: admission.record.thisHash, inputHash: surveySolverInputHash(network) }
  }

  private calculateFreeLeveling(network: SurveyNetworkV1) {
    if (network.networkType !== 'leveling' && network.networkType !== 'height-control') throw new SurveyFreeLevelingServiceError('unsupported-network')
    if (network.knownPoints.length + network.unknownPoints.length > 64 || network.observations.length > 256) throw new SurveyFreeLevelingServiceError('dimension-limit')
    // sourceEligibility already verifies sourceRecordId uniqueness, existence
    // and raw byte anchors; no observation is filtered by this trial adapter.
    if (network.observations.some(o => o.type !== 'height-difference' || !o.from || !o.to || !o.sourceRecordId || o.covariance !== undefined)) throw new SurveyFreeLevelingServiceError('unsupported-observations')
    const sigmaCount = network.observations.filter(o => o.sigma !== undefined).length
    if (sigmaCount !== 0 && sigmaCount !== network.observations.length) throw new SurveyFreeLevelingServiceError('mixed-weights')
    const routeCount = network.observations.filter(o => o.routeLength !== undefined).length
    if (sigmaCount === 0 && routeCount !== 0 && routeCount !== network.observations.length) throw new SurveyFreeLevelingServiceError('mixed-weights')
    const weightBasis = sigmaCount ? 'inverse-declared-sigma-squared' as const : 'inverse-route-length-with-unit-default' as const
    const originalPointRoles = (['knownPoints', 'unknownPoints'] as const).flatMap(collection => network[collection].map(point => ({
      id: point.id, known: point.known, collection, originalPoint: point,
      referenceHeightBasis: point.height === undefined ? 'zero-initial-approximation' as const : 'declared-height' as const
    })))
    const defaultWeightObservationIds = network.observations.filter(o => o.sigma === undefined && o.routeLength === undefined).map(o => o.id)
    const output = solveFreeLevelingTrial({
      model: 'independent-linear-height-differences', unit: 'm', constraint: 'sum-height-corrections-zero',
      points: originalPointRoles.map(p => ({ id: p.id, referenceHeight: p.originalPoint.height ?? 0 })),
      observations: network.observations.map(o => ({
        id: o.id, from: o.from!, to: o.to!, heightDifference: normalizeObservationValue(o),
        weight: o.sigma === undefined ? 1 / (o.routeLength ?? 1) : 1 / normalizeLengthUncertainty(o.sigma, o.sigmaUnit ?? o.unit) ** 2,
        weightSource: o.sigma !== undefined ? 'inverse-declared-sigma-squared' : o.routeLength !== undefined ? 'inverse-declared-route-length' : 'explicit-unit-weight-fallback',
        sourceAnchor: o.sourceRecordId!
      }))
    })
    return { weightBasis, originalPointRoles, defaultWeightObservationIds, output }
  }

  createFreeLevelingTrial(projectId: string, networkId: string, input: unknown): SurveyFreeLevelingTrialV1 | null {
    const request = SurveyFreeLevelingTrialRequestV1.parse(input)
    return this.db.transaction(() => {
      const context = this.freeLevelingContext(projectId, networkId)
      if (!context) return null
      const { network } = context
      if (request.expectedRevision !== network.revision) throw new SurveyFreeLevelingServiceError('stale')
      const requestHash = sha256CanonicalSurveyValue({ projectId, networkId, inputHash: context.inputHash, algorithmVersion: FREE_LEVELING_VERSION, ...request })
      const existing = this.db.prepare('SELECT id, request_hash FROM survey_free_leveling_trials WHERE project_id = ? AND network_id = ? AND idempotency_key = ?').get(projectId, networkId, request.idempotencyKey) as { id: string; request_hash: string } | undefined
      if (existing) {
        if (existing.request_hash !== requestHash) throw new SurveyFreeLevelingServiceError('idempotency-conflict')
        return this.getFreeLevelingTrial(projectId, networkId, existing.id)
      }
      const calculated = this.calculateFreeLeveling(network)
      const payload = {
        schemaVersion: 1 as const, id: `free_leveling_trial_${randomUUID()}`, projectId, networkId,
        networkRevision: network.revision, inputHash: context.inputHash, sourceSha256: context.sourceSha256, sourceAdmissionHash: context.sourceAdmissionHash,
        algorithmVersion: FREE_LEVELING_VERSION, constraint: request.constraint, acknowledgeDatumRelease: request.acknowledgeDatumRelease, weightPolicy: request.weightPolicy,
        ...calculated, pointCount: calculated.output.points.length, observationCount: calculated.output.observations.length, degreesOfFreedom: calculated.output.degreesOfFreedom,
        createdAt: this.nowIso(), requestHash, outputHash: sha256CanonicalSurveyValue(calculated)
      }
      const record = SurveyFreeLevelingTrialV1.parse({ ...payload, recordHash: sha256CanonicalSurveyValue(payload) })
      this.db.prepare('INSERT INTO survey_free_leveling_trials(id, project_id, network_id, idempotency_key, request_hash, record_hash, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, projectId, networkId, request.idempotencyKey, requestHash, record.recordHash, JSON.stringify(record), record.createdAt)
      return record
    })()
  }

  getFreeLevelingTrial(projectId: string, networkId: string, trialId: string): SurveyFreeLevelingTrialV1 | null {
    const row = this.db.prepare('SELECT * FROM survey_free_leveling_trials WHERE id = ? AND project_id = ? AND network_id = ?').get(trialId, projectId, networkId) as { id: string; project_id: string; network_id: string; idempotency_key: string; request_hash: string; record_hash: string; data_json: string; created_at: string } | undefined
    if (!row) return null
    const context = this.freeLevelingContext(projectId, networkId)
    if (!context) throw new Error('free trial network unavailable')
    const record = SurveyFreeLevelingTrialV1.parse(JSON.parse(row.data_json))
    const { recordHash, ...payload } = record
    if (record.id !== row.id || record.projectId !== projectId || record.networkId !== networkId || record.createdAt !== row.created_at || recordHash !== row.record_hash
      || recordHash !== sha256CanonicalSurveyValue(payload) || record.requestHash !== row.request_hash
      || record.networkRevision !== context.network.revision || record.inputHash !== context.inputHash || record.sourceSha256 !== context.sourceSha256 || record.sourceAdmissionHash !== context.sourceAdmissionHash) throw new Error('free trial evidence stale or altered')
    const requestHash = sha256CanonicalSurveyValue({ projectId, networkId, inputHash: context.inputHash, algorithmVersion: FREE_LEVELING_VERSION,
      expectedRevision: record.networkRevision, idempotencyKey: row.idempotency_key, constraint: record.constraint, acknowledgeDatumRelease: record.acknowledgeDatumRelease, weightPolicy: record.weightPolicy })
    const calculated = this.calculateFreeLeveling(context.network)
    if (requestHash !== record.requestHash || record.outputHash !== sha256CanonicalSurveyValue(calculated)
      || record.outputHash !== sha256CanonicalSurveyValue({ weightBasis: record.weightBasis, originalPointRoles: record.originalPointRoles, defaultWeightObservationIds: record.defaultWeightObservationIds, output: record.output })
      || record.pointCount !== record.output.points.length || record.observationCount !== record.output.observations.length || record.degreesOfFreedom !== record.output.degreesOfFreedom) throw new Error('free trial replay mismatch')
    return record
  }

  listFreeLevelingTrials(projectId: string, networkId: string, limit = 20, offset = 0): SurveyFreeLevelingTrialListV1 | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error('invalid free trial pagination')
    if (!this.freeLevelingContext(projectId, networkId)) return null
    const rows = this.db.prepare('SELECT id FROM survey_free_leveling_trials WHERE project_id = ? AND network_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(projectId, networkId, limit + 1, offset) as { id: string }[]
    return { trials: rows.slice(0, limit).map(row => {
      const record = this.getFreeLevelingTrial(projectId, networkId, row.id)
      if (!record) throw new Error('free trial disappeared')
      const { output: _output, originalPointRoles: _roles, ...summary } = record
      return SurveyFreeLevelingTrialSummaryV1.parse(summary)
    }), nextOffset: rows.length > limit ? offset + limit : null }
  }

  getAdjustmentStatisticalDiagnostics(projectId: string, id: string): SurveyStatisticalDiagnosticsV1 | null {
    const stored = this.getAdjustmentForProjectNewUse(projectId, id)
    if (!stored?.result) return null
    const network = this.getNetwork(stored.run.networkId)
    if (!network?.sourceFile) throw new Error('statistical diagnostic source evidence is unavailable')
    const binding = {
      schemaVersion: 1, diagnosticsVersion: 'leveling-deleted-t-1',
      projectId, networkId: network.id, runId: stored.run.id, resultId: stored.result.id,
      inputHash: stored.run.inputHash, algorithmVersion: stored.run.algorithmVersion,
      sourceSha256: network.sourceFile.sha256, calculationHash: adjustmentCalculationHash(stored.result),
      decision: 'not-evaluated'
    } as const
    const unavailable = (reason: Extract<SurveyStatisticalDiagnosticsV1, { status: 'unavailable' }>['reason'], detailCode?: string) =>
      SurveyStatisticalDiagnosticsV1.parse({ ...binding, status: 'unavailable', reason, ...(detailCode ? { detailCode } : {}) })
    if (network.networkType !== 'leveling' && network.networkType !== 'height-control') return unavailable('unsupported-network-type')
    const { rows } = levelingEquations(network)
    if (rows.length > 256) return unavailable('dimension-limit')
    if (rows.some(row => row.observation.covariance !== undefined)) return unavailable('correlated-observations')
    const declaredSigmas = rows.filter(row => row.observation.sigma !== undefined).length
    if (declaredSigmas !== 0 && declaredSigmas !== rows.length) return unavailable('inconsistent-weight-basis')
    const solved = weightedLeastSquares(rows)
    if (!solved) return unavailable('unresolved-residual-model')
    if (solved.dof <= 1) return unavailable('insufficient-redundancy')
    const design = rows.map(row => row.coefficients)
    const propagated = surveyMatrix.multiply(surveyMatrix.multiply(design, solved.covariance), surveyMatrix.transpose(design))
    const cofactor = propagated.map((row, i) => row.map((value, j) => (i === j ? 1 / rows[i]!.weight : 0) - value))
    try {
      const diagnostic = diagnoseDeletedResiduals({
        model: 'linear-independent-observations', residuals: solved.residuals,
        observationWeights: rows.map(row => row.weight), residualCofactor: cofactor,
        weightedResidualSum: solved.residuals.reduce((sum, value, i) => sum + value * rows[i]!.weight * value, 0),
        degreesOfFreedom: solved.dof
      })
      return SurveyStatisticalDiagnosticsV1.parse({
        ...binding, status: 'available', statistic: diagnostic.statistic, model: diagnostic.model,
        varianceBasis: 'deleted-observation-posterior',
        weightBasis: declaredSigmas ? 'inverse-declared-sigma-squared' : 'inverse-route-length-with-unit-default',
        assumptions: ['fixed-linear-model', 'independent-gaussian-errors', 'weights-proportional-to-inverse-variance', 'fixed-known-datum'],
        assumptionsVerified: false, residualUnit: 'm', statisticUnit: 'dimensionless',
        fullModelDegreesOfFreedom: diagnostic.fullModelDegreesOfFreedom, degreesOfFreedom: diagnostic.degreesOfFreedom,
        observations: diagnostic.observations.map((observation, i) => ({
          observationId: rows[i]!.observation.id, sourceRow: rows[i]!.observation.sourceRow,
          sourceRecordId: rows[i]!.observation.sourceRecordId,
          residual: observation.residual, observationWeight: rows[i]!.weight,
          residualCofactor: observation.residualCofactor, redundancy: observation.redundancy,
          leverage: observation.leverage, deletedWeightedResidualSum: observation.deletedWeightedResidualSum,
          deletedVarianceFactor: observation.deletedVarianceFactor,
          externallyStudentizedResidual: observation.externallyStudentizedResidual
        }))
      })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (!code.startsWith('statistical_diagnostics_')) throw error
      return unavailable(code.includes('deleted_variance') || code.includes('invalid_weighted_residual_sum')
        ? 'zero-or-unresolved-deleted-variance' : 'unresolved-residual-model', code)
    }
  }
  listAdjustments(projectId?: string): SurveyAdjustmentSummary[] {
    const rows = projectId
      ? this.db.prepare('SELECT data_json FROM survey_adjustments WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.db.prepare('SELECT data_json FROM survey_adjustments ORDER BY updated_at DESC').all()
    return (rows as Array<{ data_json: string }>).map((row) => {
      const stored = this.normalizeStoredAdjustment(JSON.parse(row.data_json))
      const network = this.getNetwork(stored.run.networkId)
      const adjustment = this.withCurrentSourceAdmission(stored, network)
      return {
        ...adjustment,
        ...(network?.observationEpoch ? { observationEpoch: network.observationEpoch } : {}),
        ...(network ? { networkType: network.networkType, coordinateSystem: network.coordinateSystem, verticalDatum: network.verticalDatum } : {})
      }
    })
  }
  cancelAdjustment(id: string, input: unknown): AdjustmentRunV1 { const req = AdjustmentMutationRequestV1.parse(input); const stored = this.getAdjustment(id); if (!stored) throw new Error(`adjustment not found: ${id}`); if (req.expectedRevision !== 0 && req.expectedRevision !== stored.run.revision) throw new SurveyRevisionConflictError('adjustment revision conflict'); if (stored.run.status === 'completed') return stored.run; const next = AdjustmentRunV1.parse({ ...stored.run, status: 'cancelled', revision: stored.run.revision + 1, updatedAt: this.nowIso(), cancellationReason: req.reason ?? 'cancelled by user' }); this.saveAdjustment({ ...stored, run: next }); return next }
  resumeAdjustment(id: string, input: unknown): StoredAdjustment { const req = AdjustmentMutationRequestV1.parse(input); const stored = this.getAdjustment(id); if (!stored) throw new Error(`adjustment not found: ${id}`); if (req.expectedRevision !== 0 && req.expectedRevision !== stored.run.revision) throw new SurveyRevisionConflictError('adjustment revision conflict'); if (!['cancelled', 'failed', 'needs_attention'].includes(stored.run.status)) return stored; const network = this.getNetwork(stored.run.networkId); if (!network) throw new Error(`survey network not found: ${stored.run.networkId}`); return this.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `${stored.run.id}-resume-${stored.run.resumeCount + 1}`, method: stored.run.method, constraint: stored.run.constraint }) }
  previewAdjustment(id: string): SurveyAdjustmentRead | null { return this.getAdjustment(id) }

  private currentDeformationEpochs(projectId: string, adjustmentIds: readonly string[]): CurrentDeformationEpoch[] {
    const stored = adjustmentIds.map((id) => {
      const adjustment = this.getAdjustmentForProjectNewUse(projectId, id)
      if (!adjustment?.result) throw new Error(`adjustment not found: ${id}`)
      if (adjustment.run.id !== id) throw new Error(`deformation comparison requires an adjustment run id, received result id ${id}`)
      if (adjustment.run.projectId !== projectId) throw new Error(`adjustment ${id} does not belong to project ${projectId}`)
      const network = this.getNetwork(adjustment.run.networkId)
      if (!network) throw new Error(`survey network not found: ${adjustment.run.networkId}`)
      if (!network.observationEpoch || !Number.isFinite(Date.parse(network.observationEpoch))) throw new Error(`adjustment ${id} has no valid observation epoch`)
      return { adjustment: { run: adjustment.run, result: adjustment.result }, network }
    })
    const reference = stored[0]
    if (!reference) throw new Error('deformation comparison requires at least two adjustments')
    if (reference.network.coordinateSystem === '待确认' || reference.network.verticalDatum === '待确认') {
      throw new Error('deformation comparison requires confirmed coordinate system and vertical datum metadata')
    }
    for (const { network, adjustment } of stored.slice(1)) {
      if (network.networkType !== reference.network.networkType
        || adjustment.result.strategyId !== reference.adjustment.result.strategyId
        || adjustment.result.transformType !== reference.adjustment.result.transformType) {
        throw new Error('deformation comparison requires the same deterministic survey strategy for every epoch')
      }
      if (network.coordinateSystem !== reference.network.coordinateSystem
        || network.projection !== reference.network.projection
        || network.ellipsoid !== reference.network.ellipsoid
        || network.verticalDatum !== reference.network.verticalDatum) {
        throw new Error('deformation comparison requires identical coordinate system, projection, ellipsoid and vertical datum metadata')
      }
    }
    return stored
  }

  private buildDeformationResult(
    projectId: string,
    stored: readonly CurrentDeformationEpoch[],
    pairs: readonly DeformationPairDefinitionV1[],
    stabilityRateMPerDay: number,
    identity: { id: string; createdAt: string } = { id: `deformation_${randomUUID()}`, createdAt: this.nowIso() }
  ): DeformationComparisonV1 {
    const ordered = [...stored].sort((left, right) => Date.parse(left.network.observationEpoch!) - Date.parse(right.network.observationEpoch!))
    const epochs = ordered.map(({ adjustment, network }) => ({ adjustmentId: adjustment.run.id, observationEpoch: network.observationEpoch!, result: adjustment.result }))
    const metrics = compareAdjustedEpochs(epochs, [...pairs], stabilityRateMPerDay)
    const epochEvidence = ordered.map(({ adjustment, network }) => ({
      adjustmentId: adjustment.run.id,
      resultId: adjustment.result.id,
      networkId: network.id,
      observationEpoch: network.observationEpoch!,
      inputHash: adjustment.result.inputHash,
      resultHash: createHash('sha256').update(JSON.stringify(adjustment.result)).digest('hex')
    }))
    const inputHash = createHash('sha256').update(JSON.stringify({ epochs: epochEvidence, pairs, stabilityRateMPerDay })).digest('hex')
    return DeformationComparisonV1.parse({
      schemaVersion: 1,
      id: identity.id,
      projectId,
      referenceAdjustmentId: epochEvidence[0]!.adjustmentId,
      currentAdjustmentId: epochEvidence.at(-1)!.adjustmentId,
      adjustmentIds: epochEvidence.map((epoch) => epoch.adjustmentId),
      referenceEpoch: epochEvidence[0]!.observationEpoch,
      currentEpoch: epochEvidence.at(-1)!.observationEpoch,
      durationDays: metrics.durationDays,
      epochs: epochEvidence,
      points: metrics.points,
      pairs: metrics.pairs,
      stabilityRateMPerDay,
      inputHash,
      algorithmVersion: DEFORMATION_ALGORITHM_VERSION,
      createdAt: identity.createdAt
    })
  }

  /** Verify a persisted deformation payload against freshly re-bound epoch inputs. */
  private assertDeformationCurrent(result: DeformationComparisonV1): void {
    if (!sameUniqueIds(result.adjustmentIds, result.epochs.map((epoch) => epoch.adjustmentId))) {
      throw new Error(`historical deformation ${result.id} has inconsistent epoch evidence`)
    }
    const current = this.currentDeformationEpochs(result.projectId, result.adjustmentIds)
    const candidate = this.buildDeformationResult(
      result.projectId,
      current,
      deformationPairDefinitions(result),
      result.stabilityRateMPerDay,
      { id: result.id, createdAt: result.createdAt }
    )
    // The reconstructed request fingerprint binds inputs that may not change
    // the final metrics in an obvious way (for example a stability threshold
    // that only affects a trend classification). Do not let a self-consistent
    // edit of both the stored metrics and threshold bypass new-use admission.
    // An older record that lacks enough request evidence simply remains an
    // auditable historical record instead of becoming a fresh delivery input.
    if (candidate.inputHash !== result.inputHash
      || deformationCalculationHash(candidate) !== deformationCalculationHash(result)) {
      throw new Error(`historical deformation ${result.id} no longer matches a fresh deterministic comparison`)
    }
  }

  compareDeformation(input: unknown): DeformationComparisonV1 {
    const req = DeformationComparisonRequestV1.parse(input)
    const adjustmentIds = [...new Set(req.adjustmentIds)]
    if (adjustmentIds.length !== req.adjustmentIds.length) throw new Error('deformation comparison contains duplicate adjustment ids')
    // Current adjustment/source evidence is collected before an idempotency
    // replay or cached row is considered. Historical values remain readable,
    // but cannot be promoted into a new deformation calculation.
    const stored = this.currentDeformationEpochs(req.projectId, adjustmentIds)
    const currentByEpoch = [...stored].sort((left, right) => Date.parse(left.network.observationEpoch!) - Date.parse(right.network.observationEpoch!)).at(-1)!
    if (req.expectedRevision !== 0 && req.expectedRevision !== currentByEpoch.adjustment.run.revision) {
      throw new SurveyRevisionConflictError(`adjustment revision conflict: expected ${req.expectedRevision}, actual ${currentByEpoch.adjustment.run.revision}`)
    }
    const candidate = this.buildDeformationResult(req.projectId, stored, req.pairs, req.stabilityRateMPerDay)
    const replay = this.replayDeformation(req, candidate)
    if (replay) return replay

    const existing = this.db.prepare('SELECT project_id, input_hash, data_json FROM survey_deformations WHERE project_id = ? AND input_hash = ?').get(req.projectId, candidate.inputHash) as { project_id: string; input_hash: string; data_json: string } | undefined
    if (existing) {
      const result = DeformationComparisonV1.parse(JSON.parse(existing.data_json))
      if (existing.project_id !== result.projectId || existing.input_hash !== result.inputHash || result.inputHash !== candidate.inputHash) {
        throw new Error(`historical deformation ${result.id} has inconsistent durable input provenance`)
      }
      if (deformationCalculationHash(result) !== deformationCalculationHash(candidate)) {
        throw new Error(`historical deformation ${result.id} no longer matches a fresh deterministic comparison`)
      }
      this.rememberDeformation(req, result)
      return result
    }
    this.db.prepare('INSERT INTO survey_deformations(id, project_id, reference_adjustment_id, current_adjustment_id, input_hash, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(candidate.id, candidate.projectId, candidate.referenceAdjustmentId, candidate.currentAdjustmentId, candidate.inputHash, JSON.stringify(candidate), candidate.createdAt)
    this.rememberDeformation(req, candidate)
    this.trackPersistence(candidate, 'deformations', this.options.getProject?.(req.projectId)?.workspace)
    return candidate
  }

  /**
   * Return an idempotent deformation result only when it is bound to this
   * request and each historical epoch is still a currently admissible source.
   * Old unbound generic idempotency rows remain readable through the result
   * table, but are deliberately not re-issued as new computational output.
   */
  private replayDeformation(request: DeformationComparisonRequestV1, candidate: DeformationComparisonV1): DeformationComparisonV1 | null {
    const raw = this.replay(request.idempotencyKey)
    if (!raw) return null
    const stored = raw as Partial<StoredDeformationIdempotency>
    if (stored.kind !== 'deformation-comparison' || typeof stored.requestHash !== 'string' || !stored.result) {
      throw new Error('deformation idempotency replay has no bound comparison request')
    }
    if (stored.requestHash !== deformationComparisonRequestHash(request)) {
      throw new Error('deformation idempotency key was reused with a different comparison request')
    }
    const replay = DeformationComparisonV1.parse(stored.result)
    if (replay.projectId !== request.projectId) throw new Error('deformation idempotency key belongs to another project')
    if (!sameUniqueIds(replay.adjustmentIds, request.adjustmentIds)) {
      throw new Error('deformation idempotency key belongs to another adjustment set')
    }
    if (!sameUniqueIds(replay.adjustmentIds, replay.epochs.map((epoch) => epoch.adjustmentId))) {
      throw new Error('historical deformation replay has inconsistent epoch evidence')
    }
    if (replay.inputHash !== candidate.inputHash || deformationCalculationHash(replay) !== deformationCalculationHash(candidate)) {
      throw new Error('historical deformation replay no longer matches the current deterministic comparison')
    }
    const durable = this.getDeformationForNewUse(replay.id)
    if (!durable || createHash('sha256').update(JSON.stringify(durable)).digest('hex') !== createHash('sha256').update(JSON.stringify(replay)).digest('hex')) {
      throw new Error(`historical deformation replay is unavailable or differs from its durable result: ${replay.id}`)
    }
    return replay
  }

  private rememberDeformation(request: DeformationComparisonRequestV1, result: DeformationComparisonV1): void {
    const stored: StoredDeformationIdempotency = {
      kind: 'deformation-comparison',
      requestHash: deformationComparisonRequestHash(request),
      result
    }
    this.db.prepare('INSERT INTO survey_idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(request.idempotencyKey, JSON.stringify(stored), this.nowIso())
  }

  getDeformation(id: string): DeformationComparisonV1 | null {
    const row = this.db.prepare('SELECT data_json FROM survey_deformations WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? DeformationComparisonV1.parse(JSON.parse(row.data_json)) : null
  }

  /**
   * Return an existing deformation only after recalculating its numerical
   * payload from current adjustment evidence. getDeformation() intentionally
   * remains an audit/read API for historical records that can no longer be
   * admitted into a new report or delivery.
   */
  private getDeformationForNewUseScoped(id: string, expectedProjectId?: string): DeformationComparisonV1 | null {
    const row = (expectedProjectId === undefined
      ? this.db.prepare('SELECT id, project_id, reference_adjustment_id, current_adjustment_id, input_hash, data_json FROM survey_deformations WHERE id = ?').get(id)
      : this.db.prepare('SELECT id, project_id, reference_adjustment_id, current_adjustment_id, input_hash, data_json FROM survey_deformations WHERE id = ? AND project_id = ?').get(id, expectedProjectId)
    ) as {
      id: string
      project_id: string
      reference_adjustment_id: string
      current_adjustment_id: string
      input_hash: string
      data_json: string
    } | undefined
    if (!row) return null
    const result = DeformationComparisonV1.parse(JSON.parse(row.data_json))
    if (row.id !== id
      || result.id !== id
      || row.project_id !== result.projectId
      || (expectedProjectId !== undefined && row.project_id !== expectedProjectId)
      || row.reference_adjustment_id !== result.referenceAdjustmentId
      || row.current_adjustment_id !== result.currentAdjustmentId
      || row.input_hash !== result.inputHash) {
      throw new Error(`historical deformation ${id} has inconsistent durable input provenance`)
    }
    this.assertDeformationCurrent(result)
    return result
  }

  getDeformationForNewUse(id: string): DeformationComparisonV1 | null {
    return this.getDeformationForNewUseScoped(id)
  }

  /** Project-scoped strict lookup for delivery providers; avoids cross-project probing. */
  getDeformationForProjectNewUse(projectId: string, id: string): DeformationComparisonV1 | null {
    return this.getDeformationForNewUseScoped(id, projectId)
  }

  listDeformations(projectId?: string): DeformationComparisonV1[] {
    const rows = projectId
      ? this.db.prepare('SELECT data_json FROM survey_deformations WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT data_json FROM survey_deformations ORDER BY created_at DESC').all()
    return (rows as Array<{ data_json: string }>).map((row) => DeformationComparisonV1.parse(JSON.parse(row.data_json)))
  }

  private saveNetwork(network: SurveyNetworkV1, expectedRevision?: number): void {
    const result = expectedRevision === undefined
      ? this.db.prepare('UPDATE survey_networks SET revision = ?, data_json = ?, updated_at = ? WHERE id = ?').run(network.revision, JSON.stringify(network), network.updatedAt, network.id)
      : this.db.prepare('UPDATE survey_networks SET revision = ?, data_json = ?, updated_at = ? WHERE id = ? AND revision = ?').run(network.revision, JSON.stringify(network), network.updatedAt, network.id, expectedRevision)
    if (result.changes !== 1) throw new SurveyRevisionConflictError(`network revision conflict while saving ${network.id}`)
  }
  private normalizeStoredAdjustment(value: unknown): StoredAdjustment {
    const raw = value as { run?: unknown; result?: unknown }
    const run = AdjustmentRunV1.parse(raw.run)
    if (!raw.result) return { run }
    const network = this.getNetwork(run.networkId)
    const observationUnits = new Map(network?.observations.map((observation) => [observation.id, normalizedResidualUnit(observation)]) ?? [])
    const resultInput = raw.result as Record<string, unknown>
    const closure = resultInput.closure && typeof resultInput.closure === 'object' ? resultInput.closure as Record<string, number> : {}
    const observations = Array.isArray(resultInput.observations)
      ? resultInput.observations.map((item) => {
          const observation = item as Record<string, unknown>
          return observation.unit ? observation : { ...observation, unit: observationUnits.get(String(observation.observationId)) }
        })
      : []
    return { run, result: AdjustmentResultV1.parse({ ...resultInput, observations, closureUnits: resultInput.closureUnits ?? inferredClosureUnits(closure) }) }
  }
  private saveAdjustment(value: StoredAdjustment): void {
    // Admission state is derived from the current source at read time. Never
    // persist it back into an immutable historical adjustment through a later
    // lifecycle operation such as cancellation.
    const stored: StoredAdjustment = value.result === undefined ? { run: value.run } : { run: value.run, result: value.result }
    this.db.prepare('UPDATE survey_adjustments SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(stored), stored.run.updatedAt, stored.run.id)
  }
  private replay(key: string): unknown | null { const row = this.db.prepare('SELECT result_json FROM survey_idempotency WHERE key = ?').get(key) as { result_json: string } | undefined; return row ? JSON.parse(row.result_json) : null }
  /**
   * Reissue an adjustment only when the durable run, immutable idempotency
   * envelope, current network fingerprint, and actually executed strategy all
   * agree. Historical bare rows are deliberately readable from
   * survey_adjustments but cannot be upgraded into fresh calculation output.
   */
  private replayAdjustment(
    idempotencyKey: string,
    network: SurveyNetworkV1,
    inputHash: string,
    execution: AdjustmentExecution
  ): { run: AdjustmentRunV1; result: AdjustmentResultV1 } | null {
    const raw = this.replay(idempotencyKey)
    if (!raw) return null
    const stored = raw as Partial<StoredAdjustmentIdempotency>
    if (stored.kind !== 'survey-adjustment'
      || typeof stored.requestHash !== 'string'
      || typeof stored.projectId !== 'string'
      || typeof stored.networkId !== 'string'
      || typeof stored.inputHash !== 'string'
      || typeof stored.method !== 'string'
      || typeof stored.constraint !== 'string'
      || !stored.result) {
      throw new Error('adjustment idempotency replay has no bound adjustment request')
    }
    if (stored.projectId !== network.projectId || stored.networkId !== network.id) {
      throw new Error('adjustment idempotency key belongs to another network')
    }
    // Source admission is deliberately checked before request-fingerprint
    // comparison. A source mutation that revokes admission must be reported
    // as such, rather than disguising the safety gate as a generic retry
    // mismatch; eligible semantic changes still fall through to the strict
    // request-hash check below.
    const eligibility = this.sourceEligibility(network)
    if (!eligibility.eligible) {
      const historicalRunId = (() => {
        try { return this.normalizeStoredAdjustment(stored.result).run.id } catch { return network.id }
      })()
      throw new Error(`历史平差 ${historicalRunId} 的原始资料不再满足可平差门禁：${eligibility.findings.map((item) => item.message).join('；')}`)
    }
    if (stored.requestHash !== adjustmentRequestHash(network, inputHash, execution)) {
      throw new Error('adjustment idempotency key was reused with a different adjustment request')
    }
    if (stored.inputHash !== inputHash || stored.method !== execution.method || stored.constraint !== execution.constraint) {
      throw new Error('adjustment idempotency evidence does not match the requested deterministic execution')
    }

    const restored = this.normalizeStoredAdjustment(stored.result)
    if (!restored.result) throw new Error('stored adjustment replay is missing its deterministic result')
    if (restored.run.projectId !== network.projectId
      || restored.run.networkId !== network.id
      || restored.run.inputHash !== inputHash
      || restored.result.networkId !== network.id
      || restored.result.inputHash !== inputHash
      || restored.result.runId !== restored.run.id
      || restored.run.method !== execution.method
      || restored.run.constraint !== execution.constraint) {
      throw new Error('adjustment idempotency evidence has inconsistent run/result provenance')
    }

    // The idempotency envelope is mutable compatibility state, not numerical
    // authority. Re-issue only the same strict evidence path used by a new
    // deformation or delivery so a self-consistent envelope/row rewrite
    // cannot bypass immutable output evidence or fresh recomputation.
    const durableRead = this.getAdjustmentForProjectNewUse(network.projectId, restored.run.id)
    if (!durableRead?.result) throw new Error(`historical adjustment replay is unavailable: ${restored.run.id}`)
    const durable: StoredAdjustment = { run: durableRead.run, result: durableRead.result }
    if (adjustmentOutputHash(durable) !== adjustmentOutputHash(restored)) {
      throw new Error(`historical adjustment replay no longer matches its durable result: ${restored.run.id}`)
    }

    return { run: restored.run, result: restored.result }
  }
  private rememberAdjustment(
    key: string,
    network: SurveyNetworkV1,
    inputHash: string,
    execution: AdjustmentExecution,
    result: StoredAdjustment
  ): void {
    const stored: StoredAdjustmentIdempotency = {
      kind: 'survey-adjustment',
      requestHash: adjustmentRequestHash(network, inputHash, execution),
      projectId: network.projectId,
      networkId: network.id,
      inputHash,
      method: execution.method,
      constraint: execution.constraint,
      result
    }
    this.db.prepare('INSERT INTO survey_idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(stored), this.nowIso())
  }
  private replayImportNetwork(request: SurveyNetworkImportRequest, prepared: PreparedImportRequest): SurveyNetworkV1 | null {
    const raw = this.replay(request.idempotencyKey)
    if (!raw) return null
    const stored = raw as Partial<StoredImportNetworkIdempotency>
    if (stored.kind !== 'survey-network-import' || typeof stored.requestHash !== 'string' || typeof stored.projectId !== 'string' || !stored.source || !stored.network) {
      throw new Error('survey import idempotency replay has no bound import request')
    }
    if (stored.requestHash !== prepared.requestHash) {
      throw new Error('survey import idempotency key was reused with a different import request')
    }
    if (stored.projectId !== request.projectId) {
      throw new Error('survey import idempotency key belongs to another project')
    }
    const envelopeNetwork = SurveyNetworkV1.parse(stored.network)
    if (envelopeNetwork.projectId !== stored.projectId) {
      throw new Error('survey import idempotency evidence has inconsistent project ownership')
    }
    const provenance = stored.source
    if (provenance.mode !== prepared.source.mode
      || provenance.name !== prepared.source.name
      || provenance.originalSha256 !== prepared.source.originalSha256
      || provenance.originalByteLength !== prepared.source.originalByteLength) {
      throw new Error('survey import idempotency evidence does not match the requested source provenance')
    }
    // The idempotency envelope proves request identity only. Never return its
    // embedded network projection: it can be stale or independently altered.
    // The authoritative row must exist and match the complete projection.
    const durable = this.getNetwork(envelopeNetwork.id)
    if (!durable || durable.projectId !== envelopeNetwork.projectId || durable.projectId !== request.projectId) {
      throw new Error(`historical imported network replay is unavailable: ${envelopeNetwork.id}`)
    }
    const durableHash = sha256CanonicalSurveyValue(durable)
    if (typeof stored.durableNetworkHash === 'string' && stored.durableNetworkHash !== durableHash) {
      throw new Error(`historical imported network replay no longer matches its durable record: ${durable.id}`)
    }
    if (canonicalImportRequestJson(envelopeNetwork) !== canonicalImportRequestJson(durable)) {
      throw new Error(`historical import idempotency projection differs from its durable network: ${durable.id}`)
    }
    const sourceFile = durable.sourceFile
    if (provenance.mode === 'raw-source') {
      if (!sourceFile
        || sourceFile.name !== provenance.name
        || sourceFile.sha256 !== provenance.originalSha256
        || sourceFile.fileSize !== provenance.originalByteLength
        || sourceFile.detection.format !== provenance.format
        || (sourceFile.detection.version ?? null) !== provenance.formatVersion
        || sourceFile.parserId !== provenance.parserId
        || sourceFile.parserVersion !== provenance.parserVersion
        || sourceFile.parserSourceHash !== provenance.parserSourceHash) {
        throw new Error('survey import idempotency evidence has inconsistent source format provenance')
      }
      const rawIntegrity = this.checkRawSourceIntegrity(durable, false)
      if (rawIntegrity.status !== 'verified') {
        throw new Error(`historical imported network source is no longer verified: ${rawIntegrity.errors.join('；')}`)
      }
      const admission = this.verifySourceAdmission(durable)
      if (!admission.valid) {
        throw new Error(`historical imported network source admission is invalid: ${admission.errors.join('；')}`)
      }
    }
    return durable
  }
  private rememberImportNetwork(key: string, prepared: PreparedImportRequest, value: SurveyNetworkV1): void {
    const sourceFile = value.sourceFile
    const stored: StoredImportNetworkIdempotency = {
      kind: 'survey-network-import',
      requestHash: prepared.requestHash,
      projectId: value.projectId,
      source: {
        ...prepared.source,
        format: sourceFile?.detection.format ?? null,
        formatVersion: sourceFile?.detection.version ?? null,
        parserId: sourceFile?.parserId ?? null,
        parserVersion: sourceFile?.parserVersion ?? null,
        parserSourceHash: sourceFile?.parserSourceHash ?? null
      },
      network: value,
      durableNetworkHash: sha256CanonicalSurveyValue(value)
    }
    this.db.prepare('INSERT INTO survey_idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(stored), this.nowIso())
  }
  private remember(key: string, value: unknown): void { this.db.prepare('INSERT OR IGNORE INTO survey_idempotency(key, result_json, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), this.nowIso()) }
  private async persist(value: unknown, kind: string, workspace?: string): Promise<void> {
    if (!workspace) return
    const root = resolve(workspace); const directory = join(root, '.workwise', 'engineering', kind); await mkdir(directory, { recursive: true })
    const record = value as { id?: unknown; run?: { id?: unknown } } | null
    const id = typeof record?.id === 'string' ? record.id : typeof record?.run?.id === 'string' ? record.run.id : randomUUID()
    await atomicWriteFile(join(directory, `${id}.json`), JSON.stringify(value, null, 2))
  }
  private trackPersistence(value: unknown, kind: string, workspace?: string): void {
    const pending = this.persist(value, kind, workspace)
    this.pendingPersistence.add(pending)
    void pending.finally(() => this.pendingPersistence.delete(pending)).catch(() => undefined)
  }
}
