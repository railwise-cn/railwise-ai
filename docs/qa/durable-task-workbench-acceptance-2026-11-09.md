# 持续任务与品牌统一：实施及验收记录

本记录对应 `codex/durable-task-document-workbench`。完成情况以生产装配入口、故障回归和实际交付为依据；历史阶段的未完成项保留原始记录，当前精确包验收见文末。

## 已接入的生产路径

| 要求 | 实现入口与证据 |
| --- | --- |
| 根任务、隐藏执行、补充与状态查询 | `TaskCoordinator`、`TaskControlService`、聊天命令 IPC；生产 Runtime 集成测试验证状态查询不创建 Turn、新任务不取消原任务、暂停输入不唤醒 |
| 输入持久投递与确认 | SQLite delivery + 文件型会话；JSONL 消息 ID/哈希落盘后进入 delivered，匹配检查点事务后进入 consumed |
| fencing、回执、Shell、共享额度 | 每 attempt 不可变租约凭证，工具边界回执，进程启动指纹与组，根预算账本和容量管理器；测试失租、未知结果、PID 复用和并发预算 |
| 事件与上下文 | Flow nonce/event/outbox、Schedule occurrence 原子提交；固定 Flow 版本与幂等跨库投递；实际出站模型上下文投影与授权 spill 召回 |
| 子任务隔离 | 实际工具调用边界拒绝通用 write/edit/bash 和任意 MCP；仅保留父任务授权内的只读资料及受限候选工具，子任务独立暂存 |
| 文档审阅 | 来源 SHA、目标/候选版本、差异、接受/拒绝、幂等日志与历史；保留真实被替换 inode，迟到外部写入可恢复；不宣称跨应用原子 CAS |
| 章节依赖 | 来源到章节映射，过期章节展示；重新读取来源后产生新候选，未改章节保持字节，拒绝重叠/歧义章节和不完整来源更新 |
| 实时任务界面 | main/preload 聚合 SSE、持久全局水位、固定成员分页快照、共享状态、Flow 待办原 API、持久通知去重与详情入口 |
| 品牌与兼容 | publication manifest 驱动新制品名、更新元数据、官网数据和恢复；保留旧 feed、App ID、数据目录、IPC 和历史文件 |

## 真实模型与文件

显式测试脚本为 `scripts/run-task-delivery-live.mjs`。使用已配置 DeepSeek 官方提供商和固定合成资料，API 请求/实际响应模型均为 `deepseek-flash`。密钥只在本机内存使用，不进入报告或仓库。

2026-11-09 第三轮本机结果：

| 场景 | 样本 | 任务结果 | 实际文件核验 | 墙钟耗时 | 场景内人工介入 |
| --- | --- | --- | --- | --- | --- |
| 监测报告 | 1 | completed | Markdown、DOCX、PDF、确定性 SVG 均通过 | 72,327 ms | 0 |
| 投标技术文件 | 1 | completed | Markdown、DOCX、PDF 均通过 | 102,688 ms | 0 |
| 研究报告 | 1 | completed | 两个候选及各自 DOCX/PDF 均通过 | 126,534 ms | 0 |

共 47 次实际模型请求，提供商返回累计 716,833 tokens（含缓存输入；不等于未缓存计费 token）。未返回账单成本，记录为 null。以上只是 3 个合成样本，不作为与 0.5.4 对比的性能提升比例，也不代表工程专业审定。没有基线对照实测，不填改善百分比。

任务 SQLite 实测的模型/工具累计执行时间依次为 68,618/841 ms、99,540/767 ms、121,628/1,291 ms；排队分别为 16、12、13 ms，均无人工等待。工具回执成功/失败分别为 21/2、19/2、27/3，失败调用包含模型参数自纠正及重复分析被 revision 检查拒绝，不能描述为零错误运行。没有 `outcome_unknown` 回执；重复副作用的故障保证由明确操作键的恢复回归覆盖，本组三个样本不替代崩溃重放测试。

PDF 实际解析和首屏检查：监测 2 页、投标 5 页、研究最终稿 3 页；中文文本可读取，未发现替换字符。DOCX ZIP 结构可读取，表格分别为 1、4、3 个，默认作者为 RailWise AI。图表是独立成果；本组模型没有将其嵌入 DOCX，不能据此宣称本组验证了 DOCX 图片嵌入。

原始私有证据位于 `/private/tmp/railwise-next-live-delivery-20261109-r3/results.json`，同时保留实际会话、工具结果、来源及成果哈希。该轮源为未提交开发树，报告记录 HEAD、tracked diff SHA、编译 Runtime 入口 SHA 和导出桥 SHA；不能替代最终安装包验收。

前两轮失败未删除：第一轮暴露只读目录枚举误算为来源与合成字段类型错误，第二轮暴露独立测试 Electron 导出桥随最后隐藏窗口关闭而退出；已修复并在第三轮实际运行。后续新增的子任务执行限制、成果发现过滤及章节更新通过聚焦回归独立核验。

### 已提交生产源码复跑

第四轮使用提交 `8c7d2603df3f909245d0ee9a19742b59d13ae9c6`，tracked diff 为 SHA-256 空值；私有原始报告为 `/private/tmp/railwise-next-live-delivery-20261109-r4/results.json`。三任务均 completed、交付核验通过，未发现无效成果，分别用时 100,216、60,771、75,146 ms，场景内人工介入均为 0。44 次请求累计 880,237 tokens；账单成本未提供。监测有确定性 SVG、Markdown/DOCX/PDF，其他两组各有 Markdown/DOCX/PDF。

模型/工具累计执行时间依次为 95,972/1,383、58,741/545、71,867/474 ms；排队 18、14、13 ms，无人工等待。工具成功/失败回执依次为 27/0、13/1、20/1；没有 unknown 回执。PDF 分别为 3、2、2 页，中文与表格已检查；DOCX 默认作者正确。

第四轮研究稿因合成验收目标同时描述三类条件，额外加入无关监测与投标章节，文件通过不等于内容质量完全通过。因此单独收窄研究目标，在同一生产代码下再次实际执行研究样本：仅使用 source.md 的两条观察和适用限制，得到按事实、判断、不确定性组织的研究稿及真实 DOCX/PDF，58,813 ms、10 次请求，样本 completed/verified=true。原始证据保留于 `/private/tmp/railwise-next-live-delivery-20261109-research-r5/results.json`。该轮新加的单模板选择仍受脚本旧的“三样本”总计判断影响，原报告 overall passed=false，未改写原始结果；已修正脚本按实际模板数量及 error 判定，不能将这份单样本原报告称为整体通过。

## 兼容和回退

迁移及数据保留见 `docs/MIGRATION_DURABLE_TASK_WORKBENCH.zh-CN.md` 和 `docs/MIGRATION_RELEASE_IDENTITY.zh-CN.md`。迁移前使用 SQLite 一致性备份，旧数据不删除。`RAILWISE_TASK_SCHEDULING_DISABLED=1` 停止自动恢复和后台派发，任务记录、成果与普通聊天仍可用；显式执行仍保留 fencing 与回执校验。

## 最终发行验收状态

本地验证：应用全套 413 文件、4,082 测试通过（2 文件/3 测试跳过），最新任务 UI 聚焦 9 项通过；KUN 最终全套 238 文件、3,306 测试通过（2 文件/22 测试跳过）。类型检查、lint、OpenSpec 严格验证（13 项）、品牌扫描、文档依赖许可与生产构建通过，构建 freshness 检查覆盖 1,239 项输入。发行清单/门禁及 Windows 安装合同回归通过；本机无法执行的 Windows PowerShell 解析留给 Windows runner。

最终候选验收以实际安装结果为准。新官网路径的配置和校验代码已完成，尚未将下一版官网/Stable/Release 公开部署。历史 v0.5.4 资产不改名。

提交 8c7d2603 的 Quality CI run `42573343821` 三项均通过：OpenSpec/brand/lint/type/test/build、Windows path/spawn/persistence、Electron production smoke。包外证据校验器提交 d3f15bbe 的 Quality run `42576854263` 也通过。私有精确包 run `42573336374` 的构建已完成；公开发布、官网及 Stable 步骤未启用。

同一私有 run 的 Windows 实际安装验收已通过，原始制品 `exact-package-windows-install-42573336374` / ID `13655057552`。安装文件为 `RailWise-AI-0.5.5-win-x64.exe`，SHA-256 `aaeed49fff224341f68a472a7ab6f4be0c618f6421c8af200698a9d42fcd532a`，安装 ASAR SHA-256 `2626ae9ea30390f09083782fec2d9d926d879da4b1b15fc5fa4642c6802679aa`。PE 产品名、桌面/开始菜单快捷方式、卸载名均为 RailWise AI；NSIS GUID 保留 `0daef81e-c00a-5e19-aa76-e6b9a68e0938`。临时实例卸载成功，原/新 profile 探针哈希保持一致。Windows 未配置签名证书，installer/executable 原始 Authenticode 均为 NotSigned，不能表述为 Windows 签名通过。

发布校验器后续复核发现仍强制截图/独立 AI 审查和旧私有冻结。已按当前 AGENTS 改为 schema2 当前策略：截图/AI/完整矩阵可选，实际更新路径改变才要求一次真实 updater；精确包源、文件哈希、身份、签名、公证、CI/聚焦测试/构建与受影响包内 UI 仍检查。新 exact-build 来源绑定同仓库真实工作流和不可变制品；旧 schema1 兼容。仅明确列出的包外证据/测试/校验器变更可在同包后追加，任何 app 载荷变化仍要求新包。对应回归 485 通过、1 个非 Windows 解析跳过；没有重新构建或派发私有冻结。

不将私有 Actions 证据称为公开发行批准，不推进公开 tag、Release、官网或 Stable。

### 第一份精确包发现的问题与修正

同次构建 Apple Silicon DMG 为 `RailWise-AI-0.5.5-mac-arm64.dmg`，SHA-256 `81449c83b9b5e98dd12c8d9cdbe0d1be5b1a86d5da216bd479a3336d4f9856c6`。已私有安装，版本 0.5.5、App ID 与身份迁移文档中的历史兼容值一致、源码 8c7d2603、ASAR SHA-256 `9c05dcfd609b4ef6aab4c0f786f81cdbc421643185a89beabd09b9bfe31ff144` 均匹配。deep/strict codesign 与 stapler validate 成功；本机 Gatekeeper assessment 返回 Notarized Developer ID，但系统 assessments disabled，不能将本机结果表述为安全策略开启下的执行验证。Actions 原始 runner 的 Gatekeeper assessments enabled，目标 ZIP 预检及更新后签名检查均通过。

官方 0.5.4 → 该精确 0.5.5 的原生 Squirrel 回执 `native-updater.json` 为 passed，已实际下载、安装、重启并保留 nonce/profile。外层 `frozen-updater.json` 为 failed：更新后只读 `stapler validate` 请求 Apple CloudKit 连接中断（NSURLError -1005，退出码 68）。原始失败回执保留，未改写为 passed。外层后续详细工程数据、配置和再次重启读回尚未执行，不能声称通过。相同签名身份与资源封印的本机应用补充公证复核成功，仅作为独立信任证据，不替代未执行的详细数据检查。

在该精确包的中文、浅色、1280×840 内容区域中实际操作任务页，发现三个缺陷：任务分页的 pagination/filter/cursor 未进入 main IPC 允许合同；协调命令 POST `/v1/task-commands` 也被拒绝；模板任务在列表和详情展示完整执行提示词，且候选审阅缺三个翻译。候选来源/差异/接受操作本身已通过，目标正文和候选 SHA-256 相同。执行会话未出现在普通会话列表。此包不能标为中文 UI 验收通过。

整改补齐实际 preload→main 合同回归（含分页、普通聊天协调、候选重生成）；模板只将用户目标保存为可见 goal，Turn 仍使用完整执行指令；历史模板显示使用保守提取，不改写历史；补齐中英按钮并用真实字典检查任务动态标签。修正涉及应用载荷，必须用修正后的源码重新构建和检查精确包，不能沿用本次失败包作为最终验收。

整改本地验证：preload/main/真实中文 DOM/显示合同聚焦 117 项通过，生产模板装配及恢复 7 项通过，web/node 类型检查、lint、生产构建及 1,240 输入 freshness 通过。公证只读检查现对已观察的精确 CloudKit -1005/exit68 最多尝试 3 次，500/1,000 ms 间隔；保留每次失败，复核同一签名身份和资源封印后才重试，不重放更新器、不接受无效票据。该模块 12 项和现有 updater 57 项回归通过。

修正版提交 2f8330a9 的真实研究复跑整体 passed=true，39,939 ms、8 次 DeepSeek 请求、116,295 tokens（实际返回 deepseek-flash），Markdown/DOCX/PDF 均通过，场景内人工介入 0，成本仍为 null。原始报告 `/private/tmp/railwise-next-live-delivery-2f8330a9-research/results.json` 记录干净源码与实际文件哈希。该提交首轮 Quality 品牌检查因测试夹具及 QA 记录逐字保存的旧 App ID 被误判为公开名称而失败；将合成夹具改为示例 ID、记录引用兼容身份文档，品牌扫描规则未放宽。后续修正仅限不进安装包的测试、证据和来源校验器，继续复用同一次修正版精确构建。

修正版私有构建 run `42581502074` attempt 1 未产包：macOS 下载 Electron、Windows 真实 managed-tool 预检下载分别遇到上游 HTTP 504。已保留原始日志，仅通过 Actions rerun-failed 复用同源码及成功 sidecar，attempt 2 重跑失败构建和依赖验收；未重发新的冻结、未重放任何已执行 Squirrel 更新。

2f305dac 的 Quality run `42582161082` 三项全绿：应用 Linux 4,091 通过/9 跳过，KUN 3,306 通过/22 跳过，Windows 安全与 Electron production smoke 通过。修正版构建 attempt 2 仍在 GitHub Electron 下载阶段遇到 504，没有安装包或 updater 执行。发行工作流已采用 Quality 相同的 Electron 镜像；仍使用锁定 npm 包内的校验和，未启用远端校验和或跳过签名/公证。Electron及发行聚焦 31 项通过；后续必须验证新工作流实际生成的精确包。

### 当前源码的精确包验收（run 42588564428）

本节只记录提交 `47a9c932fb686761dfd2b89193f241fb38298cb9` 绑定的私有候选，不表示已创建公开 Release、tag、Stable 指针或官网部署。Release 工作流 run `42588564428` 成功，`productionTouched=false`、`publicReleasePerformed=false`。

macOS Apple Silicon 精确包为 `RailWise-AI-0.5.5-mac-arm64.dmg`，大小 `352483557` bytes，SHA-256 `1055ba1b5d49be9c0e297c4d17f0e0d0dd4a98021e1f1c55d8b79f3308080de7`。Actions runner 的冻结更新验收确认 0.5.4 基线和 0.5.5 目标均为 bundle ID `com.wangjiawei508.workgpt`、Developer ID `R35G7F4A9U`，签名和 stapled 公证票据通过；Gatekeeper assessments 已启用并返回 `accepted` / `source=Notarized Developer ID`。目标 ZIP 成员 `RailWise-AI-0.5.5-mac-arm64.zip` SHA-256 为 `8cabbd2e6017e429add620e1390ad92a8a6d9f4f4c0e3bedaa824738ffe3da8e`，安装后 `app.asar` SHA-256 为 `8cac28cc28f34cca1afc6cae151230d3aa8afa037c251425a942fcbb3cd67291`。macOS 制品外层 Actions artifact digest 没有做整包独立下载复核；已对选定 ZIP 成员执行 CRC、大小和 SHA-256 校验，不能把该限制表述为整包 digest 已验证。

Windows x64 精确安装验收通过，安装包名为 `RailWise-AI-0.5.5-win-x64.exe`，产品版本、PE 产品名、安装目录、桌面/开始菜单快捷方式和卸载项均为 `RailWise AI`，profile 哨兵在安装前后保持一致，安装后清理通过。Windows installer 与安装后的 executable 均为 `NotSigned`，当前没有配置 Authenticode 证书；这是已知发布风险，不能写成 Windows 签名通过。证据文件为 `windows-install-evidence/windows-install-smoke.json`。

真实 updater smoke 使用官方 v0.5.4 基线和本次精确包：`native-updater.json` 与 `frozen-updater.json` 均为 `status=passed`。流程实际完成发现更新、下载、安装、重启，目标版本为 0.5.5；用户数据回读保持，`verify-data.json` 与 `verify-restart-data.json` 通过。该结果绑定同一源码、制品和 run，旧 run 的 CloudKit 网络失败记录仍保留，不以本次结果覆盖历史证据。

### 当前精确包内任务工作台与中文 UI

在隔离 profile 的真实候选应用中，以中文、浅色、任务工作台路径完成生产入口验收：普通任务列表和详情只显示根任务及业务目标，Session/Worker/Thread/Turn 技术 ID 不出现在普通界面；成果、来源、验证状态和交付说明可见。状态查询通过 `coordinateTaskCommand(... intent: "status")` 返回本地 snapshot，未创建 Turn、未调用模型且任务 revision 不变；新任务不会取消既有任务，补充输入按任务归属送达，暂停后的输入只入队。聚合任务 SSE 从持久事件回放，未发现重复事件。候选文档真实审阅显示来源和正文差异，先外部修改目标文件时接受请求返回结构化版本冲突，重新比较后接受成功；冲突内容保留在 `.railwise-preserved` 文件，历史记录已生成。

以上是精确包的生产 UI/Runtime 操作结果，不等同于全语言、全主题或全窗口矩阵。原始安装、更新、身份和回执文件保存在 `/private/tmp/railwise-next-exact-42588564428`；本节不把私有候选证据当作公开发行批准。
