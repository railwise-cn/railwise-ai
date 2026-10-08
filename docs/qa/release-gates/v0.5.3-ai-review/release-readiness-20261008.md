# RailWise AI / Survey 0.5.3 发布准备状态

日期：2026-10-08（Asia/Shanghai）。类型：**AI review / 发布证据审计**。

结论：真实 GitHub REST 来源适配、冻结包与 updater 不可变报告绑定及发布事务恢复的源码整改已完成本地回归；最终公开身份包尚待包含全部整改的受保护 main 提交冻结和验收。本仓库已按用户明确授权切换为单维护者发布模式，不再等待独立 GitHub 审核；本记录不是通过的发布 manifest，不替代用户的 0.5.3 发布授权、厂商互操作证明或真人专业签认。历史失败记录保留原样。

## 本次审计身份

- 仓库：`railwise-cn/railwise-ai`。
- 工作树：`/Users/wangjiawei/.codex/worktrees/railwise-053-remediation/WorkWise`。
- 分支：`codex/railwise-053-remediation`。
- 审计开始时提交：`e83e4d9bfbf98316e4593211bd7b2b4b98a5e020`，已合入最新 main 发布控制；`package.json` 为 `0.5.3`。
- PR：[44](https://github.com/railwise-cn/railwise-ai/pull/44)。本次 GitHub API 读取为 `OPEN`、`MERGEABLE`、`BLOCKED`、`REVIEW_REQUIRED`，作者为 `railwise-cn`，审查列表为空；整改已提交 `b0008c9c` 和 `ff01a178` 并推送。
- 最新质量 CI 成功记录：`37722185209`（push）和 `37722189688`（PR），对应 `ff01a1784797bed097d576aa0c9e2175cd85bc12`；三类 Linux/Windows/Electron 检查全部通过。它们是源码检查，不能替代最终安装包验收或独立审核。
- 本次已完成 GitHub REST 运行来源校验字段适配、updater machine/native 报告不可变来源绑定及发布事务回归；两路独立 AI 源码审查均未发现剩余确定缺陷，边界见 `source-gate-independent-ai-review-20261008.md`。这些修复不能冒充上述 e83 提交内容。后续最终冻结须采用包含全部修复、经审核合并的实际受保护 main 提交。

## 候选证据的有效范围

此前执行会话检查过 `ad39467bb0c936ddd916c5a9d8afede06141cdb6` 的隔离候选：

- 版本 `0.5.3`；Bundle ID `com.wangjiawei508.workwise.candidate.headad39467bb0c9`。
- 安装路径：`/private/tmp/railwise-053-ad39467b-review/Applications/RailWise AI Candidate ad39467bb0c9.app`。
- 已观察导入、基准确认、预检、平差、结果、协作审查稿编辑/保存和交付；交付完成 DOCX、PDF、XLSX、SVG 四个文件。
- 已观察实际 AI 答复使用专业意见与复核文案，以及 0.5.2 历史记录的只读回归。
- 私有更新运行 `37585345642` 成功验证签名/公证目标的下载、安装、重启和探测数据保留，但基线是 `0.0.0` 的同源版本探测，不是官方 `0.5.2` 到最终公开身份 `0.5.3` 的更新。

这些事实来自此前执行会话的候选验收记录，本次文档审计未重新运行应用。该候选的身份和来源与待冻结的最终 main 包不同，不能据此将最终包门禁标为通过。

已提交的历史证据仍分别指向旧包：

- [`functional-checklist.md`](functional-checklist.md) 对应 `9527ec5f1bcb` 候选，最终包检查未完成。
- [`independent-ai-review.md`](independent-ai-review.md) 保留历史 adhoc 包、服务联通和 UI 覆盖失败。
- [`acceptance-findings-20261007.md`](acceptance-findings-20261007.md) 对应 `5a9dc7d0e028` 的签名公证候选；该包存在交付 draft IPC 阻断，而且 UI 包与另行构建的 updater 目标 ASAR 不同。后续源码修复不改变该旧包的失败结论。
- 尚无通过的 `docs/qa/release-gates/v0.5.3.json`。本记录不创建该文件。

## GitHub 维护者与发布模式

本次访问 collaborator、main protection、PR 和环境 API，并修正实际检查名称后确认：

| 控制 | 当前设置 | 实际影响 |
| --- | --- | --- |
| 仓库 collaborator | API 仅返回 `railwise-cn`，角色 admin | 当前未发现第二个有效维护者账户 |
| PR #44 作者 | `railwise-cn` | 单维护者模式允许该账户在 CI 通过后合并自己的发布整改 PR |
| CODEOWNERS | 发布控制及 `docs/qa/release-gates/**` 均为 `@railwise-cn` | 唯一 CODEOWNER 与 PR 作者相同 |
| main review | 单维护者模式：保留 PR 合并，人工批准数为 0，不要求 CODEOWNER 或最后推送者审批；`enforce_admins.enabled=true` 和严格状态检查仍保留 | CI、严格检查和标签保护仍然有效；不宣称存在独立人审 |
| main checks | 三个实际 job 名称、app_id=15368（GitHub Actions）、strict=true | 原 Quality / 前缀导致所有真实检查 isRequired=false，现已修正；GraphQL 确认 6 个实际 check 均 isRequired=true 且 SUCCESS，检查成功不等于独立审核 |
| production-release | 单维护者模式：移除 required reviewer 规则；环境仍用于发布工作流隔离 | 当前维护者可执行已获授权的发布工作流；不宣称存在独立环境审批 |

本机 GitHub CLI 实时权限 API 仍显示有效维护者为 `railwise-cn`；`wangjiawei508` 为 `permission=read`、`push=false`。用户明确授权恢复单维护者模式后，已移除阻塞性的 PR 审批与 production required reviewer 配置；没有伪造审批、切换身份或关闭 CI/标签保护。只读检查 25 个实际存在的 registered worktree，未发现 `docs/release/stable-release-gate.md` 的未提交旧修改；本轮明确修正其旧有“从 tag 生成候选/发布重新构建”说明。

模拟资深工程师的 AI review 用于产品/软件验收，不能伪装另一 GitHub 身份、真人批准、厂商互操作结果或专业签认。单维护者模式是本仓库当前明确授权的治理选择，不代表存在独立人审。

检查名称整改的独立复审、PATCH 范围与回读记录见 [`github-required-checks-correction-20261008.md`](github-required-checks-correction-20261008.md)。本次在用户明确授权下修改了 required_pull_request_reviews 与 production-release required reviewer 配置；required status checks、CODEOWNERS 文件、enforce_admins、force-push/delete 和 v* 标签保护继续保留。

本次核验命令：

```text
gh api repos/railwise-cn/railwise-ai/collaborators
gh api repos/railwise-cn/railwise-ai/branches/main/protection
gh pr view 44 --repo railwise-cn/railwise-ai --json author,reviews,headRefOid,mergeStateStatus,reviewDecision
gh api repos/railwise-cn/railwise-ai/environments/production-release
```

## 最终安装包验收缺口

| 项目 | 待完成证据 |
| --- | --- |
| 最终包来源 | 受保护 main 上 `candidate_only=true`、`prepare_public_artifacts=true`、`publish_release=false`、`skip_stability=false` 的成功冻结 run；完整两小时稳定性及三客户端验证 |
| immutable 身份 | mac/win artifact ID/digest、两份原始 `reviewed-build.json` receipt、八个文件的大小/hash、公有 Bundle/包名及实际 CUA 审查安装的 `package.identity.asarSha256`；该 64 位值必须同时等于机器 updater 报告的 `targetAsarSha256` 与 `installedAsarSha256`，不得混用独立构建 |
| 签名/公证 | 该精确包的 Developer ID、签名要求、Gatekeeper、公证和 staple 验证 |
| 专业主流程 | 最终包 IN2/GSI 和监测 CSV/XLSX、基准/单位确认、质量问题修复、计算、结果证据定位、DOCX/PDF/XLSX 实际读回、编辑审查稿及重启 |
| UI 矩阵 | 中文/英文 × 明亮/深色 × 1280×800/1440×900/窄窗口 × 概览/处理/结果/交付，共 48 组合；AI/高级抽屉、品牌/图标及专业表格滚动另查 |
| 可访问性 | 全流程 Tab/键盘顺序、焦点进入/恢复、Escape、状态播报、不依赖颜色的状态和图标按钮可访问名称 |
| AI/恢复 | 真实默认及显式模型问答/计划、一次明确确认、离线/过期/取消/失败/重试/继续/重新规划、恢复后结果与历史一致 |
| 真实更新 | 官方 pinned `0.5.2` → 同一冻结 `0.5.3` ZIP，经真实 HTTPS/native updater 下载、安装、重启；UI 审查、冻结 ZIP 和安装后 ASAR 完全一致；committed `frozen-updater.json`/`native-updater.json` 分别通过 `machineReportPath`/`nativeReportPath` 绑定；必须记录成功 updater `workflowRun` 的仓库、工作流路径、相同冻结 sourceHead、runId/runAttempt 和 immutable artifact ID/name/digest，机器报告保留七字段 provenance 和 nativeReportSha256；实际 API 验证后下载 archive，digest 校验及两报告字节比对均通过 |
| 历史/配置保留 | 更新后项目、网络、结果和原始依据读回；如实记录报告/签认/插件/凭据迁移未覆盖的范围，不能把惰性配置字节探测称为所有配置行为验证 |
| 独立 AI 复核 | 新包精确版本/来源/hash、截图、功能和可访问性清单、数值/报告口径及缺陷闭环 |
| 发布证据 | 全部门禁通过后提交真实 `v0.5.3.json`，包含必需的 `package.reviewedBuild`；冻结后至发布 tag 仅有 `docs/qa/` 证据变化 |

源级验证器已适配真实 GitHub REST：使用 API 实际返回的仓库/workflow ID、路径、受保护 main 祖先关系、run/attempt、成功 job/step 与 artifact/receipt 绑定，已移除对 run 响应不存在的 `workflow_ref` 字段的依赖；保留 hosted workflow 引用和冻结 receipt 约束。receipt 的 `workflowRef` 必须精确为 `railwise-cn/railwise-ai/.github/workflows/release.yml@refs/heads/main`，`workflowSha` 必须等于冻结 `sourceHead`。机器 updater 报告的严格基线、reviewedBuild、签名、nonce、ASAR、数据读回、清理和 native stages 核验也已集成。独立只读复核未发现确定的新缺陷；已实时确认历史 run `37585345642` 的 API 字段形状，历史小型 artifact `11466917433` 下载 ZIP 的 SHA-256 与 API digest 一致。这些真实 API/传输检查仅证实验证代码兼容，不能将该历史同源版本探测升级为最终官方更新验收。上述已完成源码仍须经审核合入最终受保护 main，再冻结同一来源的公有身份包。

新 schema 还要求 `acceptance.updaterRoundTrip.workflowRun={repository,workflowPath,sourceHead,runId,runAttempt,artifact:{id,name,digest}}`：repository 为 `railwise-cn/railwise-ai`，workflowPath 为 `.github/workflows/frozen-release-updater-acceptance.yml`，sourceHead 精确等于 `package.reviewedBuild.sourceHead`，artifact name 为实际 `frozen-updater-${arch}-${runId}`。机器 `provenance` 必须完整保留 runner 的七字段 `repository`、`workflowPath`、`workflowRef`、`workflowSha`、`sourceHead`、`runId`、`runAttempt`；workflowRef 为受保护 main 的上述 updater 工作流，workflowSha 与 sourceHead 相同。`nativeReportSha256` 必须等于实际留存 native 报告字节的 SHA-256。发布门禁通过真实 API 核验 run、attempt、仓库/工作流 ID、受保护 main 祖先关系、成功 job/step 及未过期 artifact，然后按 ID 下载不可变 archive、核对其 digest，并逐字节比较下载的机器/native 报告和 committed 报告。不得通过本地补写 provenance、替换报告或伪造 passed 关闭这些缺口。

## 发布事务源码整改与验证边界

此前流程在 Release 说明、draft 和下载检查之前就提升 stable 指针，后续失败可能留下用户可见的新版本。当前 `.github/workflows/release.yml` 和 `scripts/release-promotion-recovery.mjs` 的工作树差异已调整先后顺序并保存真实上一版本状态。本节记录源码整改，尚未执行生产提升或生产故障恢复，不将单元测试称为真实发布验收。

| 项目 | 当前源码证据与状态 |
| --- | --- |
| 提升前验证 | release notes、创建/更新 draft、仅保留三客户端安装包、实际 GitHub 下载及逐文件 `cmp` 都位于 stable promotion 之前；同 tag 已公开的 GitHub Release 会被拒绝编辑或替换资产 |
| 真实 metadata 快照 | promotion 前读取 R2 与 pinned-SSH 官网各六份 metadata：stable/legacy 两目录各 `latest.json`、`latest.yml`、`latest-mac.yml`，总计十二份；要求全部选择同一实际上一版本，不使用 `PREVIOUS_TAG` 猜测回滚版本 |
| promotion 启动门禁 | capture 保存实际 previousTag、全部旧/目标 metadata 和固定 generatedAt；核验官网旧 archive 的文件校验和与 metadata 精确一致，核验旧 R2 资料引用的实际安装包/ZIP SHA-512 与大小，拒绝重复引用的冲突值；start 再核验旧版、目标 immutable metadata 和十二份当前指针，变化即停止，未进入 started 状态不执行自动恢复 |
| 故障恢复 | 仅在 GitHub 权威状态为 draft/absent 且状态已 started、绑定本次 tag/run/attempt 时恢复受影响 surface；当前字节必须属于保存的旧记录或本次预定目标，archive 核验后再次检查所有权，恢复后全部旧字节精确相同，包含 generatedAt；同版本变化或其他版本占用均拒绝覆盖 |
| 发布请求与不确定状态 | 正常/超时/失败请求后查询真实 GitHub 状态；已公开时复核精确三安装包集合、大小、SHA-256 和实际重新下载哈希，以及两 surface 的目标 metadata，符合才视为 published/reconciled；unknown 不自动回滚，保留私有 snapshot/result artifact；不删除或重写已公开 Release |
| 版本与并发 | target 必须高于当前 Stable；publish、rollback、独立/内嵌缓存修复和官网 deploy 共用 production-release-public 串行锁，cancel-in-progress=false；事务 promotion 使用 skip-retention 保留旧版恢复能力，公开版本相同/更高即阻止滞后任务降级 |
| 测试 | 事务扩展后的最终正式入口回归、frozen runner、ESLint 和独立复审结果见下节；不把重叠导入执行的测试项累计为新的覆盖 |

发布事务代码全部完成并通过定向回归后，仍须合并至受保护 main 并作为冻结源码的一部分；其真实生产行为只在实际批准发布过程中核验。不能为证明恢复能力而擅自修改官方指针。

## 本地源码验证

- 根目录全量：356 文件通过、2 文件跳过；3196 项测试通过、2 项跳过。
- `kun` 全量：218 文件通过、2 文件跳过；3167 项测试通过、22 项跳过。
- 实际测试 runtime：Electron 43.1.1 内置 Node 24.18.0、ABI 148。现有 SQLite addon 属于该 ABI，系统 Node 26.10.0 使用 ABI 147，直接运行会有环境加载错误；通过临时 PATH 的 node 符号链接及 ELECTRON_RUN_AS_NODE=1 使用匹配 runtime，未重装、覆写或重编译依赖。
- addon 前后 SHA-256 相同：8b56e43f8fe02042839ad9bf4fe07947a77c883426e080c274cae12e1dcb0747。临时测试日志位于 `/private/tmp/railwise-053-test-runtime.dGTZl0/`，不是最终包证据。
- 最终 `npm run test:release-gate`：214/214；独立 frozen runner：20/20；官网版本/页面审计回归：12/12。release-gate 已导入来源、updater evidence 和事务测试，重复执行的定向测试不累计覆盖。
- 全量 ESLint、桌面 typecheck、OpenSpec 12/12、品牌边界最终 2724 文件及 diff 检查通过；事务文件稳定后再次执行相关脚本定向 ESLint 通过。
- 补充 0.5.3 用户发布说明；根据实际 GitHub publishedAt 修正 CHANGELOG 中 0.5.1/0.5.2 的已发布状态，0.5.3 仍标为待验收与发布。

## main 合并前与合并后的执行顺序

合并前继续完成发布事务差异、定向回归及独立源码审查、候选异常恢复演练、验收清单和治理门禁核对。REST 来源适配及 immutable updater 绑定的源码整改已完成；其本地验证不能关闭未来最终包验收。此次已补齐 README 的完整 `reviewedBuild` 示例与冻结流程。

main 合并后按以下顺序执行：

1. 从包含所有整改的精确 main 提交私有冻结最终公有身份包；不跳过两小时稳定性，不发布或更新官网/feed。
2. 下载不可变 artifact ID，核验原始 receipt、所有文件及签名/公证，形成实际 `reviewedBuild`。
3. 安装同一目标 ZIP/DMG，完成 48 组合 UI、专业主流程、AI、重启、异常恢复和可访问性；失败即修复并重新冻结。
4. 在相同冻结 sourceHead 的受保护 main 运行官方 0.5.2→精确冻结 0.5.3 更新验收，保留原始 retained updater/seed/readback 报告字节和 `workflowRun`、immutable artifact ID/name/digest、七字段 provenance、nativeReportSha256，完成真实 API/下载 artifact 字节绑定；核对 CUA 实际审查安装的 `package.identity.asarSha256`、机器报告 `targetAsarSha256` 和 `installedAsarSha256` 三者完全相同。
5. 独立综合资深工程师模式代理复核精确包及证据；解决所有发布阻断。
6. 仅此后创建通过的 manifest，并以 `docs/qa/` 证据提交保留冻结源码祖先关系；完成单维护者模式下的 AI 复核与本地验收。
7. 按既有确切版本发布授权执行 tag/Release/stable/官网发布，消费已经验收的 artifact，验证公开下载与更新行为；当前不再等待独立 GitHub 或环境审核。

## 产品计划与外部证据边界

本次台账计数：`survey-professional-workflow` 17/19，未完成 4.2 精确包完整验收和 4.4 授权厂商/SUC证据及真实角色专业签认；`workwise-0-5-0-engineering-delivery` 95/126，31 项开放，包含重复的包验收聚合项以及真实格式、生产质量/算法范围、设备/空间、协作和生产指标。

公开 COSA/测量云资料、独立数学对算及源码回归能支持流程/数值判断，不能变成厂商授权、真实仪器联调或真人签名。0.5.3 的候选通过不得将这些未完成项目整体标为完成；正式成果所需的专业签认与规范/厂商状态必须如实展示。
