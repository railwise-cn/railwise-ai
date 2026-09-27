import { z } from 'zod'

const text = z.string().min(1).max(500)
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const SurveyStandardBasisTextV1 = z.object({ zh: text, en: text }).strict()
export const SURVEY_STANDARD_BASIS_CATALOG_VERSION = 'gbt24356-2023-trial-basis-1' as const
export const SURVEY_SAMPLING_BASIS_PROFILE_VERSION = 'survey-quality-sampling-request-v1' as const

/** Exact lookup identity, not an instruction to execute or approve a rule. */
export const SurveyStandardBasisReferenceV1 = z.object({
  standardCode: text, standardVersion: id, ruleId: id, ruleVersion: id,
  sourceSha256: hash, algorithmVersion: id, profileId: id, profileVersion: id
}).strict()
export type SurveyStandardBasisReferenceV1 = z.infer<typeof SurveyStandardBasisReferenceV1>

export const SurveyStandardBasisLocatorV1 = z.object({
  clauses: z.array(id).min(1).max(16), tables: z.array(z.number().int().positive()).max(4),
  printedPages: z.array(z.number().int().positive()).min(1).max(8),
  pdfPages: z.array(z.number().int().positive()).min(1).max(8),
  description: SurveyStandardBasisTextV1
}).strict().refine(value => value.printedPages.length === value.pdfPages.length
  && value.pdfPages.every((page, index) => page === value.printedPages[index]! + 3), 'GB/T 24356-2023 printed/PDF page pairs must match the retained source')
export type SurveyStandardBasisLocatorV1 = z.infer<typeof SurveyStandardBasisLocatorV1>

export const SurveyStandardBasisProfileV1 = z.object({
  profileId: id, profileVersion: id, label: SurveyStandardBasisTextV1,
  unitProduct: z.enum(['caller-defined-unit-product', 'point', 'section']),
  locators: z.array(SurveyStandardBasisLocatorV1).min(1).max(8)
}).strict()
export const SurveyStandardBasisRuleV1 = z.object({
  standardCode: z.literal('GB/T 24356-2023'), standardVersion: z.literal('2023'), ruleId: id, ruleVersion: id,
  title: SurveyStandardBasisTextV1, summary: SurveyStandardBasisTextV1,
  executor: z.object({ family: z.enum(['sampling', 'declared-scoring']), operation: id, algorithmVersion: id,
    inputContract: id, outputContract: id, implementationPath: text }).strict(),
  source: z.object({ kind: z.literal('official-scanned-pdf'), sha256: hash, officialUrl: z.string().url(),
    publicationUrl: z.string().url(), metadataUrl: z.string().url(), byteLength: z.literal(27976440), pageCount: z.literal(129),
    evidenceDocuments: z.array(z.object({ path: text, sha256: hash }).strict()).min(1).max(4),
    availability: z.literal('public-url-and-retained-digest-no-runtime-fetch'),
    redistribution: z.literal('full-pdf-not-bundled-license-not-inferred') }).strict(),
  locators: z.array(SurveyStandardBasisLocatorV1).min(1).max(8),
  profiles: z.array(SurveyStandardBasisProfileV1).min(1).max(4),
  implementationChoices: z.array(SurveyStandardBasisTextV1).min(1).max(8), exclusions: z.array(SurveyStandardBasisTextV1).min(1).max(16),
  reviewIdentity: z.literal('agent-reviewed-not-professional-signoff'),
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated'),
  projectApplicability: z.literal('not-evaluated'), formalResultsModified: z.literal(false)
}).strict()
export type SurveyStandardBasisRuleV1 = z.infer<typeof SurveyStandardBasisRuleV1>

export const SurveyStandardBasisEntryV1 = z.object({ rule: SurveyStandardBasisRuleV1, ruleDigest: hash }).strict()
export type SurveyStandardBasisEntryV1 = z.infer<typeof SurveyStandardBasisEntryV1>
export const SurveyStandardBasisCatalogV1 = z.object({ schemaVersion: z.literal(1), catalogVersion: z.literal(SURVEY_STANDARD_BASIS_CATALOG_VERSION),
  catalogDigest: hash, rules: z.array(SurveyStandardBasisEntryV1).min(1).max(32),
  updatePolicy: z.literal('exact-version-only-no-automatic-latest'), historicalRecordsModified: z.literal(false)
}).strict()
export type SurveyStandardBasisCatalogV1 = z.infer<typeof SurveyStandardBasisCatalogV1>
export const SurveyStandardBasisResolvedV1 = z.object({ schemaVersion: z.literal(1), catalogVersion: z.literal(SURVEY_STANDARD_BASIS_CATALOG_VERSION),
  status: z.literal('resolved-basis-only'), reference: SurveyStandardBasisReferenceV1, entry: SurveyStandardBasisEntryV1,
  profile: SurveyStandardBasisProfileV1, historicalRecordsModified: z.literal(false)
}).strict()
export type SurveyStandardBasisResolvedV1 = z.infer<typeof SurveyStandardBasisResolvedV1>
