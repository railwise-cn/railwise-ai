import {
  RUNTIME_STANDARD_BASIS_PATH, runtimeStandardBasisPath, SURVEY_SAMPLING_BASIS_PROFILE_VERSION,
  SurveyStandardBasisCatalogV1, SurveyStandardBasisResolvedV1,
  type SurveyStandardBasisEntryV1, type SurveyStandardBasisReferenceV1
} from '@shared/survey-standard-basis'
import type { SurveySamplingRunSummaryV1 } from '@shared/survey-quality-sampling-workspace'
import type { SurveyQualityScoringOutputV1 } from '@shared/survey-quality-scoring'
import { rendererRuntimeClient } from './runtime-client'

export type StandardBasisContext = {
  schemaVersion: number; family: 'sampling' | 'declared-scoring'; operation: string
  standardCode: string; sourceSha256: string; algorithmVersion: string; profileId: string; profileVersion: string
}
export class StandardBasisRequestError extends Error {
  constructor(readonly reason: 'mismatch' | 'invalid-response' | 'unavailable' | 'request-failed') { super(reason) }
}
const invalid = (): never => { throw new StandardBasisRequestError('invalid-response') }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
const encoded = (value: unknown): string => JSON.stringify(canonical(value))
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
async function request(path: string): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, 'GET') }
  catch { throw new StandardBasisRequestError('request-failed') }
  if (!response.ok) throw new StandardBasisRequestError(response.status === 409 ? 'mismatch' : [404, 503].includes(response.status) ? 'unavailable' : 'request-failed')
  if (new TextEncoder().encode(response.body).byteLength > 512 * 1024) return invalid()
  try { return JSON.parse(response.body) } catch { return invalid() }
}

// Existing records remain unchanged. These identities associate their retained
// algorithm/input contract with catalog documentation, not a stored approval.
export function samplingStandardBasisContext(run: SurveySamplingRunSummaryV1): StandardBasisContext {
  return { schemaVersion: run.schemaVersion, family: 'sampling', operation: run.inspectionMode,
    standardCode: run.source.standard, sourceSha256: run.source.sourceSha256, algorithmVersion: run.algorithmVersion,
    profileId: run.inspectionMode, profileVersion: SURVEY_SAMPLING_BASIS_PROFILE_VERSION }
}
export function scoringStandardBasisContext(result: SurveyQualityScoringOutputV1): StandardBasisContext | null {
  const request = result.request
  if (!request || request.standardCode !== result.source.standardCode || request.sourceDigest !== result.source.sha256) return null
  return { schemaVersion: result.schemaVersion, family: 'declared-scoring', operation: request.operation,
    standardCode: result.source.standardCode, sourceSha256: result.source.sha256, algorithmVersion: result.algorithmVersion,
    profileId: request.productProfileId, profileVersion: request.productProfileVersion }
}
function matches(entry: SurveyStandardBasisEntryV1, context: StandardBasisContext): boolean {
  const { rule } = entry
  return context.schemaVersion === 1 && rule.standardCode === context.standardCode && rule.source.sha256 === context.sourceSha256
    && rule.executor.family === context.family && rule.executor.operation === context.operation
    && rule.executor.algorithmVersion === context.algorithmVersion
    && rule.profiles.filter(profile => profile.profileId === context.profileId && profile.profileVersion === context.profileVersion).length === 1
}
export async function readResultStandardBasis(context: StandardBasisContext): Promise<SurveyStandardBasisResolvedV1> {
  const parsed = SurveyStandardBasisCatalogV1.safeParse(await request(RUNTIME_STANDARD_BASIS_PATH))
  if (!parsed.success) return invalid()
  const catalog = parsed.data
  for (const entry of catalog.rules) if (await digest(entry.rule) !== entry.ruleDigest) return invalid()
  if (await digest(catalog.rules.map(entry => entry.ruleDigest)) !== catalog.catalogDigest) return invalid()
  const candidates = catalog.rules.filter(entry => matches(entry, context))
  if (candidates.length !== 1) throw new StandardBasisRequestError('mismatch')
  const entry = candidates[0]!
  const reference: SurveyStandardBasisReferenceV1 = {
    standardCode: entry.rule.standardCode, standardVersion: entry.rule.standardVersion,
    ruleId: entry.rule.ruleId, ruleVersion: entry.rule.ruleVersion, sourceSha256: context.sourceSha256,
    algorithmVersion: context.algorithmVersion, profileId: context.profileId, profileVersion: context.profileVersion
  }
  const detail = SurveyStandardBasisResolvedV1.safeParse(await request(runtimeStandardBasisPath(reference)))
  if (!detail.success) return invalid()
  const value = detail.data
  const expectedProfile = entry.rule.profiles.find(profile => profile.profileId === context.profileId && profile.profileVersion === context.profileVersion)
  if (encoded(value.reference) !== encoded(reference) || encoded(value.entry) !== encoded(entry)
    || encoded(value.profile) !== encoded(expectedProfile)) return invalid()
  for (const locator of [...value.entry.rule.locators, ...value.profile.locators]) {
    for (const page of locator.pdfPages) standardBasisPdfPageUrl(value, page)
  }
  return value
}

export function standardBasisPdfPageUrl(value: SurveyStandardBasisResolvedV1, page: number): string {
  const { source } = value.entry.rule
  const knownPage = [...value.entry.rule.locators, ...value.profile.locators].some(locator => locator.pdfPages.includes(page))
  const url = new URL(source.officialUrl)
  if (!knownPage || !Number.isSafeInteger(page) || page < 1 || page > source.pageCount || url.protocol !== 'https:'
    || url.hostname !== 'zrzy.guizhou.gov.cn' || url.username || url.password || url.port
    || url.pathname !== '/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf' || url.search || url.hash) return invalid()
  url.hash = `page=${page}`
  return url.href
}
