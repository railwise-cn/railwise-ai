# be0d7ac 隔离候选包实际验收

日期：2026-09-20。状态：**partial-not-release-approval**。本目录只覆盖完整源码提交 `be0d7ac47550d4d178674f63ce4406ee7c614e66` 的 macOS arm64 隔离候选包，版本 `0.5.0`。不代表当前工作树的新修改已经进入该包，不代表真人专业签认、用户 UI 确认或公开发布。

## 包身份与私有更新

[包摘要](package-summary.json)记录 bundle ID `com.wangjiawei508.workwise.candidate.headbe0d7ac47550`，ZIP SHA-256 `79b5201890d45e8399e902b0312a65c961979bb00a584776feef2cfa08cf671a`，ASAR SHA-256 `ee13677b587d69f230e60227d9d85a681961323272795e09fbfc6617e1da9209`。本机安装的应用来自私有原生 updater 使用的同一个目标 ZIP，ASAR 与 updater 安装结果一致。

云端完成同源码 `0.0.0 -> 0.5.0` 的私有原生更新、目标重启和用户数据 sentinel 保留：[私有更新](private-updater-summary.json)、[原生阶段](native-updater-summary.json)、[TLS 拒绝检查](tls-preflight-summary.json)。这是隔离更新探针，不是历史正式版升级或生产数据迁移；没有推广公开 feed，没有打开浏览器手动下载替代 updater。私有 manifest/ZIP 使用证书固定的回环 HTTPS，Squirrel 内部仍使用 electron-updater 的本机 HTTP。

本机 codesign、stapler、spctl assess 命令退出 0，但 `spctl --status` 为 `assessments disabled`、退出 1；云端检查为 `assessments enabled`。两套状态分别保留，不能把云端启用状态套用到本机。原始包检查中的 `guiAcceptance:not-tested` 是安装时记录，本目录后续 GUI 证据不会反向改写它。

## 原生 GUI 与合成记录

主任务通过原生应用界面创建首轮全数检查和声明单位评分，没有用 SQL/API 预置 GUI 验收记录。当前工程 `project_e53c6744-12ba-45bf-95f4-860f31b6a49c`，抽样 `sampling_run_d8581927-2b66-4058-bb09-174e4eedda81`，评分 `quality_scoring_d20c1d56-0e62-4952-9ace-ed15de36b802`。全数选择 2/2，完整声明评分精确结果 `9141/100`；这些是合成输入下的计算，不是实测成果批准。

| 已记录状态 | 截图 / 摘要 | 限制 |
| --- | --- | --- |
| 中文浅色首轮全数检查及依据 | [01](screenshots/01-census-zh-light.jpg)、[02 来源身份](screenshots/02-census-identities.jpg) | 仅当前合成例 |
| 中文浅色声明评分及依据 | [03](screenshots/03-unit-zh-light.jpg) | 评分通过 JSON 文本框输入，非文件选择器 |
| 中文浅色键盘折叠 / 展开 | [Space 折叠 AX](ax-excerpts/06-keyboard-collapse.json)、[Return 展开 AX](ax-excerpts/07-keyboard-expand.json) | 不是英文 compact 键盘测试，也不是完整无障碍审计 |
| 英文深色常规评分 | [08](screenshots/08-unit-en-dark.jpg) | 工程名“新建内业任务”是合成用户数据 |
| 英文深色较窄状态 | [09](screenshots/09-unit-en-dark-compact.jpg)、[10 依据链接](screenshots/10-basis-en-dark-compact.jpg) | 保存实际画面，不声称完整尺寸验收通过 |
| 真实模型回答 | [11](screenshots/11-live-model-answer.jpg)、[AX 节选](ax-excerpts/11-live-model-answer.json) | 见下节链路及范围 |
| 同包重启后的评分、会话及抽样 | [12 评分与会话](screenshots/12-restart-score-and-chat.jpg)、[13 抽样](screenshots/13-restart-census.jpg) | 恢复相同 ID，没有重算 |
| 旧 281 合成工程历史恢复 | [14 旧评分](screenshots/14-legacy-score-basis.jpg)、[15 旧抽样](screenshots/15-legacy-census-basis.jpg) | 保留旧工作区绑定，依据仅作只读关联 |

原始 01–11 截图文件扩展名虽是 `.png`，编码实际为 JPEG；12–15 原件已是 `.jpg`。本目录无转码、无裁剪，按原字节复制为 `.jpg`；[文件清单](file-manifest.json)保存原始与归档 SHA 一致性。常规图像为 1171×768，较窄图像为 1053×703；这些是图像像素，不是已核实的原生窗口逻辑尺寸，不记为 960×640。截图只用于历史 QA，不替换官网首页截图。

当前基线在两个合成记录创建、初次依据查看之后建立。记录摘要 [baseline](current-before-basis-report.json) 与 [主题/尺寸操作后](current-after-themes.json) 逻辑摘要均为 `adc32186545edb404208446a1c46bdf3b147e4bc46f517b35f0cca823a022d89`。因此可证明基线之后本次所查三表逻辑列字节和行成员未变，不能声称“首次打开抽样依据前已取基线”。只读检查器自身的 `guiExecutionVerified:false` 表示它不认证 GUI；实际 GUI 另由截图与原生 AX 支持。

主任务用 Cmd-Q 正常退出，进程检查无候选匹配（退出 1），再用同一签名应用和隔离环境启动。在默认 Code 入口点击内业后，原工程和答案 `5` 恢复；评分历史恢复同一 score ID、`9141/100` 并展开依据；抽样历史恢复同一 run ID、全数 2/2 并展开依据。[重启后比对](current-after-restart.json)仍为 `unchanged:true`，摘要与上述基线一致。原生 AX 中分别保留 [score ID](ax-excerpts/12-restart-score-and-chat.json) 与 [run ID](ax-excerpts/13-restart-census.json)。

旧 281 合成工程复制一致性见 [复制比对](legacy-copy-matches-source.json) 与 [启动前基线](legacy-before-startup-report.json)。主任务保留原工作区绑定，通过 GUI 恢复工程 `project_9c8894f5-7683-4b0e-a634-466ffca1dbe0`、评分 `quality_scoring_29a60f54-f4d6-4d54-ba73-ae70e032ae70`（`9141/100`）及抽样 `sampling_run_de67cfde-0c90-41df-884f-53af2da4cacd`（全数2/2），均展开规范依据。[恢复后比对](legacy-after-restore.json)相对复制后启动前基线 `unchanged:true`，逻辑摘要均为 `5f4235dc0af70d459dba5f6833272de034266cee27562d51b44e951b23c353ba`。这是历史记录的只读关联，不把旧记录补写成新批准。

## 官方 PDF 链接与已知修正

原生操作打开了官方 PDF 第8页和第60页，保留 [PDF8 AX 节选](ax-excerpts/05-standard-pdf8.json)、[PDF60 AX 节选](ax-excerpts/04-standard-pdf60.json)及[归档代理的截图实读记录](pdf-view-observations.json)。PDF60 的 AX 仅报告未变化，页码确认来自原截图的 `60 / 129` 计数及官方 URL；PDF8 同时有 URL AX 和 `8 / 129` 截图。官方来源为贵州自然资源部门托管的 GB/T 24356-2023 PDF；本目录不打包原 PDF 或 PDF 页面截图。

be0d7ac 的平面控制入口把“表43/44”与 PDF60–63 合并展示。实读发现 PDF60 / 印刷57 的大部分仍为表42续，底部才开始 7.5.1 引导；表43权重实际在 PDF61 / 印刷58，表44错漏分类在 PDF62–63 / 印刷59–60。源代码随后已拆分权重表、错漏表和引导条款的链接，高程控制相应为 PDF64、65–66；**该修正不在本候选包**。原图 [10](screenshots/10-basis-en-dark-compact.jpg) 特意保留旧呈现，不作为修正后截图。

## 真实模型链路

[转发记录](live-model-relay-summary.json)包含 5 次模型目录请求和 1 次合成聊天请求，均为官方 HTTP 200。聊天发生于 `2026-09-20T05:07:22.777Z`，请求模型 `deepseek-flash`，原生界面实际显示回答 `5`；提问明确为带 `RAILWISE-SYNTHETIC-ACCEPTANCE` 标识的 `2+3` 合成题。

调用链为：原生 GUI → 候选隔离 Runtime → 仅本机回环临时兼容端点 → 官方 DeepSeek HTTPS。候选受保护凭据访问保持 0，真实 key 只由转发进程在内存使用，没有写入候选；归档不包含 key、候选设置、环境文件、本地 token 或请求响应完整正文。转发报告记载 SIGINT 停止，主任务同时确认进程退出 0、临时 token 删除、停止后连接拒绝（curl 退出 7）；归档代理未重跑 GUI 或读取真实凭据。

测试结束后，主任务通过候选 GUI 恢复 DeepSeek 官方 Base URL 和空 key；本次新增自定义条目保留，但本地 token 已通过 GUI 清空。只读存在性检查为三个 provider 均 `hasKey:false`；正式用户设置未改。保留新增条目避免隐式删除已有配置，已失效的本地标识也不再保存在候选 provider 中。

本例不覆盖官方直连凭据链、官方 host 自动别名和推理档位映射，也不证明供应商模型内部版本号、完整工程问答能力或 V4.1 全功能验收。截图上的推理选项不被倒推为请求参数。

## 尚未覆盖

- 当前源码新增的证据导航、异步隔离、复验生命周期、品牌/语言修正和 PDF 精确表页拆分，均需新候选包验收。
- 本候选未执行真实只读 HTTP 身份拒绝探针或原生 GUI 身份错误态；源码组件/协议测试不能写成本包通过。
- 语言×主题×尺寸全组合和完整键盘/a11y 尚未覆盖；typed 修改确认与执行审批的真实 GUI/模型回合仍待验收，基础问答成功不替代这些功能。
- 未进行真人专业签认、用户对最终安装界面的确认或本轮公开发布操作。

[机器摘要](acceptance-summary.json)与[文件摘要清单](file-manifest.json)明确这些边界。原始 SQLite/base64 基线、完整原生 AX、环境、配置、凭据及私有 feed 地址仍留在本地，不进入公开仓库。
