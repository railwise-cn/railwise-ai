import { createHash } from 'node:crypto'
import {
  SurveyStandardBasisCatalogV1, SurveyStandardBasisReferenceV1, SurveyStandardBasisResolvedV1,
  SurveyStandardBasisRuleV1, SURVEY_STANDARD_BASIS_CATALOG_VERSION, SURVEY_SAMPLING_BASIS_PROFILE_VERSION,
  type SurveyStandardBasisLocatorV1, type SurveyStandardBasisRuleV1 as Rule
} from '../contracts/survey-standard-basis.js'
import { QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST } from '../contracts/survey-quality-scoring.js'
import { GBT24356_SAMPLING_SOURCE } from './survey-quality-sampling.js'

const bilingual = (zh: string, en: string) => ({ zh, en })

const source: Rule['source'] = {
  kind: 'official-scanned-pdf', sha256: QUALITY_STANDARD_DIGEST,
  officialUrl: GBT24356_SAMPLING_SOURCE.officialUrl,
  publicationUrl: 'https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/t20230829_82109696.html',
  metadataUrl: 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=2874EFAC7523FB293E6AF2E4068CEB02',
  byteLength: 27976440, pageCount: 129,
  evidenceDocuments: [
    { path: 'docs/qa/evidence/railwise-standards-20260920/sources.json', sha256: '276fe3d72b577b3b5dddea0cbd2c3c481c228d64aea450a2f22322758d03b687' },
    { path: 'docs/qa/evidence/railwise-quality-scoring/implementation-contract.md', sha256: '6c9bc89884210cfff2a3623b9f7cb35c5286ae7819f95037f57a7b37f0905541' },
    { path: 'docs/qa/evidence/railwise-standard-basis-20260920/page-review.json', sha256: '1033fb3134662894da90e1d433eb7b4d7b37003e6a15f2c7e48af753ba9a2cd2' }
  ],
  availability: 'public-url-and-retained-digest-no-runtime-fetch', redistribution: 'full-pdf-not-bundled-license-not-inferred'
}
const locator = (clauses: string[], tables: number[], printedPages: number[], zh: string, en: string): SurveyStandardBasisLocatorV1 => ({
  clauses, tables, printedPages, pdfPages: printedPages.map(page => page + 3), description: bilingual(zh, en)
})
const common = {
  standardCode: 'GB/T 24356-2023', standardVersion: '2023', ruleVersion: '1', source,
  reviewIdentity: 'agent-reviewed-not-professional-signoff', standardConformity: 'not-evaluated',
  humanSignatureVerification: 'not-evaluated', projectApplicability: 'not-evaluated', formalResultsModified: false
} as const
const samplingLocators = [
  locator(['4.2.2', '4.2.3', '4.2.4'], [], [3], '过程检查、最终内业全数检查和可抽样阶段；本目录不认证阶段完成。', 'Process and final-office census requirements and sampling stages; no stage completion is authenticated.'),
  locator(['5.1', '5.2'], [1], [5], '成果单位、批量、表1样本量和大批量均匀分批。', 'Unit products, batch size, Table 1 sample sizes and balanced splitting of large populations.'),
  locator(['5.3.1', '5.3.2', '5.3.3'], [], [5, 6], '抽样方法、分布及抽中单位成果的全部资料和补充资料。', 'Sampling methods, distribution, and all records and supplementary material for selected units.')
]
const samplingRules: Rule[] = (['census', 'table-1-simple-random'] as const).map(mode => ({
  ...common, ruleId: `gbt24356-2023.sampling.${mode}`,
  title: mode === 'census' ? bilingual('全数检查总体计划', 'Census population plan') : bilingual('表1简单随机抽样计划', 'Table 1 simple random sampling plan'),
  summary: bilingual('只关联调用方声明的单位成果总体和可重放抽样执行器；不从原始观测推断批量，不认证总体完整性或现场分布。', 'Links a caller-declared unit-product population to the replayable sampler; raw observations do not establish batch size, population completeness or field distribution.'),
  executor: { family: 'sampling', operation: mode, algorithmVersion: 'quality-sampling-hmac-sha256-fy-1',
    inputContract: 'SurveyQualitySamplingRequestV1', outputContract: 'SurveyQualitySamplingPlanV1',
    implementationPath: 'kun/src/engineering/survey-quality-sampling.ts' },
  locators: samplingLocators,
  profiles: [{ profileId: mode, profileVersion: SURVEY_SAMPLING_BASIS_PROFILE_VERSION, label: bilingual('调用方定义的单位成果总体', 'Caller-defined unit-product population'),
    unitProduct: 'caller-defined-unit-product', locators: samplingLocators }],
  implementationChoices: [bilingual('HMAC-SHA256计数扩展、拒绝采样与部分Fisher-Yates是软件选择，非标准指定算法。', 'HMAC-SHA256 counter expansion, rejection sampling and partial Fisher-Yates are software choices, not algorithms prescribed by the standard.'),
    bilingual('最少批次数均匀连续分批，多出的单位分配给前面的批；总体顺序属于可追溯输入。', 'Use the minimum balanced contiguous batches with extra units assigned first; population order remains part of the recorded input.'),
    bilingual(`表1规范化数据摘要 ${GBT24356_SAMPLING_SOURCE.tableSha256}；仅核查记录中的PNG编码摘要，不声称跨渲染器像素一致。`, `Table 1 encoded-data digest: ${GBT24356_SAMPLING_SOURCE.tableSha256}. Reviewed PNG byte hashes do not imply renderer-independent pixels.`)],
  exclusions: [bilingual('不支持分层比例随机抽样。', 'Proportional stratified sampling is not supported.'), bilingual('不推断成果类别、单位成果或项目适用性。', 'No inference of product class, unit products or project applicability.'), bilingual('不认证随机种子来源、总体完整性、空间均匀性或既往轮次。', 'Random seed origin, population completeness, spatial uniformity and previous rounds are not authenticated.'),
    bilingual('不执行质量评分、阶段完成、组织独立核验或人工专业签认。', 'No scoring, stage completion, organizational independence verification or professional signoff.')]
}))
const profiles: Rule['profiles'] = [
  { profileId: 'planar-control-point', profileVersion: QUALITY_PROFILE_VERSION, label: bilingual('平面控制测量（点）', 'Planar control survey (point)'), unitProduct: 'point',
    locators: [
      locator(['7.5.1'], [43], [58], '表43：平面控制测量质量元素、子元素、检查项及权；单位为点。', 'Table 43: planar-control quality elements, subelements, inspection items and weights; unit: point.'),
      locator(['7.5.1'], [44], [59, 60], '表44及续表：错漏分类；分类仍由调用方声明，未编码完整自动分类表。', 'Table 44 and continuation: defect classes remain caller-declared; no complete automatic classification table.'),
      locator(['7.5.1'], [], [57], '7.5.1条款引导位于页底；本页上部为表42续表，表43从下一页开始。', 'Clause 7.5.1 introduction is at the foot; Table 42 continues above it, and Table 43 starts on the next page.')
    ] },
  { profileId: 'height-control-section', profileVersion: QUALITY_PROFILE_VERSION, label: bilingual('高程控制测量（测段）', 'Height control survey (section)'), unitProduct: 'section',
    locators: [
      locator(['7.5.2'], [45], [61], '表45：高程控制测量质量元素、子元素、检查项及权；单位为测段，不能从观测边数或未知点数推断。', 'Table 45: height-control quality elements, subelements, inspection items and weights; sections cannot be inferred from edge or unknown-point counts.'),
      locator(['7.5.2'], [46], [62, 63], '表46及续表：高程控制测量错漏分类；分类仍由调用方声明。', 'Table 46 and continuation: height-control defect classification remains caller-declared.'),
      locator(['7.5.2'], [], [61], '7.5.2条款引导与表45位于同页。', 'Clause 7.5.2 introduction and Table 45 appear on the same page.')
    ] }
]
const scoringDefinitions: Array<{ operation: string; title: Rule['title']; summary: Rule['summary']; locators: SurveyStandardBasisLocatorV1[]; exclusions: Rule['exclusions'] }> = [
  { operation: 'accuracy', title: bilingual('声明数学精度评分', 'Declared mathematical accuracy score'), summary: bilingual('只接收声明的中误差幅值和允许值，以式(3)计算并按声明方式聚合。', 'Uses declared error magnitudes and allowed values in formula (3), aggregated as declared.'),
    locators: [locator(['6.2.1.2', '6.2.4.1.1'], [], [6], 'A类否决、完整式(3)及多数学精度项聚合均位于本页。', 'A-class veto, complete formula (3) and multiple accuracy-item aggregation all appear on this page.')],
    exclusions: [bilingual('不从平差残差或检测差值推导中误差；4.3.4恰好20个检测点的分支未解释。', 'No error inference from residuals or inspection differences; exactly 20 inspection points in 4.3.4 remains unresolved.'), bilingual('m大于m0、多精度项中恰有60分的聚合返回不可用；单项60分有效。', 'm greater than m0 or a 60-point item in a multiple-item group is unavailable; a single 60-point item remains valid.')] },
  { operation: 'deduction', title: bilingual('声明子元素错漏扣分', 'Declared subelement deductions'), summary: bilingual('按声明的A/B/C/D计数试算；A类独立否决，保留低于60及负值诊断，不截零。', 'Trials use declared A/B/C/D counts; A-class veto is independent, and below-60 or negative diagnostics are retained without clipping.'),
    locators: [locator(['6.2.1.2', '6.2.4.1.2', '6.2.4.2'], [2], [6, 7], '式(4)、表2和A类否决；最小合同只执行t=1。', 'Formula (4), Table 2 and A-class veto; the minimal contract only executes t=1.')],
    exclusions: [bilingual('不自动分类错漏；数学精度B/C/D输入不适用于表44/46。', 'No automatic defect classification; mathematical-accuracy B/C/D counts are outside Tables 44/46.'), bilingual('t不等于1的调整不支持，即使调用方附加批准文字也不会开启。', 'Adjusted t other than 1 remains unsupported even when approval text is supplied.')] },
  { operation: 'unit', title: bilingual('声明单位成果分层评分', 'Declared hierarchical unit score'), summary: bilingual('按两个控制测量profile的七子元素逐层加权；缺失、明确排除和已检查分开，任何A类或低于60子项不能被平均抵销。', 'Weights seven leaves within two control-survey profiles; pending, excluded and checked states remain distinct, with no averaging away A-class or below-60 vetoes.'),
    locators: [locator(['6.2.1.2', '6.2.2', '6.2.3', '6.2.4.4', '6.2.4.5', '6.2.5'], [2, 3], [6, 7, 8], '式(6)属于6.2.4.5，6.2.5为等级及表3。旧算法trace的6.2.5/formula-6标签保留原样，本目录补正定位；部分声明范围不等于完整验收。', 'Formula (6) belongs to 6.2.4.5; 6.2.5 covers grades and Table 3. The old 6.2.5/formula-6 trace label is preserved; this catalog corrects its location. Partial scope is not full acceptance.')],
    exclusions: [bilingual('仅覆盖两个控制测量profile；不覆盖地形、线路或变形测量成果。', 'Only two control-survey profiles; topographic, route and deformation products are excluded.'), bilingual('部分范围得分不认证排除依据、完整检查或项目合格。', 'A partial score does not authenticate exclusions, complete inspection or project qualification.')] },
  { operation: 'overview', title: bilingual('声明概查判定', 'Declared overview inspection'), summary: bilingual('只用于概查：声明A为0且B少于4时计算声明合格，不替代样本详查评分。', 'Overview only: declared A=0 and B<4 yields declared qualification; it does not replace detailed sample scoring.'),
    locators: [locator(['6.1.3'], [], [6], '概查单位成果A/B错漏条件。', 'A/B defect conditions for overview unit inspection.')], exclusions: [bilingual('不能将概查条件当作全体单位成果详查通用规则。', 'Overview conditions are not general detailed-inspection rules for every unit.')] },
  { operation: 'sample', title: bilingual('声明样本等级', 'Declared sample grade'), summary: bilingual('显式成员中的任一不合格单位否决样本；全部声明合格后才能对单位得分做算术平均。', 'Any failed declared member vetoes the sample; unit scores are averaged only after every member is declared qualified.'),
    locators: [locator(['6.3'], [3], [8], '样本合格前提、算术平均及等级。', 'Sample qualification prerequisite, arithmetic mean and grade.')], exclusions: [bilingual('不生成样本，也不认证样本来源、单位得分真实性或完整检查。', 'Does not select a sample or authenticate its origin, unit scores or complete inspection.')] },
  { operation: 'final-batch', title: bilingual('声明最终检查批等级', 'Declared final-inspection batch grade'), summary: bilingual('使用实际批的显式数量及独立声明的批合格前提，以整数比例判优、良、合格。', 'Uses explicit actual-batch counts and a separately declared qualification prerequisite, with exact integer grade ratios.'),
    locators: [locator(['6.4.1'], [], [8], '最终检查批合格前提和优良品率、优级品率。', 'Final-batch qualification prerequisite and excellent/good product ratios.')], exclusions: [bilingual('不能由等级比例反推批合格，也不能以样本数量替代实际批量。', 'Grade ratios cannot establish batch qualification, and sample size cannot replace actual batch size.')] },
  { operation: 'acceptance-batch', title: bilingual('声明验收批判定', 'Declared acceptance-batch decision'), summary: bilingual('区分详查、概查未实施与概查待定；伪造成果或重大技术路线偏差声明优先否决。', 'Distinguishes detailed inspection, overview not performed and overview pending; declared fabrication or major route deviation takes veto precedence.'),
    locators: [locator(['6.4.2'], [], [8], '验收批详查/概查和独立否决条件。', 'Detailed/overview acceptance inspection and independent veto conditions.')], exclusions: [bilingual('只试算声明合格与否，不输出优良等级，不构成委托方或有资质机构验收。', 'Trials qualification only, without excellent/good grades or acceptance by a client or qualified organization.')] }
]
const scoringRules: Rule[] = scoringDefinitions.map(definition => ({
  ...common, ruleId: `gbt24356-2023.scoring.${definition.operation}`, title: definition.title, summary: definition.summary,
  executor: { family: 'declared-scoring', operation: definition.operation, algorithmVersion: 'gbt24356-declared-exact-quality-scoring-1',
    inputContract: 'SurveyQualityScoringInputV1', outputContract: 'SurveyQualityScoringOutputV1', implementationPath: 'kun/src/engineering/survey-quality-scoring.ts' },
  locators: definition.locators, profiles,
  implementationChoices: [bilingual('有界约分BigInt有理数，不预先舍入、不使用epsilon放宽阈值。', 'Bounded reduced BigInt rationals; no pre-rounding or epsilon threshold relaxation.'), bilingual('目录只描述现有声明试算合同；依据解析不会执行计算，也不会改变旧得分或升级旧记录。', 'The catalog describes existing trial contracts; resolving a basis does not execute calculations, alter scores or upgrade historical records.')],
  exclusions: [...definition.exclusions, bilingual('不认证检查证据、缺陷分类、既有资格或项目适用性。', 'Inspection evidence, defect classification, prior qualification and project applicability are not authenticated.'), bilingual('不自动批准工程成果、签字或认证组织独立。', 'No automatic engineering approval, signatures or authentication of organizational independence.')]
}))

/** Contract parsing fixes property order before hashing. Source metadata is not
 * entered into SurveyStandardRegistry's independently trusted predicate set. */
export function surveyStandardBasisDigest(input: Rule): string {
  return createHash('sha256').update(JSON.stringify(SurveyStandardBasisRuleV1.parse(input)), 'utf8').digest('hex')
}
const entries = [...samplingRules, ...scoringRules].map(input => {
  const rule = SurveyStandardBasisRuleV1.parse(input)
  return { rule, ruleDigest: surveyStandardBasisDigest(rule) }
})
const catalogJson = JSON.stringify(SurveyStandardBasisCatalogV1.parse({
  schemaVersion: 1, catalogVersion: SURVEY_STANDARD_BASIS_CATALOG_VERSION,
  catalogDigest: createHash('sha256').update(JSON.stringify(entries.map(entry => entry.ruleDigest))).digest('hex'),
  rules: entries, updatePolicy: 'exact-version-only-no-automatic-latest', historicalRecordsModified: false
}))
export function getSurveyStandardBasisCatalog(): SurveyStandardBasisCatalogV1 {
  return SurveyStandardBasisCatalogV1.parse(JSON.parse(catalogJson))
}
export type SurveyStandardBasisFailure = 'validation' | 'exact-rule-version-unavailable' | 'standard-version-mismatch' | 'source-mismatch' | 'algorithm-mismatch' | 'profile-not-covered' | 'profile-version-mismatch'
export class SurveyStandardBasisError extends Error {
  constructor(readonly reason: SurveyStandardBasisFailure) { super(reason) }
}
export function resolveSurveyStandardBasis(input: unknown): SurveyStandardBasisResolvedV1 {
  const parsed = SurveyStandardBasisReferenceV1.safeParse(input)
  if (!parsed.success) throw new SurveyStandardBasisError('validation')
  const reference = parsed.data
  const entry = getSurveyStandardBasisCatalog().rules.find(({ rule }) => rule.ruleId === reference.ruleId && rule.ruleVersion === reference.ruleVersion)
  if (!entry) throw new SurveyStandardBasisError('exact-rule-version-unavailable')
  const rule = entry.rule
  if (rule.standardCode !== reference.standardCode || rule.standardVersion !== reference.standardVersion) throw new SurveyStandardBasisError('standard-version-mismatch')
  if (rule.source.sha256 !== reference.sourceSha256) throw new SurveyStandardBasisError('source-mismatch')
  if (rule.executor.algorithmVersion !== reference.algorithmVersion) throw new SurveyStandardBasisError('algorithm-mismatch')
  const profile = rule.profiles.find(profile => profile.profileId === reference.profileId)
  if (!profile) throw new SurveyStandardBasisError('profile-not-covered')
  if (profile.profileVersion !== reference.profileVersion) throw new SurveyStandardBasisError('profile-version-mismatch')
  return SurveyStandardBasisResolvedV1.parse({ schemaVersion: 1, catalogVersion: SURVEY_STANDARD_BASIS_CATALOG_VERSION,
    status: 'resolved-basis-only', reference, entry, profile, historicalRecordsModified: false })
}
