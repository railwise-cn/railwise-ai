import type { AdjustmentResultV1, SurveyNetworkV1 } from '../contracts/survey.js'
import { SurveyResidualStatisticV1, SurveyStatisticalSummaryV1 } from '../contracts/survey-statistical-semantics.js'

export const SEMANTIC_ADJUSTMENT_VERSION = 'workwise-survey-adjustment-9'
export const LEGACY_SEMANTIC_ADJUSTMENT_VERSION = 'workwise-survey-adjustment-8'

type Basis = Pick<SurveyResidualStatisticV1, 'method' | 'scaleBasis'>

export function residualStatistic(
  basis: Basis, value: number | undefined, degreesOfFreedom: number,
  unavailableReason?: Extract<SurveyResidualStatisticV1, { status: 'not-testable' }>['reason']
): SurveyResidualStatisticV1 {
  const common = { schemaVersion: 1 as const, ...basis, scope: 'descriptive-screening' as const, significance: 'not-evaluated' as const }
  const reason = degreesOfFreedom <= 0 ? 'no-redundancy' : unavailableReason
    ?? (value === undefined || !Number.isFinite(value) || value < 0 ? 'numeric-unavailable' : undefined)
  return SurveyResidualStatisticV1.parse(reason
    ? { ...common, status: 'not-testable', reason }
    : { ...common, status: 'available', value, threshold: 3, thresholdExceeded: value! > 3 })
}

/** Preserve algorithm-8 replay exactly; new weighting semantics apply to 9. */
export function withStatisticalSemantics(network: SurveyNetworkV1, result: AdjustmentResultV1): AdjustmentResultV1 {
  if (![SEMANTIC_ADJUSTMENT_VERSION, LEGACY_SEMANTIC_ADJUSTMENT_VERSION].includes(result.algorithmVersion)) return result
  const currentWeighting = result.algorithmVersion === SEMANTIC_ADJUSTMENT_VERSION
  const sources = new Map(network.observations.map((observation) => [observation.id, observation]))
  const observations = result.observations.map((observation) => {
    const sourceId = network.networkType === 'coordinate-transform' || network.networkType === 'gnss'
      ? observation.observationId.replace(/:[xyzh]$/, '') : observation.observationId
    const source = sources.get(sourceId)
    const relativeWeight = (network.networkType === 'leveling' || network.networkType === 'height-control') && source?.sigma === undefined
    const statistic = observation.residualStatistic ?? residualStatistic({
      method: relativeWeight ? 'weight-normalized-residual' : 'observation-sigma-ratio',
      scaleBasis: relativeWeight ? 'relative-weight' : source?.sigma === undefined ? 'default-prior' : 'declared-prior'
    }, source ? observation.standardizedResidual : undefined, result.degreesOfFreedom,
    currentWeighting && relativeWeight ? 'missing-absolute-precision' : undefined)
    // Old numeric aliases remain compatible when meaningful. Never serialize
    // an untestable component as zero, which looks like a successful check.
    const { standardizedResidual: _legacy, ...rest } = observation
    return { ...rest, ...(statistic.status === 'available' ? { standardizedResidual: statistic.value } : {}), residualStatistic: statistic }
  })
  const available = observations.filter((row) => row.residualStatistic.status === 'available')
  const flaggedCount = available.filter((row) => row.residualStatistic.status === 'available' && row.residualStatistic.thresholdExceeded).length
  const estimated = result.varianceFactorEstimated && result.degreesOfFreedom > 0
  const absoluteScale = !currentWeighting || result.weightingBasis === 'absolute-prior'
  const uncalibratedFallback = currentWeighting && result.weightingBasis === 'relative-route-length' && !estimated
  const statisticalSummary = SurveyStatisticalSummaryV1.parse({
    schemaVersion: 1,
    scope: 'descriptive-screening',
    numericalStatus: result.validation !== 'valid' || flaggedCount ? 'review-required'
      : !available.length ? 'not-evaluated' : available.length < observations.length ? 'incomplete' : 'clear',
    availableCount: available.length,
    unavailableCount: observations.length - available.length,
    flaggedCount,
    varianceBasis: estimated ? 'estimated-posterior' : !uncalibratedFallback && result.unknownCount > 0 && result.points.length > 0 ? 'prior-fallback' : 'not-estimated',
    varianceLog10RatioToUnit: absoluteScale && estimated && result.varianceFactor > 0 ? Math.log10(result.varianceFactor) : null,
    standardDeviationLog10RatioToUnit: absoluteScale && estimated && result.unitWeightStdDev > 0 ? Math.log10(result.unitWeightStdDev) : null,
    significance: 'not-evaluated',
    standardsConformity: 'not-evaluated'
  })
  const qualityFindings = result.qualityFindings.map((item) => item.code === 'outlier_candidate'
    ? { ...item, message: item.message.replace('标准化残差超过 3σ', '残差筛查比值超过 3（非显著性判定）') } : item)
  return { ...result, observations, statisticalSummary, qualityFindings }
}

export function statisticalEvidenceSheets(results: AdjustmentResultV1[]): Array<{ name: string; rows: string[][] }> {
  return [{
    name: 'survey_statistical_scope',
    rows: [['runId', 'semanticsVersion', 'scope', 'numericalStatus', 'availableCount', 'unavailableCount', 'flaggedCount', 'varianceBasis', 'varianceLog10RatioToUnit', 'standardDeviationLog10RatioToUnit', 'significance', 'standardsConformity'],
      ...results.map((r) => {
        const s = r.statisticalSummary
        return [r.runId, s ? '1' : '', s?.scope ?? 'legacy-unknown', s?.numericalStatus ?? 'not-evaluated',
          s ? String(s.availableCount) : '', s ? String(s.unavailableCount) : '', s ? String(s.flaggedCount) : '',
          s?.varianceBasis ?? 'unknown', String(s?.varianceLog10RatioToUnit ?? ''), String(s?.standardDeviationLog10RatioToUnit ?? ''), 'not-evaluated', 'not-evaluated']
      })]
  }, {
    name: 'survey_residual_semantics',
    rows: [['runId', 'observationId', 'method', 'scaleBasis', 'scope', 'status', 'reason', 'value', 'threshold', 'thresholdExceeded', 'significance'],
      ...results.flatMap((r) => r.observations.map((o) => {
        const s = o.residualStatistic
        return [r.runId, o.observationId, s?.method ?? 'legacy-unknown', s?.scaleBasis ?? 'unknown', s?.scope ?? 'unknown',
          s?.status ?? 'not-evaluated', s?.status === 'not-testable' ? s.reason : '', s?.status === 'available' ? String(s.value) : '',
          s?.status === 'available' ? String(s.threshold) : '', s?.status === 'available' ? String(s.thresholdExceeded) : '', 'not-evaluated']
      }))]
  }]
}

/** Missing semantics stay unknown, even when a legacy precision flag is true. */
export function statisticalReportLines(result: AdjustmentResultV1): string[] {
  const summary = result.statisticalSummary
  return [
    summary
      ? `统计口径：描述性筛查；数值状态=${summary.numericalStatus}；可筛查=${summary.availableCount}；不可检验=${summary.unavailableCount}；需复核=${summary.flaggedCount}；方差尺度=${summary.varianceBasis}`
      : '统计口径：历史记录未保存；不得从 precision.passed 推定显著性或规范符合。',
    '筛查阈值 3 不是正态/t 检验临界值；显著性未评定；工程规范符合性未评定。',
    ...(summary?.varianceLog10RatioToUnit !== null && summary?.varianceLog10RatioToUnit !== undefined ? [
      `相对解算名义单位尺度的 log10 比值：方差=${summary.varianceLog10RatioToUnit}；标准差=${summary.standardDeviationLog10RatioToUnit}。这不是坐标精度提高的结论。`
    ] : []),
    ...result.observations.slice(0, 200).map((row) => {
      const s = row.residualStatistic
      return `残差 ${row.observationId}：${row.residual} ${row.unit ?? '单位未记录'}；${s ? `方法=${s.method}；尺度=${s.scaleBasis}；${s.status === 'available' ? `筛查比值=${s.value}；需复核=${s.thresholdExceeded}` : `不可检验=${s.reason}`}` : '历史统计口径未记录'}`
    }),
    ...(result.observations.length > 200 ? [`正文仅列前 200 / ${result.observations.length} 项残差口径；完整逐项数据见 XLSX survey_residual_semantics。`] : [])
  ]
}
