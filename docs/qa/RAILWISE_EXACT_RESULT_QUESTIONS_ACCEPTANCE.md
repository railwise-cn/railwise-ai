# RailWise Survey 精确结果追问源码验收

日期：2026-09-21。范围：独立工作树 `codex/survey-result-questions`，基线提交 `b193fc70d6363dc768e715087ca9c0d9975158c9` 之上的增量，已以 `353d407` 提交并合入主任务分支。本记录证明引用合同、只读工具、桌面接线及自动化验证；签名候选的包内审计已另行完成，但真实模型 GUI 读回和用户确认仍未完成，不能据此公开发布。

## 2026-09-21 精确 0.5.0 候选包审计

工作流 `35540198977` 对源码 HEAD `3f0dbf1024577b5d28db1fe1570fe2e3173ae52a` 的私有 macOS arm64 候选通过。该流程只执行隔离私有 updater，公开 Release、stable/frontier feed 和官网发布 job 均跳过。目标 ZIP SHA-256 为 `a9569e9e712c16bb6abda1dd506eb041b942f4f7da4bc23415dee2c4d05aa4ff`，安装后 ASAR SHA-256 为 `0be93bf52ea87fe3b413a97e52674608156a53eceb4050ce504aa221a80bb744`；候选路径为 `/private/tmp/railwise-survey-3f0dbf1/Applications/RailWise AI Candidate 3f0dbf102457.app`。`codesign --verify --deep --strict`、`xcrun stapler validate`、`spctl --assess --type execute` 均通过；本机 `spctl --status` 仍为 `assessments disabled`，未被改动。私有 updater 六阶段 `base_started -> update_available -> download_completed -> install_requested -> target_relaunched -> user_data_preserved` 通过，TLS pin、manifest、ZIP 和用户数据哨兵均通过。完整安装与云证据见 `/private/tmp/railwise-survey-3f0dbf1/evidence/package.json`、`/private/tmp/railwise-survey-3f0dbf1/evidence/installation-context.json`。

使用该候选自身 Electron 可执行文件和 ASAR 完成包内精确审计：26 项通过，覆盖 17 类引用、精确 selector、跨项目/过期/错误哈希拒绝、大型 Huber 结果的 `selector-required`、实际只读 `survey_read_evidence` 工具调用及业务数据库/工作区前后快照不变。报告为 `/private/tmp/railwise-exact-questions-package-audit/run-001/audit-report.json`。这是合成数据的包内工具审计，不是 GUI 或真实模型验收。

候选 GUI 可启动，但当前隔离界面显示 `Connect to the runtime first`；Computer Use 会话刷新随后超时，未能建立受限 relay，也未产生真实 GUI turn、模型调用、截图序列或重启恢复记录。该部分继续保持未完成，不使用脚本、旧包或 headless 结果冒充真实模型证据。

### 2026-09-21 GUI follow-up attempt

候选进程退出后，旧的 GUI seed 数据库和工作区被完整移入 `/private/tmp/railwise-survey-3f0dbf1/failed-gui-seed-20260921-0645/`，没有覆盖；随后用同一候选 Electron、同一 ASAR `0be93bf52ea87fe3b413a97e52674608156a53eceb4050ce504aa221a80bb744` 重新生成 `gui-seed-003`，包内 26 项检查仍全部通过。候选以 `candidate.env` 启动，Runtime 实际监听 `127.0.0.1:62595`，数据目录仍为隔离候选目录。

本次启动截图保存在 `/private/tmp/railwise-exact-questions-package-audit/candidate-current.png`，可见候选原生窗口；启动日志为 `/private/tmp/railwise-survey-3f0dbf1/logs/gui-acceptance-launch.log`，Runtime 日志记录了 `WORKWISE_RUNTIME_READY`。GUI 业务库/合成工作区的只读基线快照已保存为 `/private/tmp/railwise-exact-questions-package-audit/gui-before-002.json`（SHA-256 `1b88fd1f95676b3ff44d9019674981fa4b2f0e1ecebf3be7748964b56bd2a6a8`）。Computer Use 能打开候选并进入工作目录选择器，但路径提交后仍停留在原生选择器，未进入可发送的 Survey 对话；因此没有生成 `expected-selection.json`、`raw-turn-items.json`、GUI after 快照或模型调用记录。该尝试仍是未完成，而不是 GUI 通过。

[历史界面清单](RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)中 `267aade` 基准的 Q10–Q17 缺口保留为历史记录；其当前源码接线状态由下表补充。本次覆盖以完整记录和有明确身份的行、成员、迭代为单位，不声称每个数值单元格、矩阵元素或所有任意字段都有独立按钮。

### 2026-09-24 真实 GUI 发送与鉴权失败

同一 3f0dbf1 安装包已进入中文浅色 Survey 合成工作区，实际完成点位 A 及 Q10 来源摘要的“准备草稿 → 显式发送”。Q10 保留已有正文，持久用户消息含准确的 typedEvidence 网络绑定；其发送前后 8 个业务数据库、23 个文件快照完全相同。两个真实回合均因上游 `401 Authentication Fails (governor)` 失败，未产生模型回答或工具调用，故模型读回门禁继续未通过。[脱敏证据与范围](evidence/railwise-result-questions-gui-20260924/README.md)保留失败及原始导出摘要。

## 实现覆盖

| 表面 | 本增量实现 | 源码入口 |
| --- | --- | --- |
| Q10 原始点、拓扑、摘要 | 工作区来源摘要与拓扑标题选择完整网络；原始控制点表选择 `knownPoints[index]` 或 `unknownPoints[index]`。按实际显示位置定位，重复点号不再落到第一行。 | [工作区](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx)、[测量面板](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx) |
| Q11 期次比较 | 点行、点对行选择比较记录及两期平差 ID；不继承当前面板中的另一次平差。比较记录按工作区、项目和项目修订号隔离。 | [测量面板](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx) |
| Q12 统计诊断 | 完整诊断和观测行；绑定实际网络修订号、计算哈希、诊断算法版本。 | [统计诊断](../../src/renderer/src/components/engineering/SurveyStatisticalDiagnostics.tsx) |
| Q13 自由水准 | 完整试算、输出点行及输出观测行；引用 `.output` 内的准确路径。 | [自由水准](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx) |
| Q14 六类高级试算 | 六类均有完整保存记录入口；广义 W 方向行、VCE 迭代、Huber 展开迭代、统计族成员、参考基准完整结果、静态追加步骤有独立选择。 | [工作区](../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx)、[通用结果](../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx)、[参考基准](../../src/renderer/src/components/engineering/SurveyReferenceDatumResult.tsx)、[静态追加](../../src/renderer/src/components/engineering/SurveyStaticIncrementalResult.tsx) |
| Q15 质量流程 | 总体及分页单位、抽样运行及分页样本；评分记录、结果字段和 trace；资料保留计划、文件成员、检查项、审计事件；评定计划、结果、单位和材料行。 | [抽样](../../src/renderer/src/components/engineering/SurveyQualitySamplingWorkspace.tsx)、[评分](../../src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.tsx)、[评分结果](../../src/renderer/src/components/engineering/SurveyQualityScoringResult.tsx)、[资料](../../src/renderer/src/components/engineering/SurveyQualityWorkspace.tsx)、[评定](../../src/renderer/src/components/engineering/SurveyQualityAssessmentWorkspace.tsx) |
| Q16 复验及规范 | 旧成果复验按保存回执中的 `checks[index]` 选择；新监测复算选择完整 attempt；规范依据选择已解析版本以及 rule/profile locator，并保留抽样或评分父记录绑定。 | [旧复验](../../src/renderer/src/components/engineering/EngineeringManifestVerification.tsx)、[监测复算](../../src/renderer/src/components/engineering/EngineeringMonitoringReplay.tsx)、[规范依据](../../src/renderer/src/components/engineering/SurveyStandardBasis.tsx) |
| Q17 监测 | 数据集完整记录、质量发现行、监测分析结果行；结果同时用监测项目和点号标识。 | [工作区](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx) |

## 精确引用合同

所有引用必须携带 `schemaVersion: 1`、`projectId`、正整数 `projectRevision` 和区分种类的 `kind`。哈希要求 64 位小写十六进制。完整合同见 [survey-evidence-reference.ts](../../kun/src/contracts/survey-evidence-reference.ts)。

| kind | 必需绑定字段（公共字段之外） |
| --- | --- |
| `network` | `networkId`、`networkRevision`、`sourceSha256` |
| `deformation` | `comparisonId`、`referenceAdjustmentId`、`currentAdjustmentId`、`inputHash`、`algorithmVersion` |
| `statistics` | 网络三个字段、`adjustmentId`、`inputHash`、`calculationHash`、`diagnosticsVersion` |
| `free-leveling` | 网络三个字段、`trialId`、`recordHash` |
| `advanced-trial` | `trialId`、`recordHash`；实际试算 kind 来自所读记录 |
| `sampling-population` | `populationId`、`populationHash`；选择单位时同时要求 `unitIndex`、`unitId` |
| `sampling-run` | `runId`、`runHash`、`planHash`；选择样本时同时要求 `sampleIndex`、`unitId` |
| `scoring` / `assessment` | `recordId`、`recordHash` |
| `retention-plan` | `planId`、`manifestHash`、`artifactHash` |
| `retention-record` | `recordId`、`planHash`、`headHash` |
| `assessment-plan` | `planId`、`planHash` |
| `standard-basis` | 完整 `SurveyStandardBasisReferenceV1`、`ruleDigest`；关联结果时还带抽样运行或评分的 `parent` 绑定 |
| `monitoring-dataset` | `datasetId`、`datasetRevision`、`sourceFileHash` |
| `monitoring-analysis` | `analysisId`、`datasetId`、`inputHash`、`algorithmVersion` |
| `deliverable-verification` | `manifestId`、`checkedAt`；服务验证保存回执摘要及身份，同时间重复回执拒绝选择 |
| `monitoring-replay` | `manifestId`、`attemptId`、`checkedAt`；服务验证开始/完成事件链及结果摘要 |

可选 `selector.path` 从相应严格读取 API 的真实返回对象根部开始。对象数组选择必须校验所选对象的 `identity` 或相对 `identityPaths`；原始点、观测、成员、迭代、材料和条款使用各自的身份字段。纯标量/矩阵路径可以通过不可变记录绑定及坐标选择。路径只允许自有 JSON 字段，禁止原型访问，限制长度和数组索引。抽样分页行使用完整总体/运行中的绝对索引，不能把页内序号当全局序号。

## 失败与草稿边界

- [共用按钮](../../src/renderer/src/components/engineering/EngineeringEvidenceQuestion.tsx)只准备当前工作区/项目的会话草稿及引用并聚焦输入框；点击不发送模型请求，不调用计算、复验、批准或修改 Runtime 的 API。缺失版本/哈希、作用域冲突或离线时禁用。
- 已有非空问题、附件、上传状态、错误和推理力度保留。显式选择使用 `evidenceContext`，不被普通页面导航覆盖；旧版草稿字段和读法保留。项目切换加载期间不把旧网络写入新项目草稿，过期比较结果隐藏。
- 只有用户显式发送才附带 `typedEvidence`，提示模型先调用 `survey_read_evidence` 读取该准确引用，禁止替换记录或据此执行计算。真实模型是否遵循提示仍需另验。
- 发送失败保留草稿；成功仅清除已发送的输入、引用和附件。与该引用相同的 `viewContext` 一并清除，下一条普通问题不暗带旧引用；发送期间新选中的记录和新输入保留。移除引用不删除问题正文。
- [读取器](../../kun/src/engineering/survey-evidence-reader.ts)及[工具适配器](../../kun/src/adapters/tool/engineering-conversation-tools.ts)检查线程项目、工作区、项目修订号及各类记录绑定，调用现有严格只读读取/完整性校验。严格 getter 可以为校验保存记录而重算其数学结果，但不执行新的用户计算任务。失配、缺失、损坏、歧义和非法 selector 返回不可用，不取最新记录替代，不创建新的计算记录或复验审计。
- 完整工具响应超过 48 KiB 或 1500 个结构项时返回 `selector-required` 和选择提示，不把截断前缀假称完整结果。大记录整体入口因此可能需要进一步指定字段；这不是模型读回成功。
- 读取成功只说明已保存证据可按绑定解析，不能认证调用者声明、现场来源、标准符合性或人员签名，也不改变工程成果审核状态。

## 已验证命令与证据

公开源码验证文件位于 [evidence/railwise-result-questions-source](evidence/railwise-result-questions-source/README.md)。保留原始测试输出、命令元数据与摘要；未复制模型配置、凭据、数据库、工程原始数据、临时 Vitest 配置或运行脚本。

[源码摘要清单](evidence/railwise-result-questions-source/source-files-sha256.json)记录生成时 44 个已修改/新增 TypeScript 源码及测试文件，集合 SHA-256 为 `4750545d2e202ce726a85f971afc4a2d7c3349eb0999eabc4960f05fc180c399`。这是未提交增量的字节定位，不是全部依赖或安装包指纹；[SHA256SUMS](evidence/railwise-result-questions-source/SHA256SUMS)记录公开验证文件摘要。

| 命令与执行范围 | 结果 |
| --- | --- |
| `npm test -- --reporter=default`，`kun/` | 192 文件通过、2 文件跳过；2929 项通过、22 项跳过。见 [Runtime 日志](evidence/railwise-result-questions-source/runtime-tests.log)。 |
| `npm run typecheck`、`npm run build`，`kun/` | 均退出 0，分别执行 Runtime 全量类型检查和 TypeScript 构建。 |
| `npm run test`，桌面首次原配置 | 330 文件通过、1 失败、2 跳过；2847 项通过、3 失败、2 跳过。唯一失败为 PDF 预览文件：Vite 拒绝共享依赖符号链接指向工作树外的 `pdf.worker.min.mjs?url`。见 [首次失败日志](evidence/railwise-result-questions-source/desktop-test.log)。 |
| `npm run test -- --config /private/tmp/railwise-result-questions-validation/vitest-worktree.config.mts` | 临时配置仅增加工作树及共享 `node_modules` 的 `server.fs.allow` 读取目录，保留全部测试且不增加 mock。331 文件通过、2 跳过；2850 项通过、2 跳过。见 [完整复验日志](evidence/railwise-result-questions-source/desktop-test-worktree-allow.log)。 |
| `npm run typecheck`，桌面 | Web 和 Node 两个工程均通过。 |
| `npm run lint`，仓库 | 0 错误，1 条既有 `Workbench.tsx:1406` 的 `setInput` Hook 依赖警告；该文件未由本增量修改。 |
| `./node_modules/.bin/electron-vite build`，桌面 | main、preload、renderer 生产构建均通过。Runtime 已单独构建；跳过顶层 `npm run build` 中可能安装/删除共享原生依赖的 `ensure-runtime-install.cjs`，没有执行 native rebuild。 |

首次与复验独立记录，不能用复验覆盖失败日志。Runtime 跳过项为需显式启用的真实 macOS converter sandbox 20 项及需外部 Leica GSI 文件的 2 项，不计为实测通过。桌面 2 项跳过保持原套件状态，不计为通过。测试包含真实本地服务保存记录、只读工具适配器读取、记录损坏/失配拒绝和 DOM 点击；[readback 测试](../../kun/src/engineering/survey-evidence-readback.test.ts)没有调用外部模型，不应称为真实模型验收。

## 尚未完成

- 本增量独立候选的版本、源码/ASAR 绑定、签名/公证和隔离安装已完成，见本页 2026-09-21 记录；精确成果追问的完整 GUI/模型流程和重启恢复仍待验收。
- 安装包中 Q10–Q17 准备草稿、手动发送、真实模型调用工具、准确读回及回答引用的整条证据，包含离线、过期、失败与恢复。
- 中文/英文、浅色/深色、支持窗口尺寸、键盘和辅助功能的安装包操作与截图，以及用户对该确切版本的 UI/功能确认。
- 该确切安装包的用户本人 UI/功能确认及后续公开发布门禁。3f0dbf1 候选自己的真实私有 updater round-trip 已通过；此前其他候选的证据不替代本增量 GUI/模型验收。

OpenSpec `Exact result questions follow-through` 仅前两项标记源码实现完成，第三项签名候选验收保持未完成。其他增量和产品总计划的任务状态不由本记录推定完成。
