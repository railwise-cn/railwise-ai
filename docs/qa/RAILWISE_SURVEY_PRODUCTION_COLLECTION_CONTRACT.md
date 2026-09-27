# Survey 生产采集资料合同 V1

2026-09-20。此合同补齐 R11 的可执行资料格式、离线一致性验证和事件语义。它没有新增 Runtime 埋点、认证签章服务或真实生产记录，也不改变 [现有指标](./RAILWISE_SURVEY_PRODUCTION_METRICS.md) 的数值与 `not-measurable` 结论。

## 已有能力与本次补齐

| 边界 | 已有实现 | 本合同增加 | 不可据此宣称 |
| --- | --- | --- | --- |
| 服务导入开始 | [survey-import-audit.ts](../../kun/src/engineering/survey-import-audit.ts)写 started/committed/finished；键是 projectId + idempotencyKey 的摘要 | 预声明业务任务与多个导入尝试的外部 sidecar 资料结构 | 服务可识别键等于全部首次业务任务、GUI 完成或平差可用 |
| 复验开始 | [engineering-verification-audit.ts](../../kun/src/engineering/engineering-verification-audit.ts)写持久开始与原子终态 | 复用现有只读指标工具的输出 | recorded passed 等于当前字节完好、人工批准或生产总体通过 |
| 生产 cohort | `--cohort production` 是调用者标签 | 冻结协议、授权证据、外部总体登记与逐项纳入/排除、未知数量 | 来源真实、授权人身份真实或统计代表性已认证 |
| 正式交付 | [DeliverableManifestV1](../../kun/src/contracts/engineering.ts#L124)包含草稿/状态文本 | 正式签认声明与撤销的精确对象、意图、人员授权和外部验签回执引用 | `finalize()`、截图、hash、代理审核或字符串 approved 等于真人签认 |
| UI 指标 | SQLite 无法给出可见状态分母 | 继续使用 [UI 静态清单](./RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)冻结候选表面 | 本采集合同补出了真实 UI 点击、数值来源或英文渲染证据 |

## 可执行入口

- [survey-production-collection-contract.mjs](../../scripts/survey-production-collection-contract.mjs)：Zod V4 严格 schema 和跨字段/事件校验。拒绝未声明字段，身份只用 64 位十六进制键，时间需带时区；不含姓名、坐标、任意文件路径或凭据字段。
- [validate-survey-production-collection.mjs](../../scripts/validate-survey-production-collection.mjs)：只读 CLI。按摘要读取材料字节、匹配停止应用后的 SQLite 副本，再建立权限 0700 的临时目录与 0600 的逐字节副本供原有 [measure-survey-workflows.py](../../scripts/measure-survey-workflows.py)读取。原文件不由 SQLite 打开，不复制实现其计算公式，不发网络请求。临时副本结束后清理。
- [survey-production-collection-contract.test.mjs](../../scripts/survey-production-collection-contract.test.mjs)：仅合成测试，包含真实临时 SQLite 到旧指标 CLI 的链路；材料显式标记 `SYNTHETIC-TEST-ONLY`，不作为生产证明。

```sh
node scripts/validate-survey-production-collection.mjs --schema
node scripts/validate-survey-production-collection.mjs \
  --contract '<采集包>/collection.json' \
  --evidence-dir '<采集包>/objects' \
  --engineering-db '<停止应用后的副本>/engineering.sqlite3' \
  --survey-db '<同次副本>/survey.sqlite3'
node --test scripts/survey-production-collection-contract.test.mjs
```

`--schema` 向 stdout 输出标准 JSON Schema，可供独立资料生产端使用；跨引用、事件先后与证据字节仍由验证器核查。无需再维护一份易漂移的手写 schema。`collection.json` 必须是 `JSON.stringify(value, null, 2) + '\n'` 的 UTF-8 字节，重复字段、非标准缩进或尾随空白也拒绝，防止 JSON.parse 隐藏同名键。合同最大 32 MiB，每个外部证据最大 50 MiB，总证据最大 256 MiB，每个数据库快照最多 64 MiB 且不能为空，最多 10 万任务/事件和 1 万材料；超出需显式修订合同，不能悄悄截断。上述为输入字节限制，不是解析后对象的进程内存保证；旧采集子进程限制 60 秒、stdout/stderr 缓冲 4 MiB，超限整体失败。

材料文件名只能是 `objects/<sha256>`，不接受合同中的 URL 或相对路径，不自动下载材料。合同、证据对象和数据库末级文件拒绝符号链接、FIFO 和其他非普通文件，材料目录本身也不得是符号链接；父目录的系统别名（如 macOS `/var`）先解析为真实路径。以 `O_NOFOLLOW/O_NONBLOCK` 打开并在句柄上核对类型、大小、读取上限及前后文件身份/修改时间，读取中增长、截断或替换均拒绝。没有取得的材料不得用空文件或“待补”文字冒充原件；验证器不解释材料正文，因此不能识别伪造占位文字。资料可以不完整：authorization=null、unknownTaskCount=null、coverageClaim=unknown、任务没有 first-start 均保留为缺口；必需引用文件不存在则字节校验失败。

## Schema 与资料来源

| 对象 | 必需字段及含义 | 校验与来源边界 |
| --- | --- | --- |
| period | startInclusive/endExclusive | UTC 语义的半开区间；end 必须不晚于提取时点；时区转换按时间点比较 |
| protocol | frozenAt/historyFrom、protocol/scope/selectionPolicy 三份证据摘要、sourceSystemKey、taskUnit、retryPolicy、unknownHistory | 协议必须在窗口开始前冻结；`taskUnit=predeclared-business-task`，同任务重试不重新定义首次，历史未知不补造。摘要验证不解释协议正文 |
| authorization | 证据摘要、grantor/custodian 假名键、scope摘要、用途、validFrom/Until、revokedAt、authenticity | 必须覆盖统计窗口至副本提取，且 scope 与协议一致；提取前撤销或到期拒绝；authenticity 只能是 not-authenticated。此格式不验证授权文件签名或法律效力 |
| population | 外部 registerEvidenceSha256、asOf、declaredTaskCount、unknownTaskCount、coverageClaim、members | 截止登记覆盖到 end，且不晚于提取。members 每个 taskKey 唯一，全部 origin 必须与 cohort 相同；名单数量与声明总数一致。complete-declared 要求未知数为 0，但仍只是声明 |
| members | taskKey/projectKey、origin、inclusion、exclusionReason | 排除理由限制为 outside-period/outside-task-type/duplicate-register-entry/authorization-withheld；excluded 必须有理由，included 不得有排除理由。保留失败、中断和未完成任务，不能以“没有合格成果”排除 |
| extraction | capturedAt/runtimeCommit/shutdownEvidenceSha256、engineering/survey 的 sha256/sizeBytes | 绑定两个不同路径的副本，拒绝任何 WAL/SHM/journal（包括空文件及符号链接）；采集器只打开私有临时副本，前后重核原库和临时主库字节。停机回执的真实性、两库是否同一业务时点及曾被删历史仍不能由 hash 证明 |
| evidence | sha256/sizeBytes/kind | purpose 类型分别为 protocol/scope/selection-policy/population-register/authorization/shutdown-receipt/event-receipt/identity/signature-envelope/signature-verification/revocation；引用类型必须匹配，不把任意附件当授权 |
| events | UUID、taskKey、全局 sequence、occurredAt、recordedAt、event-receipt 摘要与类型专用字段 | UUID 唯一、sequence 严增，记录时间不倒退；occurred <= recorded <= captured，不早于 historyFrom；任务必须存在于登记册。没有签名链的这一数组只表示声明序列，不宣称不可篡改 |

假名键应由资料保管方使用固定协议、租户隔离和秘密盐/HMAC 生成，保留独立受控映射；不得直接 SHA-256 姓名、手机号或短项目号后宣称不可反推。验证器只检查键形状，不读取密钥、生成真实人员身份或认证去重。底层已有 `serviceTaskHash` 仍按其原算法定义，不能重新命名成专业任务身份。

来源授权与覆盖证明的资料包必须由真实保管方提供：有范围和用途的授权原件、统计窗外也可查重的业务任务登记册、候选/生产区分依据、纳入排除规则及每项依据、收集启停/停机副本记录、摘要对应的真实材料。名单及排除项的内部数量相等仅证明自洽，独立总体是否漏项须对来源系统/现场台账核验；本工具不解释不透明登记册正文，也未验证 taskKey 与数据库 projectId/taskHash 的映射。

## 业务 First-Start 与尝试

`task-started` 表示业务任务首次操作之前持久记录的开始，必须带 `boundary=before-first-user-request` 和 `backfilled=false`。在这份 sidecar 中每任务最多一条；后续事件必须在其后，首次导入尝试的 occurredAt 不早于该开始的 recordedAt。只有 prospective 协议下真实收集的客户端/外业入口持久收据，才能证明业务首次开始，手工抄写服务创建时间不具备这个含义。

`import-attempt-started` 使用独立 attemptKey；serviceTaskHash 可为 null，保留鉴权后身份未知或未建立映射的请求。每次重试新建 attemptKey，同一业务 taskKey 不变；并发尝试可以独立开始，不能只保留最后成功。`import-attempt-finished` 与同任务的开始匹配，结束不得先于开始落盘；outcome 为 returned/rejected/cancelled，returned 必须带 sourceDisposition，其他终态不得带处置来暗示成功。

returned 仅是请求返回声明；archive-only/converter-required/gnss-processing-required 不得转换成平差准入成功。源文件已经提交但响应/侧写失败仍保留 rejected，不能删除中间失败。没有 finished 表示提取时未完成，不自动改为失败；期末以后结束与提取时仍未完成也不同。新增输出的 incompleteAttemptsAtExtraction 明确按提取时点计数，**不是**期末 KPI 分母。原指标工具仍按自身 `[start,end)` 截止规则输出服务事件统计。

历史任务无 first-start 继续保留 includedWithoutStart；升级前服务事件、成功网络创建、草稿创建、复验 started、人工估计时间都不可回填为业务开始。CLI 不安装上述业务埋点，不把 sidecar task/attempt 声明合并到原 SQLite 事件表，两个来源的计数不可相加。

## 正式签认与撤销

`formal-signoff-declared` 冻结 manifestSha256、bundleSha256、inputBindingSha256，并绑定 actorKey、身份材料、项目授权材料、signatureEnvelope 和 verificationReceipt 摘要；意图只能为 approve-frozen-delivery。`actorKind=human-declared` 和 `signatureValidation=external-receipt-not-authenticated` 明确这只是收到签认资料的声明。

外部签认验证器后续必须核对签名覆盖的确切字节、签名人身份/组织/职责和该项目授权、有效期与撤销、可信时间、签名算法与信任根、所签检查/验收范围和当前成果摘要；签名图片、姓名文字或另一智能体结论均不能代替。检查者、复核者和委托方验收的角色分工须依据真实制度与合同，不能由不同 agent ID 冒充。此资料语义与 [质量链接入审计](./RAILWISE_SURVEY_QUALITY_INTEGRATION_AUDIT.md)的人审边界一致；这里没有设定新规范条款或自动授予资质。

`signoff-revoked` 引用同任务既有 signoffEventId 和撤销证据，时间不早于被撤销声明；重复撤销拒绝。新成果摘要或整改后再签是新的签认声明，不能改写旧事件。撤销在期末前/后对正式成果队列的影响必须由将来的受信审批合同定义；当前工具保留原事件及先后，不计算正式批准数或首次正式交付耗时。

## 验证输出与失败

输出以聚合为主，不返回 taskKey/projectKey/actorKey、材料正文、路径或项目名称。contractSha256 与 existingCollectorSha256 绑定精确输入和被调用工具。`existingMetrics` 是旧工具结果的原样嵌入，其 cohort 标签和不可测项不被此合同改写。

| 输出状态 | 实际含义 |
| --- | --- |
| contractValidation=structurally-consistent | schema、引用、计数及事件顺序自洽 |
| evidenceByteIntegrity=matched-declared-digests | 读取到的资料字节与调用者声明摘要/大小相等 |
| sourceAuthorization / humanSignoff / firstStartAuthenticity=not-authenticated | 资料来源、真实授权、签章与开始事件真实性没有认证 |
| populationCoverage=not-certified | 登记册与来源系统的总体覆盖没有独立证明 |
| externalReceiptContent=not-interpreted | 已匹配的证据文件正文、签名回执语义未解析；摘要不是内容真实性证明 |
| taskToSnapshotIdentity=not-verified | sidecar假名任务与数据库身份/服务事件未做受信映射验证 |
| databaseReadIsolation=byte-verified-private-copies; originals-not-opened-by-sqlite | 原 Python 采集器仅对临时副本运行；可能产生的SQLite辅助文件不会出现在原目录，原件前后字节一致 |
| productionMetricPromotion=prohibited | 不得把内部校验通过提升为任何生产 KPI 或人审通过 |

资料缺失、版本/字段错误、前后时序矛盾、跨任务引用、摘要/大小变化、快照变化、旧指标执行失败均退出 1，不输出部分成功结果；stderr 使用固定诊断，不泄露私有内容。返回 0 只代表上述有限校验成功，**不是生产数据已经齐全或正式签认有效**。外部来源授权和签认最终仍需真实可核查材料；本次没有生成、寻找替代人员或伪造此类材料。
