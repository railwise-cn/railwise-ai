import type { SurveyXyErrorEllipseV1 } from '../contracts/survey.js'
import { SURVEY_COVARIANCE_SYMMETRY_TOLERANCE } from './survey-adjustment-core.js'

/** Extract explicitly indexed XY cofactors from the solver, never from a
 * legacy point.covariance whose shape and variance scale are unspecified. */
export function surveyErrorEllipse(
  cofactor: readonly (readonly number[])[], x: number, y: number,
  varianceFactor: number, varianceFactorEstimated: boolean
): SurveyXyErrorEllipseV1 {
  const values = [cofactor[x]?.[x], cofactor[x]?.[y], cofactor[y]?.[x], cofactor[y]?.[y]]
  if (x === y || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
    || !Number.isFinite(varianceFactor) || varianceFactor < 0
    || values.some(value => value === undefined || !Number.isFinite(value))) {
    throw new Error('Invalid XY cofactor indices or variance factor')
  }
  const [qxx, qxy, qyx, qyy] = values as [number, number, number, number]
  const magnitude = Math.max(Math.abs(qxx), Math.abs(qxy), Math.abs(qyx), Math.abs(qyy))
  // A dense inverse accumulates rounding across all unknowns; its XY block
  // cannot be judged as though it came from a two-operation calculation.
  // Use the canonical covariance symmetry policy, normalized to also work
  // with very small cofactors. Average only after this bounded check passes.
  const asymmetry = magnitude ? Math.abs(qxy / magnitude - qyx / magnitude) : 0
  if (qxx < 0 || qyy < 0 || asymmetry > SURVEY_COVARIANCE_SYMMETRY_TOLERANCE) throw new Error('XY cofactor is not symmetric positive semidefinite')
  const offDiagonal = qxy / 2 + qyx / 2
  // Normalize first to avoid overflow/underflow in eigenvalue calculations.
  const a = magnitude ? qxx / magnitude : 0
  const b = magnitude ? offDiagonal / magnitude : 0
  const d = magnitude ? qyy / magnitude : 0
  const radius = Math.hypot((a - d) / 2, b)
  const major = (a + d) / 2 + radius
  const determinant = a * d - b * b
  if (determinant < -64 * Number.EPSILON) throw new Error('XY cofactor is not positive semidefinite')
  const minor = major > 0 ? Math.max(0, determinant / major) : 0
  const scale = Math.sqrt(magnitude) * Math.sqrt(varianceFactor)
  const semiMajor = Math.sqrt(major) * scale
  const semiMinor = Math.sqrt(minor) * scale
  const covarianceXY: [number, number, number, number] = [qxx * varianceFactor, offDiagonal * varianceFactor, offDiagonal * varianceFactor, qyy * varianceFactor]
  if (![semiMajor, semiMinor, ...covarianceXY].every(Number.isFinite)) throw new Error('XY ellipse exceeds finite numeric range')
  const angle = Math.atan2(2 * b, a - d) / 2
  // An isotropic or zero ellipse has no unique axis orientation.
  const orientationRad = varianceFactor === 0 || radius <= 64 * Number.EPSILON
    ? null : ((angle % Math.PI) + Math.PI) % Math.PI
  return {
    algorithmVersion: 'survey-xy-error-ellipse-1', coordinatePlane: 'solution-xy',
    covarianceUnit: 'm2', covarianceXY, semiMajor, semiMinor, axisUnit: 'm',
    orientationRad, orientationConvention: 'positive-x-toward-positive-y-mod-pi',
    scale: 'unit-mahalanobis-radius', varianceBasis: varianceFactorEstimated ? 'a-posteriori' : 'a-priori'
  }
}
