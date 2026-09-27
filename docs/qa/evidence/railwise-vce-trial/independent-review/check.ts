import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] ?? process.cwd())
const sourcePath = resolve(root, 'kun/src/engineering/survey-vce-trial.ts')
const { runSurveyVceTrial: run } = await import(pathToFileURL(sourcePath).href)
const cases = JSON.parse(readFileSync(resolve(dir, 'cases.json'), 'utf8'))
const counts: Record<string, number> = {}, failures: unknown[] = []
let maxVarianceRelativeError = 0, maxResidualScaledError = 0, maxFitScaledError = 0
for (const c of cases) {
  try {
    const out = run(c.input)
    counts[out.outcome] = (counts[out.outcome] ?? 0) + 1
    if (out.outcome !== 'converged') continue
    const got = out.convergedVariances[0], expected = c.expectedVariance
    const relative = expected === 0 ? (got === 0 ? 0 : Infinity) : Math.abs(got - expected) / Math.abs(expected)
    const residualScale = Math.max(...c.expectedResidual.map(Math.abs)) || 1
    const observedScale = Math.max(...c.input.observations.map((o: { value: number }) => Math.abs(o.value))) || 1
    const residualError = Math.max(...out.finalFit.residuals.map((v: number, i: number) => Math.abs(v - c.expectedResidual[i]) / residualScale))
    const fitError = Math.max(...c.input.observations.map((o: { coefficients: number[] }) => Math.abs(o.coefficients[0] * out.finalFit.parameters[0] - o.coefficients[0] * c.expectedX) / observedScale))
    maxVarianceRelativeError = Math.max(maxVarianceRelativeError, relative)
    maxResidualScaledError = Math.max(maxResidualScaledError, residualError)
    maxFitScaledError = Math.max(maxFitScaledError, fitError)
    if (![relative, residualError, fitError].every(Number.isFinite) || Math.max(relative, residualError, fitError) > 1e-7) failures.push({ tag: c.tag, relative, residualError, fitError })
  } catch (error) { failures.push({ tag: c.tag, error: String(error) }) }
}
const inputForInvisibleGroup = (a: number[][], y: number[], q: number) => ({
  schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'm', parameterIds: ['shared', 'isolated'],
  groups: [{ id: 'g0', initialVariance: 1 / q, sourceAnchor: 'exact-unidentifiable' }, { id: 'g1', initialVariance: q, sourceAnchor: 'exact-unidentifiable' }],
  observations: a.map((coefficients, i) => ({ id: String(i), value: y[i], coefficients, groupId: i === 0 ? 'g0' : 'g1', relativeVariance: i === 0 ? q : 1 / q, sourceAnchor: 'isolated-parameter-exact-proof' })),
  maxIterations: 30, relativeTolerance: 1e-10
})
const unidentifiable: Record<string, Record<string, number>> = { residualDof1: {}, residualDof2: {}, randomized: {} }
function checkInvisible(label: string, input: unknown): void {
  try {
    const output = run(input)
    unidentifiable[label][output.outcome] = (unidentifiable[label][output.outcome] ?? 0) + 1
    if (output.outcome !== 'stochastic-rank-or-conditioning' || output.iterations.length !== 0 || output.convergedVariances !== null || output.finalFit !== null) {
      if (failures.length < 20) failures.push({ label, input, output })
    }
  } catch (error) { if (failures.length < 20) failures.push({ label, error: String(error) }) }
}
for (const t of [.01, .02, .0314159, .1, .123456789, .3, .37, .7, .999, 1.1, 3, 10, 100]) {
  for (const q of [1, 1e2, 1e4, 1e6, 1e8]) {
    for (const y0 of [0, 1, 10000]) checkInvisible('residualDof1', inputForInvisibleGroup([[1, 1], [t, 0], [t, 0]], [y0, 1, 3], q))
    for (const y0 of [0, .1, .3, 1, 1.1, 12.3456, 10000]) checkInvisible('residualDof2', inputForInvisibleGroup([[1, 1], [t, 0], [t, 0], [t, 0]], [y0, 1, 3, 7], q))
  }
}
let seed = 20260922
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
for (let t = 0; t < 10000; t++) {
  const q = 10 ** (4 + 4 * random()), n = 3 + Math.floor(random() * 4)
  const a = Array.from({ length: n }, (_, i) => [.001 + random(), i === 0 ? 1 : 0]), y = Array.from({ length: n }, () => random() * 20 - 10)
  checkInvisible('randomized', inputForInvisibleGroup(a, y, q))
}
const report = { kind: 'independent-numerical-software-review-not-professional-acceptance', sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
  singleGroup: { cases: cases.length, counts, maxVarianceRelativeError, maxResidualScaledError, maxFitScaledError, comparisonTolerance: 1e-7 }, unidentifiable, failures }
writeFileSync(resolve(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
