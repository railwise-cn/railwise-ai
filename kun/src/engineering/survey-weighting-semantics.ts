import type { AdjustmentResultV1 } from '../contracts/survey.js'

/** Interpret recorded weighting only; schema defaults do not prove old units. */
export function surveyWeightingSemantics(result: AdjustmentResultV1) {
  const relative = result.weightingBasis === 'relative-route-length'
  const defaultIds = result.relativeWeightDefaultLengthObservationIds
  const uniqueDefaultIds = defaultIds === undefined ? undefined : new Set(defaultIds)
  const equalWeightAssumption = defaultIds?.length === result.observations.length
    && uniqueDefaultIds?.size === defaultIds?.length && result.observations.every(row => uniqueDefaultIds.has(row.observationId))
  const recorded = result.weightingBasis === 'absolute-prior'
    ? result.unitWeightStdDevUnit === 'dimensionless' && result.varianceFactorUnit === 'dimensionless'
    : relative && result.unitWeightStdDevUnit === 'm' && result.varianceFactorUnit === 'm2'
      && result.relativeWeightReferenceLengthMetres === 1 && (defaultIds?.length === 0 || equalWeightAssumption)
  const estimated = result.varianceFactorEstimated && result.degreesOfFreedom > 0
  const scaleAvailable = recorded && (estimated || !relative && result.unknownCount > 0)
  const precisionAvailable = recorded && result.points.some(point => point.standardError !== undefined)
  return {
    weightingBasis: result.weightingBasis ?? 'not-recorded',
    unitWeightStdDevUnit: recorded ? result.unitWeightStdDevUnit : null,
    varianceFactorUnit: recorded ? result.varianceFactorUnit : null,
    unitWeightStdDev: scaleAvailable ? result.unitWeightStdDev : null,
    varianceFactor: scaleAvailable ? result.varianceFactor : null,
    precision: {
      maxPointStdDev: precisionAvailable ? result.precision.maxPointStdDev : null,
      relativePrecision: precisionAvailable ? result.precision.relativePrecision ?? null : null,
      passed: precisionAvailable ? result.precision.passed : null,
      assessmentStatus: precisionAvailable ? 'available' : 'not-evaluated'
    },
    ...(relative ? {
      relativeWeightReferenceLengthMetres: result.relativeWeightReferenceLengthMetres ?? null,
      relativeWeightDefaultLengthObservationIds: result.relativeWeightDefaultLengthObservationIds ?? null
    } : {}),
    weightingSemantics: {
      status: recorded ? 'recorded' : 'not-recorded',
      method: !recorded ? 'unknown' : relative ? 'P=L0/L; L0=1 metre; missing lengths are an explicit all-observation equal-weight assumption' : 'inverse-absolute-prior-observation-covariance',
      scaleStatus: scaleAvailable ? estimated ? 'estimated-posterior' : 'prior-fallback' : 'not-evaluated',
      unitWeightStdDev: scaleAvailable ? result.unitWeightStdDev : null,
      varianceFactor: scaleAvailable ? result.varianceFactor : null,
      precisionStatus: precisionAvailable ? 'available' : 'not-evaluated',
      meaning: !recorded ? 'Historical weighting and scale units were not recorded. Schema defaults are not verified units.' : relative
        ? 'Relative route-length weights supply no absolute prior precision. The estimated unit-weight standard error is for a 1-metre reference route, not per kilometre. The variance scale is in square metres and must not be compared with dimensionless 1. Without redundancy, retained nominal scale numbers are not assessed precision. Residuals are in metres, not sigma multiples.'
        : 'Scale factors relative to the absolute prior precision model are dimensionless. Priors may be declared or model defaults; they are not independently calibrated by this label.'
    }
  }
}

export function surveyWeightingReportLine(result: AdjustmentResultV1): string {
  const semantics = surveyWeightingSemantics(result)
  if (semantics.weightingSemantics.status !== 'recorded') return '定权依据及尺度单位：历史记录未完整保存，未核定；不能根据兼容默认值推定无量纲。'
  if (result.weightingBasis === 'absolute-prior') return '定权依据：绝对先验观测精度模型（包含声明精度或模型默认精度）；单位权中误差及方差尺度为无量纲。此说明不代表先验精度已独立标定。'
  return `定权依据：测段路长相对定权 P=L0/L，参考路长 L0=1 m；单位权中误差单位 m，方差尺度单位 m²（不是每千米中误差）。${result.relativeWeightDefaultLengthObservationIds?.length ? '所有测段均未提供路长，明确采用等权假设。' : ''}${semantics.weightingSemantics.scaleStatus === 'not-evaluated' ? '没有多余观测，绝对点位精度及方差尺度未评定；保留的名义尺度不能作为先验精度。' : '未提供绝对先验精度，未做 σ 比值筛查。'}`
}

export function surveyScaleReportLine(result: AdjustmentResultV1): string {
  const semantics = surveyWeightingSemantics(result)
  const unit = (value: 'dimensionless' | 'm' | 'm2' | null) => value === 'dimensionless' ? '无量纲' : value === 'm2' ? 'm²' : value ?? '未核定'
  const basis = semantics.weightingSemantics.scaleStatus === 'estimated-posterior' ? '后验估计'
    : semantics.weightingSemantics.scaleStatus === 'prior-fallback' ? '先验尺度' : '未评定'
  const pointPrecision = result.points.some(point => point.standardError !== undefined) ? `${result.precision.maxPointStdDev} ${result.linearUnit}` : '未评定'
  return `单位权中误差=${semantics.weightingSemantics.unitWeightStdDev ?? '未评定'}（${unit(semantics.unitWeightStdDevUnit)}）；方差尺度=${semantics.weightingSemantics.varianceFactor ?? '未评定'}（${unit(semantics.varianceFactorUnit)}，${basis}），最大点位中误差=${pointPrecision}，状态=${result.validation}，输入 SHA-256=${result.inputHash}`
}
