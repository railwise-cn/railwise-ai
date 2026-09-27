export * from '../../kun/src/contracts/survey-standard-basis'
import type { SurveyStandardBasisReferenceV1 } from '../../kun/src/contracts/survey-standard-basis'

export const RUNTIME_STANDARD_BASIS_PATH = '/v1/engineering/standard-basis'
export const STANDARD_BASIS_QUERY_KEYS = ['standardCode', 'standardVersion', 'sourceSha256', 'algorithmVersion', 'profileId', 'profileVersion'] as const

export function runtimeStandardBasisPath(reference: SurveyStandardBasisReferenceV1): string {
  const query = new URLSearchParams(STANDARD_BASIS_QUERY_KEYS.map(key => [key, reference[key]]))
  return `${RUNTIME_STANDARD_BASIS_PATH}/${encodeURIComponent(reference.ruleId)}/${encodeURIComponent(reference.ruleVersion)}?${query}`
}
