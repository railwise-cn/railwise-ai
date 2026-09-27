/** Read-only product comparison. Execute from the repository root with Bun.
 * Expected values come exclusively from the separate Python generators. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'input-dir': { type: 'string' } } });
if (!values['input-dir']) throw new Error('--input-dir is required');
const generated = resolve(values['input-dir']);
const sourcePath = resolve('kun/src/engineering/survey-generalized-w.ts');
const contractPath = resolve('kun/src/contracts/survey-generalized-w.ts');
const { diagnoseGeneralizedW } = await import(pathToFileURL(sourcePath).href);
const oracle = JSON.parse(readFileSync(resolve(generated, 'fraction_oracle_output.json'), 'utf8'));
const random = JSON.parse(readFileSync(resolve(generated, 'random_fraction_cases.json'), 'utf8'));
const fraction = value => { const [a, b = '1'] = value.split('/'); return Number(a) / Number(b); };
const failures = [];
function requestFor(example, name) {
  return {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'synthetic', observationIds: example.y.map((_, i) => `o${i}`),
    parameterIds: example.xhat.map((_, i) => `p${i}`), parameterUnits: example.xhat.map(() => 'synthetic'),
    designMatrix: example.A.map(row => row.map(fraction)), observations: example.y.map(row => fraction(row[0])),
    covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Independent Fraction synthetic verification only; no engineering authentication.', matrix: example.C.map(row => row.map(fraction)) },
    family: { id: name, alpha: .05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: Object.entries(example.directions).filter(([, value]) => value.c.some(row => fraction(row[0]) !== 0)).map(([id, value]) => ({ id, coefficients: value.c.map(row => fraction(row[0])) }))
  };
}
function compareCases(cases, label) {
  let maximumScaledError = 0, maximumErrorCase = null;
  const unavailable = [];
  const compare = (actual, expected, field, id) => {
    const delta = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
    if (!Number.isFinite(actual) || !Number.isFinite(delta) || delta > 1e-11) failures.push({ label, id, field, actual, expected, delta });
    if (delta > maximumScaledError) { maximumScaledError = delta; maximumErrorCase = { id, field }; }
  };
  for (const { id, request, expected } of cases) {
    let result;
    try { result = diagnoseGeneralizedW(request); }
    catch (error) { failures.push({ label, id, error: String(error) }); continue; }
    if (result.modelStatus !== 'resolved') {
      unavailable.push({ id, reason: result.reason });
      // The recorded policy conservatively refuses this finite exact model.
      // This is an observed numeric boundary, not a mathematical singularity.
      if (label !== 'seeded' || id !== 60 || result.reason !== 'numeric-range-or-backward-error') failures.push({ label, id, unexpectedUnavailable: result.reason });
      continue;
    }
    if (result.parameters.length !== expected.xhat.length || result.residuals.length !== expected.y.length || result.residualCovariance.length !== expected.Cvv.length || result.diagnostics.length !== request.biasDirections.length) {
      failures.push({ label, id, error: 'shape mismatch' }); continue;
    }
    expected.xhat.forEach((row, i) => compare(result.parameters[i], fraction(row[0]), `x[${i}]`, id));
    expected.observedMinusAdjusted.forEach((row, i) => compare(result.residuals[i], fraction(row[0]), `v[${i}]`, id));
    expected.Cvv.forEach((row, i) => row.forEach((value, j) => compare(result.residualCovariance[i]?.[j], fraction(value), `Cvv[${i},${j}]`, id)));
    compare(result.aprioriWeightedResidualSum, fraction(expected.weightedResidualEnergy), 'SSE', id);
    for (const [index, actual] of result.diagnostics.entries()) {
      const expectedId = request.biasDirections[index].id, ref = expected.directions[expectedId];
      if (actual.id !== expectedId) { failures.push({ label, id, expectedId, actualId: actual.id }); continue; }
      if (ref.status === 'undetectable') {
        if (actual.status !== 'not-detectable-or-numerically-unresolved' || actual.generalizedW !== null) failures.push({ label, id, direction: expectedId, expected: 'undetectable', actual });
      } else if (actual.status !== 'resolved') failures.push({ label, id, direction: expectedId, expected: 'resolved', actual });
      else compare(actual.generalizedW, Number(ref.w), expectedId, id);
    }
    if (result.assumptionsVerified !== false || result.distributionEvaluation !== 'not-performed' || result.multipleComparisonAdjustment !== 'not-performed' || result.observationAction !== 'none' || result.decision !== 'not-evaluated') failures.push({ label, id, error: 'trust boundary changed' });
  }
  return { count: cases.length, resolved: cases.length - unavailable.length, unavailable, maximumScaledError, maximumErrorCase, tolerance: 1e-11 };
}
const analyticNames = ['golden', 'invarianceBase', 'rowPermutation', 'parameterColumnPermutation', 'negativeControlWrongDirectionPermutation', 'directionNegation', 'directionPositiveScale7', 'units1000ParameterUnitsChanged', 'units1000ParameterUnitsUnchanged', 'mixedRowUnitReexpression', 'priorCovarianceScale9', 'directionPlusModelSpace', 'modelSpaceShift'];
const analytical = compareCases(analyticNames.map(id => { const expected = oracle[id].result ?? oracle[id]; return { id, request: requestFor(expected, id), expected }; }), 'analytical');
const seeded = compareCases(random.cases.map(({ case: id, request, expected }) => ({ id, request, expected })), 'seeded');
const subnormal = [];
for (const multiplier of [1, 2, 3, 4, 5, 7, 100, 1e5, 1e10]) {
  const variance = multiplier * Number.MIN_VALUE;
  const input = requestFor(oracle.golden, `subnormal-${multiplier}`);
  input.observationIds = ['o0', 'o1']; input.designMatrix = [[1], [1]];
  input.observations = [0, Math.sqrt(variance)]; input.covariance.matrix = [[variance, 0], [0, variance]];
  input.biasDirections = [{ id: 'e1', coefficients: [1, 0] }];
  const result = diagnoseGeneralizedW(input);
  const entry = { multiplier, variance, status: result.modelStatus, reason: result.reason };
  subnormal.push(entry);
  if (result.modelStatus !== 'unavailable' || result.reason !== 'numeric-range-or-backward-error' || result.diagnostics.length !== 0) failures.push({ label: 'subnormal', ...entry });
}
const extremeMean = { cases: 0, unavailable: 0 };
for (const shift of [1e12, 1e14, 1e16]) for (const covarianceScale of [1, 1e-20, 1e-32]) for (const original of [[0, 0, 0], [0, 11, 2]]) {
  const input = requestFor(oracle.golden, 'extreme-mean-prior-boundary');
  input.observations = original.map(value => value + shift);
  input.covariance.matrix = input.covariance.matrix.map(row => row.map(value => value * covarianceScale));
  const result = diagnoseGeneralizedW(input);
  extremeMean.cases++;
  if (result.modelStatus === 'unavailable' && result.reason === 'numeric-range-or-backward-error' && result.diagnostics.length === 0) extremeMean.unavailable++;
  else failures.push({ label: 'extreme-mean', shift, covarianceScale, original, status: result.modelStatus, reason: result.reason });
}
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const summary = {
  review: 'independent-generalized-w-replay-1', pythonVersion: oracle.python, bunVersion: process.versions.bun ?? null,
  productSourceSha256: { 'kun/src/engineering/survey-generalized-w.ts': sha(sourcePath), 'kun/src/contracts/survey-generalized-w.ts': sha(contractPath) },
  method: 'Exact Python Fraction GLS and 70-digit Decimal w; no product imports in expected-value generation.',
  seed: random.seed, analytical, seeded, subnormal, extremeMean, failures,
  professionalSignoff: false, scope: 'pure numeric kernel only; no production model authentication, distributions, multiple comparisons or complete Baarda procedure'
};
writeFileSync(resolve(generated, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
