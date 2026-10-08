/** Shared, deterministic professional reference requirements. */
export type SurveyReferenceInput = {
  networkType: string
  transformType?: string
  coordinateSystem?: string
  verticalDatum?: string
  heightDatum?: string
  observations: readonly { type?: string; targetHeight?: number }[]
}

export function surveyReferenceDeclared(value: string | undefined): boolean {
  return Boolean(value?.trim() && !/^(待确认|待声明|未确认|未声明|未指定|未提供|不明|未知|无|unknown|unverified|pending|legacy-unknown|not[- ]declared|not[- ]confirmed|not[- ]specified|unspecified|none|tbd|n\/?a|—|-)$/i.test(value.trim()))
}

/** Height fitting uses X/Y positions as well as heights. A plane-only net
 * does not acquire a height requirement merely because its point records
 * happen to contain unused heights. */
export function surveyReferenceRequirements(network: SurveyReferenceInput): { coordinate: boolean; height: boolean } {
  const heightOnly = ['leveling', 'height-control'].includes(network.networkType)
  const heightTransform = network.networkType === 'coordinate-transform'
    && ['height-fit', 'helmert-7'].includes(network.transformType ?? '')
  const verticalObservations = network.observations.some(observation =>
    ['height-difference', 'zenith', 'slope-distance', 'gnss-baseline'].includes(observation.type ?? '')
    || observation.type === 'coordinate-pair' && observation.targetHeight !== undefined)
  return { coordinate: !heightOnly, height: heightOnly || network.networkType === 'gnss' || heightTransform || verticalObservations }
}

export function missingSurveyReferences(network: SurveyReferenceInput): Array<'coordinate' | 'height'> {
  const requirements = surveyReferenceRequirements(network)
  const missing: Array<'coordinate' | 'height'> = []
  if (requirements.coordinate && !surveyReferenceDeclared(network.coordinateSystem)) missing.push('coordinate')
  const heightDatum = surveyReferenceDeclared(network.verticalDatum) ? network.verticalDatum : network.heightDatum ?? network.verticalDatum
  if (requirements.height && !surveyReferenceDeclared(heightDatum)) missing.push('height')
  return missing
}
