import type { SurveySourceFixedModelV1 } from './survey-source-fixed-model.js'
import { canonicalSourceModel } from './survey-source-fixed-model.js'

export type SourceTrialOptions = {
  familyId: string; alpha: number; externalScale: number; externalScaleBasis: string; huberK: number
  appended: Array<{ id: string; from: string; to: string; heightDifference: number; sigma: number; sourceAnchor: string }>
  staticBaseFingerprint?: string
}
export function sourceStaticBase(source: SurveySourceFixedModelV1) {
  const m = source.model
  return { schemaVersion: 1, model: 'fixed-datum-full-column-rank-independent-linear-observations',
    covarianceBasis: 'caller-declared-known-apriori-independent-absolute-variances', errorModel: 'caller-declared-zero-mean-independent-errors-no-normality-claim',
    coefficientMeaning: 'dimensionless-all-parameters-share-observation-unit', networkId: source.binding.networkId, revision: source.binding.networkRevision, unit: 'm',
    parameterIds: m.parameterIds, sourceAnchor: source.binding.runId, sourceSha256: source.binding.sourceSha256,
    observations: m.observations.map((o,i) => ({ id: o.id, value: o.value, coefficients: m.designMatrix[i], aprioriVariance: o.sigma ** 2, sourceAnchor: o.sourceAnchor })) }
}

/** Data-only adapter; user-declared family, external scale and new observations
 * remain explicit. Absolute heights never replace correction parameters. */
export function buildSourceTrialDeclaration(source: SurveySourceFixedModelV1, kind: string, options: SourceTrialOptions): unknown {
  const m = source.model, firstVariance = m.observations[0]!.sigma ** 2
  if (kind === 'generalized-w') return {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'm', observationIds: m.observations.map(o => o.id), parameterIds: m.parameterIds, parameterUnits: m.parameterIds.map(() => 'm'),
    designMatrix: m.designMatrix, observations: m.observations.map(o => o.value), covariance: { kind: 'known-apriori-absolute-observation-covariance',
      basisStatement: 'Source-declared independent absolute prior sigma squared; source integrity verified, field stochastic assumptions not authenticated.', matrix: m.observationCovariance },
    family: { id: options.familyId, alpha: options.alpha, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: m.observations.map((o,i) => ({ id: o.id, coefficients: m.observations.map((_,j) => i === j ? 1 : 0) })) }
  if (kind === 'vce') return {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'm', parameterIds: m.parameterIds,
    groups: [{ id: 'source-prior', initialVariance: firstVariance, sourceAnchor: source.binding.runId }],
    observations: m.observations.map((o,i) => ({ id: o.id, value: o.value, coefficients: m.designMatrix[i], groupId: 'source-prior', relativeVariance: o.sigma ** 2 / firstVariance, sourceAnchor: o.sourceAnchor })),
    maxIterations: 30, relativeTolerance: 1e-8 }
  if (kind === 'huber') return {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', independenceDeclaration: 'caller-declared-independent-observations', residualConvention: 'observed-minus-fitted',
    observationUnit: 'm', parameterIds: m.parameterIds, parameterUnits: m.parameterIds.map(() => 'm'), initialParameters: m.formalCorrections,
    scale: { kind: 'fixed-external', value: options.externalScale, unit: 'm', basisStatement: options.externalScaleBasis }, loss: { kind: 'huber', k: options.huberK },
    observations: m.observations.map((o,i) => ({ id: o.id, value: o.value, coefficients: m.designMatrix[i], relativeSigma: o.sigma / m.observations[0]!.sigma, sourceAnchor: o.sourceAnchor })),
    stopping: { maxIterations: 100, standardizedPredictionStepTolerance: 1e-8, relativeObjectiveTolerance: 1e-8, normalizedScoreTolerance: 1e-8 } }
  if (kind === 'static-incremental') return {
    schemaVersion: 1, operation: 'append-independent-observations-only', base: sourceStaticBase(source), expectedBaseFingerprint: options.staticBaseFingerprint,
    append: { batchId: 'declared-independent-new-observations', nextRevision: source.binding.networkRevision + 1, sourceAnchor: options.appended[0]?.sourceAnchor,
      observations: options.appended.map(o => {
        const from = m.referencePoints.find(p => p.id === o.from), to = m.referencePoints.find(p => p.id === o.to)
        if (!from || !to || o.from === o.to || !(o.sigma > 0)) throw new Error('invalid-source-append')
        return { id: o.id, value: o.heightDifference - (to.height - from.height), coefficients: m.parameterIds.map(id => (id === o.to ? 1 : 0) - (id === o.from ? 1 : 0)), aprioriVariance: o.sigma ** 2, sourceAnchor: o.sourceAnchor }
      }) } }
  throw new Error('unsupported-source-trial')
}

/** Source binding alone is insufficient: compare every immutable model row
 * and absolute covariance. Trial-specific declarations remain caller inputs. */
export function declarationMatchesSource(source: SurveySourceFixedModelV1, kind: string, declaration: unknown): boolean {
  const d = declaration as { base?: unknown; parameterIds?: unknown; observationUnit?: unknown; parameterUnits?: unknown; observationIds?: unknown; designMatrix?: unknown; observations?: unknown; covariance?: { matrix?: unknown }; initialParameters?: unknown; unit?: unknown; groups?: unknown }, m = source.model
  const eq = (a: unknown,b: unknown) => canonicalSourceModel(a) === canonicalSourceModel(b)
  if (kind === 'static-incremental') return eq(d.base, sourceStaticBase(source))
  if (!['generalized-w','vce','huber'].includes(kind) || !eq(d.parameterIds, m.parameterIds)) return false
  if (kind === 'generalized-w') return d.observationUnit === 'm' && eq(d.parameterUnits, m.parameterIds.map(() => 'm'))
    && eq(d.observationIds,m.observations.map(o => o.id)) && eq(d.designMatrix,m.designMatrix) && eq(d.observations,m.observations.map(o => o.value)) && eq(d.covariance?.matrix,m.observationCovariance)
  if (kind === 'huber') return d.observationUnit === 'm' && eq(d.parameterUnits,m.parameterIds.map(() => 'm')) && eq(d.initialParameters,m.formalCorrections)
    && eq(d.observations,m.observations.map((o,i) => ({ id:o.id,value:o.value,coefficients:m.designMatrix[i],relativeSigma:o.sigma/m.observations[0]!.sigma,sourceAnchor:o.sourceAnchor })))
  const variance = m.observations[0]!.sigma ** 2
  return d.unit === 'm' && eq(d.groups,[{id:'source-prior',initialVariance:variance,sourceAnchor:source.binding.runId}])
    && eq(d.observations,m.observations.map((o,i) => ({id:o.id,value:o.value,coefficients:m.designMatrix[i],groupId:'source-prior',relativeVariance:o.sigma**2/variance,sourceAnchor:o.sourceAnchor})))
}
