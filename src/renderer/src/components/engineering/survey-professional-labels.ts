const observationLabels: Record<string, readonly [string, string]> = {
  'height-difference': ['高差', 'Height difference'], distance: ['平距', 'Horizontal distance'],
  direction: ['方向', 'Direction'], angle: ['水平角', 'Horizontal angle'], zenith: ['天顶距', 'Zenith angle'],
  'slope-distance': ['斜距', 'Slope distance'], 'gnss-baseline': ['GNSS 基线', 'GNSS baseline'],
  'coordinate-pair': ['同名坐标点', 'Coordinate correspondence']
}

const trendLabels: Record<string, readonly [string, string]> = {
  settling: ['沉降发展', 'Settling'], heaving: ['隆起发展', 'Heaving'],
  'horizontal-moving': ['水平位移发展', 'Horizontal movement'],
  stable: ['变化速率在阈值内', 'Rate within the threshold'], unknown: ['趋势待判定', 'Trend undetermined']
}

const parameterLabels: Record<string, readonly [string, string]> = {
  translationX: ['X 平移', 'X translation'], translationY: ['Y 平移', 'Y translation'], translationZ: ['Z 平移', 'Z translation'],
  scalePpm: ['尺度改正', 'Scale correction'], rotationRad: ['平面旋转角', 'Planar rotation'],
  rotationX: ['X 轴旋转角', 'X rotation'], rotationY: ['Y 轴旋转角', 'Y rotation'], rotationZ: ['Z 轴旋转角', 'Z rotation'],
  heightOffset: ['高程常数改正', 'Height offset'], heightSlopeX: ['X 向高程倾斜系数', 'Height slope along X'], heightSlopeY: ['Y 向高程倾斜系数', 'Height slope along Y'],
  centralMeridianRad: ['中央子午线', 'Central meridian'], falseEasting: ['东坐标加常数', 'False easting'], zonePrefix: ['投影带号', 'Projection zone']
}

/**
 * User-facing observation reference. Parser identifiers (for example
 * `cosa-in2-6-backsight-reset`) are kept in evidence selectors, but are not a
 * useful label for a surveyor. Prefer the measured station/target pair and
 * observation type; retain a source row or stable sequence so repeated
 * measurements remain distinguishable.
 */
export type SurveyObservationDisplayInput = {
  id?: string
  observationId?: string
  type?: string
  from?: string
  to?: string
  station?: string
  target?: string
  sourceRow?: number
  sequence?: number
}

export function surveyObservationDisplayLabel(observation: SurveyObservationDisplayInput, locale: string): string {
  const english = locale.startsWith('en')
  const from = observation.station ?? observation.from
  const to = observation.target ?? observation.to
  const pair = from && to ? `${from} → ${to}` : undefined
  const type = observation.type ? surveyObservationLabel(observation.type, locale) : undefined
  const identifier = observation.observationId ?? observation.id
  const generated = /^(?:cosa-(?:in1|in2)-\d+(?:-(?:direction|distance|backsight-reset))?|tabular-\d+|gsi-(?:block-\d+-line-)?\d+-(?:dh|hz|z|sd|hd)|(?:xml|sdr)-\d+-(?:dh|hz|z|sd|hd)|m5-\d+(?:-\d+)?-dh|(?:tds-raw|carlson-rw5|topcon-gts7|topcon-fc5|nikon-raw|spectra-survey-pro)-\d+-(?:sd|hd)|obs(?:ervation)?[-_]?\d+)$/i
  const name = identifier && !generated.test(identifier) ? identifier : undefined
  const source = observation.sourceRow !== undefined
    ? (english ? `source row ${observation.sourceRow}` : `来源第 ${observation.sourceRow} 行`)
    : observation.sequence !== undefined
      ? (english ? `observation ${observation.sequence}` : `观测 ${observation.sequence}`)
      : undefined
  return [name, pair, type, source].filter(Boolean).join(' · ') || (english ? 'Observation' : '观测')
}

export function surveyObservationLabel(type: string | undefined, locale: string): string {
  return observationLabels[type ?? '']?.[locale.startsWith('en') ? 1 : 0] ?? (locale.startsWith('en') ? 'Other observation' : '其他观测')
}

export function surveyDeformationTrendLabel(trend: string, locale: string): string {
  return (trendLabels[trend] ?? trendLabels.unknown)![locale.startsWith('en') ? 1 : 0]
}

export function surveyTransformParameterLabel(parameter: string, locale: string): string {
  return parameterLabels[parameter]?.[locale.startsWith('en') ? 1 : 0] ?? parameter
}
