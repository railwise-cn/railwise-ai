import JSZip from 'jszip'
import { DeformationComparisonV1, type AdjustmentResultV1, type DeformationComparisonV1 as DeformationComparison } from '../contracts/survey.js'
import type { RailwiseProjectV1, SurveySourceEvidenceV1 } from '../contracts/engineering.js'
import type { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'
import type { SurveySegmentComparisonV1, SurveySegmentContinuityV1 } from '../contracts/survey-monitoring.js'
import type { MonitoringProfessionalReportV1 } from '../contracts/engineering-monitoring-report.js'

/** A stable, human-facing table projection. Numerical values are never
 * recomputed by the renderer; they are copied from the frozen review. */
export type ProfessionalReportTable = {
  id: string
  title: string
  columns: Array<{ key: string; label: string; unit?: string; numeric?: boolean; decimals?: 0 | 4 | 6 | 10 }>
  rows: Array<Record<string, string | number | boolean | null | undefined>>
  note?: string
}

export type ProfessionalReportModel = {
  title: string
  projectName: string
  taskType: string
  generatedAt: string
  reviewStatus: 'unsigned'
  reportStatus: 'draft'
  sourceBinding: Array<{ networkId: string; name?: string; sha256?: string; status: string; integrity: string; inputHash?: string; resultHash?: string; projectionHash?: string }>
  comparisonBinding?: Array<{
    comparisonId: string
    inputHash: string
    reference: ProfessionalComparisonPeriod
    current: ProfessionalComparisonPeriod
  }>
  segmentContinuity?: SurveySegmentContinuityV1
  monitoringReport?: MonitoringProfessionalReportV1
  tables: ProfessionalReportTable[]
  notes: string[]
  signoff: Array<{ role: string; name: string; date: string; signature: string }>
  appendix?: string[]
}

type ProfessionalComparisonPeriod = {
  adjustmentId: string
  epoch: string
  resultHash: string
  projectionHash: string
  networkId: string
  sourceName?: string
  sourceSha256: string
}

const labels: Record<string, string> = {
  'control-network': '控制网', 'leveling-network': '水准网', 'traverse-network': '导线网', resection: '任意设站', deformation: '变形监测', gnss: 'GNSS',
  leveling: '水准网', 'height-control': '高程控制网', 'plane-control': '平面控制网', traverse: '导线网',
  bound: '已绑定', unverified: '未核实', mismatch: '绑定不一致', unavailable: '不可用', verified: '已校验', failed: '校验失败', 'not-verified': '未校验',
  declared: '已声明', incomplete: '待补充', known: '已知点', unknown: '待定点', check: '检查点', station: '测站',
  loop: '闭合环', 'attached-route': '附合路线', pass: '通过', fail: '未通过', 'not-evaluated': '未评估',
  'a-priori': '先验', 'a-posteriori': '后验', 'not-estimated': '未估计', 'not-recorded': '未记录', valid: '计算有效', invalid: '计算无效', pending: '待处理',
  'source-binding': '来源绑定', 'source-coverage': '原始记录覆盖', reference: '基准声明', 'field-checks': '外业检核', closure: '独立闭合检核', precision: '精度限差', 'numerical-result': '数值结果', standards: '规范符合性',
  'no-network-snapshot': '未提供网络快照', 'input-mismatch': '输入版本已变化', 'source-unverified': '原件未核实', 'source-integrity-failed': '原件完整性校验失败',
  'no-height-route': '无可核验高差路线', 'closure-tolerance-not-configured': '未配置闭合限差', 'station-readings-not-evaluated': '测站原始读数未评估',
  'reference-missing': '基准信息不全', 'no-point-standard-errors': '无点位中误差', 'cross-covariance-unavailable': '点间协方差不可用',
  'standards-not-evaluated': '适用规范和符合性未评估', 'missing-source-anchor': '缺少原始记录定位', 'no-redundancy': '无多余观测',
  'numerical-result-invalid': '数值结果无效', 'precision-tolerance-not-configured': '未配置精度限差', 'plane-closures-not-evaluated': '平面网独立闭合未评估',
  settling: '沉降', heaving: '隆起', 'horizontal-moving': '水平移动', stable: '稳定', 'deformation-unknown': '待确认',
  convergence: '收敛', tilt: '倾斜', horizontal: '水平距离', spatial: '空间距离', vertical: '高程差',
  significant: '显著', 'not-significant': '未见显著',
  normal: '正常', warning: '提示', alarm: '报警', control: '控制', unresolved: '待确认',
  continuous: '记录连续', 'new-point': '新增测点', 'missing-prior': '期次待确认', draft: '待审查',
  'height-difference': '高差', distance: '距离', direction: '方向', angle: '角度', zenith: '天顶距', 'slope-distance': '斜距', 'gnss-baseline': 'GNSS 基线', 'coordinate-pair': '坐标配对'
}
const label = (value: string): string => labels[value] ?? value

/** Parse and recursively freeze persisted deformation evidence before projecting it.
 * This keeps the report tied to one immutable snapshot and prevents a caller from
 * changing nested epoch or result data while the output files are being built. */
function freezeDeformation<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeformation(child)
  }
  return value
}

function periodLabel(index: number, count: number): string {
  if (index === 0) return '原测期'
  if (index === count - 1) return '本期'
  return `第 ${index + 1} 期`
}

type ReviewEnvelope = { review: SurveyProfessionalReviewV1; adjustment?: AdjustmentResultV1; source?: SurveySourceEvidenceV1 }

/** Build the three report formats from one deterministic review projection. */
export function buildProfessionalReportModel(input: {
  project: Pick<RailwiseProjectV1, 'name' | 'taskType' | 'monitoringType' | 'workspace'> & { id?: string; signConvention?: string }
  reviews: readonly ReviewEnvelope[]
  segmentComparisons?: readonly SurveySegmentComparisonV1[]
  segmentContinuity?: SurveySegmentContinuityV1
  monitoringReport?: MonitoringProfessionalReportV1
  deformations?: readonly DeformationComparison[]
  generatedAt?: string
  title?: string
  appendix?: string[]
}): ProfessionalReportModel {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const taskType = label(input.project.taskType ?? input.project.monitoringType)
  // Zod parsing makes this boundary safe for persisted/legacy JSON while the
  // recursive freeze keeps every nested epoch and result immutable for the
  // duration of the report projection.
  const deformations = Object.freeze((input.deformations ?? []).map((value) => freezeDeformation(DeformationComparisonV1.parse(value))))
  if (new Set(deformations.map((comparison) => comparison.id)).size !== deformations.length) throw new Error('duplicate deformation comparison report identities')
  const sourceBinding = input.reviews.map(({ review, source }) => ({
    networkId: review.networkId,
    name: review.source.name ?? source?.source.name,
    sha256: review.source.sha256 ?? source?.source.sha256,
    status: review.source.status,
    integrity: review.source.integrity,
    inputHash: review.inputHash,
    resultHash: review.resultHash,
    projectionHash: review.projectionHash
  }))
  const tables: ProfessionalReportTable[] = []
  if (input.monitoringReport) {
    if (input.project.id !== undefined && input.monitoringReport.projectId !== input.project.id) throw new Error('monitoring report project binding does not match the professional deliverable')
    tables.push({ id: 'monitoring-daily', title: '监测日报与累计变化', columns: [
      { key: 'item', label: '监测项' }, { key: 'point', label: '测点' }, { key: 'initialEpoch', label: '初始期' },
      { key: 'previousEpoch', label: '上期' }, { key: 'currentEpoch', label: '本期' },
      { key: 'initial', label: '初始值', numeric: true }, { key: 'previous', label: '上期值', numeric: true },
      { key: 'current', label: '本期值', numeric: true }, { key: 'periodChange', label: '本次变化', numeric: true },
      { key: 'cumulative', label: '累计变化', numeric: true }, { key: 'cumulativeBasis', label: '累计口径' }, { key: 'rate', label: '变化速率', numeric: true },
      { key: 'unit', label: '单位' }, { key: 'threshold', label: '控制值', numeric: true },
      { key: 'projectUnit', label: '项目单位' }, { key: 'unitAlignment', label: '来源/项目单位' },
      { key: 'status', label: '状态' }, { key: 'continuity', label: '期次连续性' }, { key: 'unitStatus', label: '单位状态' }, { key: 'unitConflictUnits', label: '单位冲突' }, { key: 'source', label: '原始行/文件哈希' }
    ], rows: input.monitoringReport.rows.map(row => {
      if (input.project.id !== undefined && row.projectId !== input.project.id) throw new Error('monitoring daily row project binding mismatch')
      if (row.datasetId !== input.monitoringReport!.datasetId || row.sourceFileHash !== input.monitoringReport!.sourceFileHash) throw new Error('monitoring daily row source binding mismatch')
      return { item: row.monitoringItem, point: row.point, initialEpoch: row.initialTimestamp, previousEpoch: row.previousTimestamp,
        currentEpoch: row.currentTimestamp, initial: row.unitStatus === 'conflict' ? undefined : row.initialValue, previous: row.unitStatus === 'conflict' ? undefined : row.previousValue, current: row.currentValue,
        periodChange: row.periodChange, cumulative: row.cumulativeChange, cumulativeBasis: row.cumulativeBasis === 'source-cumulative' ? '来源累计字段' : row.cumulativeBasis === 'observed-value' ? '观测值首末差' : row.cumulativeBasis === 'mixed-unavailable' ? '累计字段混用，待确认' : '未记录', rate: row.ratePerDay, unit: row.unit,
        threshold: row.threshold, projectUnit: row.projectUnit, unitAlignment: row.unitAlignment === 'source-differs' ? '来源单位与项目单位不一致' : row.unitAlignment === 'not-declared' ? '来源未声明' : row.unitAlignment === 'aligned' ? '一致' : '未记录', status: label(row.thresholdStatus), continuity: label(row.continuity), unitStatus: row.unitStatus === 'conflict' ? '冲突' : '一致', unitConflictUnits: row.unitConflictUnits?.join(' / '), source: `${row.sourceRows.join(',')} / ${row.sourceFileHash}` }
    }), note: `数据集 ${input.monitoringReport.datasetId}；算法 ${input.monitoringReport.algorithmVersion}；所有行绑定原文件 SHA-256。日报当前状态：${label(input.monitoringReport.status)}。初始值是所选数据集的首条观测值，不代表已签认的工程基准。累计变化仅在累计字段完整一致时使用来源累计字段，否则使用全量观测值首末差；累计字段混用时待确认，不与观测值混算，也不等同于原始累计量。单位冲突仅保留证据，不跨单位计算变化或速率；来源单位与项目单位未统一时，单位关系和阈值判断待确认。同一时刻的重复记录不视为相邻期次，累计变化同样待确认。` })
    const unitConflicts = input.monitoringReport.rows.filter(row => row.unitStatus === 'conflict')
    if (unitConflicts.length) tables.push({ id: 'monitoring-unit-conflicts', title: '监测单位冲突原始期次', columns: [
      { key: 'item', label: '监测项' }, { key: 'point', label: '测点' }, { key: 'period', label: '期次' },
      { key: 'timestamp', label: '观测时间' }, { key: 'value', label: '原始值', numeric: true }, { key: 'unit', label: '原始单位' }, { key: 'source', label: '原始行' }
    ], rows: unitConflicts.flatMap(row => [
      { item: row.monitoringItem, point: row.point, period: '初始期', timestamp: row.initialTimestamp, value: row.initialValue, unit: row.initialUnit ?? row.unit, source: row.sourceRows[0] },
      ...(row.previousTimestamp ? [{ item: row.monitoringItem, point: row.point, period: '上期', timestamp: row.previousTimestamp, value: row.previousValue, unit: row.previousUnit ?? row.unit, source: row.sourceRows.at(-2) }] : []),
      { item: row.monitoringItem, point: row.point, period: '本期', timestamp: row.currentTimestamp, value: row.currentValue, unit: row.unit, source: row.sourceRows.at(-1) }
    ]), note: '保留各期数值、原始单位和原始行；未进行单位换算，变化、速率及阈值判断均待确认。完整原始记录保留在 normalized_data 中。' })
  }
  tables.push({
    id: 'source-binding', title: '资料与版本绑定',
    columns: [
      { key: 'networkId', label: '网络编号' }, { key: 'source', label: '源文件' },
      { key: 'status', label: '绑定状态' }, { key: 'integrity', label: '原件完整性' }
    ], rows: input.reviews.map(({ review, source }) => ({ networkId: review.networkId, source: review.source.name ?? source?.source.name ?? '不可用', status: label(review.source.status), integrity: label(review.source.integrity) })),
    note: '完整输入、结果和投影摘要在版本附录及专业成果 JSON 中保留。'
  })
  for (const { review, adjustment } of input.reviews) {
    const prefix = input.reviews.length > 1 ? `${review.networkId} · ` : ''
    const heightOnly = review.summary.networkType === 'leveling' || review.summary.networkType === 'height-control'
    tables.push({
      id: `${review.networkId}-reference`, title: `${prefix}基准与已知控制点`,
      columns: [
        { key: 'id', label: '点号' }, { key: 'role', label: '类型' }, { key: 'x', label: 'X', unit: 'm', numeric: true },
        { key: 'y', label: 'Y', unit: 'm', numeric: true }, { key: 'height', label: '高程', unit: 'm', numeric: true }
      ], rows: review.reference.knownPoints.map(point => ({ id: point.id, role: label(point.pointClass ?? 'known'), x: point.x, y: point.y, height: point.height })),
      note: heightOnly ? `高程基准：${review.reference.verticalDatum ?? '不可用'}；单位：m；状态：${label(review.reference.status)}` : `坐标系：${review.reference.coordinateSystem ?? '不可用'}；投影：${review.reference.projection ?? '不可用'}；高程基准：${review.reference.verticalDatum ?? '不可用'}；单位：m / rad；状态：${label(review.reference.status)}`
    })
    tables.push({
      id: `${review.networkId}-closures`, title: `${prefix}闭合与附合检核`,
      columns: [
        { key: 'id', label: '线路' }, { key: 'kind', label: '类型' }, { key: 'from', label: '起点' }, { key: 'to', label: '终点' },
        { key: 'observed', label: '观测高差和', unit: 'm', numeric: true }, { key: 'known', label: '已知高差', unit: 'm', numeric: true },
        { key: 'length', label: '线路长度', unit: 'm', numeric: true }, { key: 'stationCount', label: '测站数', numeric: true },
        { key: 'misclosure', label: '闭合差', unit: 'mm', numeric: true }, { key: 'tolerance', label: '限差', unit: 'mm', numeric: true },
        { key: 'toleranceBasis', label: '限差依据' }, { key: 'status', label: '状态' }
      ], rows: review.closures.map(closure => ({ id: closure.id, kind: label(closure.kind), from: closure.from, to: closure.to, observed: closure.sumObservedMetres, known: closure.knownHeightDifferenceMetres, length: closure.totalLengthMetres, stationCount: closure.stationCount, misclosure: closure.misclosureMetres * 1000, tolerance: closure.toleranceMetres === undefined ? undefined : closure.toleranceMetres * 1000, toleranceBasis: closure.toleranceBasis ?? '未记录', status: label(closure.status) })),
      note: review.closures.length ? '闭合差与限差以 mm 显示，观测和已知高差以 m 显示；线路长度、测站数和限差依据只在原始资料明确时列出，限差未配置时不得推定合格。' : '闭合线路：不可用或未评估。'
    })
    const closureMemberships = new Map<string, string[]>()
    for (const closure of review.closures) for (const member of closure.members) {
      const memberships = closureMemberships.get(member.observationId) ?? []
      memberships.push(`${closure.id}（${member.direction === 1 ? '正向' : '反向'}）`)
      closureMemberships.set(member.observationId, memberships)
    }
    tables.push({
      id: `${review.networkId}-network-topology`, title: `${prefix}网形与测段索引`,
      columns: [
        { key: 'observationId', label: '观测号' }, { key: 'type', label: '类型' }, { key: 'from', label: '起点' }, { key: 'to', label: '终点' },
        { key: 'routeLength', label: '测段长度', unit: 'm', numeric: true }, { key: 'observed', label: '观测值', unit: 'm / rad', numeric: true }, { key: 'adjusted', label: '平差值', unit: 'm / rad', numeric: true },
        { key: 'unit', label: '单位' }, { key: 'closurePath', label: '闭合/附合路径' }, { key: 'source', label: '原始定位' }
      ], rows: review.observations.map(observation => ({
        observationId: observation.observationId, type: label(observation.type), from: observation.from, to: observation.to,
        routeLength: observation.routeLengthMetres, observed: observation.observed, adjusted: observation.adjusted, unit: observation.unit ?? observation.rawUnit,
        closurePath: closureMemberships.get(observation.observationId)?.join('；') ?? '未纳入独立闭合',
        source: [observation.sourceRecordId, observation.sourceLocator, observation.sourceRow === undefined ? undefined : `第 ${observation.sourceRow} 行`].filter(Boolean).join(' / ') || '不可用',
        sourceLocator: observation.sourceLocator, sourceRow: observation.sourceRow
      })),
      note: '本表以观测为边、起讫点为节点，保留闭合/附合线路中的有向成员关系；“未纳入独立闭合”不代表观测无效。数值来自冻结的专业审查投影，不在报告层重算。'
    })
    tables.push({
      id: `${review.networkId}-summary`, title: `${prefix}平差统计与检查状态`,
      columns: [
        { key: 'networkType', label: '网型' }, { key: 'observationCount', label: '观测数', numeric: true }, { key: 'pointCount', label: '点数', numeric: true },
        { key: 'dof', label: '自由度', numeric: true }, { key: 'unitWeightStdDev', label: '单位权中误差', unit: adjustment?.unitWeightStdDevUnit === 'dimensionless' ? '无量纲' : adjustment?.unitWeightStdDevUnit ?? '未记录', numeric: true },
        { key: 'varianceFactor', label: '方差因子', unit: adjustment?.varianceFactorUnit === 'dimensionless' ? '无量纲' : adjustment?.varianceFactorUnit ?? '未记录', numeric: true }, { key: 'varianceBasis', label: '方差依据' }, { key: 'validation', label: '计算状态' }
      ], rows: [{ networkType: label(review.summary.networkType ?? '不可用'), observationCount: review.summary.observationCount, pointCount: review.summary.pointCount, dof: review.summary.degreesOfFreedom, unitWeightStdDev: review.summary.unitWeightStdDev, varianceFactor: review.summary.varianceFactor, varianceBasis: label(review.summary.varianceBasis), validation: label(review.summary.validation) }],
      note: `残差范数仅作描述性统计，不等同闭合差；${review.residualNorms.length ? review.residualNorms.map(item => `${item.value} ${item.unit}（${item.count} 条）`).join('，') : '残差范数不可用'}`
    })
    tables.push({
      id: `${review.networkId}-points`, title: `${prefix}点位成果与精度`,
      columns: [
        { key: 'id', label: '点号' }, { key: 'role', label: '类型' }, { key: 'x', label: 'X', unit: 'm', numeric: true }, { key: 'y', label: 'Y', unit: 'm', numeric: true },
        { key: 'height', label: '高程', unit: 'm', numeric: true }, { key: 'correctionX', label: 'X 改正数', unit: 'mm', numeric: true },
        { key: 'correctionY', label: 'Y 改正数', unit: 'mm', numeric: true }, { key: 'correctionHeight', label: '高程改正数', unit: 'mm', numeric: true },
        { key: 'standardError', label: '点位中误差', unit: 'mm', numeric: true }, { key: 'precisionBasis', label: '精度依据' }
      ], rows: review.points.map(point => ({ id: point.id, role: label(point.role), x: point.x, y: point.y, height: point.height, correctionX: point.correctionX === undefined ? undefined : point.correctionX * 1000, correctionY: point.correctionY === undefined ? undefined : point.correctionY * 1000, correctionHeight: point.correctionHeight === undefined ? undefined : point.correctionHeight * 1000, standardError: point.standardError === undefined ? undefined : point.standardError * 1000, precisionBasis: label(point.precisionBasis) })),
      note: review.weakestPoint.status === 'available' ? `最弱点：${review.weakestPoint.pointId ?? '不可用'}，点位中误差 ${review.weakestPoint.standardErrorMetres ?? '不可用'} m。最弱边：未评估（${label(review.weakestEdge.reason)}）。` : `最弱点未评估（${label(review.weakestPoint.reason ?? '不可用')}）；最弱边：未评估（${label(review.weakestEdge.reason)}）。`
    })
    tables.push({
      id: `${review.networkId}-observations`, title: `${prefix}观测值、改正数与残差`,
      columns: [
        { key: 'id', label: '观测号' }, { key: 'type', label: '类型' }, { key: 'fromTo', label: '起讫点' },
        { key: 'observed', label: '观测值', numeric: true }, { key: 'adjusted', label: '平差值', numeric: true },
        { key: 'unit', label: '值单位' }, { key: 'correction', label: '改正数', numeric: true }, { key: 'residual', label: '残差', numeric: true }, { key: 'residualUnit', label: '改正/残差单位' },
        { key: 'screening', label: '残差筛查' }, { key: 'source', label: '原始定位' }
      ], rows: review.observations.map(observation => {
        const multiplier = observation.unit === 'm' ? 1000 : observation.unit === 'rad' ? 180 / Math.PI * 3600 : 1
        return { id: observation.observationId, type: label(observation.type), fromTo: [observation.from, observation.to].filter(Boolean).join(' → ') || '不可用', observed: observation.observed, adjusted: observation.adjusted, correction: observation.correction * multiplier, residual: observation.residual * multiplier, unit: observation.unit ?? observation.rawUnit ?? '不可用', residualUnit: observation.unit === 'm' ? 'mm' : observation.unit === 'rad' ? '角秒' : '不可用', screening: observation.screeningStatus === 'available' ? (observation.outlierCandidate ? '异常候选' : '未见候选') : '未评估', source: observation.sourceRecordId ?? (observation.sourceRow ? `第 ${observation.sourceRow} 行` : '不可用') }
      }), note: '观测值与平差值保持 m / rad；线性改正数和残差以 mm 显示，角度以角秒显示。'
    })
    if (review.points.some(point => point.xyErrorEllipse)) tables.push({
      id: `${review.networkId}-ellipses`, title: `${prefix}XY 标准误差椭圆`,
      columns: [{ key: 'id', label: '点号' }, { key: 'major', label: '长半轴', unit: 'mm', numeric: true }, { key: 'minor', label: '短半轴', unit: 'mm', numeric: true }, { key: 'orientation', label: '轴向', unit: 'rad', numeric: true }, { key: 'basis', label: '方差依据' }],
      rows: review.points.flatMap(point => point.xyErrorEllipse ? [{ id: point.id, major: point.xyErrorEllipse.semiMajor * 1000, minor: point.xyErrorEllipse.semiMinor * 1000, orientation: point.xyErrorEllipse.orientationRad, basis: label(point.xyErrorEllipse.varianceBasis) }] : []),
      note: '解算 XY 平面；轴向由 +X 转向 +Y，模 π；单位马氏半径，非置信百分比。缺唯一轴向时为不可用；GNSS XY 不等同当地东/北。'
    })
    tables.push({
      id: `${review.networkId}-checks`, title: `${prefix}质量检查与复核状态`,
      columns: [{ key: 'id', label: '检查项' }, { key: 'status', label: '状态' }, { key: 'reason', label: '依据/缺项原因' }],
      rows: review.checks.map(check => ({ id: label(check.id), status: label(check.status), reason: label(check.reason ?? '无') }))
    })
    if (heightOnly) {
      for (const suffix of ['reference', 'points']) {
        const table = tables.find(item => item.id === `${review.networkId}-${suffix}`)!
        table.columns = table.columns.filter(column => !['x', 'y', 'correctionX', 'correctionY'].includes(column.key))
      }
    }
  }
  const comparisonBinding: NonNullable<ProfessionalReportModel['comparisonBinding']> = []
  const comparisonVersions: ProfessionalReportTable['rows'] = []
  const comparisons = input.segmentComparisons ?? []
  if (new Set(comparisons.map(comparison => comparison.id)).size !== comparisons.length) throw new Error('duplicate segment comparison report identities')
  for (const [index, comparison] of comparisons.entries()) {
    const period = (adjustmentId: string, epoch: string, resultHash: string, projectionHash: string): { binding: ProfessionalComparisonPeriod; review: SurveyProfessionalReviewV1 } => {
      const envelope = input.reviews.find(item => item.review.runId === adjustmentId && item.review.projectId === comparison.projectId)
      const review = envelope?.review
      if (!review || review.resultHash !== resultHash || review.projectionHash !== projectionHash
        || review.source.status !== 'bound' || review.source.integrity !== 'verified' || !review.source.sha256) {
        throw new Error('segment comparison report requires matching frozen professional reviews and verified sources')
      }
      return { review, binding: { adjustmentId, epoch, resultHash, projectionHash, networkId: review.networkId, sourceName: review.source.name ?? envelope.source?.source.name, sourceSha256: review.source.sha256 } }
    }
    const reference = period(comparison.referenceAdjustmentId, comparison.referenceEpoch, comparison.referenceResultHash, comparison.referenceProjectionHash)
    const current = period(comparison.currentAdjustmentId, comparison.currentEpoch, comparison.currentResultHash, comparison.currentProjectionHash)
    comparisonBinding.push({ comparisonId: comparison.id, inputHash: comparison.inputHash, reference: reference.binding, current: current.binding })
    const prefix = comparisons.length > 1 ? `比较 ${index + 1} · ` : ''
    const note = `比较记录：${comparison.id}；原测期：${comparison.referenceEpoch}；本期：${comparison.currentEpoch}。差值为本期减原测的测段高差变化，不代表测点绝对沉降；规范符合性未评估。`
    const comparisonColumns: ProfessionalReportTable['columns'] = [
      { key: 'id', label: '测段' }, { key: 'from', label: '起点' }, { key: 'to', label: '终点' },
      { key: 'reference', label: '原测高差', unit: 'm', numeric: true }, { key: 'current', label: '本期高差', unit: 'm', numeric: true },
      { key: 'change', label: '本期减原测', unit: 'mm', numeric: true }, { key: 'standards', label: '规范符合性' }
    ]
    for (const basis of ['observed', 'adjusted'] as const) {
      tables.push({ id: `${comparison.id}-segment-${basis}`, title: `${prefix}${basis === 'observed' ? '测段观测高差比较' : '测段平差高差比较'}`,
        columns: comparisonColumns.map(column => ({ ...column })), rows: comparison.segments.map(segment => ({
          id: segment.id, from: segment.from, to: segment.to,
          reference: basis === 'observed' ? segment.referenceObservedMetres : segment.referenceAdjustedMetres,
          current: basis === 'observed' ? segment.currentObservedMetres : segment.currentAdjustedMetres,
          change: (basis === 'observed' ? segment.observedChangeMetres : segment.adjustedChangeMetres) * 1000,
          standards: label(segment.standardsConformity)
        })), note })
    }
    tables.push({ id: `${comparison.id}-segment-members`, title: `${prefix}测段两期成员与来源`, columns: [
      { key: 'segmentId', label: '测段' }, { key: 'period', label: '期次' }, { key: 'epoch', label: '观测期' },
      { key: 'adjustmentId', label: '平差运行' }, { key: 'source', label: '源文件' }, { key: 'observationId', label: '观测号' }, { key: 'sourceRecordId', label: '原始定位' }
    ], rows: comparison.segments.flatMap(segment => [{ period: '原测期', ...reference, ids: segment.referenceObservationIds }, { period: '本期', ...current, ids: segment.currentObservationIds }].flatMap(item => item.ids.map(id => {
        const observation = item.review.observations.find(row => row.observationId === id)
        if (!observation?.sourceRecordId) throw new Error('segment comparison report member is not anchored in its frozen period review')
        return { segmentId: segment.id, period: item.period, epoch: item.binding.epoch, adjustmentId: item.binding.adjustmentId,
          source: item.binding.sourceName ?? '不可用', observationId: id, sourceRecordId: observation.sourceRecordId }
      }))), note: '观测编号按所选测段路线顺序逐行保留；路径方向由起讫点确定。完整源文件、结果及投影 SHA-256 见版本附录。' })
    comparisonVersions.push({ networkId: comparison.id, kind: '比较输入', hash: comparison.inputHash })
    for (const item of [{ name: '原测期', ...reference.binding }, { name: '本期', ...current.binding }]) {
      comparisonVersions.push(...[{ kind: '结果', hash: item.resultHash }, { kind: '成果投影', hash: item.projectionHash }, { kind: '源文件', hash: item.sourceSha256 }].map(version => ({ networkId: comparison.id, kind: `${item.name}${version.kind}`, hash: version.hash })))
    }
  }
  if (input.segmentContinuity) {
    if ((input.project.id !== undefined && input.segmentContinuity.projectId !== input.project.id) || input.segmentContinuity.comparisonIds.length !== comparisons.length
      || input.segmentContinuity.comparisonIds.some((id, index) => id !== comparisons[index]?.id)) throw new Error('segment continuity report binding does not match selected comparisons')
    tables.push({ id: 'segment-continuity', title: '多期测段累计变化', columns: [
      { key: 'id', label: '测段' }, { key: 'from', label: '起点' }, { key: 'to', label: '终点' },
      { key: 'observed', label: '观测累计变化', unit: 'mm', numeric: true }, { key: 'adjusted', label: '平差累计变化', unit: 'mm', numeric: true }, { key: 'periods', label: '期次链' }
    ], rows: input.segmentContinuity.segments.map(segment => ({ id: segment.id, from: segment.from, to: segment.to,
      observed: segment.observedCumulativeChangeMetres * 1000, adjusted: segment.adjustedCumulativeChangeMetres * 1000,
      periods: segment.periodChanges.map(period => `${period.referenceEpoch} → ${period.currentEpoch}`).join('；')
    })), note: `仅累加明确选择的相邻比较：${input.segmentContinuity.firstEpoch} → ${input.segmentContinuity.currentEpoch}。累计值不替代各期观测/平差高差表；规范符合性未评估。` })
  }
  const deformationVersions: ProfessionalReportTable['rows'] = []
  for (const comparison of deformations) {
    const prefix = deformations.length > 1 ? `变形比较 ${comparison.id} · ` : ''
    const comparisonNote = `变形比较：${comparison.id}；原测期：${comparison.referenceEpoch}；本期：${comparison.currentEpoch}；历时：${comparison.durationDays} d；算法：${comparison.algorithmVersion}。数值由已冻结的变形比较结果投影，未在报告层重新计算。`
    tables.push({ id: `${comparison.id}-deformation-epochs`, title: `${prefix}多期连续性与来源`, columns: [
      { key: 'comparisonId', label: '比较编号' }, { key: 'period', label: '期次' }, { key: 'observationEpoch', label: '观测期' },
      { key: 'adjustmentId', label: '平差运行' }, { key: 'resultId', label: '结果编号' }, { key: 'networkId', label: '网络编号' },
      { key: 'inputHash', label: '输入 SHA-256' }, { key: 'resultHash', label: '结果 SHA-256' }
    ], rows: comparison.epochs.map((epoch, index) => ({
      comparisonId: comparison.id, period: periodLabel(index, comparison.epochs.length), observationEpoch: epoch.observationEpoch,
      adjustmentId: epoch.adjustmentId, resultId: epoch.resultId, networkId: epoch.networkId, inputHash: epoch.inputHash, resultHash: epoch.resultHash
    })), note: comparisonNote })
    tables.push({ id: `${comparison.id}-deformation-points`, title: `${prefix}点位变形成果`, columns: [
      { key: 'pointId', label: '点号' }, { key: 'dX', label: 'ΔX', unit: 'mm', numeric: true }, { key: 'dY', label: 'ΔY', unit: 'mm', numeric: true },
      { key: 'dH', label: 'ΔH', unit: 'mm', numeric: true }, { key: 'settlement', label: '沉降', unit: 'mm', numeric: true },
      { key: 'horizontalDisplacement', label: '水平位移', unit: 'mm', numeric: true }, { key: 'spatialDisplacement', label: '空间位移', unit: 'mm', numeric: true },
      { key: 'settlementPerDay', label: '沉降速率', unit: 'mm/day', numeric: true }, { key: 'horizontalPerDay', label: '水平速率', unit: 'mm/day', numeric: true },
      { key: 'spatialPerDay', label: '空间速率', unit: 'mm/day', numeric: true }, { key: 'trend', label: '趋势' },
      { key: 'combinedStandardError', label: '联合中误差', unit: 'mm', numeric: true }, { key: 'standardizedDisplacement', label: '标准化位移', unit: 'σ', numeric: true },
      { key: 'significant', label: '显著性' }
    ], rows: comparison.points.map((point) => ({
      pointId: point.pointId,
      dX: point.dX === undefined ? undefined : point.dX * 1000,
      dY: point.dY === undefined ? undefined : point.dY * 1000,
      dH: point.dH === undefined ? undefined : point.dH * 1000,
      settlement: point.settlement === undefined ? undefined : point.settlement * 1000,
      horizontalDisplacement: point.horizontalDisplacement === undefined ? undefined : point.horizontalDisplacement * 1000,
      spatialDisplacement: point.spatialDisplacement * 1000,
      settlementPerDay: point.rates.settlementPerDay === undefined ? undefined : point.rates.settlementPerDay * 1000,
      horizontalPerDay: point.rates.horizontalPerDay === undefined ? undefined : point.rates.horizontalPerDay * 1000,
      spatialPerDay: point.rates.spatialPerDay * 1000,
      trend: point.trend === 'unknown' ? label('deformation-unknown') : label(point.trend),
      combinedStandardError: point.combinedStandardError === undefined ? undefined : point.combinedStandardError * 1000,
      standardizedDisplacement: point.standardizedDisplacement,
      significant: point.significant === undefined ? '未评估' : point.significant ? label('significant') : label('not-significant')
    })), note: `${comparisonNote}；线性位移以 mm、速率以 mm/day 显示；沉降正值表示高程降低。显著性沿用变形结果中的标准化位移判定。` })
    tables.push({ id: `${comparison.id}-deformation-pairs`, title: `${prefix}点对与结构几何变化`, columns: [
      { key: 'pairId', label: '点对编号' }, { key: 'kind', label: '类型' }, { key: 'pointPair', label: '点对' }, { key: 'distanceMode', label: '距离定义' },
      { key: 'referenceDistance', label: '原测距离', unit: 'm', numeric: true }, { key: 'currentDistance', label: '本期距离', unit: 'm', numeric: true },
      { key: 'convergence', label: '收敛', unit: 'mm', numeric: true }, { key: 'convergenceRatePerDay', label: '收敛速率', unit: 'mm/day', numeric: true },
      { key: 'baselineM', label: '基线', unit: 'm', numeric: true }, { key: 'differentialSettlement', label: '差异沉降', unit: 'mm', numeric: true },
      { key: 'tilt', label: '倾斜', unit: 'ratio', numeric: true }
    ], rows: comparison.pairs.map((pair) => ({
      pairId: pair.id, kind: label(pair.kind), pointPair: `${pair.firstPointId} → ${pair.secondPointId}`, distanceMode: label(pair.distanceMode),
      referenceDistance: pair.referenceDistance,
      currentDistance: pair.currentDistance,
      convergence: pair.convergence === undefined ? undefined : pair.convergence * 1000,
      convergenceRatePerDay: pair.convergenceRatePerDay === undefined ? undefined : pair.convergenceRatePerDay * 1000,
      baselineM: pair.baselineM,
      differentialSettlement: pair.differentialSettlement === undefined ? undefined : pair.differentialSettlement * 1000,
      tilt: pair.tilt
    })), note: `${comparisonNote}；距离和基线以 m，收敛与差异沉降以 mm，收敛速率以 mm/day，倾斜以无量纲 ratio 显示；收敛正值表示点间距减小。` })
    deformationVersions.push({ networkId: comparison.id, kind: '变形比较输入', hash: comparison.inputHash })
    comparison.epochs.forEach((epoch, index) => {
      const period = periodLabel(index, comparison.epochs.length)
      deformationVersions.push({ networkId: comparison.id, kind: `变形${period}输入`, hash: epoch.inputHash }, { networkId: comparison.id, kind: `变形${period}结果`, hash: epoch.resultHash })
    })
  }
  const monitoringVersions: ProfessionalReportTable['rows'] = input.monitoringReport ? [{ networkId: input.monitoringReport.datasetId, kind: '监测数据集源文件', hash: input.monitoringReport.sourceFileHash }] : []
  tables.push({ id: 'version-appendix', title: '版本与证据摘要附录', columns: [{ key: 'networkId', label: comparisons.length || deformations.length || input.monitoringReport ? '网络/比较/数据集编号' : '网络编号' }, { key: 'kind', label: '版本项' }, { key: 'hash', label: '完整 SHA-256' }], rows: [...input.reviews.flatMap(({ review }) => [{ networkId: review.networkId, kind: '输入', hash: review.inputHash }, { networkId: review.networkId, kind: '结果', hash: review.resultHash }, { networkId: review.networkId, kind: '成果投影', hash: review.projectionHash }]), ...comparisonVersions, ...deformationVersions, ...monitoringVersions] })
  for (const table of tables) for (const column of table.columns) {
    if (!column.numeric) continue
    column.decimals = table.id === 'monitoring-daily' ? 4
      : ['observationCount', 'pointCount', 'dof'].includes(column.key) ? 0
      : column.unit === 'mm' || column.unit === 'mm/day' || ['correction', 'residual'].includes(column.key) ? 4
      : ['observed', 'adjusted'].includes(column.key) && table.id.endsWith('-observations') ? 10 : 6
  }
  const notes = [
    '本成果由确定性计算结果投影生成，数值未由 AI 改写。',
    '“未评估/不可用”表示当前资料或合同不足，不代表通过、合格或安全。',
    '本稿未完成专业复核、审核、批准和签名；签认栏保留空白。',
    '显示舍入：m 为 6 位小数，mm 改正/残差为 4 位，观测/平差值为 10 位；存储数值保留原精度。',
    ...(input.monitoringReport ? [`符号约定：${input.project.signConvention === 'positive' ? '正值为正向变形' : input.project.signConvention === 'negative' ? '负值为正向变形' : input.project.signConvention === 'custom' ? '自定义（以项目约定为准）' : input.project.signConvention ?? '未声明，请复核资料的正负方向'}。变化速率单位为各行所列单位/天。`] : []),
    ...(deformations.length ? ['变形成果表中的线性变形量和速率分别以 mm、mm/day 显示；距离和基线保留 m。'] : [])
  ]
  return { title: input.title ?? `${input.project.name} 测量平差专业成果册`, projectName: input.project.name, taskType, generatedAt, reviewStatus: 'unsigned', reportStatus: 'draft', sourceBinding, ...(comparisonBinding.length ? { comparisonBinding } : {}), ...(input.segmentContinuity ? { segmentContinuity: input.segmentContinuity } : {}), ...(input.monitoringReport ? { monitoringReport: input.monitoringReport } : {}), tables, notes, signoff: [{ role: '编制', name: '', date: '', signature: '' }, { role: '复核', name: '', date: '', signature: '' }, { role: '批准', name: '', date: '', signature: '' }], ...(input.appendix ? { appendix: input.appendix } : {}) }
}

function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }

/** Presentation boundary shared by all ordinary professional exports. Internal
 * identities and the legacy report appendix remain in the evidence model/JSON;
 * they are never substituted for source filenames, original rows or survey
 * quantities in an engineer's report. This projection does not change numbers. */
export function professionalReportPresentation(model: ProfessionalReportModel): ProfessionalReportModel {
  const sourceNames = new Map(model.sourceBinding.map((source, index) => [source.networkId, `资料 ${index + 1}${source.name ? ` · ${source.name}` : ''}`]))
  const deformationNames = new Map(model.tables.filter(table => table.id.endsWith('-deformation-epochs')).map((table, index) => [table.id.slice(0, -'-deformation-epochs'.length), `变形比较 ${index + 1}`]))
  const observationNames = new Map<string, Map<string, string>>()
  const closureNames = new Map<string, Map<string, string>>()
  const observationSources = new Map<string, string>()
  const sourceKey = (networkId: string | undefined, observationId: string) => JSON.stringify([networkId, observationId])
  /**
   * Source anchors created by the frozen WorkWise JSON importer are useful in
   * evidence JSON, but are implementation paths rather than a professional
   * report location. Keep real vendor/XML/worksheet locators untouched and
   * translate only the importer-owned observation identity/path pair.
   */
  const professionalSourcePosition = (locator: unknown, sourceRow: unknown, sourceValue: unknown): string | undefined => {
    const locatorText = typeof locator === 'string' ? locator.trim() : ''
    const observationPath = locatorText.match(/^WorkWise JSON:network\.observations\[(\d+)\]$/i)
    if (observationPath) return `原始观测记录第 ${Number(observationPath[1]) + 1} 条`
    if (locatorText) return locatorText
    if (typeof sourceRow === 'number') return `第 ${sourceRow} 行`
    // Legacy review projections may retain an explicit professional row
    // anchor only inside the already-visible source text (for example
    // "record_0 / 第 6 行"). Preserve that anchor, without inferring a row
    // from display order.
    const sourceText = typeof sourceValue === 'string' ? sourceValue : ''
    return sourceText.match(/第\s*\d+\s*行/)?.[0]
  }
  for (const table of model.tables.filter(table => table.id.endsWith('-network-topology'))) {
    const source = model.sourceBinding.find(binding => table.id === `${binding.networkId}-network-topology`)
    if (!source) continue
    const names = new Map<string, string>()
    table.rows.forEach((row, index) => {
      const id = String(row.observationId)
      const position = professionalSourcePosition(row.sourceLocator, row.sourceRow, row.source)
      observationSources.set(sourceKey(source.networkId, id), position ? [source.name, position].filter(Boolean).join(' · ') : '原始定位未记录')
      // Preserve user-provided observation numbers. Parser-generated IDs are
      // implementation identifiers; the source locator carries their evidence.
      if (/^(?:workwise-|cosa-|gsi-|m5-|jobxml-|rw5-|obs_|observation_)/.test(id)) names.set(id, `观测 ${index + 1}`)
    })
    observationNames.set(source.networkId, names)
  }
  for (const source of model.sourceBinding) {
    const table = model.tables.find(table => table.id === `${source.networkId}-closures`)
    closureNames.set(source.networkId, new Map(table?.rows.map((row, index) => [String(row.id), `${row.kind === '附合路线' ? '附合路线' : '闭合环'} ${index + 1}`])))
  }
  const displayNote = (text: string): string => {
    return text
      .replaceAll('network.instrumentParameters.closureTolerance', '项目闭合限差')
      .replaceAll('完整输入、结果和投影摘要在版本附录及专业成果 JSON 中保留。', '各项成果对应所列原始资料；完整来源与版本记录另行保存。')
      .replaceAll('数值来自冻结的专业审查投影，不在报告层重算。', '数值来自本次平差成果。')
      .replace(/比较记录：[^；]+；/g, '')
      .replace(/变形比较：[^；]+；/g, '')
      .replace(/；算法：[^。]+。数值由已冻结的变形比较结果投影，未在报告层重新计算。/g, '。数值来自所选期次的变形比较成果。')
      .replace(/数据集 [^；]+；算法 [^；]+；所有行绑定原文件 SHA-256。/g, '各期观测对应原始资料。')
      .replaceAll('完整源文件、结果及投影 SHA-256 见版本附录。', '完整来源与版本记录另行保存。')
      .replaceAll('完整原始记录保留在 normalized_data 中。', '完整原始记录另行保存。')
  }
  // Only internally authored identity fields are renamed. A point number or
  // filename can legitimately contain the same bytes as an internal ID.
  const networkSuffixes = ['reference', 'closures', 'network-topology', 'summary', 'points', 'observations', 'ellipses', 'checks']
  const tables = model.tables.filter(table => table.id !== 'version-appendix').map(table => {
    const networkId = model.sourceBinding.find(source => networkSuffixes.some(suffix => table.id === `${source.networkId}-${suffix}`))?.networkId
    const columns = table.columns.filter(column => !['adjustmentId', 'resultId', 'inputHash', 'resultHash'].includes(column.key)).map(column => ({
      ...column,
      ...(table.id === 'source-binding' && column.key === 'networkId' ? { label: '资料编号' } : {}),
      ...(table.id === 'monitoring-daily' && column.key === 'source' ? { label: '原始行' } : {})
    }))
    const rows = table.rows.map((row, index) => {
      const result = { ...row }
      if (table.id === 'source-binding') result.networkId = sourceNames.get(String(row.networkId)) ?? '资料未记录'
      if (networkId && table.id.endsWith('-closures')) {
        result.id = closureNames.get(networkId)?.get(String(row.id)) ?? row.id
        if (row.toleranceBasis === 'network.instrumentParameters.closureTolerance') result.toleranceBasis = '项目闭合限差'
      }
      if (table.id.endsWith('-observations') || table.id.endsWith('-network-topology')) {
        const id = String(row.observationId ?? row.id)
        const key = table.id.endsWith('-observations') ? 'id' : 'observationId'
        result[key] = observationNames.get(networkId ?? '')?.get(id) ?? row[key]
        result.source = observationSources.get(sourceKey(networkId, id)) ?? '原始定位未记录'
        if (networkId && typeof row.closurePath === 'string') result.closurePath = row.closurePath.split('；').map(path => {
          const direction = path.endsWith('（正向）') ? '（正向）' : path.endsWith('（反向）') ? '（反向）' : ''
          const route = direction ? path.slice(0, -direction.length) : path
          return `${closureNames.get(networkId)?.get(route) ?? route}${direction}`
        }).join('；')
      }
      if (table.id.endsWith('-segment-members')) {
        const binding = model.comparisonBinding?.find(item => table.id === `${item.comparisonId}-segment-members`)
        const period = row.period === '原测期' ? binding?.reference : binding?.current
        result.sourceRecordId = observationSources.get(sourceKey(period?.networkId, String(row.observationId))) ?? '原始定位未记录'
        result.observationId = observationNames.get(period?.networkId ?? '')?.get(String(row.observationId)) ?? row.observationId
      }
      if (table.id.endsWith('-deformation-epochs')) {
        result.comparisonId = '所选期次比较'
        result.networkId = sourceNames.get(String(row.networkId)) ?? `第 ${index + 1} 期资料`
      }
      if (table.id === 'monitoring-daily' && typeof row.source === 'string') result.source = row.source.split(' / ')[0]
      return result
    })
    let title = table.title
    if (networkId && title.startsWith(`${networkId} · `)) title = `${sourceNames.get(networkId)} · ${title.slice(`${networkId} · `.length)}`
    for (const [id, name] of deformationNames) if (title.startsWith(`变形比较 ${id} · `)) {
      title = `${name} · ${title.slice(`变形比较 ${id} · `.length)}`
      break
    }
    return { ...table, title, columns, rows, ...(table.note ? { note: displayNote(table.note) } : {}) }
  })
  return { ...model, tables, appendix: undefined, notes: model.notes.map(note => displayNote(note)
    .replaceAll('本成果由确定性计算结果投影生成，数值未由 AI 改写。', '本成果采用测量平差计算值。')
    .replaceAll('当前资料或合同不足', '当前资料或检核条件不足')) }
}
export function professionalReportCellText(value: unknown, decimals?: number): string {
  if (value === undefined || value === null || value === '') return '不可用'
  if (typeof value !== 'number') return String(value)
  if (!Number.isFinite(value)) return '不可用'
  if (value === 0) return decimals === undefined ? '0' : (0).toFixed(decimals)
  if (decimals === undefined) return Number(value.toPrecision(10)).toString()
  const rounded = value.toFixed(decimals)
  if (Number(rounded) === 0) return value.toExponential(4)
  return rounded
}
function cellText(value: unknown): string { return professionalReportCellText(value) }

function wordRun(value: unknown, bold = false): string { return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(cellText(value))}</w:t></w:r>` }
function wordParagraph(value: unknown, style?: string): string { return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${xml(style)}"/></w:pPr>` : ''}${wordRun(value)}</w:p>` }
function wordTable(table: ProfessionalReportTable): string {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
  const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${table.columns.map(column => `<w:tc><w:tcPr><w:shd w:fill="D9EAF7"/></w:tcPr>${wordParagraph(column.unit ? `${column.label} (${column.unit})` : column.label)}</w:tc>`).join('')}</w:tr>`
  const rows = table.rows.map(row => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${table.columns.map(column => `<w:tc>${table.id === 'signoff' && row[column.key] === '' ? '<w:p/>' : wordParagraph(professionalReportCellText(row[column.key], column.decimals))}</w:tc>`).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>${borders}<w:tblLayout w:type="autofit"/></w:tblPr>${header}${rows}</w:tbl>${table.note ? wordParagraph(`说明：${table.note}`) : ''}`
}

/** OOXML is intentionally emitted locally to avoid adding a second document runtime. */
export async function makeProfessionalDocx(model: ProfessionalReportModel): Promise<Buffer> {
  model = professionalReportPresentation(model)
  const body = [
    wordParagraph(model.title, 'Title'), wordParagraph(`项目：${model.projectName}`), wordParagraph(`作业类型：${model.taskType}`), wordParagraph(`生成时间：${model.generatedAt}`), wordParagraph('状态：待审查草稿；签认状态：未签认'),
    ...model.notes.map(note => wordParagraph(`说明：${note}`)),
    ...model.tables.flatMap(table => [wordParagraph(table.title, 'Heading1'), wordTable(table)]),
    wordParagraph('签认栏', 'Heading1'), wordTable({ id: 'signoff', title: '', columns: [{ key: 'role', label: '角色' }, { key: 'name', label: '姓名' }, { key: 'date', label: '日期' }, { key: 'signature', label: '签名' }], rows: model.signoff }),
    ...(model.appendix?.length ? [wordParagraph('计算与来源明细附件', 'Heading1'), ...model.appendix.map(line => line ? wordParagraph(line) : '<w:p/>')] : [])
  ].join('')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>')
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="Noto Sans SC"/><w:sz w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>')
  zip.file('word/footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>RailWise Survey · 待审查 · </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p></w:ftr>')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

type XlsxCell = string | number | boolean | null | undefined
function columnName(index: number): string { let n = index + 1; let result = ''; while (n > 0) { const remainder = (n - 1) % 26; result = String.fromCharCode(65 + remainder) + result; n = Math.floor((n - 1) / 26) } return result }
function xlsxCell(value: XlsxCell, address: string, header: boolean, decimals: number = 6): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const scientific = value !== 0 && Math.abs(value) < 0.5 * 10 ** -decimals
    const style = scientific ? 7 : decimals === 0 ? 4 : decimals === 4 ? 5 : decimals === 10 ? 6 : 2
    return `<c r="${address}" s="${style}"><v>${value}</v></c>`
  }
  if (typeof value === 'boolean') return `<c r="${address}" s="1" t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${address}" s="${header ? 3 : 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value === undefined || value === null || value === '' ? '不可用' : String(value))}</t></is></c>`
}
function professionalSheet(table: ProfessionalReportTable): string {
  const rows: XlsxCell[][] = [table.columns.map(column => column.unit ? `${column.label} (${column.unit})` : column.label), ...table.rows.map(row => table.columns.map(column => row[column.key]))]
  const widths = table.columns.map(column => table.id === 'report-metadata' && column.key === 'value' ? 100 : column.key === 'hash' ? 80 : column.key === 'networkId' ? 48 : column.key === 'source' ? 32 : column.key === 'reason' ? 48 : column.numeric ? 14 : ['unit', 'residualUnit'].includes(column.key) ? 12 : 20)
  const rowHeight = (row: XlsxCell[]): number => Math.max(22, ...row.map((value, index) => Math.ceil([...String(value ?? '不可用')].reduce((count, character) => count + (character.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(1, widths[index]! - 2)) * 16 + 8))
  const sheetRows = rows.map((row, ri) => `<row r="${ri + 1}" ht="${rowHeight(row)}" customHeight="1">${row.map((value, ci) => xlsxCell(value, `${columnName(ci)}${ri + 1}`, ri === 0, table.columns[ci]?.decimals)).join('')}</row>`).join('')
  const maxColumn = columnName(Math.max(0, table.columns.length - 1))
  const autoFilter = rows.length ? `<autoFilter ref="A1:${maxColumn}${rows.length}"/>` : ''
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData>${autoFilter}<printOptions horizontalCentered="0"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C待审查草稿 &amp;P / &amp;N</oddFooter></headerFooter></worksheet>`
}

/** A separate professional workbook preserves evidence.xlsx byte/schema compatibility. */
export async function makeProfessionalXlsx(model: ProfessionalReportModel): Promise<Buffer> {
  model = professionalReportPresentation(model)
  const metadata: ProfessionalReportTable = { id: 'report-metadata', title: '成果说明与签认状态', columns: [{ key: 'item', label: '项目' }, { key: 'value', label: '内容' }], rows: [{ item: '成果标题', value: model.title }, { item: '项目名称', value: model.projectName }, { item: '生成时间', value: model.generatedAt }, { item: '签认状态', value: '未签认' }, ...model.notes.map(value => ({ item: '说明', value })), ...model.tables.flatMap(table => table.note ? [{ item: `${table.title}说明`, value: table.note }] : [])] }
  const sheets = [metadata, ...model.tables].map((table, index) => ({ name: `${String(index + 1).padStart(2, '0')}_${table.title.split(' · ').at(-1)}`.replaceAll('\\', '_').replaceAll('/', '_').replaceAll('?', '_').replaceAll('*', '_').replaceAll('[', '_').replaceAll(']', '_').replaceAll(':', '_').slice(0, 31), table }))
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  const numericStyle = (numberFormat: number): string => `<xf numFmtId="${numberFormat}" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment wrapText="1" vertical="top" horizontal="right"/></xf>`
  zip.file('xl/styles.xml', `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="0.000000"/><numFmt numFmtId="165" formatCode="0.0000"/><numFmt numFmtId="166" formatCode="0.0000000000"/><numFmt numFmtId="167" formatCode="0.0000E+00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Noto Sans SC"/></font><font><b/><sz val="11"/><name val="Noto Sans SC"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF3"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFB5BEC8"/></left><right style="thin"><color rgb="FFB5BEC8"/></right><top style="thin"><color rgb="FFB5BEC8"/></top><bottom style="thin"><color rgb="FFB5BEC8"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>${numericStyle(164)}<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>${numericStyle(1)}${numericStyle(165)}${numericStyle(166)}${numericStyle(167)}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  zip.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets><definedNames>${sheets.flatMap((sheet, index) => [`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">'${xml(sheet.name)}'!$1:$1</definedName>`, `<definedName name="_xlnm.Print_Area" localSheetId="${index}">'${xml(sheet.name)}'!$A$1:$${columnName(Math.max(0, sheet.table.columns.length - 1))}$${sheet.table.rows.length + 1}</definedName>`]).join('')}</definedNames></workbook>`)
  sheets.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, professionalSheet(sheet.table)))
  return zip.generateAsync({ type: 'nodebuffer' })
}
