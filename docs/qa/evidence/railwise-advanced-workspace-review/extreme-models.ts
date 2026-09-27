/** Synthetic inputs generated here; no external field data or saved output. */
export function maximalWModel() {
  const id = (prefix: string, i: number, length = 200) => `${prefix}${i}-`.padEnd(length, 'x')
  return {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'm', observationIds: Array.from({ length: 64 }, (_, i) => id('observation', i)),
    parameterIds: Array.from({ length: 16 }, (_, i) => id('parameter', i)), parameterUnits: Array(16).fill('m'),
    designMatrix: Array.from({ length: 64 }, (_, i) => Array.from({ length: 16 }, (_, j) => Number(i % 16 === j))),
    observations: Array.from({ length: 64 }, (_, i) => i),
    covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Synthetic absolute identity covariance; no field-model inference.',
      matrix: Array.from({ length: 64 }, (_, i) => Array.from({ length: 64 }, (_, j) => Number(i === j))) },
    family: { id: 'synthetic-before-evaluation', alpha: .05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: Array.from({ length: 64 }, (_, i) => ({ id: id('direction', i), coefficients: Array.from({ length: 64 }, (_, j) => Number(i === j)) }))
  }
}
export function maximalVceModel() {
  return {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm',
    parameterIds: Array.from({ length: 32 }, (_, i) => `parameter-${i}`.padEnd(160, 'x')),
    groups: Array.from({ length: 8 }, (_, i) => ({ id: `group-${i}`, initialVariance: 1, sourceAnchor: 'synthetic'.padEnd(160, 'x') })),
    observations: Array.from({ length: 128 }, (_, i) => ({ id: `observation-${i}`.padEnd(160, 'x'), value: i % 4,
      coefficients: Array.from({ length: 32 }, (_, j) => Number(Math.floor(i / 4) === j)), groupId: `group-${Math.floor(i / 4) % 8}`,
      relativeVariance: 1, sourceAnchor: 'synthetic'.padEnd(160, 'x') })),
    maxIterations: 100, relativeTolerance: 1e-12
  }
}
/** Seed 20260920, input 172: genuine 100-step exhaustion on the reviewed kernel.
 * Only input generation occurs for preceding indices; outputs are always fresh. */
export function hundredStepVceModel() {
  let state = 20260920
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  let model
  for (let trial = 0; trial <= 172; trial += 1) model = {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm', parameterIds: ['mean', 'slope'],
    groups: [0, 1].map(i => ({ id: `g${i}`, initialVariance: 10 ** (random() * 6 - 3), sourceAnchor: 'synthetic' })),
    observations: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, value: random() * 10 - 5, coefficients: [1, random() * 2 - 1],
      groupId: `g${i % 2}`, relativeVariance: 10 ** (random() * 4 - 2), sourceAnchor: 'synthetic' })),
    maxIterations: 100, relativeTolerance: 1e-12
  }
  return model!
}
