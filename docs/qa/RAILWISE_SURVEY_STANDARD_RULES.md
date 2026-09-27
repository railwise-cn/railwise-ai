# Survey 规范规则与质检记录内核

## 当前实现索引（2026-09-20）

本页下文保留内核增量及各轮研究的历史说明。其中“没有内置抽样/评分”“尚未接入数据库、HTTP 或 UI”限定于相应内核/当时增量，不再代表整个产品现状。截至源码 `43689493ab586c8d65bae729cfd291f3c813f679`，已有[证据保全与首轮抽样工作区](RAILWISE_SURVEY_QUALITY_WORKSPACE.md)、[限定声明评分](evidence/railwise-quality-scoring-workspace/README.md)、[首轮材料与评分关联评估](evidence/railwise-convergence-281dc8767250/README.md)和[精确规范依据目录](evidence/railwise-standard-basis-20260920/README.md)，包含各自的 Runtime、持久化和桌面接线。

这些能力仍不等于受信规则完整执行、实际缺陷认证、整改后重抽、完整组织阶段、真实数字签名或批准交付。完整缺口见[总计划未完成清单](RAILWISE_SURVEY_REMAINING_WORK.md)。当前最终候选状态为 `in_progress`；源码、历史包与待验最终包的证据分别记录，不用此索引关闭包验收或人审。

## 历史内核增量说明

此增量提供可接入 Runtime 的版本化规则注册和质检事件链。它没有内置 GB/T 24356-2023 或其他真实规范的阈值、抽样数、评分表，也没有实现该标准的符合性判定。09-19 的[官方来源记录](evidence/railwise-research-20260919/standards-source.json)仅覆盖元数据；09-20 已取得[官方全文并核对列明条款](evidence/railwise-standards-20260920/README.md)，包括检查顺序、抽样、评分和工程控制分类。扫描页来源仍需与规则合同衔接，完整映射、独立专业签认及生产流程未完成；研究记录没有自动进入受信规则集合。

## 规则执行条件

入口为 `kun/src/engineering/survey-standard-registry.ts`，合同在 `kun/src/contracts/survey-standard-quality.ts`。必须同时满足：

- 用 `standardCode + standardVersion + ruleId + ruleVersion` 精确选择规则；没有自动选择最新版或替换版本。
- 任务类型、等级、地区逐项精确匹配，时间落在配置的生效区间 `[effectiveFrom, effectiveUntil)` 内；不解释通配符。
- 指标和单位完全相同；不做隐式单位换算，输入必须为有限数。
- 来源为 `full-text`，具有全文 SHA-256、条款位置、条款字节范围和 SHA-256；读取的真实字节与两项哈希一致。
- 全文摘要存在于调用方受信集合中，**完整规则内容的摘要**存在于独立审核集合中。修改阈值、适用范围、来源、条款或版本都会使旧审核摘要失效。
- 同一规范版本、同一适用范围和指标下，不存在单位、操作符或阈值冲突的注册规则。发生冲突时不自动选择较严或较宽的规则。

缺少任一条件时，返回 `outcome: 'not-evaluated'` 和稳定原因码。非法合同、重复精确版本在注册时抛错。`official-metadata` 即使带有阈值也不能执行，可以不填条款位置。来源读取失败不暴露底层路径或异常文本。

可执行断言只有有限标量的 `lte`、`gte`、`abs-lte`。它不是任意代码或表达式执行器。单条谓词执行的结果可为 `passed` 或 `failed`，但 `standardConformity` 始终为 `not-evaluated`。

```ts
import { SurveyStandardRegistry } from '../../kun/src/engineering/survey-standard-registry.js'

// 三项输入由受信调用方提供；不能从模型文本或同一未审核上传中直接授予信任。
const registry = new SurveyStandardRegistry(registeredRules, {
  fullTextSha256: verifiedFullTextHashes,
  reviewedRuleDigests: independentlyReviewedRuleDigests,
  readSource: sha256 => retainedSourceBytes.get(sha256)
})
const evaluation = registry.evaluate(exactRuleReference, {
  taskType: project.taskType,
  grade: project.grade,
  jurisdiction: project.jurisdiction,
  at: inspectionTime,
  metric: measurement.metric,
  unit: measurement.unit,
  value: measurement.value
})
```

这是依赖注入示例，变量必须来自真实项目和受信存储。内核验证内容完整性，不验证发布机构身份、来源使用许可或审核人的真实身份。调用方负责这些信任来源，不能把设置集合视为已完成人工审核。测试只使用明确标为 `TEST-ONLY` 的虚构规则。

## 质检记录

入口为 `kun/src/engineering/survey-quality-record.ts`。`appendSurveyQualityEvent(history, event)` 返回新的事件数组，不改变历史。事件类型为原始检查、指定成果检查（`artifact-check`）、发现问题、记录整改、复核问题；阶段名称由项目流程提供，不声称是标准规定的检查层级。现有 V1 事件及其哈希保持兼容。

- 每条事件绑定项目和原成果摘要，保持连续序号、非倒退时间、前项哈希与自身哈希。
- 问题必须引用之前的非通过检查；整改必须对应未关闭问题，并绑定新的成果摘要。
- 复核必须引用该问题最新的整改编号和同一整改成果摘要；未解决结果保留问题，已关闭问题不能重复关闭。
- 原始检查编号唯一；`artifact-check` 可重复引用该逻辑检查编号，必须明确 `checkedArtifactSha256`，且不能更换或省略原检查的规范规则版本。重复事件、原始检查、问题或整改编号、跨项目混入、篡改和非法顺序被拒绝。

```ts
const next = appendSurveyQualityEvent(history, recordedEvent)
const checkpoint = {
  projectId: next[0].projectId,
  artifactSha256: next[0].artifactSha256,
  eventCount: next.length,
  headHash: next.at(-1).thisHash
}
// 将 checkpoint 独立保存，不能每次从待验证链重新生成。
const integrity = verifySurveyQualityRecord(reloadedEvents, retainedCheckpoint)
```

无独立检查点时，哈希链不能证明末尾没有被截断，也不能抵御整条链被重新计算后替换。`valid` 只表示记录完整性；为空的链可完整但没有检查。`standardConformity` 和 `humanSignatureVerification` 始终为 `not-evaluated`。事件中的摘要和人员标识本身不证明原文件存在、数字签名有效或人员已签认；`valid: false` 时不可把附带数量用于验收。尚未接入数据库、HTTP 路由、交付 manifest 或 UI。

## 最终成果检查覆盖

`openIssueCount = 0` 只说明各问题分别记录了闭环，整改可能对应不同成果版本。新增 `evaluateSurveyFinalArtifactCoverage(history, request)` 独立评估指定最终成果的记录覆盖，不能直接以问题计数放行。

```ts
const coverage = evaluateSurveyFinalArtifactCoverage(reloadedEvents, {
  schemaVersion: 1,
  projectId,
  finalArtifactSha256,
  requiredCheckIds: independentlyRetainedCheckPlan.checkIds,
  checkpoint: independentlyRetainedCheckpoint
})
```

`requiredCheckIds` 必须非空且唯一，由独立保存的项目检查计划提供，不能从本次通过的检查动态挑选；缺少独立检查点或非法请求抛出合同错误。完整性检查不通过（包括篡改、重排、检查点不符或尾部截断）及项目不符时，返回 `coverageStatus: 'not-evaluated'`，不返回可供拼接的通过检查列表。

返回 `covered` 必须同时满足以下条件：

- 链完整且符合独立检查点，所有已打开问题都已闭环。
- 每个必需编号都有检查记录；按链上序号选择该逻辑检查的最新记录，同时间戳不会造成歧义。
- 每项最新记录都绑定请求中的同一个 `finalArtifactSha256`，且结果为 `passed`。不能回退选取较早的通过结果，也不能拼接不同版本上的通过检查。
- 每项检查都晚于链上最后一次整改事件。任一后续整改都会要求最终成果重新完成全部必需检查，避免先前检查对新成果失效。

旧 `check` 仅覆盖链头原始成果；`issue-rechecked: resolved` 只关闭问题，不能替代对最终成果的 `artifact-check: passed`。缺项、失败、未评估、成果摘要不符、整改后未重检或未闭环返回 `incomplete`，并列出逐项状态与关联事件。

输出明确标记 `assessmentBasis: 'recorded-events-only'`，`standardConformity` 和 `humanSignatureVerification` 仍为 `not-evaluated`。`covered` 表示给定检查计划在事件记录中的覆盖，不表示已批准交付。调用方仍须核实最终成果及检查证据的真实字节、检查语义、计划完整性与人员身份；内核不会把任意填写的 `passed`、摘要或同链现算的检查点提升为独立证明。该函数尚未接入持久化、GUI 或交付流程。

## 验证

新增 `scanned-pdf` 来源分支，以 PDF 字节 SHA-256、1-based PDF 页、可选印刷页、固定渲染器/版本/DPI、RGB8 全页与可选区域像素摘要、UTF-8 转录及复核证据绑定扫描条款。旧 `full-text` 字节摘录、`official-metadata` 与已保存规则摘要兼容，混用两种摘录形式拒绝。记录 actor 的 human/agent 字段仅为声明，不认证身份。

规则仍需独立保存的精确规则摘要和全文信任，不能仅由网页地址或同次输入自授信任。受信 `renderPdfPage` 必须从已核实 PDF 字节实际重渲染；内核核对全页及逐行裁剪区域，不接受无关图片代替来源。没有渲染器或复核证据时返回未评估。扫描专属上限为 PDF 64 MiB、复核证据 1 MiB、全页 1600 万像素/4800 万 RGB 字节；渲染器必须在分配前执行尺寸预算。本增量尚未接生产渲染服务、规则登记、数据库或 GUI。

[真实官方 PDF 渲染合同验证](./evidence/railwise-standards-20260920/renderer-contract.md)已使用 GB/T 24356-2023 第 4.2.1 条所在 PDF 第 6 页，经 Poppler 26.05.0 在 72 DPI 实际重渲染并核对完整 RGB、区域、转录及复核证据。缺少独立全文/规则摘要、换页、换转录、改区域及超预算请求均拒绝。试验只注册 `TEST-ONLY-SOURCE-BINDING` 非规范标记，reviewer 为 agent，不把测试信任集合作为真实人工审核。扫描/质检定向 59 项通过，最终 Runtime 全量 1741 通过 / 3 跳过。

```sh
cd kun
npm test -- --run src/engineering/survey-standard-registry.test.ts src/engineering/survey-quality-record.test.ts
npm run typecheck
```

2026-09-20：28 项独立测试通过，覆盖版本隔离、来源与条款篡改、元数据默认不执行、规则冲突、时间/单位边界、整改产物绑定、独立检查点，以及最终成果的混合版本、最新失败/未评估、规则版本替换、缺项与未闭环边界；Runtime 类型检查与相关文件 ESLint 通过。
