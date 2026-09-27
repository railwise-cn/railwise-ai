import { describe, expect, it } from 'vitest'
import { surveyErrorEllipse } from './survey-error-ellipse.js'
import { surveyMatrix } from './survey-adjustment-core.js'
import { AdjustmentPointResultV1, SurveyXyErrorEllipseV1 } from '../contracts/survey.js'

describe('XY standard error ellipse', () => {
  it('accepts solver rounding using the canonical covariance symmetry policy', () => {
    // The Hilbert matrix is symmetric positive definite. Its exact inverse
    // has bottom-right block [[4410000,-1746360],[-1746360,698544]].
    // Pivoted elimination introduces about 3e-13 relative asymmetry here.
    const matrix = Array.from({ length: 6 }, (_, row) => Array.from({ length: 6 }, (_, column) => 1 / (row + column + 1)))
    const inverse = surveyMatrix.invert(matrix).inverse!
    const original = JSON.stringify(inverse)
    const actual = surveyErrorEllipse(inverse, 4, 5, 1, false)
    const expected = surveyErrorEllipse([[4410000, -1746360], [-1746360, 698544]], 0, 1, 1, false)
    expect(actual.semiMajor / expected.semiMajor).toBeCloseTo(1, 8)
    expect(actual.semiMinor / expected.semiMinor).toBeCloseTo(1, 8)
    expect(actual.orientationRad).toBeCloseTo(expected.orientationRad!, 8)
    expect(actual.covarianceXY[1]).toBe(actual.covarianceXY[2])
    expect(JSON.stringify(inverse)).toBe(original)
    // This policy does not turn a materially asymmetric matrix into evidence.
    expect(() => surveyErrorEllipse([[1, 0.25], [0.2500000001, 1]], 0, 1, 1, false)).toThrow()
    expect(() => surveyErrorEllipse([[1e-200, 0.25e-200], [0.2500000001e-200, 1e-200]], 0, 1, 1, false)).toThrow()
  })
  it('matches a diagonal analytic covariance and applies variance exactly once', () => {
    const result = surveyErrorEllipse([[4e-6, 0], [0, 1e-6]], 0, 1, 9, true)
    expect(result.semiMajor).toBeCloseTo(0.006, 14)
    expect(result.semiMinor).toBeCloseTo(0.003, 14)
    expect(result.orientationRad).toBe(0)
    expect(result.covarianceXY).toEqual([36e-6, 0, 0, 9e-6])
    expect(result.varianceBasis).toBe('a-posteriori')
    expect(SurveyXyErrorEllipseV1.safeParse(result).success).toBe(true)
  })

  it('recovers a rotated ellipse with eigenvalues 9 and 1 and a 30-degree major axis', () => {
    // R diag(9,1) R^T with theta=pi/6, independently expanded.
    const result = surveyErrorEllipse([[7, 2 * Math.sqrt(3)], [2 * Math.sqrt(3), 3]], 0, 1, 1, false)
    expect(result.semiMajor).toBeCloseTo(3, 14)
    expect(result.semiMinor).toBeCloseTo(1, 14)
    expect(result.orientationRad).toBeCloseTo(Math.PI / 6, 14)
    expect(result.varianceBasis).toBe('a-priori')
    expect(result.scale).toBe('unit-mahalanobis-radius')
  })

  it('uses explicit nonadjacent indices and is invariant under parameter reordering', () => {
    const matrix = [[3, 0, -2 * Math.sqrt(3)], [0, 1000, 0], [-2 * Math.sqrt(3), 0, 7]]
    const result = surveyErrorEllipse(matrix, 2, 0, 1, false)
    expect(result.semiMajor).toBeCloseTo(3, 14)
    expect(result.orientationRad).toBeCloseTo(5 * Math.PI / 6, 14)
    expect(result.covarianceXY[0]).toBe(7)
  })

  it('does not assign a misleading bearing to isotropic or zero ellipses', () => {
    expect(surveyErrorEllipse([[1, 0], [0, 1]], 0, 1, 1, false).orientationRad).toBeNull()
    expect(surveyErrorEllipse([[4, 0], [0, 1]], 0, 1, 0, true)).toMatchObject({ semiMajor: 0, semiMinor: 0, orientationRad: null })
    expect(surveyErrorEllipse([[0, 0], [0, 0]], 0, 1, 1, false).semiMajor).toBe(0)
    expect(surveyErrorEllipse([[0, 0], [0, 4]], 0, 1, 1, false).orientationRad).toBeCloseTo(Math.PI / 2, 14)
  })

  it('handles tiny covariance and rejects indefinite, asymmetric or missing inputs', () => {
    expect(surveyErrorEllipse([[4e-200, 0], [0, 1e-200]], 0, 1, 1, false).semiMajor).toBeCloseTo(2e-100, 110)
    for (const matrix of [[[1, 2], [2, 1]], [[1, 0], [0.1, 1]], [[-1, 0], [0, 1]], [[NaN, 0], [0, 1]], [[1]]]) {
      expect(() => surveyErrorEllipse(matrix, 0, 1, 1, false)).toThrow()
    }
    expect(() => surveyErrorEllipse([[1, 0], [0, 1]], 0, 0, 1, false)).toThrow()
    expect(() => surveyErrorEllipse([[1, 0], [0, 1]], 0, 1, -1, false)).toThrow()
    expect(() => surveyErrorEllipse([[1e308, 0], [0, 1e308]], 0, 1, 1e308, false)).toThrow()
  })

  it('keeps legacy point covariance opaque without inventing an ellipse', () => {
    const point = Object.freeze({ id: 'legacy', x: 1, y: 2, covariance: [1, 2, 3, 4, 5, 6] })
    expect(AdjustmentPointResultV1.parse(point)).toEqual(point)
    expect(AdjustmentPointResultV1.parse(point).xyErrorEllipse).toBeUndefined()
  })
})
