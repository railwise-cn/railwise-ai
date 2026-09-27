# Survey 生产指标口径

更新于 2026-09-20。本次新增复验生命周期的持久事件和开始队列只读统计，保留既有导入审计及终态复验统计；旧的 `281dc87672509de147357efc3aabbeae0eb4dbcb` 及其他候选证据保持历史口径，不追溯补造事件、不把候选验收换算成生产 KPI。

## 数据与事件来源

只读工具为 [`scripts/measure-survey-workflows.py`](../../scripts/measure-survey-workflows.py)，不是 [`check-survey-production-delivery.mjs`](../../scripts/check-survey-production-delivery.mjs)。后者在临时隔离 Runtime 主动创建工程与交付，并可调用产品参考解析器，验证的是所选样本闭环；即使使用包内 Electron，也不产生 GUI 或生产成功率分母。

指标脚本用 SQLite `mode=ro`、`query_only=ON` 和独立读事务读取 `engineering.sqlite3` / `survey.sqlite3`。应使用完全停止应用后的成对副本，保留副本哈希、代码提交、提取时点和 cohort 来源；两个库的读事务不是跨库原子快照。脚本不读输出/源文件、不发遥测、不重算平差、不验签，不输出项目名、坐标或私有路径。

| 事实/事件 | 持久来源 | 真实含义与限制 |
| --- | --- | --- |
| 网络创建 | `survey_networks.data_json.createdAt` | 成功保存网络的时点。不是导入按钮点击、文件选择开始或首次请求；不能单独提供失败分母。 |
| 导入请求生命周期 | `survey_import_attempt_events` | 服务入口先写 started；网络提交与 committed 同事务；请求返回前写 finished。鉴权后的 HTTP 无效 JSON、请求超限、读取异常、结构化网络拒绝分别记录为拒绝；正文读取期间崩溃不在服务入口分母中。 |
| 平差完成 | `survey_adjustments.data_json.run.completedAt`，`run.status=completed`、`result.validation=valid` | 当前保存的运行与结果；需要网络/项目/输入hash/算法版本绑定。不是人工复核。 |
| 草稿清单创建 | `engineering_manifests.data_json.createdAt`、`reviewStatus=draft` | 已保存草稿，非签认固化；清单包含成果引用不证明当前字节完好。 |
| 复验终态 | `engineering_verification_attempts` | `EngineeringService.verifyDeliverable` 在成功、检查失败或捕获异常后保存的终态；序列、身份、时间、原JSON SHA-256及元数据绑定可核对。进程崩溃或审计写入失败没有此事件，不能进入已记录分母。 |
| 复验生命周期 | `engineering_verification_events` | 复验前独立事务提交 started；finished 与原终态同事务提交，并绑定终态 ID、精确 JSON 摘要和 started 摘要。started 之后中断会保留未完成事件；旧终态不补造 started。 |

指标时间统一为 UTC 半开区间 `[start, end)`；输入时间必须带时区。清单按 `createdAt` 入期，旧复验尝试统计按 `completedAt` 入期，导入请求及新增复验生命周期按 started 入期并只读取 end 前终态。`--cohort candidate-fixture` 与 `production` 必须分开；`production` 参数只是调用者标签，不认证数据来源，也不会自动过滤候选记录。

## 现有可计算统计

| 输出键 | 样本/分母 | 数值定义 | 无效或缺失处理 |
| --- | --- | --- | --- |
| `counts.projectsInSnapshot` / `networksInSnapshot` | 所读完整快照 | 唯一项目/网络ID总数，不限报告期 | 缺失或重复ID直接失败，不能悄悄去重。不是每月生产项目数。 |
| `counts.manifestsInPeriod` / `manifestReviewStates` | 创建时间入期的全部清单 | 已知状态draft/reviewed/approved/rejected分组，其余记other | 无效时间排除并计入`invalidManifestTime`；状态字符串不能证明批准真实。 |
| `draftManifestsWithConsistentStoredBindings` | 入期且通过下述草稿绑定检查的清单 | 每清单计一次，同项目多份可以多次计数 | 不查当前文件字节、不表示完整三格式，也不是成功导入率。 |
| `importToFirstBoundDraftSeconds` | 保留历史中每项目最早合格草稿恰好在期内的项目；每项目一次 | 每份首草稿时间减去它所绑定网络的最早创建时间，取中位数，单位秒，同时报sampleSize与range；包括等待和人工操作 | 先读期前历史，防止重复交付误算首次。空样本为`value:null/status:no-samples`；删除过的历史不可探测。不是“首次有效正式成果”或操作净耗时。 |
| `recordedStrictReverificationCoverage` | 创建时间入期且当前`reviewStatus=draft`的全部清单，以`(projectId,manifestId)`为唯一键；不只选曾成功或已有正确绑定的清单 | 分子为每个清单截止end前最后一条终态复验通过、完整检查通过且与本次快照元数据仍绑定的数量 | 缺事件或最后失败均不给分；后续失败覆盖旧成功。分母身份缺失/重复则不可测。无清单为no-samples。 |
| `recordedVerificationAttemptSuccessRate` | `completedAt`入期的所有已记录终态尝试，包括passed/failed/error、未知清单查找错误和对期前清单的复验 | 分子是终态passed且仍通过当前快照元数据绑定检查的尝试数；同清单多次尝试各自计数 | 当前绑定失效的旧passed保留在分母但不进分子；`outcomes.passed`可能大于分子。无事件为no-samples。崩溃/未写入审计不在分母。 |
| `recordedVerificationLifecycle` | started 入期的全部已记录复验调用，不按清单去重 | `counts` 区分期末已完成/未完成；`outcomesByPeriodEnd` 分列 passed/failed/error；`recordedTerminalPassRate` 为 end 前 recorded passed / 入期 started | 期末未完成保留在分母；end 时刻及之后的完成不提前计分。只表示历史终态，不重新校验当前绑定或文件，不能替代旧严格复验指标。 |
| `recordedImportAttempts.counts` | started 入期的全部已记录调用 | 成功、拒绝、未完成、已提交、重放、身份无法识别、非文件请求分层计数 | 终态在 end 之后视为期末未完成。未完成不是拒绝；重放是独立调用，但不增加首次键分母。 |
| `recordedImportAttempts.firstObservedFileRequestCompletionRate` | 保留历史每个项目/幂等键的最早 started，恰好入期、文件模式且不是首次见到的历史重放 | 分子为 end 前请求成功返回的首次调用，分母保留拒绝和未完成；后来的成功不能覆盖首次失败 | 这是可识别文件键子集的首次已记录请求完成率，不是全部首次任务成功率，也不是平差可用率。 |

草稿绑定检查要求项目存在、非空adjustments及outputs、清单validation.valid，并对每个adjustment核对run/result/network的项目、网络、result ID、run ID、非空inputHash和algorithmVersion；要求 `network.createdAt <= run.completedAt <= manifest.createdAt`。首草稿排序读取所有end之前保留历史，只处理draft；不能把reviewed/approved/rejected当成首草稿或人审通过。

“最后一条”按审计表 `sequence` 顺序选取满足 `completedAt < end` 的最后写入终态，不按UUID排序，也不是按checkedAt求最大。覆盖率没有额外要求该条必须在start以后；它是截止期末的记录状态。尝试率则严格按完成时间入期，与清单创建期是两个不同分母。

复验分子要求原事件schema/SQL身份/精确序列化JSON摘要/时间一致；bindingStable、bindings.complete和verification.valid为true；checkedAt位于startedAt与completedAt之间；清单仍为draft；项目/清单/工程run/dataset/analysis及Survey network/result/deformation的集合和typed-json-sha256-v1摘要匹配，五项检查状态完整。没有Survey网络时surveyReplay/sources必须为not-applicable；其余应passed。脚本只核对记录元数据，不能证明原复验之后文件没有变化，因此 `strictReverificationCoverage`（当前重新复验）仍不可测。

## 无效样本与故障口径

### 导入请求事件

`SurveyService.importNetwork` 在契约校验、base64 解码、格式解析之前写入 started，随机 attempt ID 标识每次调用；文件模式和项目/幂等键组合的 SHA-256 用于分层和去重。没有合法有界键时 `taskHash=null`，仍进入全部尝试分母。项目 ID 超过 512 字符或幂等键不满足 8 至 200 字符的输入不参与键识别，不改变原导入契约。审计不保存键明文、项目名、文件名、原文、坐标、凭据或任意异常文本；拒绝原因为固定阶段枚举。

每条事件保存精确 JSON 字节摘要和同一调用的前序摘要；SQLite 触发器禁止更新、删除和替换。指标脚本校验所有行的 SQL/JSON 身份、字段集合、摘要、前序链、阶段顺序和带时区时间；任一坏行使整个 `recordedImportAttempts` 不可测，不跳过坏行找旧成功。此本地完整性机制不等于不可伪造的外部签名或生产来源认证。

网络、原始资料账本、来源准入、幂等预约和 committed 收据一起提交。started 写入失败则不进入导入；committed 写入失败则回滚网络事务；finished 写入失败则调用报错，已保存 started/committed 保留为未完成，禁止声称成功。若数据库故障连 started 都无法保存，该调用数不可从此库恢复，不能声称分母全覆盖。

普通源文件保存/解析失败记录为拒绝；数据库提交成功后侧写失败记录 `committed + finished(rejected, projection)`，此时网络仍可恢复。重试保留原有幂等行为并新增 replay 收据；早先失败不会被后续成功覆盖。同键并发按 started 序列选择最早调用，只提交一个新网络；先开始但尚未结束的调用保留在首次子集分母。对于升级前已存在的成功导入，首次见到 replay 不补造原始尝试，不进入首次子集。

HTTP 拒绝仅在现有 Runtime 鉴权之后记录：无效 JSON/超限/流读取错误没有可识别键，结构化请求是非文件模式。鉴权失败、服务不可用、正文尚未读完时进程崩溃不在该链路覆盖内。统计显式给出无法识别键、非文件请求及首次重放/非文件排除数，禁止只展示子集百分比而隐去这些分母。

成功终态表示 `SurveyService.importNetwork` 完成，不代表其后 HTTP 响应附加读取、序列化、网络送达或界面渲染已完成。此边界写入统计输出，不能把该指标描述为端到端外业操作成功率。

`successfulRequestSourceDispositions` 单列 `adjustment-ready`、`archive-only`、`converter-required`、`gnss-processing-required` 和 `legacy-unverified`。未知格式归档可以是请求完成，但不能算平差准入通过；即使 `adjustment-ready` 也只是提交时文件处置，不证明当前原始字节、整个网络校核或平差结果有效。

### 复验生命周期

`EngineeringService.verifyDeliverable` 先通过 [`engineering-verification-audit.ts`](../../kun/src/engineering/engineering-verification-audit.ts) 独立提交 started，再执行原有读取、复算和终态写入事务。开始事件只保存随机尝试 ID、项目/清单 ID、时间和摘要，不增加工程名、原文、坐标、路径或任意异常文本。原终态表的字段、结果、异常口径和既有记录保留；被检查对象、输出字节及审查状态不改变。

finished 的 `terminalId` 必须等于本次 attempt ID，`terminalRecordHash` 必须等于原终态精确 JSON 的 SHA-256；开始时间、完成时间、项目、清单、结果状态逐项匹配。finished 与原终态在同一事务内写入，任一写入失败均回滚两者，已独立提交的 started 保留。开始审计写入失败时不执行复验，没有持久开始事件，不能从该库恢复分母。已开始后崩溃、事务失败或时钟回退会保留未完成，统计不把它改写为 failed，也不在重启时补造终态。

新表通过触发器禁止 update/delete/replace。只读脚本验证全表身份、字段集合、JSON 摘要、前序摘要、阶段顺序、带时区时间和终态原子绑定；任一损坏使新增生命周期统计不可测。校验可扫描期外行以发现完整性问题，但统计分子和分母严格按窗口，不把期末之后的成功提前计入。该本地摘要链不构成外部签名或生产来源证明。

`counts.legacyTerminalOnlyCompletedInPeriod` 单列没有 started 的历史终态，按完成时间入期，不进入新增开始队列分母；旧终态统计继续包含这些历史记录。不存在生命周期表为 `not-measurable`；存在表但没有入期 started 为 `no-samples`、比例为 null，即使有历史终态也不填 100%。已有开始却缺结束的调用仍计入分母；出现同 ID 原终态但缺 finished 是原子绑定损坏，不能当作正常中断。

`recordedTerminalPassRate` 不作当前文件或元数据有效性声明：后续文件变化不重写历史终态。当前快照绑定仍由原 `recordedVerificationAttemptSuccessRate` / `recordedStrictReverificationCoverage` 按原口径核对；两类比例的入期时间、分母和语义不同，不应相互替换。所有输出仅为汇总，不输出项目/清单 ID；HTTP 收发、界面完成、服务外请求、升级前缺失历史和独立开始落盘前的故障仍不在该分母内。

### 其他统计

1. `invalidManifestTime`统计全快照的无效清单创建时间；无法判断是否属于报告期，不能强塞入期内分母。
2. `missingOrMismatchedBinding`、`invalidBoundInputTime`、`nonForwardTime`检查所有end之前的draft历史，含期前历史；不是仅期内失败数，也不是唯一项目数。每份草稿遇到首个失败后停止该草稿的输入检查，不能把这些计数相加当“全部缺陷数”。
3. 任一审计行的身份、JSON摘要或时间完整性失败，会使两项recorded指标一起`not-measurable`，不跳过坏行后选旧成功；这包括扫描到的期外审计行。
4. 没有终态审计表时，两项recorded指标均不可测；不从“文件存在”或GUI截图反推历史事件。其他数据库/记录结构错误导致命令退出1且不产生可信结果，不填0。
5. `not-measurable`表示缺必要测量条件，`no-samples`表示该已定义样本集合为空；二者都不是0%或100%。单项故障、跨库不一致、缺审计记录均应保留原因，不从分母删掉失败以改善比例。

## 生产目标的缺失分母

以下是生产测量所需条件。截至本索引均为`not-measurable`，无生产数值。2026-09-20 已增加[外部采集合同 V1](./RAILWISE_SURVEY_PRODUCTION_COLLECTION_CONTRACT.md)，提供业务任务/首次开始/授权/签认声明的严格 schema 与只读字节验证，不新增生产埋点或认证服务；[UI 静态清单](./RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)冻结候选表面，不替代值级和 GUI 验收。

| 产品指标/目标 | 必需事件与分母 | 目前缺口 |
| --- | --- | --- |
| 每月完整可追溯项目数 | 期内完成且唯一的真实项目ID，绑定完整交付、源数据、算法与可验证的人工批准/签名 | 当前草稿和reviewStatus文本不能证明正式批准；真实生产cohort来源与覆盖不明。 |
| 首次有效成果耗时 | 预先固定的开始事件至首次合格签认交付事件，每项目一次；失败/中断项目保留审查名单 | 现有时间只是成功网络创建至首草稿，缺首次尝试和正式批准时点。 |
| P0一次导入成功率 ≥85% | 每个事先定义的导入任务首次开始及终态，包括解析拒绝、崩溃/中断；成功任务数/全部首次任务数 | 已新增调用与可识别文件键的首次记录；业务任务按文件/批次的定义、身份未知请求归属、升级前历史及生产总体覆盖仍未认证，不能用子集完成率代替。 |
| 中等水准网导入至固化中位时间 ≤30分钟 | 先定义网络规模、排除规则与生产cohort，再记录开始/签认固化及未完成样本 | 中等网络定义、正式固化事件和代表性样本缺失；首草稿秒数不能代替。 |
| 数值可复现率 100% | 预先冻结的运行集合及每项严格重放终态；分子为输入/版本/输出条件一致并在声明数值规则下通过者 | 已存绑定与选定两样本参考比较不覆盖全部生产运行。 |
| 规范依据可追溯率 100% | 预声明必须核查的规范判定项集合，逐项权威版本/条款/适用条件/数值证据 | 自由文本引用和有限条文试算不能证明全量逐项适用及验真。 |
| 非Runtime数字混入成果=0 | 固定成果及全部需追溯数值字段清单，逐项绑定Runtime计算/授权原始声明与变换来源 | 没有完整值级provenance审计；不能把PDF/DOCX/XLSX哈希一致当数字来源合规。 |
| 许可违规=0 | 固定发行包/依赖/转换器/资料范围及逐项许可证审计 | 无该生产范围独立许可结论；“未发现记录”不等于0。 |
| 英文界面中文残留=0 | 预声明英文可见状态与可计UI文本集合，明确排除用户原文、源证据和专有名称 | 未覆盖完整状态、错误、窄屏与恢复路径；截图抽样不能推广为全量0。 |
| 结果一键追问覆盖率 | 冻结可追问结果表面集合，逐项成功携带准确结果/工程上下文进入追问 | 数据库记录数不提供UI分母，缺全清单及真实操作证据。 |

缺失/失败/取消的采集政策必须在正式统计前固定。上述建议不会追溯伪造旧事件；历史未知应保持未知。`productionRepresentativeness`即使传production标签仍不可测，需单独提供收集来源、授权、去重及覆盖证据。

## 截至 281dc87 的证据索引

- [d249035历史指标](./evidence/railwise-research-20260919/candidate-metrics.json)：两项目首草稿中位111.788秒（原JSON为`111.78800000000001`，此处按毫秒展示），范围83.48至140.096秒。保留历史窗口和旧schema；不能当最新源码或生产指标。
- [4f859c0失败快照](./evidence/railwise-convergence-4f859c081b33/metrics-failed.json)为记录覆盖0/1、尝试通过1/2；[结束快照](./evidence/railwise-convergence-4f859c081b33/metrics-final.json)为2/2、5/6，首草稿中位66.994秒（样本2）。该差异证明已记录的后续失败不会被旧成功掩盖，不证明总体生产稳定性。
- [6ff P0证据](./evidence/railwise-convergence-6ff82c8c2746/p0-summary.json)：实际GUI的IN2/GSI两网络、两草稿、六文件以及重启前后四次持久成功复验，每次五项。此文件是P0选定样本核验摘要，不是指标脚本输出；没有把它重新标成生产“100%覆盖率”或生成新耗时。格式范围见[验收矩阵当前索引](./WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md)。

不要将不同候选、不同窗口、重复使用的同源样本合并成更大的生产样本数。四次复验与每次五检查不是20个项目；IN2和GSI的实际文件也不是六个独立工程。

## 复测命令与检查范围

```sh
python3 scripts/measure-survey-workflows.py \
  --engineering-db '<停止应用后的副本>/engineering.sqlite3' \
  --survey-db '<同一副本>/survey.sqlite3' \
  --cohort candidate-fixture \
  --start '2026-09-01T00:00:00Z' --end '2026-10-01T00:00:00Z'
```

导入审计回归为 [`survey-import-audit.test.ts`](../../kun/src/engineering/survey-import-audit.test.ts)：真实服务/SQLite 的契约和源文件保存失败、归档处置、首次失败后重试、跨项目键、同键并发、侧写失败、三个阶段审计写入故障、事务故障、不可变保护、HTTP 拒绝，以及真实事件到 Python CLI 的只读链路。脚本回归 `python3 scripts/test_measure_survey_workflows.py` 共 37 项，包括首次/重试、未完成、跨期、历史重放、未知身份、归档处置与摘要/时序异常，以及新增复验生命周期的开始分母、截止时间、原子绑定和历史兼容。没有采集或重测真实生产数据库。

复验审计回归在 [`engineering-verification-audit.test.ts`](../../kun/src/engineering/engineering-verification-audit.test.ts)：保留原严格复验、元数据绑定、旧指标和输入输出不变测试；新增 started/finished/原终态写入故障、时钟回退、截止时间、旧表升级、不可变保护和实际子进程 SIGKILL 后开始事件存续。进程终止测试使用独立审计模块和真实 SQLite；它不是安装包 GUI、真实工程生产样本或人员签认。历史归档的数值与哈希保持其原始提交和窗口，不因新增事件能力而变成新的验收结论。
