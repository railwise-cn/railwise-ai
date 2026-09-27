# 声明检查关联评估：最小接入合同草案

日期：2026-09-20。作者角色：独立 AI 技术设计与核查，不是专业人员签字。主树只读；本文不实施生产代码、签名或正式批准能力。边界已获主任务授权，由 production_metrics 在独立 worktree 实施。此项属于下一项独立变更，明确排除在当前最终候选包之外。

## 0. 本轮精确目标与非目标

新增一个独立 `quality-assessment` sidecar，把**当前成果包 + 已有保全计划/记录 + 已有抽样运行 + 明确选择的单位评分记录**连接起来，计算“当前本地记录之间的绑定、资料引用覆盖、单位评分覆盖与声明否决”。它解决当前三个孤立工作区之间没有关联检查的问题。

产品名：中文“声明检查关联评估”，英文“Declared inspection linkage assessment”。不得命名为“规范验收完成”“批准交付”。不把 `retention-only` 的旧计划改称规范质检计划；新对象称 `assessment-plan`，purpose 固定为 `declared-record-linkage-only`。

第一版仅接两个既有 profile，评分对象只接 `operation=unit`，检查范围来自一个既有首轮抽样运行的**全部实际 selectedUnitProductIds**。缺记录可保存 incomplete，不自行缩小目标集合；不生成额外抽样，不拼批，不由单位评分反推正式批合格，不重算新样本/批等级，不实现组织职责、专业签认、数字签名、整改重抽或正式批准。已有评分纯核/采样纯核保持冻结。

新能力可完整实现并验收，但不据此关闭总计划“完整 GB/T 24356 质检链”大任务。后续阶段/角色/签名属于单独、有授权和来源条件的增量。

## 1. 已核查的事实与可复用接口

主树 `/Users/wangjiawei/Documents/WorkWise`：

| 现有对象 | 权威读取入口 | 可复用事实 | 不能提升的语义 |
|---|---|---|---|
| 项目及成果 manifest | EngineeringService.getProject/getManifestForProject | 当前项目/修订/目录及manifest原对象；成果成员字节由保全严格读取核对 | 本增量不调用写审计的verifyDeliverable，不执行其五项成果复验；manifest.reviewStatus不变 |
| 材料保全计划与包 | SurveyQualityWorkspaceService.getPlan | projectBindingHash、manifestHash、artifactId/artifactHash=bundleHash、成员身份/路径/字节/哈希、固定 requiredCheckIds | purpose=evidence-retention-only；成员存在不代表内容满足专业检查 |
| 材料保全记录 | SurveyQualityWorkspaceService.getRecord | record.planId/planHash、events、当前 headHash、逐项 passed/missing；重读文件和保留字节 | 当前 coverageStatus 固定 not-evaluated；checkpointTrust=local-records-only |
| 抽样总体及运行 | SurveySamplingWorkspaceService.getPopulation/getRun/listSamples | 原始定义、populationHash、planHash/runHash、stage、mode、round=1、实际完整样本 | 总体完整性/空间均匀性/随机独立见证均未验证；阶段取值不是阶段完成 |
| 单位评分记录 | SurveyQualityScoringWorkspaceService.getRecord | 原字节/来源/模型/结果/环境/record hashes；每次真实重算；unitId、profile、scope、分数/否决 | 来源资料、缺陷分类、允许值及此前条件是caller declaration；不认证真实检查 |
| 规范来源合同 | survey-standard-quality.ts；SurveyStandardRegistry；既有采样/评分source常量 | 精确code/version/source hash/profile版本/表号；已有pure registry可作未来生产适配 | 没有生产受信rule目录；不得把客户端传的ruleDigest注册为trusted |
| 最终覆盖纯核 | evaluateSurveyFinalArtifactCoverage | 已有事件链/改正后同摘要复查逻辑 | 它要求独立保留计划与checkpoint；本轮不能伪造checkpoint调用它来取得covered |

建议只为材料保全服务增加一个内部只读 `getAssessmentSnapshot(projectId, planId, recordId)`：在同一源数据库read transaction内、共享artifact读取缓存，返回既有严格schemas的plan/artifact/record/events/verification。复用原有 readPlan/readRecord/byte guards，不开放新写入口、不绕过检查、不读取调用方文件路径。若不增加helper，可调用现有严格公开读法，但必须记录重复磁盘IO预算。

**现有成果复验不是只读能力**：`EngineeringService.verifyDeliverable`会追加`engineering_verification_attempts`。本增量不调用它、不暴露绕过审计的私有checkDeliverable接口，也不新增另一套成果复验。严格保全snapshot负责精确manifest/输出/保留字节一致性；评分/抽样服务各自真实重算。成果输入与原工程数值五项复验仍由原有显式操作执行，本评估固定输出`deliverableVerification: not-performed-by-assessment`、`deliverableNumericalReplay: not-performed-by-assessment`，不将关联读操作计入生产复验指标。该标记不否定源评分/采样自身的重放，只限定成果verification范围。

抽样仅需getPopulation/getRun和一次listSamples(limit=100, offset=0)，因为本轮拒绝sampleSize>8；无须暴露随机种子或完整内部采样计划。运行getRun已经完整重算所有抽样，不能拿缓存摘要充当验证。

## 2. 来源与准许引用的依据

官方全文：[贵州省自然资源厅附件](https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf)。GB/T 24356—2023，129页，27,976,440字节。本轮重新读取既有本地PDF并计算SHA-256，确认为：

`96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`

本轮依据既有页图核查记录，不声称再次目视审定全部正文。来源记录：`docs/qa/evidence/railwise-standards-20260920/sources.json`；更晚的评分精确核读：`docs/qa/evidence/railwise-quality-scoring/implementation-contract.md`；已实现完整采样表应以 `survey-quality-sampling.ts` source合同为准，早期sources.json“未编码完整表”是历史研究时点。

| 条款 | 印刷页 / PDF页（从封面1起） | 已有依据 | 本轮允许的实现 |
|---|---|---|---|
| 4.1 | 3 / 6 | 结合标准、批准设计/补充资料、合同任务/委托依据 | 保存声明依据及其明确材料引用；“批准”真实性未认证 |
| 4.2.1–4.2.4 | 3 / 6 | 阶段独立有序；过程全数、终检内业全数，终检外业/验收允许按条件抽样 | 精确保留run.stage/mode，拒绝把抽样当内业全数；不认定实际职责及阶段完成 |
| 4.5.1–4.5.2 | 4 / 7 | 保存记录/报告，检查者和复核者签字 | 保全绑定与追溯；本轮不实现或模拟签字 |
| 4.6.1–4.6.3 | 4 / 7 | 改正/重新检查；失败批重新申请需重新抽样 | 新成果摘要不复用旧评估，保留旧记录；重新检查轮次不在V1覆盖范围 |
| 5.1、5.2、表1 | 5 / 8 | 明确成果单位、总体与抽样/分批 | 完全复用已冻结采样结果，不从文件/观测/点数推算总体；不新增表阈值 |
| 5.3.3 | 6 / 9 | 抽中单位成果包含全部资料及补充依据 | 冻结“单位→已声明应含材料”的映射并逐项查存在/保全状态；不认证该声明已穷尽全部法定资料 |
| 6.2.1.2、6.2.3–6.2.5 | 6–8 / 9–11 | A/子项低于60否决、分层和部分范围不能混用 | 读取既有unit结果；partial/pending不能计作完整单位评分覆盖；不自行评分 |
| 6.3、6.4.1–6.4.2 | 8 / 11 | 样本、最终批和验收批前提不同 | 本轮不生成样本等级/终检批等级/验收批合格性，只汇总已声明单位状态 |
| 7.5.1 表43/44；7.5.2 表45/46 | 57–63 / 60–66 | 平面控制单位为点、高程控制单位为测段；产品profile不同 | 只能选既有两profile，与unitType和表号严格匹配 |

SHA-256、追加SQLite、两遍读取、8单位上限、API形状、状态码均为**软件设计策略**，不是标准规定。没有新增检测阈值。t≠1、m>m0、多精度项恰60、检测数恰20等原有未覆盖分支继续原样unavailable。

## 3. Contract草案（严格schema，不接受未列字段）

### 3.1 共用原子与固定信任标记

ID：exact valid Unicode、不可前后空白、1..160字符；引用现有采样unit ID允许原schema上限200，**不得trim/截断**，但进入既有评分unitId时须满足其160字符合同，否则本版unsupported。SHA-256为64个小写hex。时间由服务端生成ISO8601。原始请求用fatal UTF-8解析，拒绝重复/escaped-equivalent键、孤立surrogate、过深嵌套及超限。

固定边界（plan、assessment、verify和export中保持相同）：

```ts
purpose: 'declared-record-linkage-only'
associationTrust: 'caller-declared-not-authenticated'
inspectionEvidenceAuthenticity: 'not-verified'
materialCompletenessBeyondDeclaration: 'not-evaluated'
populationCompleteness: 'caller-declared-not-verified'
classificationAuthenticity: 'not-verified'
organizationIndependence: 'not-evaluated'
stageCompletion: 'not-evaluated'
checkpointTrust: 'local-records-only'
standardConformity: 'not-evaluated'
humanSignatureVerification: 'not-evaluated'
engineeringDecision: 'not-evaluated'
approvalCapability: 'none'
formalResultsModified: false
deliverableVerification: 'not-performed-by-assessment'
deliverableNumericalReplay: 'not-performed-by-assessment'
```

不要返回无修饰 `passed/approved/qualified/covered` 全局状态。内部保全单项原status可保留，但必须标注其retained-byte语义。

### 3.2 冻结关联计划请求 `SurveyQualityAssessmentPlanCreateV1`

```ts
{
  schemaVersion: 1,
  acknowledged: true,
  expectedProjectRevision: positiveSafeInteger,
  idempotencyKey: exactString8To160,
  retentionPlanId: Id,
  retentionRecordId: Id,
  samplingRunId: Id,
  productProfileId: 'planar-control-point' | 'height-control-section',
  basisStatement: exactUtf8TextUpTo16KiB,
  // Exactly all selected sample IDs, in source order. Server verifies, never trusts a submitted subset.
  unitMaterials: Array<{
    unitId: UnitId,
    requirements: Array<{
      reference: Id, // exact scoring evidenceRefs/aEvidenceRefs value to be resolved
      retentionCheckId: Id,
      memberId: Id,
      locatorStatement: exactUtf8TextUpTo1000Bytes
    }>
  }>
}
```

要求：1..8 units；每单位至少1 requirement；全计划≤64映射；同单位reference唯一。允许同一真实资料成员为多个单位共用，但映射逐单位显式；不把共用文件按单位复制成“独立检查”。checkId/memberId必须来自**同一retentionPlan**固定requirement；artifact-bytes为自动全局要求，不能充当单位专属检查引用。禁止自定义通过状态、hash、actor、rule threshold、缺陷分类、sampling seed、批准人字段。

服务器从严格源读冻结：project snapshot/binding；retentionPlan精确对象digest；artifactId/bundleHash/manifestId/manifestHash/members；retentionRecordId；sampling populationId/populationHash/definitionEvidenceSha256、runId/runHash/planHash、stage/mode/round、完整选中ID与其序列digest；profileVersion/table43/44或45/46；标准code/source hash与采样/评分既有algorithm/source constants。既有总体productType/unitProductType是自由文本，不能据字符串相似自动等同profile；保留原始定义与用户显式profile绑定并标记caller-declared。

**head不冻结为永远不可变**：plan只冻结retentionRecordId和其所属plan；assessment时冻结那次current head/eventCount。否则plan创建后补齐检查会导致计划永远不可评估。plan读时仍重核所属关系与当前目标包；评估记录则严格绑定当次head。

输出 `SurveyQualityAssessmentPlanV1` = 请求原文/parsed request、上述服务器snapshot、id、createdAt、requestSha256/size、planHash、algorithmPolicyVersion、固定边界。保留basis原字节。

### 3.3 创建评估请求 `SurveyQualityAssessmentCreateV1`

```ts
{
  schemaVersion: 1,
  acknowledged: true,
  expectedProjectRevision: positiveSafeInteger,
  idempotencyKey: exactString8To160,
  assessmentPlanId: Id,
  expectedPlanHash: Hash, // optimistic concurrency selector only, not proof supplied by client
  unitScores: Array<{ unitId: UnitId, scoringRecordId: Id }>
}
```

unitScores可0..8（允许完整显示缺失项），无重复unitId和recordId，unitId必须是计划全部目标集合内成员。客户端不得传分数、资格、coverage、outcome、材料状态、human身份。评分记录只能unit操作；profile/version/表号/sourceDigest须匹配冻结计划；评分unitId必须精确等于关联unitId。请求不同顺序保留原文，计算按冻结target顺序输出，不改变既有record的schema-normalized/JSON hash方式。

允许关联计划创建前已有评分，但输出 `associationTiming: 'existing-record-linked-after-calculation'`，**不宣称检查时已绑定该成果**。新评分也仅证明时间顺序，不证明采集来源真实性。每条 `declaredTargetAssociation`固定标记caller declaration。

### 3.4 评估记录 `SurveyQualityAssessmentV1`

包括：id/project snapshot/revision/createdAt；完整request原字节与hash；assessmentPlanId/planHash；source binding vector；算法版本；计算结果；recordHash；运行环境快照。source vector至少：

```ts
{
  manifestId, manifestHash, artifactId, bundleHash,
  retentionPlanId, retentionPlanDigest, retentionRecordId, retentionEventCount, retentionHeadHash,
  populationId, populationHash, populationDefinitionHash,
  samplingRunId, samplingRunHash, samplingPlanHash, sampleIdsHash,
  scoring: [{ unitId, recordId, requestSha256, declarationSha256, modelHash, resultHash, recordHash }],
  standardCode, sourceSha256, profileId, profileVersion, weightTable, classificationTable,
  dependencyAlgorithmVersions
}
```

计算结果分轴，不折叠成一个“通过”：

- `bindingIntegrity: 'verified-current-local-records'`（只在两遍读取及binding一致后输出）；
- `retentionCoverage: 'complete-declared-requirements' | 'incomplete-declared-requirements'`；
- `scoreCoverage: 'complete-full-profile-unit-results' | 'incomplete-full-profile-unit-results'`；
- `declaredResultSummary: 'contains-declared-nonconforming' | 'all-declared-unit-results-calculated' | 'unresolved'`；
- `overallLinkage: 'complete-declared-linkage' | 'incomplete-declared-linkage'`；
- `unitRows`依完整冻结sample顺序返回，列出material requirements及命中的event、每个评分evidenceRef解析结果、record scope/outcome/reason/精确得分（原对象），缺失及不可用原因；
- `counts: expectedUnits, linkedScores, fullProfileUnits, requiredMaterialMappings, satisfiedMaterialMappings, unresolvedReferences`，整数；没有用户定义的合格率/规范百分比；
- 固定边界；`manifestReviewStatus`是源manifest的只读回显，UI前缀“原清单状态”；新评估自身无reviewStatus字段。

创建返回本次已经严格验证的**完整记录**，客户端直接验证，不进行第二次GET（见资源预算）。GET详情/POST reverify/GET export均做一次完整新鲜评估与snapshot比对；reverify返回重新核验的完整记录+checkedAt envelope，不再连发detail请求。record内容的createdAt不变，checkedAt不进入持久recordHash。

## 4. 准入与覆盖计算表（无新规范阈值）

| 输入/依赖情况 | 技术行为 | 覆盖/声明结果 | 说明 |
|---|---|---|---|
| JSON不合法、重复键、wrong kind、未知字段、重复绑定 | HTTP400，不保存 | 无可接受记录 | 先做结构检查，不把错请求包装成工程不合格 |
| 跨项目、对象不存在 | 404；不泄露其他项目身份 | 无 | 所有reader以请求projectId限定 |
| 项目revision/workspace改变，目标成果/member摘要变 | 409 stale/source-changed | 原记录仍保留，当前详情不可恢复 | 新成果必须新计划，不自动重定向旧plan |
| 源存储hash/metadata/纯核重算不一致 | 409 integrity | 当前拒绝；列表注明dependency-unverified直至详情检测 | rehash全部普通摘要也不能绕过source replay |
| 采样sampleSize>8、round≠1、不支持profile/unitId | 422 unsupported-scope（软件限制） | 不截断、不拆成任意子样本、不退化无抽样 | 已有采样能力仍可正常单独使用 |
| process/final-office非census | 400或源integrity，不能继续 | 无 | 理论上existing schema已拒绝，集成再次绑定 |
| 提交unitMaterials少一个/多一个sample ID或顺序不符 | 400 incomplete/mismatched-plan-scope | 不冻结缩减计划 | 采样run为唯一目标集合来源 |
| retention plan的任一requiredCheckId尚无passed | 保存有效incomplete评估 | retentionCoverage=incomplete | 包含artifact-bytes及所有原requiredEvidence，客户端不能只选本次方便项 |
| 每单位mapped check尚missing | unit材料missing | retentionCoverage=incomplete | 原始证据真实性仍未评估 |
| 分数引用的任何evidenceRefs/aEvidenceRefs没有对应本unit mapping | unresolved-reference | overallLinkage=incomplete | 对unit schema递归白名单遍历root/leaf/model/items/weighted basis refs；不得用任意递归字段名匹配信任 |
| 缺某unit评分record | missing-score | scoreCoverage=incomplete；summary=unresolved除非别项已否决 | 缺失不等于100或0 |
| operation=accuracy/deduction/sample/final-batch/acceptance-batch | 400 incompatible-record-role | 不冒充unit完整评分 | 既有7操作继续可单独使用 |
| 单位评分scope=partial/unresolved | 保存、显示其原范围/结果 | 不计full-profile覆盖 | 若已nonconforming仍在declaredResultSummary显式显示 |
| full-profile但unavailable/invalid | 保留原reason | scoreCoverage=incomplete | 不支持分支不可通过关联修复成成功 |
| full-profile且calculated | 计一个完整单位结果 | 原精确分数展示 | 不重新舍入、不推批资格 |
| full-profile且nonconforming | 计一个完整单位结果（已有明确结论） | contains-declared-nonconforming | “资料/记录齐全”可与“声明结果不合格”同时存在 |
| 任一已绑定unit nonconforming，其他missing | 同时显示incomplete及contains-declared-nonconforming | 不因缺失隐藏已知否决，不制造综合分 | 原始否决依据继续是声明 |
| 所有材料/refs满足且所有目标unit有full-profile calculated或nonconforming | overallLinkage=complete-declared-linkage | 否决优先显示；否则all-declared-unit-results-calculated | 不是covered标准、不是stageCompleted、不是approved |
| 保全record在评估后新增任意事件（head改变） | 历史记录保存；当前GET 409 source-changed | 新评估取新head | 不把正常追加误标存储篡改 |
| 原manifest是draft | 永远保持draft | 界面与导出标记待审 | 任何完整关联、分数、重放不能写回approved |
| 原manifest已有approved字符串 | 只读回显旧状态且加“签认未验证” | 本次assessment仍无approval | 不认可也不覆盖历史数据 |
| rate-limit/服务暂不可用 | 429/503，可重试原请求 | 不保存incomplete作为“检查失败”，不将healthy source标坏 | 资源状态≠记录损坏 |

覆盖公式（逻辑，不做浮点比率）：

1. `retentionComplete = every original requiredCheckId passed AND every frozen per-unit material mapping passed AND every referenced member identity/hash matches`。
2. `scoreComplete = each complete frozen sample unit has exactly one linked unit result with complete-declared-product-profile AND outcome in {calculated,nonconforming}`。
3. `refsResolved = every actual scoring evidence reference resolves exactly once to a satisfied mapping of that same unit`。
4. `overallLinkageComplete = retentionComplete && scoreComplete && refsResolved`。
5. `declaredResultSummary = any selected record nonconforming ? contains-declared-nonconforming : (all full profile calculated && scoreComplete ? all-declared-unit-results-calculated : unresolved)`。summary和overallLinkage分轴，不借结果summary抹去资料缺失。
6. 出现未知标准规则/未注册production rule，不执行新规则，`standardConformity`仍not-evaluated。精确标准hash匹配只是关联，不是适用性认证。

## 5. 源读取、并发与重放

现有数据分别位于多个SQLite/文件，不能声称有跨库ACID snapshot。实现两遍严格依赖读取：A遍读取完整材料snapshot、当前manifest身份及精确字节绑定、采样与评分并计算（不调用带写审计的成果verifyDeliverable）；B遍重新读取、重算并比对所有source vector和结果；写评估库前再次读取当前project binding。任一变化就不发布新评估，返回source-changed。这是有界乐观一致性策略；并不检测外部恶意ABA/整库回滚，也不是独立托管。

为了避免先写后读第三遍超预算，A/B验证完成再将已验证record写入评估库，返回该对象；read-after-write只读自身新行验证序列化hash，不能再重放所有source。GET恢复在两遍源验证之后重算本次关联与保存record.result逐值比较；不信任保存布尔值。自库请求/源binding/result/hash全部一致但修改计算内容时，重放仍必须拒绝。

source依赖由构造器注入**固定只读capability**：project/getManifest、quality snapshot、sampling reads、scoring.getRecord。评估服务不能获得 finalize/updateProject/approve/appendQualityCheck/createScore/verifyDeliverable 等写方法。不得通过“方便”直接打开源数据库绕过其hash/重算/权限/限流。

不把本库head赋给 `SurveyQualityCheckpointV1`，不调用旧final coverage核伪造独立checkpoint。采用本文专属declared-linkage evaluator，明确不替代该纯核的规范范围与前提。

## 6. 持久化/API/资源

独立 `survey-quality-assessment.sqlite3`，两表assessment_plans/assessments，原始UTF-8 request BLOB，parsed normalized records，SQL metadata，canonical digest，唯一(project,idempotencyKey)。UPDATE/DELETE/REPLACE禁止；同key完全相同原字节重试返回同ID且仍严格检查source，改空白也conflict。schema/version专用，旧库/manifest不迁移。

建议每项目128plans、128assessments、总64MiB，request≤256KiB、record≤512KiB（不嵌入8份完整评分原文，只保存摘要、精确结果投影及source IDs，原数据由其既有不可变仓储保存）、8units/8scores、64material mappings。来源单record仍遵守既有4MiB，最大一轮评分输入物化32MiB；按条读出只留必要投影，禁止把所有原文重复入结果。保全文件遵守既有每件32MiB/每包128MiB，无声称wall-clock SLA。

评分getRecord成本5+ceil(modelUnits/8)。unit最坏64数学精度项+6其它叶=70，故每条14，两遍8条=224，低于现有240/min。资源读取不能跳过既有限流；已有其他工作耗预算时429正常，Retry-After沿用。自己的计算/IO同时加每项目有界预算；失败/重复也收费。最大8units是**本版软件范围**，不是GB/T样本量限制。若未来扩大容量，应设计独立分阶段作业和一致性策略，不能简单绕过source限流。

建议认证路由：

- POST/GET `/v1/engineering/projects/:projectId/quality-assessment-plans`
- GET `.../quality-assessment-plans/:id`
- POST/GET `/v1/engineering/projects/:projectId/quality-assessments`
- GET `.../quality-assessments/:id`
- POST `.../quality-assessments/:id/reverify` body `{}`
- GET `.../quality-assessments/:id/export`

返回no-store；创建201；限制query重复/未知参数；主进程IPC只允许上述方法/严格body/分页。

**列表明确不重放所有依赖**：每页10条，校核本库SQL/record内部绑定及当前项目binding，返回 `view: 'saved-summary-only', dependencyVerification: 'not-performed-on-list'`。不得显示“当前核验通过”绿灯；summary有createdAt且提示“保存时结果，打开后重新核验”。损坏本库行隔离不隐藏其他条。详情/复验/导出走完整源重放。这样10条列表不会产生10×224成本；不得偷偷沿用已有工作区“列表全重算”语义。源坏记录在打开时明确拒绝，列表不能错误暗示已检查源完整性。

## 7. 最小UI及防止草稿被批准

独立面板放当前“成果与审查”阶段，从已有manifest/保全plan/record及抽样run选择，逐单位显示源run真实选中ID与资料映射。显示来源定义、profile、阶段和只读结果，不添加“批准”“转正式”“签字”“完成验收”按钮。

计划冻结前展示关联边界并显式确认；计划保存后required集合不可编辑。新建评估从计划展开完整单位，逐项选既有unit评分记录或保持缺失。不得自动选“最高分”或“最新成功”记录；选择由用户明确完成并保留ID。开启新计划允许不同声明，因此不宣称防止用户选择性申报，旧评估始终留存。

结果第一屏并列“资料关联范围”“单位结果覆盖”“声明否决”，并显示“未认证真实检查；未完成组织职责/签认核验；不改变待审草稿”。原manifest draft必须仍展示“待审查”。partial本身显著显示部分；缺失/unsupported不可变成完成标签。

中英、明暗、常规/窄/最大化、键盘读写、精确fraction、不依赖Buffer、迟到请求scope变化全部沿用已有pattern；注意create/reverify返回detail，别接第二次GET。原生导出完整assessment及source reference vector，fresh replay后UTF-8另存，取消不报成功。导出无外部签名/证书。

不改 `DeliverableManifestV1` 和 `DeliverableVerificationV1.checks` 五项合同；不把旧valid解释为新quality结果。绑定sidecar ID如需在未来manifestV2引用，另立兼容设计，不在本轮执行。

## 8. 有意义的实施验收与独立核查

必须用真实临时quality/sampling/scoring/engineering服务和SQLite，至少一个完整合成3单位fixture；不能用全mock source替代接入测试。

1. 3单位全数采样、真实draft三格式包、对应保全check、3份完整unit评分：complete-declared-linkage；manifest仍draft、输出字节不变；source IDs/hash精确匹配。
2. 相同单位中一份partial→scoreCoverage incomplete；pending/multi60→unresolved；一份明确nonconforming+另份missing→同时incomplete与contains-declared-nonconforming，不能算综合合格分。
3. 漏/多/重复/乱序sample映射，跨project，plan/hash/profile/version/table/unit mismatch，非unit评分，一份record重复给两个unit，全拒绝；有相同字节但不同memberId/artifactId仍不能偷换。
4. 评分root/leaf/items/aEvidenceRefs/weighted basis任何引用缺映射，映射check未过，原plan另一个requiredCheck未过，即使所选unit分数全100也incomplete。
5. 原始UTF-8/emoji/空白保存，重启同ID；重复key/escaped-equivalent/超限/孤立surrogate拒绝；同key不同原字节conflict。
6. 篡改assessment.result并重签自身全部hash，恢复仍被源重放/关联重算拒绝；分别对源score数值、sampling名单、保全head/文件做更改，保留底层拒绝语义。正常追加head变化为source-changed，不标tamper。
7. 两遍间修改project revision/源head/file，拒绝发布新assessment；完全相同source恢复后可新鲜复验；旧失败证据/记录不覆盖。
8. 最大8unit（每个64精度项+6叶）单次两遍224可通过，紧接请求预算不足返回429，不标integrity；list10条不重放源，明确saved-summary-only；第9unit返回unsupported且不截断。
9. 全链生成/重放/导出无写入旧manifest.reviewStatus；注入只读依赖API，测试禁止approve/finalize/verifyDeliverable capability；对比旧工程复验审计表行数不变，并核对not-performed-by-assessment标记；伪造human/approved/signature字段400。原有5类工作区/旧manifest可读。
10. 真实HTTP auth、no-store、IPC约束与非404内部分类；GUI中英完整/不完整/否决、保存/取消导出、恢复旧profile、Buffer缺失、revision/workspace/offline/cancel迟到隔离。
11. 最终独立核查：纯核5+4hash冻结、source linkage重算、最大资源界限、真实candidate数据库重放；本项独立变更未来候选的GUI/签名公证/updater由主任务另行安排，不能用DOM通过替代；不得混入当前最终候选包。

## 9. 建议实施分工与交付顺序

A. 本文bounded语义已获主任务授权，直接交付实施，不再等待重复确认。本项作为下一项独立变更，当前最终候选包明确排除。
B. production_metrics独立worktree：data-only contracts +纯linkage evaluator +保全只读snapshot helper +服务/存储 +真实跨服务测试 +authenticated routes/IPC +小型双语UI；冻结旧数值核，不动主树。
C. interface_review独立不改实现：另写跨库fixture、负例/资源/GUI探针，核对source与scope不被提升。
D. 下一项独立变更准备就绪后，由主任务决定独立整合时点、全量回归、精确安装包验收和台账更新，保留未实现的组织职责/专业签名/正式批准大项。

本文是可实施草案；未产生真实工程批准，未新增规范阈值，未修改主树。
