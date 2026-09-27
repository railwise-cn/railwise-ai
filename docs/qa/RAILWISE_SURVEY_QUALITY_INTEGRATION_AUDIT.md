# Survey 质检链 Runtime 接入审计

## 当前实现索引（2026-09-20）

下文是 `4f859c081b33e6f0f9b8d16f9c046466ccb90e75` 的历史审计，原结论与建议保持原样，不应把“尚无质检专用 Runtime 服务、持久化”当作当前源码状态。截至 `43689493ab586c8d65bae729cfd291f3c813f679`，已接入[材料保全/质量记录和首轮抽样工作区](RAILWISE_SURVEY_QUALITY_WORKSPACE.md)、[限定声明评分](evidence/railwise-quality-scoring-workspace/README.md)、[首轮关联评估](evidence/railwise-convergence-281dc8767250/README.md)及[规范依据目录](evidence/railwise-standard-basis-20260920/README.md)。这些增量具有独立的持久化、认证 Runtime/IPC 与桌面入口，历史包已有各自限定验收记录。

仍未完成的范围包括受信规则/项目适用性、真实材料与缺陷分类核验、整改后重抽、完整阶段职责及授权、独立签名认证和批准交付门禁，见[总计划未完成清单](RAILWISE_SURVEY_REMAINING_WORK.md)。当前最终候选状态为 `in_progress`；本索引不将历史包证据改写为最终包通过，也不将声明评分、字节保全或智能体预审视作专业签认。

## 原始审计快照

审计对象：`4f859c081b33e6f0f9b8d16f9c046466ccb90e75`。日期：2026-09-20。角色：独立模拟技术审核智能体，`actor.kind=agent`；不是测绘质量检验人员签字、项目验收或规范符合性证明。本次只读代码及已取得的资料，没有改动候选、生产规则集合或仓库。

结论：现有实现可以复用“规范来源绑定、精确版本谓词、事件链完整性、最终成果记录覆盖”四块内核，但尚无质检专用 Runtime 服务、持久化、认证签认和交付批准门禁。不能把 `coverageStatus=covered` 映射成 `reviewStatus=approved`。最小可交付增量应先完成冻结计划、证据保存、追加记录和独立覆盖复验；规范评分与真实签认是后续具有明确前提的层次。

## 核查依据

- 官方全文：[贵州省自然资源厅附件](https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf)，GB/T 24356-2023《测绘成果质量检查与验收》。本次重新计算本地 PDF 摘要，仍为 `96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`，与[既有来源记录](../../docs/qa/evidence/railwise-standards-20260920/sources.json)一致。
- 页码采用“印刷页 / PDF 从封面起计页”。既有目视核对范围为正文 1–9、57–63、114–115 页。本次又直接查看了 PDF 页 6、8、9、64 的已保存渲染图，分别核对阶段要求、抽样表、评分否决和高程控制测量分类。其他表内条款沿用有页码的[既有核读记录](../../docs/qa/evidence/railwise-standards-20260920/README.md#L15)，不声称本次重新逐页审定全文。
- 已有扫描件来源类型及真实渲染验证，不能再写成“扫描 PDF 尚无合同支持”。[扫描合同](../../kun/src/contracts/survey-standard-quality.ts#L26)和[真实渲染研究](../../docs/qa/evidence/railwise-standards-20260920/renderer-contract.md)均存在；缺的是生产适配器、受信登记、数据库和授权流程。该研究中的 `TEST-ONLY-SOURCE-BINDING` 不是生产规范规则。

## 最小具体实施矩阵

下表新增名称均为建议，不表示候选已经实现。所列条款支持业务要求；SQLite、SHA-256、CAS、签名算法等是软件设计手段，不是这些条款指定的技术。

| 顺序与交付单元 | 现有可复用实现及真实位置 | 最小新增字段 / 状态 / 持久化 | 已核对依据与允许的判断 | 必须保留的边界 |
| --- | --- | --- | --- | --- |
| 1. 冻结项目质检计划 | [SurveyStandardRuleRefV1](../../kun/src/contracts/survey-standard-quality.ts#L7)、[SurveyRuleContextV1](../../kun/src/contracts/survey-standard-quality.ts#L82)只能表达单规则及单指标上下文；[最终覆盖请求](../../kun/src/contracts/survey-standard-quality.ts#L119)已要求独立计划提供必检项 | `survey_quality_plans`：`planId, projectId, revision, supersedesPlanId, planHash, standardRefs, basisEvidenceIds, productType, unitProductType, populationHash, unitProductIds, lotIds, requiredChecks, stagePolicyVersion, approvalEvidenceRefs`。每次修订新记录；检查请求只引用计划，不提交可随意缩减的必检项 | 4.1（3/6）：标准、批准设计/补充文件、合同/任务及验收委托依据；5.1（5/8）：先确定成果类型、单位成果及元素；7.5.2 表45（61/64）高程控制单位为测段 | 不能从当前观测条数、未知点数、原始边数推断批量；未明确单位成果与适用依据只能记 `not-evaluated`。设计审批是事实证据，不能由代理生成“已批准” |
| 2. 冻结被检查成果与证据文件 | [DeliverableManifestV1](../../kun/src/contracts/engineering.ts#L124)已有项目、run、输入、输出摘要；[assertDeliveryOutputsCurrent](../../kun/src/engineering/engineering-service.ts#L1117)、[assertPublishedManifestCurrent](../../kun/src/engineering/engineering-service.ts#L1146)已重读真实文件 | `survey_quality_artifacts`：`artifactId, projectId, manifestId, manifestDigest, bundleDigest, digestAlgorithmVersion, members[{outputId,sha256,sizeBytes}], createdAt`。`survey_quality_evidence`：`evidenceId, projectId, sha256,sizeBytes,mediaType,storageKey,retentionState`；服务器内容寻址读取，不接受任意路径 | 4.5.1–4.5.2（4/7）保存各阶段记录及报告；5.3.3（6/9）样本全部资料和补充材料 | 必须定义 `artifactSha256` 是单文件还是冻结集合；不可把全部文件只绑定到某个 PDF 摘要。先生成 draft 再冻结检查，不在检查过程中改写目标 manifest；质检证据放 sidecar，避免自引用摘要 |
| 3. 追加式质量记录仓储 | [SurveyQualityEventV1](../../kun/src/contracts/survey-standard-quality.ts#L88)、[appendSurveyQualityEvent](../../kun/src/engineering/survey-quality-record.ts#L93)、[verifySurveyQualityRecord](../../kun/src/engineering/survey-quality-record.ts#L24)；[现有独立审计表防改模式](../../kun/src/engineering/engineering-service.ts#L233) | `survey_quality_records` 包含 `recordId,projectId,planId,planHash,rootArtifactSha256`；`survey_quality_events` 包含 `recordId,sequence,eventId,eventJson,thisHash,requestHash,idempotencyKey`，唯一 `(recordId,sequence)` 和幂等键；事务校验 `expectedHeadHash`、服务端序号/时间、项目和冻结计划；禁止 UPDATE/DELETE/REPLACE | 4.5（4/7）记录留存；4.6（4/7）整改/重新检验留痕 | V1事件没有 `recordId/planId`，先用服务器外层绑定保存，不能插入字段改变旧V1摘要算法；若升级V2需版本化读取。数据库同处的 hash 与 trigger 不证明能抵御整库替换或回滚 |
| 4. 阶段与组织职责状态机 | [event.stage](../../kun/src/contracts/survey-standard-quality.ts#L93)目前只是任意本地标签；[纯函数状态流](../../kun/src/engineering/survey-quality-record.ts#L47)只管check/issue/correction/recheck | `stage=process/final/acceptance` 的专用版本化合同；`stageStarted/stageCompleted` sidecar事件；`organizationId,departmentRole,authorityEvidenceId,predecessorCompletionId,checkedScope`，先决条件由冻结计划确定 | 4.2.1–4.2.4（3/6）：独立且按顺序；过程全数，最终内业全数，最终外业及验收可按第5章抽样；完成修改确认后转下一阶段 | 单纯三个不同 `actor.id` 或不同 agent 不代表不同组织职责；不能把任意 `stage` 字符串当已通过规范阶段。各阶段同名检查应由计划分配不同稳定 `checkId`，避免V1全链检查ID唯一规则冲突 |
| 5. 整改、复查与最终目标覆盖 | [issue/recheck合同](../../kun/src/contracts/survey-standard-quality.ts#L102)、[内核重检绑定](../../kun/src/engineering/survey-quality-record.ts#L61)、[evaluateSurveyFinalArtifactCoverage](../../kun/src/engineering/survey-quality-record.ts#L108) | 保存 `issueId,checkId,correctionId,correctedArtifactId,verificationEvidenceId` 的仓储索引；服务器保证事件内全部摘要可解到本项目实际保留字节；`requiredCheckIds` 从计划读取 | 4.6.1–4.6.3（4/7）：改正、重检；失败批再申请须重新抽样。既有内核会让最后整改以前的检查变成 `stale-after-correction` | “问题已复查解决”不会自动令所有必检项通过，仍需最终相同摘要上的 `artifact-check`。重新抽样是独立新记录，不能仅复用旧样本并增加一条已解决事件 |
| 6. 独立链尾检查点与回放 | [SurveyQualityCheckpointV1](../../kun/src/contracts/survey-standard-quality.ts#L113)、[checkpoint检查](../../kun/src/engineering/survey-quality-record.ts#L80) | 检查点外层新增 `recordId,planHash,issuedAt,custodianId,receiptEvidenceId,signatureEnvelope`；本地保存receipt索引，独立保管方保留检查点；GET也做项目/记录绑定、链完整性及证据存在检查 | 4.5（4/7）支持留存要求；独立checkpoint和签名回执是为检测链整体替换/截断提出的软件证据措施 | 同一数据库另一张表不是独立可信保管；V1checkpoint只有 project/artifact/count/head，外层必须补record和plan，防止同项目同摘要的两条链混用。缺外部证据不授予真实签认状态 |
| 7. Runtime 路由最小闭环 | [现有engineering路由](../../kun/src/server/routes/engineering.ts#L58)与[verifyDeliverable](../../kun/src/engineering/engineering-service.ts#L564)边界可复用；当前搜索未发现质量内核被Runtime调用 | 新 `SurveyQualityService`/repository，同Runtime同项目权限；建议 `POST /projects/:id/quality-plans`、`POST/GET /projects/:id/quality-records`、`POST /projects/:id/quality-records/:recordId/events`、`POST .../:recordId/verify-final`。验证body只接受 `planId,artifactId,expectedHeadHash,idempotencyKey` 等引用 | 阶段、整改、档案依据分别见4.2（3/6）、4.5–4.6（4/7）；路由形式不是条文要求 | 不允许HTTP客户端直接提交受信 `actor.kind=human`、必检清单、独立checkpoint或机器通过结果。机器检查由服务器重算；人工录入记录仅为声明，未认证前不升级。跨项目404、旧head/重放冲突409、材料不齐明确未评估；限制链长、单事件和证据大小 |
| 8. 精确条款与扫描证据生产适配 | [SurveyStandardRegistry](../../kun/src/engineering/survey-standard-registry.ts#L58)、[信任入口](../../kun/src/engineering/survey-standard-registry.ts#L43)、[verifyScan](../../kun/src/engineering/survey-standard-registry.ts#L135) | 规则库保存 `ruleRef,ruleDigest,sourceSha256,locator,scanEvidence,scope,effectiveInterval,trustReceipt,revocationState`；生产只读证据存储和受限PDF renderer；明确规则审核及全文信任集合由何受信边界维护 | 本次源证据可定位4.2.1（3/6）及表1（5/8）等；实际登记前每条规则都要绑定精确文本/图像证据及适用范围 | 内核仅支持 `lte/gte/abs-lte`，不能把阶段序列、抽样或层级评分塞成一个标量阈值。页面/转录/版本发生变化会使旧ruleDigest失效。真实渲染适配研究不是已装入Runtime的受信规则 |
| 9. 抽样与错漏/评分专用内核 | 现有[单标量规则合同](../../kun/src/contracts/survey-standard-quality.ts#L67)和[coverage结果](../../kun/src/contracts/survey-standard-quality.ts#L126)没有抽样、错漏类别和层级评分字段 | 分开新增 `samplingPlan`（总体、批、分层、方法、抽样算法/随机来源、抽中名单、轮次、前轮关联），`faultRecord`（单位成果、元素/子元素、分类规则、A/B/C/D、证据、处理），`scoreAssessment`（版本、原始计数、适用权、否决原因、单元/样本/批结果、批准调整证据）；均追加保存 | 5.2–5.3（5–6/8–9）、6.1–6.4（6–8/9–11）、高程控制表45–46（61–63/64–66）支持不同的可复核过程 | 可先实现记录与回放；完整表1及表45–46需逐项双向核对并版本化，不能依局部例子插值。没有现场证据不能机器断言仪器检定、观测条件、埋石或托管符合。数学精度n=20解释未明确时不执行对应分支 |
| 10. 人员授权、签认与交付门禁 | [recordedActor及明确非认证注释](../../kun/src/contracts/survey-standard-quality.ts#L38)、[coverage仍未评估](../../kun/src/contracts/survey-standard-quality.ts#L137)、[draft manifest合同](../../kun/src/contracts/engineering.ts#L134)、[checkDeliverable](../../kun/src/engineering/engineering-service.ts#L635) | 独立 `qualityAssessment` sidecar：`planHash,targetBundleDigest,recordHeadHash,checkpointReceiptHash,ruleTrustSnapshotHash,coverageResult,stageResult,signatureVerification,assessedAt`；签认包包含身份/组织/项目授权/意图/有效期及所签覆盖。保留原V1读取；新验证响应V2或独立assessment endpoint | 4.2职责（3/6）、4.5检查者与复核者签字（4/7）。可在后续正式批准/受控交付入口重读对象、重算覆盖、验证阶段与签认；不允许仅凭算法通过批准 | 当前 `finalize()`实际产生待审draft，必须允许先生成供检查，不宜把有无质检记录硬塞为所有draft生成的前置条件。现有verification.checks枚举固定五项，新增质量项要扩展合同和消费者；未集成前不能改变其 `valid` 含义或自动回填历史为approved |

## 规则可执行性清单

“有条款依据”与“已具备规范自动判定资格”分列。下面数值均来自上述已核对页；本审计没有注册或执行生产阈值。

| 规则 | 已核对条款 / 印刷页 / PDF页 | 可先实现 | 目前不能据此推出 |
| --- | --- | --- | --- |
| 三阶段独立、顺序及全数/可抽样范围 | 4.2.1–4.2.4 / 3 / 6 | 显式阶段状态、前后依赖、范围记录、不齐全拒绝升级 | 不同代理身份等于组织独立；终检记录等于委托方验收 |
| 高程控制单位成果为测段；数据/点位/资料质量 | 7.5.2、表45–46 / 61–63 / 64–66 | 计划中要求真实测段总体与所有质量元素的证据任务 | 平差跑完等于测段整体合格；原始边或未知点可直接当批量 |
| 样本量与分批 | 5.2、表1 / 5 / 8 | 完整表版本化后测试区间边界及全数规则。已记录例：1–20→3、21–40→5、687–1000→56；样本量≥批量时全数；总量≥1001时分批且批次数最小、批量均匀 | 用三个例子补齐整表；把最终内业全数检查改成抽样；未定义总体时抽样具有代表性 |
| 概查否决 | 6.1.3 / 6 / 9 | 在明确“概查”范围、完整分类和证据后，检出A类或B类不少于4时记录不合格；不冒充详查规则 | 给所有单位成果统一套用“无A且B<4即通过” |
| 单位成果先行否决 | 6.2.1.2 / 6 / 9 | 有完整输入和分类证据时，A类或任意元素/子元素<60先行否决；缺项保留未评估 | 其他项高分抵消A类或低于60；未检查项填100 |
| 错漏扣分与权重 | 6.2.2–6.2.4、表2 / 6–8 / 9–11 | B/C/D为12/t、4/t、1/t，通常t=1；调整t保留委托方批准，适用元素权重按条款处理；A类仍先触发否决 | 任意修改t、任意删项后归一化即可通过；将表46横线解释成任意零扣分 |
| 单位/样本/批分层评定 | 6.2.5、6.3、6.4 / 8 / 11 | 在全部前提满足后按90/75/60等级界处理单位成果；样本任一单位不合格即不合格；终检批等级与验收批判定分别建模 | 用均分遮盖不合格单位，或混用终检“等级”与验收“合格性” |
| 数学精度检测的计数边界 | 4.3.4 / 4 / 7 | 保留原文、检测数量和待解释状态 | 原文“少于20/大于20”未明确恰为20，不能自行用 `>=20` 填补；也不能把任意后验平差中误差当规定检测值 |
| 记录签字及重检 | 4.5–4.6 / 4 / 7；附录A / 114–115 / 117–118（资料性） | 保留检查、复核、整改、重抽记录及绑定，提供真实签认入口 | 姓名字符串、图片签名、哈希完整、agent交叉审核或附录表式本身可证明真人签字与授权 |

## 接入验收最小集

1. 实际Runtime→SQLite→重启→读取→复验：一条完整链和一次有整改的新成果链；检查目标文件及原manifest在核验期间字节不变。
2. 并发追加同head只能有一个成功；同幂等键同载荷返回原事件，换载荷冲突；UPDATE/DELETE/INSERT OR REPLACE均不能悄悄覆盖事件。
3. 跨项目、换planHash、换root/final artifact、证据失踪/截断/哈希变更、链尾截断、错误checkpoint、整个链替换各有独立拒绝用例。
4. 不能由请求删掉必检项、伪造human actor或passed结果。阶段倒序、相同组织冒充独立阶段、未关闭整改、旧最终摘要和重抽复用均不得提升验收状态。
5. 对已核对且正式登记的规则测试等号、区间端点、单位、版本、有效期、冲突规则、错误渲染/页码、转录和信任撤销；未正式登记项稳定返回未评估。
6. 历史V1事件摘要和旧draft manifest继续可读。只有新独立assessment明确给出新增能力；旧的技术复验审计成功不得回填为质检通过。

本审计只产出接入矩阵和可执行验收要求。未新建Runtime路由、数据库表、评分内核或真人签认系统；这些不能计入本候选已经完成的功能。
