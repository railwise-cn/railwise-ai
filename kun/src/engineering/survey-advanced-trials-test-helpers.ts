import { hashSurveyStaticIncrementalBaseV1 } from './survey-static-incremental.js'
import type { SurveyAdvancedTrialKindV1 } from '../contracts/survey-advanced-trials-workspace.js'

export function advancedTrialTestRequest(kind: SurveyAdvancedTrialKindV1, key = 'advanced-test-1') {
  const declaration = kind === 'static-incremental' ? staticIncrementalTestModel() : kind === 'reference-datum' ? {
    schemaVersion: 1, model: 'two-epoch-one-dimensional-declared-reference-datum', unit: 'mm', method: 'gls-reference-mean',
    referenceDeclaration: 'caller-selected-reference-set-not-verified-stable', testingStrategy: 'none-datum-comparison-only',
    firstEpoch: { id: 'epoch-1', sourceAnchor: 'synthetic-not-verified', sourceSha256: '0'.repeat(64), covarianceBasis: 'caller-declared-full-coordinate-covariance-not-cofactor',
      points: [0, 10, 20].map((coordinate, i) => ({ id: ['a', 'b', 'c'][i], coordinate })), covariance: [[1,0,0],[0,1,0],[0,0,1]] },
    secondEpoch: { id: 'epoch-2', sourceAnchor: 'synthetic-not-verified', sourceSha256: '0'.repeat(64), covarianceBasis: 'caller-declared-full-coordinate-covariance-not-cofactor',
      points: [2, 14, 27].map((coordinate, i) => ({ id: ['a', 'b', 'c'][i], coordinate })), covariance: [[1,0,0],[0,1,0],[0,0,1]] },
    mapping: ['a', 'b', 'c'].map(id => ({ id, firstPointId: id, secondPointId: id })), referenceIds: ['a', 'b'],
    dependence: { kind: 'caller-declared-independent', sourceAnchor: 'synthetic-not-verified' }
  } : kind === 'huber' ? {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', independenceDeclaration: 'caller-declared-independent-observations',
    residualConvention: 'observed-minus-fitted', observationUnit: 'm', parameterIds: ['position'], parameterUnits: ['m'], initialParameters: [0],
    scale: { kind: 'fixed-external', value: 1, unit: 'm', basisStatement: 'Synthetic fixed external scale.' }, loss: { kind: 'huber', k: 1 },
    observations: [0, 0, 0, 10].map((value, i) => ({ id: `o${i}`, value, coefficients: [1], relativeSigma: 1, sourceAnchor: 'synthetic' })),
    stopping: { maxIterations: 200, standardizedPredictionStepTolerance: 1e-10, relativeObjectiveTolerance: 1e-10, normalizedScoreTolerance: 1e-10 }
  } : kind === 'statistical-family' ? {
    schemaVersion: 1, familyId: 'synthetic-family', declaration: 'caller-declared-before-observing-statistics',
    statisticPrecision: 'caller-declared-exact-scalar-inputs-no-upstream-error-propagation', correction: 'bonferroni', alpha: .05,
    members: ['a', 'b', 'c'].map(id => ({ id, sourceAnchor: 'synthetic', distribution: { kind: 'normal', tail: 'two-sided', statisticBasis: 'standardized-by-known-prior-scale', scaleBasis: 'caller-declared-known-prior-standard-deviation', priorStandardDeviation: 1, scaleUnit: 'm' } })),
    statistics: [{ memberId: 'a', status: 'available', value: 3 }, { memberId: 'c', status: 'undetectable', reason: 'synthetic-unresolved-direction' }]
  } : kind === 'vce' ? {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm', parameterIds: ['height'],
    groups: [{ id: 'g0', initialVariance: 1, sourceAnchor: 'synthetic' }, { id: 'g1', initialVariance: 10, sourceAnchor: 'synthetic' }],
    observations: [1.6,.9,-.9,3.6].map((value, i) => ({ id: `o${i}`, value, coefficients: [1], groupId: i < 2 ? 'g0' : 'g1', relativeVariance: 1, sourceAnchor: 'synthetic' })),
    maxIterations: 100, relativeTolerance: 1e-10
  } : {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'm', observationIds: ['a','b','c'], parameterIds: ['height'], parameterUnits: ['m'], designMatrix: [[1],[1],[1]], observations: [1,2,3],
    covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Synthetic absolute C, not relative-weight conversion.', matrix: [[1,0,0],[0,2,0],[0,0,3]] },
    family: { id: 'declared-family', alpha: .05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: [{ id: 'first-observation', coefficients: [1,0,0] }]
  }
  return { kind, acknowledged: true as const, expectedProjectRevision: 1, idempotencyKey: key,
    declarationJson: JSON.stringify(declaration, null, 2), modelBasisStatement: '模拟数据，独立声明完整模型。\n非正式成果、非专业签认。' }
}

export function maximumNewAdvancedTrialRequest(kind: 'huber' | 'statistical-family', key = 'maximum-new-trial') {
  const request = advancedTrialTestRequest(kind, key)
  const model = JSON.parse(request.declarationJson)
  if (kind === 'huber') {
    const n = 128, p = 16
    model.parameterIds = Array.from({ length: p }, (_, j) => `x${j}`); model.parameterUnits = Array(p).fill('m'); model.initialParameters = Array(p).fill(0)
    model.observations = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, value: Math.sin(i * 13.1) * 10 + (i % 7 === 0 ? 100 : 0),
      coefficients: Array.from({ length: p }, (_, j) => Math.cos(Math.PI * (i + .5) * j / n)), relativeSigma: 1, sourceAnchor: 'maximum-synthetic' }))
    model.loss.k = .01
    model.stopping = { maxIterations: 200, standardizedPredictionStepTolerance: 1e-12, relativeObjectiveTolerance: 1e-12, normalizedScoreTolerance: 1e-12 }
  } else {
    model.members = Array.from({ length: 256 }, (_, i) => ({ id: `m${i}`, sourceAnchor: 'maximum-synthetic', distribution: {
      kind: 'chi-square', tail: 'upper', statisticBasis: 'quadratic-form-divided-by-known-prior-variance', degreesOfFreedom: 745 + i,
      scaleBasis: 'caller-declared-known-prior-standard-deviation', priorStandardDeviation: 1, scaleUnit: 'm' } }))
    model.statistics = model.members.map((member: { id: string }, i: number) => ({ memberId: member.id, status: 'available', value: 745 + i }))
  }
  request.declarationJson = JSON.stringify(model)
  return request
}

export function maximumReferenceDatumRequest(key = 'maximum-reference-trial') {
  const request = advancedTrialTestRequest('reference-datum', key)
  const model = JSON.parse(request.declarationJson)
  const ids = Array.from({ length: 32 }, (_, i) => `${i}-参考点` + '测'.repeat(150))
  const covariance = ids.map((_, i) => ids.map((_, j) => i === j ? 2 : .1))
  model.firstEpoch.points = ids.map((id, i) => ({ id, coordinate: i * 100 }))
  model.secondEpoch.points = ids.map((id, i) => ({ id, coordinate: i * 100 + i % 3 }))
  model.firstEpoch.covariance = covariance; model.secondEpoch.covariance = covariance
  model.mapping = ids.map(id => ({ id, firstPointId: id, secondPointId: id }))
  model.referenceIds = ids
  model.dependence = { kind: 'caller-declared-cross-covariance', sourceAnchor: 'synthetic-cross', firstToSecondCovariance: ids.map((_, i) => ids.map((_, j) => i === j ? .5 : 0)) }
  request.declarationJson = JSON.stringify(model)
  return request
}

function staticIncrementalTestModel() {
  const model = {
  "schemaVersion": 1,
  "operation": "append-independent-observations-only",
  "base": {
    "schemaVersion": 1,
    "model": "fixed-datum-full-column-rank-independent-linear-observations",
    "covarianceBasis": "caller-declared-known-apriori-independent-absolute-variances",
    "errorModel": "caller-declared-zero-mean-independent-errors-no-normality-claim",
    "coefficientMeaning": "dimensionless-all-parameters-share-observation-unit",
    "networkId": "synthetic:equal-weight-location",
    "revision": 1,
    "unit": "mm",
    "parameterIds": [
      "x0"
    ],
    "sourceAnchor": "original-synthetic-fixed-model:equal-weight-location",
    "sourceSha256": "3333333333333333333333333333333333333333333333333333333333333333",
    "observations": [
      {
        "id": "b0",
        "value": 0.0,
        "coefficients": [
          1.0
        ],
        "aprioriVariance": 1.0,
        "sourceAnchor": "original-synthetic:b0"
      },
      {
        "id": "b1",
        "value": 2.0,
        "coefficients": [
          1.0
        ],
        "aprioriVariance": 1.0,
        "sourceAnchor": "original-synthetic:b1"
      },
      {
        "id": "b2",
        "value": 4.0,
        "coefficients": [
          1.0
        ],
        "aprioriVariance": 1.0,
        "sourceAnchor": "original-synthetic:b2"
      }
    ]
  },
  "expectedBaseFingerprint": "5ce1012b2d69f7021925d88c7cb55d5d25865cabdd9d606f267484e4b12dd510",
  "append": {
    "batchId": "append:equal-weight-location",
    "nextRevision": 2,
    "sourceAnchor": "original-synthetic-append:equal-weight-location",
    "observations": [
      {
        "id": "a0",
        "value": 8.0,
        "coefficients": [
          1.0
        ],
        "aprioriVariance": 1.0,
        "sourceAnchor": "original-synthetic:a0"
      },
      {
        "id": "a1",
        "value": -1.0,
        "coefficients": [
          1.0
        ],
        "aprioriVariance": 1.0,
        "sourceAnchor": "original-synthetic:a1"
      }
    ]
  }
}
  model.expectedBaseFingerprint = hashSurveyStaticIncrementalBaseV1(model.base)
  return model
}

export function maximumStaticIncrementalRequest(key = 'maximum-static-trial') {
  const request = advancedTrialTestRequest('static-incremental', key)
  const model = staticIncrementalTestModel()
  model.base.parameterIds = Array.from({ length: 16 }, (_, i) => `p${i}`)
  const rows = Array.from({ length: 256 }, (_, i) => ({ id: `o${i}`, value: (i % 16) + (i % 3) * .125,
    coefficients: Array.from({ length: 16 }, (_, j) => i % 16 === j ? 1 : 0), aprioriVariance: 1, sourceAnchor: 'original-synthetic-max' }))
  model.base.observations = rows.slice(0, 128); model.append.observations = rows.slice(128)
  model.expectedBaseFingerprint = hashSurveyStaticIncrementalBaseV1(model.base)
  request.declarationJson = JSON.stringify(model)
  return request
}
