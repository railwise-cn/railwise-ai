import { createHash } from 'node:crypto'
import type { AdjustmentResultV1, AdjustmentRunV1, SurveyNetworkV1, SurveyObservationV1 } from '../contracts/survey.js'
import {
  SURVEY_PROFESSIONAL_PROJECTION_VERSION,
  SurveyProfessionalReviewV1,
  type SurveyProfessionalClosureV1,
  type SurveyProfessionalClosureMemberV1,
  type SurveyProfessionalReasonV1
} from '../contracts/survey-professional.js'
import { surveyWeightingSemantics } from './survey-weighting-semantics.js'

type SourceIntegrity = 'verified' | 'failed' | 'not-verified'
export type SurveyProfessionalReviewInput = Readonly<{
  projectId: string
  result: AdjustmentResultV1
  network?: SurveyNetworkV1 | null
  sourceIntegrity?: SourceIntegrity
  expectedInputHash?: string
  /** The immutable run constraint; absent only for direct legacy projections. */
  constraint?: AdjustmentRunV1['constraint']
}>

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

function isKnownControl(point: SurveyNetworkV1['knownPoints'][number]): boolean {
  return point.known || point.pointClass === 'known'
}

/** Shared with SurveyService; lifecycle revisions do not change a calculation fingerprint. */
export function surveyProfessionalInputHash(network: SurveyNetworkV1): string {
  return hash({
    schemaVersion: 1, projectId: network.projectId, networkId: network.id, networkType: network.networkType,
    transformType: network.transformType ?? null, coordinateSystem: network.coordinateSystem,
    projection: network.projection, centralMeridian: network.centralMeridian ?? null,
    ellipsoid: network.ellipsoid, verticalDatum: network.verticalDatum, heightDatum: network.heightDatum ?? null,
    unit: network.unit, knownPoints: network.knownPoints, unknownPoints: network.unknownPoints,
    observations: network.observations, instrumentParameters: network.instrumentParameters,
    observationEpoch: network.observationEpoch ?? null, inputAttachmentHash: network.inputAttachmentHash ?? null
  })
}

const LINEAR_SCALES: Readonly<Record<string, number>> = Object.freeze({ m: 1, meter: 1, meters: 1, km: 1_000, cm: 0.01, mm: 0.001 })
const ANGULAR_SCALES: Readonly<Record<string, number>> = Object.freeze({
  rad: 1, radian: 1, radians: 1, gon: Math.PI / 200, grad: Math.PI / 200, grads: Math.PI / 200,
  deg: Math.PI / 180, degree: Math.PI / 180, degrees: Math.PI / 180, '\u00b0': Math.PI / 180,
  arcsec: 1 / 206264.806247, arcsecond: 1 / 206264.806247, arcseconds: 1 / 206264.806247,
  sec: 1 / 206264.806247, '\u2033': 1 / 206264.806247
})
function isAngular(observation: SurveyObservationV1): boolean { return ['direction', 'angle', 'zenith'].includes(observation.type) }
function normalized(value: number | undefined, observation: SurveyObservationV1): number | undefined {
  const factor = (isAngular(observation) ? ANGULAR_SCALES : LINEAR_SCALES)[observation.unit.trim().toLowerCase()]
  if (value === undefined || factor === undefined) return undefined
  const canonicalValue = value * factor
  return Number.isFinite(canonicalValue) ? canonicalValue : undefined
}
function sourceForResidual(sources: ReadonlyMap<string, SurveyObservationV1>, id: string) {
  const exact = sources.get(id)
  if (exact) return { source: exact }
  const matched = /^(.*):(x|y|z|h)$/.exec(id)
  return matched ? { source: sources.get(matched[1]!), component: matched[2] as 'x' | 'y' | 'z' | 'h' } : {}
}
function componentValue(observation: SurveyObservationV1, component?: 'x' | 'y' | 'z' | 'h'): number | undefined {
  if (!component) return observation.value
  if (observation.type === 'gnss-baseline') return ({ x: observation.vectorX, y: observation.vectorY, z: observation.vectorZ, h: undefined })[component]
  if (observation.type === 'coordinate-pair') return ({ x: observation.targetX, y: observation.targetY, h: observation.targetHeight, z: observation.targetHeight })[component]
  return undefined
}

type Edge = Readonly<{ id: string; from: string; to: string; value: number; source: SurveyObservationV1 }>
type SignedEdge = Readonly<{ edge: Edge; direction: 1 | -1 }>
type Parent = Readonly<{ from: string; edge: Edge; direction: 1 | -1 }>
function stationCount(observation: SurveyObservationV1): number | undefined {
  // A segment or a setup identifier is not evidence of its number of field stations.
  const count = observation.rawFields?.stationCount
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : undefined
}
function closureMember({ edge, direction }: SignedEdge): SurveyProfessionalClosureMemberV1 {
  const count = stationCount(edge.source)
  return {
    observationId: edge.id, direction,
    from: direction === 1 ? edge.from : edge.to, to: direction === 1 ? edge.to : edge.from,
    heightDifferenceMetres: direction * edge.value,
    ...(edge.source.routeLength === undefined ? {} : { routeLengthMetres: edge.source.routeLength }),
    ...(count === undefined ? {} : { stationCount: count }),
    ...(edge.source.sourceRecordId ? { sourceRecordId: edge.source.sourceRecordId } : {}),
    ...(edge.source.sourceRow === undefined ? {} : { sourceRow: edge.source.sourceRow })
  }
}
function closureRow(network: SurveyNetworkV1, id: string, path: SignedEdge[], controls: ReadonlyMap<string, number>): SurveyProfessionalClosureV1 {
  const members = path.map(closureMember)
  const from = members[0]!.from, to = members[members.length - 1]!.to
  const kind = from === to ? 'loop' as const : 'attached-route' as const
  const sumObservedMetres = members.reduce((sum, item) => sum + item.heightDifferenceMetres, 0)
  const knownHeightDifferenceMetres = kind === 'loop' ? 0 : controls.get(to)! - controls.get(from)!
  const misclosureMetres = sumObservedMetres - knownHeightDifferenceMetres
  const allLengths = members.every((item) => item.routeLengthMetres !== undefined)
  const allStations = members.every((item) => item.stationCount !== undefined)
  const configured = network.instrumentParameters.closureTolerance
  const toleranceMetres = configured !== undefined && configured >= 0 ? configured : undefined
  return {
    id, kind, from, to, members, sumObservedMetres, knownHeightDifferenceMetres, misclosureMetres,
    ...(allLengths ? { totalLengthMetres: members.reduce((sum, item) => sum + item.routeLengthMetres!, 0) } : {}),
    ...(allStations ? { stationCount: members.reduce((sum, item) => sum + item.stationCount!, 0) } : {}),
    ...(toleranceMetres === undefined
      ? { status: 'not-evaluated', reason: 'closure-tolerance-not-configured' }
      : { toleranceMetres, toleranceBasis: 'network.instrumentParameters.closureTolerance', status: Math.abs(misclosureMetres) <= toleranceMetres ? 'pass' : 'fail' })
  }
}

/** Builds a reproducible fundamental closure basis for each leveling graph component. */
export function professionalLevelingClosures(network: SurveyNetworkV1): SurveyProfessionalClosureV1[] {
  const controls = new Map([...network.knownPoints, ...network.unknownPoints].filter((point) => isKnownControl(point) && point.height !== undefined).map((point) => [point.id, point.height!]))
  const edges: Edge[] = network.observations.flatMap((observation) => {
    const value = normalized(observation.value, observation)
    return observation.type === 'height-difference' && observation.from && observation.to && value !== undefined
      ? [{ id: observation.id, from: observation.from, to: observation.to, value, source: observation }] : []
  })
  if (!edges.length || edges.length !== network.observations.length || new Set(edges.map((edge) => edge.id)).size !== edges.length) return []
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const sorted = [...edges].sort((a, b) => compare(a.id, b.id) || compare(a.from, b.from) || compare(a.to, b.to) || a.value - b.value)
  const adjacency = new Map<string, Array<{ edge: Edge; to: string; direction: 1 | -1 }>>()
  const addAdjacent = (point: string, edge: Edge, to: string, direction: 1 | -1): void => {
    const adjacent = adjacency.get(point)
    if (adjacent) adjacent.push({ edge, to, direction })
    else adjacency.set(point, [{ edge, to, direction }])
  }
  for (const edge of sorted) {
    addAdjacent(edge.from, edge, edge.to, 1)
    addAdjacent(edge.to, edge, edge.from, -1)
  }
  const components: string[][] = []
  const componentSeen = new Set<string>()
  for (const start of [...adjacency.keys()].sort(compare)) {
    if (componentSeen.has(start)) continue
    const component = [start]
    componentSeen.add(start)
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const next of adjacency.get(component[cursor]!) ?? []) {
        if (componentSeen.has(next.to)) continue
        componentSeen.add(next.to)
        component.push(next.to)
      }
    }
    component.sort(compare)
    components.push(component)
  }
  const componentIndex = new Map<string, number>()
  components.forEach((component, index) => component.forEach((point) => componentIndex.set(point, index)))
  const componentEdges = components.map((): Edge[] => [])
  for (const edge of sorted) componentEdges[componentIndex.get(edge.from)!]!.push(edge)
  const componentControls = components.map((): string[] => [])
  for (const id of controls.keys()) {
    const index = componentIndex.get(id)
    if (index !== undefined) componentControls[index]!.push(id)
  }
  for (const ids of componentControls) ids.sort(compare)

  const parents = new Map<string, Parent>()
  const depths = new Map<string, number>()
  const treeEdges = new Set<Edge>()
  const closures: SurveyProfessionalClosureV1[] = []
  for (const [index, component] of components.entries()) {
    const edgesInComponent = componentEdges[index]!
    const componentControlIds = componentControls[index]!
    const root = componentControlIds[0] ?? component[0]!
    const roots = new Map([[root, root]])
    const queue = [root]
    depths.set(root, 0)
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const from = queue[cursor]!
      for (const next of adjacency.get(from) ?? []) {
        if (roots.has(next.to)) continue
        roots.set(next.to, root)
        parents.set(next.to, { from, edge: next.edge, direction: next.direction })
        depths.set(next.to, depths.get(from)! + 1)
        treeEdges.add(next.edge)
        queue.push(next.to)
      }
    }

    const controlIds = new Set(componentControlIds)
    const orderedControls: string[] = []
    const stack = [root]
    while (stack.length) {
      const point = stack.pop()!
      if (controlIds.has(point)) orderedControls.push(point)
      const children = new Set((adjacency.get(point) ?? [])
        .filter((next) => parents.get(next.to)?.from === point)
        .map((next) => next.to))
      for (const child of [...children].sort(compare).reverse()) stack.push(child)
    }

    const pathBetweenControls = (start: string, end: string): SignedEdge[] => {
      const fromStart: SignedEdge[] = []
      const fromEnd: SignedEdge[] = []
      let left = start
      let right = end
      const reverse = (direction: 1 | -1): 1 | -1 => direction === 1 ? -1 : 1
      while (depths.get(left)! > depths.get(right)!) {
        const parent = parents.get(left)!
        fromStart.push({ edge: parent.edge, direction: reverse(parent.direction) })
        left = parent.from
      }
      while (depths.get(right)! > depths.get(left)!) {
        const parent = parents.get(right)!
        fromEnd.push({ edge: parent.edge, direction: parent.direction })
        right = parent.from
      }
      while (left !== right) {
        const leftParent = parents.get(left)!
        const rightParent = parents.get(right)!
        fromStart.push({ edge: leftParent.edge, direction: reverse(leftParent.direction) })
        fromEnd.push({ edge: rightParent.edge, direction: rightParent.direction })
        left = leftParent.from
        right = rightParent.from
      }
      return [...fromStart, ...fromEnd.reverse()]
    }

    // Consecutive controls in tree DFS order form an independent height-difference basis.
    // Their combined route membership is bounded by the DFS walk, unlike root-to-control paths.
    for (let controlIndex = 1; controlIndex < orderedControls.length; controlIndex += 1) {
      const from = orderedControls[controlIndex - 1]!
      const to = orderedControls[controlIndex]!
      closures.push(closureRow(network, `leveling-attached:${from}:${to}`, pathBetweenControls(from, to), controls))
    }

    for (const edge of edgesInComponent) {
      if (treeEdges.has(edge)) continue
      const path: SignedEdge[] = [
        ...pathBetweenControls(edge.to, edge.from),
        { edge, direction: 1 }
      ]
      closures.push(closureRow(network, `leveling-cycle:${edge.id}`, path, controls))
    }
  }
  return closures
}

function declared(value: string | undefined): string | null {
  return value && !/^(待确认|未确认|unknown|unverified|pending|legacy-unknown)$/i.test(value.trim()) ? value : null
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function buildSurveyProfessionalReview(input: SurveyProfessionalReviewInput): SurveyProfessionalReviewV1 {
  const { projectId, result } = input
  const candidate = input.network ?? undefined
  const currentHash = candidate ? surveyProfessionalInputHash(candidate) : undefined
  const mismatched = Boolean(candidate && (candidate.projectId !== projectId || candidate.id !== result.networkId
    || currentHash !== result.inputHash || (input.expectedInputHash !== undefined && input.expectedInputHash !== currentHash)))
  // Current metadata must never be displayed as the historical result's datum after an edit.
  const network = mismatched ? undefined : candidate
  const integrity = input.sourceIntegrity ?? 'not-verified'
  const status = !candidate ? 'unavailable' as const : mismatched ? 'mismatch' as const : integrity === 'verified' ? 'bound' as const : 'unverified' as const
  const sourceReason: SurveyProfessionalReasonV1 | undefined = !candidate ? 'no-network-snapshot' : mismatched ? 'input-mismatch' : integrity === 'failed' ? 'source-integrity-failed' : integrity !== 'verified' ? 'source-unverified' : undefined
  const sources = new Map((network?.observations ?? []).map((observation) => [observation.id, observation]))
  const anchors = new Set(network?.sourceFile?.records.map((record) => record.id) ?? [])
  const missingAnchorObservationIds = result.observations.filter((row) => {
    const { source } = sourceForResidual(sources, row.observationId)
    return !row.sourceRecordId || row.sourceRecordId !== source?.sourceRecordId || !anchors.has(row.sourceRecordId)
  }).map((row) => row.observationId)
  const observations = result.observations.map((row) => {
    const { source, component } = sourceForResidual(sources, row.observationId)
    const sourceValue = source ? componentValue(source, component) : undefined
    const observed = source && sourceValue !== undefined ? normalized(sourceValue, source) : undefined
    return {
      id: row.observationId, observationId: source?.id ?? row.observationId, type: source?.type ?? 'unknown',
      ...(component ? { component } : {}), ...(source?.from ?? source?.station ? { from: source?.from ?? source?.station } : {}),
      ...(source?.to ?? source?.target ? { to: source?.to ?? source?.target } : {}),
      ...(sourceValue === undefined ? {} : { rawValue: sourceValue, rawUnit: source!.unit }),
      ...(observed === undefined ? {} : { observed, adjusted: observed + row.correction }),
      ...(source?.routeLength === undefined ? {} : { routeLengthMetres: source.routeLength }),
      correction: row.correction, residual: row.residual, ...(row.unit ? { unit: row.unit } : {}),
      ...(row.sourceRecordId ? { sourceRecordId: row.sourceRecordId } : {}),
      ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      ...(source?.sourceLocator ? { sourceLocator: source.sourceLocator } : {}),
      outlierCandidate: row.outlier,
      ...(row.residualStatistic ? { screening: row.residualStatistic } : {}),
      screeningStatus: row.residualStatistic?.status ?? 'legacy-not-recorded' as const
    }
  })
  const originalPoints = new Map([...(network?.knownPoints ?? []), ...(network?.unknownPoints ?? [])].map((point) => [point.id, point]))
  const points = result.points.map(({ covariance: _covariance, correctionX, correctionY, correctionHeight, ...point }) => {
    const sourcePoint = originalPoints.get(point.id)
    return {
      ...point, role: sourcePoint ? isKnownControl(sourcePoint) ? 'known' as const : sourcePoint.pointClass : 'unverified' as const,
      ...(sourcePoint?.x === undefined || correctionX === undefined ? {} : { correctionX }),
      ...(sourcePoint?.y === undefined || correctionY === undefined ? {} : { correctionY }),
      ...(sourcePoint?.height === undefined || correctionHeight === undefined ? {} : { correctionHeight }),
      precisionBasis: point.standardError === undefined ? 'not-recorded' as const : result.varianceFactorEstimated ? 'a-posteriori' as const : 'a-priori' as const,
      unit: 'm' as const
    }
  })
  const leveling = network?.networkType === 'leveling' || network?.networkType === 'height-control'
  const closures = network && leveling ? professionalLevelingClosures(network) : []
  const residualNorms = (['m', 'rad'] as const).flatMap((unit) => {
    const values = result.observations.filter((row) => row.unit === unit)
    return values.length ? [{ unit, value: values.reduce((norm, row) => Math.hypot(norm, row.residual), 0), count: values.length, status: 'descriptive-only' as const }] : []
  })
  const reference = {
    coordinateSystem: declared(network?.coordinateSystem), projection: declared(network?.projection), ellipsoid: declared(network?.ellipsoid),
    ...(network?.centralMeridian === undefined ? {} : { centralMeridian: network.centralMeridian }), verticalDatum: declared(network?.verticalDatum),
    linearUnit: 'm' as const, angularUnit: 'rad' as const, knownPoints: network?.knownPoints.filter(isKnownControl) ?? [],
    status: !network ? 'unavailable' as const : (leveling ? declared(network.verticalDatum) : declared(network.coordinateSystem)) && network.knownPoints.some(isKnownControl) ? 'declared' as const : 'incomplete' as const
  }
  const weakest = points.filter((point) => point.role !== 'known' && point.standardError !== undefined)
    .reduce<typeof points[number] | undefined>((best, point) => !best || point.standardError! > best.standardError! ? point : best, undefined)
  const closureStatus = closures.some((row) => row.status === 'fail') ? 'fail' as const : closures.length && closures.every((row) => row.status === 'pass') ? 'pass' as const : 'not-evaluated' as const
  // A numerically valid result is not usable when the adjustment retained an
  // unresolved blocking quality finding (for example malformed geometry or a
  // missing datum). Warnings remain descriptive and do not change this gate.
  const blockingQualityFinding = result.qualityFindings.some((finding) => finding.severity === 'blocking' && finding.status === 'open')
  const checks: SurveyProfessionalReviewV1['checks'] = [
    { id: 'source-binding', status: status === 'bound' ? 'pass' : status === 'mismatch' || integrity === 'failed' ? 'fail' : 'not-evaluated', ...(sourceReason ? { reason: sourceReason } : {}) },
    { id: 'source-coverage', status: network && missingAnchorObservationIds.length === 0 ? 'pass' : 'not-evaluated', ...(missingAnchorObservationIds.length ? { reason: 'missing-source-anchor' } : {}) },
    { id: 'reference', status: reference.status === 'declared' ? 'pass' : 'not-evaluated', ...(reference.status === 'declared' ? {} : { reason: 'reference-missing' }) },
    { id: 'field-checks', status: 'not-evaluated', reason: 'station-readings-not-evaluated' },
    { id: 'closure', status: closureStatus, ...(closureStatus === 'not-evaluated' ? { reason: !network ? sourceReason ?? 'no-network-snapshot' : leveling ? closures.length ? 'closure-tolerance-not-configured' : 'no-height-route' : 'plane-closures-not-evaluated' } : {}) },
    { id: 'precision', status: 'not-evaluated', reason: weakest ? 'precision-tolerance-not-configured' : 'no-point-standard-errors' },
    { id: 'numerical-result', status: result.validation === 'invalid' || blockingQualityFinding ? 'fail' : result.validation === 'valid' ? 'pass' : 'not-evaluated',
      ...((result.validation === 'invalid' || result.validation === 'pending') ? { reason: 'numerical-result-invalid' as const } : blockingQualityFinding ? { reason: 'blocking-quality-finding' as const } : {}) },
    { id: 'standards', status: 'not-evaluated', reason: 'standards-not-evaluated' }
  ]
  const constraint = input.constraint ?? 'not-recorded' as const
  const rank = result.solverDiagnostics?.rank
  const parameterCount = result.unknownCount
  const datumDefect = rank !== undefined && rank <= parameterCount ? parameterCount - rank : undefined
  const solver = {
    ...(rank === undefined ? {} : { rank }),
    parameterCount,
    ...(datumDefect === undefined ? {} : { datumDefect }),
    rankStatus: rank === undefined ? 'not-recorded' as const : 'available' as const,
    datumStatus: rank === undefined || rank > parameterCount
      ? 'not-evaluated' as const
      : constraint === 'fixed-known-points'
        ? 'fixed-datum' as const
        : constraint === 'free'
          ? 'free-network' as const
          : constraint === 'minimum-constraint'
            ? 'minimum-constraint' as const
            : 'not-evaluated' as const,
    constraint,
    constraintBasis: input.constraint === undefined ? 'not-recorded' as const : 'adjustment-run' as const
  }
  const body = {
    schemaVersion: 1 as const, projectionVersion: SURVEY_PROFESSIONAL_PROJECTION_VERSION, projectId,
    networkId: result.networkId, runId: result.runId, resultId: result.id, inputHash: result.inputHash,
    resultHash: hash(result), algorithmVersion: result.algorithmVersion, resultCreatedAt: result.createdAt,
    source: {
      ...(candidate?.revision === undefined ? {} : { networkRevision: candidate.revision }),
      ...(network?.sourceFile ? { sha256: network.sourceFile.sha256, formatId: network.sourceFile.formatId, name: network.sourceFile.name } : {}),
      status, integrity, ...(sourceReason ? { reason: sourceReason } : {}),
      anchoredObservationCount: result.observations.length - missingAnchorObservationIds.length, missingAnchorObservationIds
    },
    reference, summary: {
      ...(network ? { networkType: network.networkType } : result.strategyId ? { networkType: result.strategyId } : {}),
      observationCount: result.observationCount, pointCount: result.points.length, degreesOfFreedom: result.degreesOfFreedom,
      unitWeightStdDev: result.unitWeightStdDev, varianceFactor: result.varianceFactor,
      ...(surveyWeightingSemantics(result).weightingSemantics.status === 'recorded' ? {
        weightingBasis: result.weightingBasis, unitWeightStdDevUnit: result.unitWeightStdDevUnit, varianceFactorUnit: result.varianceFactorUnit,
        ...(result.relativeWeightReferenceLengthMetres === undefined ? {} : { relativeWeightReferenceLengthMetres: result.relativeWeightReferenceLengthMetres }),
        ...(result.relativeWeightDefaultLengthObservationIds === undefined ? {} : { relativeWeightDefaultLengthObservationIds: result.relativeWeightDefaultLengthObservationIds })
      } : {}),
      varianceBasis: result.weightingBasis === 'relative-route-length' && !result.varianceFactorEstimated ? 'not-estimated' as const
        : result.varianceFactorEstimated ? 'a-posteriori' as const : result.points.length && result.unknownCount ? 'a-priori' as const : 'not-estimated' as const,
      validation: result.validation
    }, solver,
    closures, residualNorms, observations, points,
    weakestPoint: weakest
      ? { status: 'available' as const, criterion: 'largest-reported-point-standard-error' as const, pointId: weakest.id, standardErrorMetres: weakest.standardError }
      : { status: 'not-evaluated' as const, criterion: 'largest-reported-point-standard-error' as const, reason: 'no-point-standard-errors' as const },
    weakestEdge: { status: 'not-evaluated' as const, reason: 'cross-covariance-unavailable' as const },
    checks, reviewStatus: 'unsigned' as const, standardsConformity: 'not-evaluated' as const
  }
  return deepFreeze(SurveyProfessionalReviewV1.parse({ ...body, projectionHash: hash(body) }))
}
