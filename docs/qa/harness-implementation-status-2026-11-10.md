# RailWise AI Harness 实施状态核对（截至 2026-11-11）

## 0.5.6 全量闭环实施与当前验收

本轮继续使用 `codex/harness-connector-closure`。已发布版本已核对为 0.5.5，本轮私有目标版本采用 0.5.6，同时保留计划要求的正式 0.5.4 升级兼容验收。原工作目录的未提交内容保持独立。本页下方旧版本记录保留各自源码、证据和当时缺口。

| 事项 | 本轮生产实现 | 当前证据与剩余验收 |
| --- | --- | --- |
| 任务权限入口与范围 | 任务详情和阻断卡挂载权限面板。读写路径、网络 origin、Provider、目标、15 分钟及单次授权进入不可变 Grant。子任务收紧、重定向和真实路径复核已接入 | 聚焦服务和界面回归通过。最终包操作继续验收 |
| Flow 与副作用验收 | 业务 Agent 和文档节点统一经 TaskCoordinator，持久 Flow/task/outbox 关联。可信工具注册表驱动 effect 范围，文件和外部动作共同验收 | 真实 Runtime、SQLite、HTTP 协议回放通过。未知 MCP 写入停止自动重试 |
| 钉钉及飞书交付 | DWS 转交、固定 Lark 1.0.100、邮件、消息、云盘上传、账号及后端绑定、原动作只读核验已接入。IM 回复账本单独关联任务 | 自动回归通过。真实平台写入仍须在应用内明确确认具体测试目标 |
| SSE 与迁移 | 实际 HTTP SSE 断线回放、快照和去重，四类目录一致性 SQLite 备份及插件/MCP/Skill/凭据引用保留 | 真实 SQLite/WAL 与回放回归通过。最终包及安全存储跨升级继续验收 |
| 一键升级 | 普通与写作侧栏共享左下角控件，下载、保存、暂停派发、安全停止和安装串联。查询失败拒绝继续安装，已下载制品支持离线重试 | 新增真实审批等待、退出及重启回归。修复等待审批无法停止、退出误判失败及旧 prepared 操作结果不明的恢复路径 |
| 完整帮助 | 原 13 章手册为单一正文源，关联文档和图片随包，支持中文搜索、目录和内部跳转。三个帮助入口移除个人主页 | 内容、菜单和类型回归通过，最终包离线阅读继续验收 |
| 工程资源与目录 | 技能、插件、连接器顺序和默认技能已接入。四项可选工程 Skill、高德及只读 Zotero 配置、原工具精选集合已实现 | 本地样例及服务回归通过。依赖镜像真实冷缓存安装、高德 Key 和 Zotero 本机业务检查继续验收 |
| GitHub 0.5.5 连接错误 | 根据用户截图补充整改。旧入口在保存时尝试 OAuth 注册，缺少宿主 Client ID。专属连接器配置提供官方支持的令牌认证和实际 MCP 检测 | 88 项聚焦回归及 Node/Web 类型检查通过。实际官方只读 MCP 初始化与工具发现通过，返回 29 项工具，未调用业务工具；最终包界面继续验收。旧 OAuth 配置及凭据引用保留 |
| 真实模型三模板 | `04c85d07` 使用本机已配置官方 DeepSeek，真实返回 `deepseek-flash`，通过生产协调器、工具和 Electron 导出生成三组固定合成报告 | 3 项任务完成，40 次 HTTP 请求，模型返回累计 601149 token，实际计费未返回。首轮发现 DOCX SVG 缺图和 PDF 续页边距缺陷，已由 `3a55dab8` 修复。三组原候选通过真实 Electron 重新导出，六页 PDF 与 DOCX 内嵌图检查通过；属于固定合成资料验收 |
| 精确包及升级 | 增加同一 Windows 已安装 EXE 的中文页签、离线帮助与更新状态验收。沿用同轮 macOS 正式 0.5.4 到目标精确包的真实 updater smoke | 尚待最终源码构建和实际执行。公开发行作为后续独立动作 |

已完成的自动验证包括 `1d5a8ada` 干净依赖生产构建与桌面全量 4356 项通过、5 项跳过，以及 `37602800` Runtime 全量 3650 项通过、22 项跳过。后续生产变更需使用对应源码再次验证，旧结果仅覆盖各自版本。

`3a55dab8` 干净依赖生产构建、桌面全量 4378 项通过、6 项跳过，ESLint 零错误。三组真实任务的持久执行计时分别为 93073、55113、54130 毫秒，排队分别为 32、21、23 毫秒，人工等待均为零。计时来源为实际工作 span 和状态 span，原始模型运行及修复后的导出证据分别保留在私有 `live-delivery-04c85d07/results.json` 与 `reexport-evidence.json`。

国内依赖已完成 31 项固定资源上架及公司域名 SHA-256 核验，共 572969337 字节。复用原下载进度完成恢复后，真实冷缓存安装使用公司源完成 7 次下载，共 31.42 秒，禁止上游回退。实际 uv 0.12.3、Python 3.12.12、Lark 1.0.100、OfficeCLI 1.0.160、34 项配套技能与许可证核验通过。相关运行 [42956592229](https://github.com/railwise-cn/railwise-ai/actions/runs/42956592229) 成功。应用版本发布、Stable 指针及官网版本数据尚未推进。

### 0.5.6 精确包增量验收

- `8601c2b3` 干净依赖生产构建通过，Desktop 4385 项通过、7 项跳过，Runtime 3667 项通过、22 项跳过。`8133ea26` 两条 Quality 均为 3/3 jobs 成功。相应结果分别覆盖各自源码。[PR Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/42960462329) · [Push Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/42960456846)
- `8601c2b3` macOS arm64 包在本机校验版本 0.5.6、bundle `com.wangjiawei508.workgpt`、Team `R35G7F4A9U`、源码、ASAR、签名、公证及 Gatekeeper。只修改本地应用目录名以选取隔离验收 profile，签名内容与 bundle 身份保持原包。DMG SHA-256 `e828e3d2d538e1b3f5fcee0e559118e375b35f923cf6acded87c524e2a4972d7`，ASAR `6eb808cb2ac674bbeb74b179637f4676d839ca2a6764051632ff9cd6c729b60f`。
- 该 macOS 包中文深色实际检查通过页签顺序及默认技能、AutoCAD 两条目的搜索和详情、GitHub 专属配置页、13 章手册、中文搜索和章节跳转、随包历史图片。钉钉保留账号后的诊断查询返回 0 条记录，记录为成功的只读响应。
- 正式 0.5.4 到 `8601c2b3` 精确 0.5.6 包的真实 updater smoke 通过。首次及再次重启后，paused/waiting_user 各 1 项任务、2 条未消费输入、1 项人工待答、2 段会话历史、1 份候选草稿和基线均一致，插件、MCP、Skill、凭据引用保留。该项为中间源码包证据，后续产品修复继续验收。[原运行](https://github.com/railwise-cn/railwise-ai/actions/runs/42955599584)
- `8133ea26` Windows 精确包安装后，使用仅改变测试脚本的 `93e33f6b` 完成中文深色 1024×728 的 10 项实际 UI 检查，帮助搜索正确定位第 12 章。卸载、注册表和快捷方式清理、两个资料保留探针、正常退出、ASAR 未变化均通过。安装器和应用 EXE 均为 `NotSigned`，签名配置仍缺失。安装包 SHA-256 `9d8d8ca14996a1cde094e1051ed3f4b2b6f5623ab49e75cf8229776dcaacdbf8`，ASAR `e40969dace567ca341f9ddf145148fb37c65bfb4bcb16ff12b2f5c992ed214a8`。[实际验收](https://github.com/railwise-cn/railwise-ai/actions/runs/42963745083)
- Zotero 0.17.0 经真实安装入口完成固定依赖安装，实际 MCP 启动发现 31 项原始工具，白名单开放 10 项只读工具。当前缺少本机用户文献库业务读取证据。
- AutoCAD DWG 重绘和图片转 CAD 两项已加入随包技能目录，固定源码 `ed182ec5966caaaf1d82d6ad4015435a27a8a909`。上游未声明许可证，采用外部来源入口，保留平台、Python/AutoCAD 依赖、示例、输出和覆盖/重启范围说明。当前没有分发安装和 CAD 执行验收。

### 实包发现并继续整改的缺陷

| 实际场景 | 根因及修复方向 | 当前状态 |
| --- | --- | --- |
| 查询当前未完成钉钉待办 | 全句“完成”匹配把状态筛选误认成写操作。实际列表回执已验证，Task 却要求具体写目标。区分查询状态与独立执行动作，并允许符合条件的旧任务通过正常继续修正验收合同 | 112 项聚焦回归及类型检查通过，含生产协调器、真实 HTTP 模型协议、合成 DWS 子进程、SQLite 及旧任务同 ID 恢复；真实平台重验待补 |
| 飞书初次连接 | 固定 CLI 1.0.100 的 `config show` 默认输出 JSON，`--json` 已不是合法参数，导致扫码前失败 | 修复四处调用，52 项聚焦回归通过；真实冷缓存生产登录入口返回缺应用配置，并成功取得官方首次配置授权页后取消，33.75 秒通过 |
| 手册 4.1 流程图 | 1552px 自然宽度缩放到 2000 时，浮点舍入产生 2001px，触发内部尺寸上限 | Mermaid 和被动 SVG 两入口修复通过 20 项回归及真实 Electron 渲染，三张流程图和 1552px SVG 均成功；精确补包待验 |
| 飞书 IM 正文与幂等键 | 官方 1.0.100 的 --text 解释 @file/stdin，幂等键最多 50 字符。改为结构化字面量正文及 50 字符确定性键 | 50 项回归、类型检查及固定 CLI 纯参数契约检查通过，未执行业务写入 |

以上新增修复须进入新精确包。原 `8601c2b3`、`8133ea26` 的包结果保留其已验证范围。

### 668d 真实原任务与后续界面收尾

`668d4567` 精确 macOS 包通过本机签名、公证和 Gatekeeper 核验。使用正常任务界面继续先前被误判的原任务，任务 ID 保持一致，新增一次真实钉钉查询返回 0 条且 `hasMore=false`，两条已验证只读回执保留，任务进入 `completed`、三个节点完成。实际模型为 `deepseek-flash`，三次请求均返回 200，累计 47486 token。另一个独立生产 Runtime 的只读回归也通过，两次请求累计 4427 token，0 审批、0 业务写入。

`668d4567` 与 `e1cabad6` 两个 Windows 精确包均通过安装、10 项中文界面、正常退出、ASAR 不变及资料保留检查。`e1cabad6` 的实际第 12 章截图已呈现“软件更新”标签。两个包的安装器及 EXE 继续记录为 `NotSigned`。

`668d4567` 正式 0.5.4 到精确 0.5.6 包的真实 updater smoke 通过，两轮独立目标进程重开后，任务、输入、待答、草稿及基线、会话历史和配置引用均保留。目标及安装 ASAR 同为 `76c86a38bbaba1fd443c1fd87b24c4ce929e0c41c1acad00aaf6655c980516b3`。[实际升级运行](https://github.com/railwise-cn/railwise-ai/actions/runs/42965369652)

GitHub 官方只读 MCP 已实际读取本任务仓库 `main/README.md`，20867 字节与独立官方 API 返回逐字节一致，SHA-256 为 `f00e1f843b937238550b20825fde88f3128953a009269841ade491be20fd0ba8`。凭据只在内存使用，用户连接配置和任务启用状态保持原状。

后续实际界面检查补齐以下修复。

- 手册流程图已恢复渲染，但七节点横排在窄正文栏中文字过小。`4c41778d` 保留全部节点和顺序，改为竖向。真实 Electron 365px 栏宽检查中，标签约 13.74px，七节点与箭头均完整可读。
- 已完成任务的权限面板继续显示停止执行提示。`4c41778d` 对终态保留权限摘要和历史，收起新增授权操作；53 项相关回归通过。该源码生产构建及类型检查通过，Desktop 4400 项通过、7 项跳过。KUN 源码与 `668d4567` 一致，保留 3705 项通过、22 项跳过的对应记录。
- 飞书首次配置的官方二维码已通过精确包实际显示，并等待用户操作至真实超时。本轮没有完成平台授权。到期后界面仍显示旧二维码，已补首次配置独立到期处理，隐藏失效入口并恢复重新配置按钮，旧计时器不能覆盖新流程或已配置结果。26 项界面及配置流程回归通过，精确补包继续验证。

飞书本轮实际应用配置、用户授权及重启身份诊断已通过。两个平台明确测试目标的写入、高德 Key、Zotero 本机文献库及代表性历史 Keychain 凭据样本仍需对应用户环境。AutoCAD 已接通固定上游安装，图纸重绘仍待对应平台与任务环境核验。公开应用发行仍保留为独立动作。


### 0a1ad 精确包与 AutoCAD 安装增量

`0a1ad0f008ddfee66e7d3c2e7de080fd5c4331e9` 干净生产构建及类型检查通过，Desktop 4404 项通过、7 项跳过；KUN 树与 `668d4567` 一致，3705 项通过、22 项跳过。两条 Quality 与私有发行验收运行均通过。[私有验收运行](https://github.com/railwise-cn/railwise-ai/actions/runs/42973966217)

该源码 macOS arm64 精确包已在本机完成签名、公证、Gatekeeper、版本、公开 bundle 身份及 ASAR 核对。DMG SHA-256 为 `29eaec33b75273fae81e1da72a13762cf14245d87fbcee4432ea12e2dc75c50e`，ASAR 为 `f6a5ccd6f6c6713b3e5049310d77fe678855d626c33e2b5148a8c7ec9eb16b8d`。下载校验覆盖所选 DMG 的 ZIP CRC、更新元数据 SHA-512 及本地 SHA-256，完整远端 artifact ZIP 未下载核验。

中文深色本机检查确认终态权限面板仅保留摘要与历史、13 章离线手册、中文搜索及标题跳转、七节点竖向流程图、帮助菜单移除个人主页、页签顺序和无更新时控件隐藏。真实聊天输入“现在做到哪了”返回本地快照，前后持久 Turn、模型 span、工具回执及任务数均未增加。Windows 同源精确包的安装、10 项中文界面、退出、卸载及资料保留均通过，安装器和 EXE 为 `NotSigned`。

正式 0.5.4 到该精确 0.5.6 包的真实更新通过，两次独立目标重启后的任务、输入、问题、草稿、基线、历史与配置引用均保持，安装 ASAR 与目标包完全一致。配置引用属于合成验收资料，真实历史 Keychain 样本仍待核验。

AutoCAD 两项原先仅显示来源入口，这项额外限制已在后续源码中纠正。新流程使用用户主动的上游安装，固定作者、仓库、commit、子目录及 SHA-256，保留 `license: null`。真实生产服务冷安装两项成功，18 个上游文件逐字节一致，13 个脚本及参考引用完整，正式 Skill 索引发现两项；安装期间脚本执行为零。105 项后端相关测试与 37 项界面/helper 测试通过，类型检查通过。新的精确包与安装界面继续验收，以上 `0a1ad0f0` 包不包含此安装变更。


### 飞书真实账号与空待办回归

用户在 `0a1ad0f0` 精确包中完成官方应用配置及用户授权，账号与所需权限核验成功，重启后身份保持。正常聊天入口的首次只读任务实际调用官方服务，暴露 CLI 1.0.100 空结果返回 `items: null` 的兼容缺陷。锁定版本源码与真实响应一致，`ok: true`、`has_more: false`、空 `page_token` 同时成立，Provider 原先强制要求数组。

本轮仅将上述完整成功空页归一为空数组，异常或缺失字段继续失败。使用实际生产 Provider、默认 CLI runner、当前账号和仅含 `lark_task_list`/`task:task:read` 的 Grant 重验通过，返回零条结果、已验证读取证据、匹配的账号指纹及 `lark-cli` 后端。原任务保留三个旧失败回执，待最终包从正常界面继续同一任务。

同时修复当前执行已有外部失败回执时的任务等待原因，显示经过格式限制的错误码和回执入口，旧执行或未注册工具的失败不能覆盖本轮状态。配置转入用户授权时同步更新提示，消除要求点击已禁用登录按钮的旧文案。组件 11 项、Provider 33 项和任务控制器 53 项回归通过。真实业务写入为零，平台授权及只读服务验收与后续写操作验收分别记录。


### 用户确认后的两平台写入验收

用户明确允许在当前飞书和钉钉账号下各创建一个“RailWise 验收”测试待办，并通过 RailWise 完成。两项均已由锁定官方 CLI 创建一次，负责人为当前账号。创建前保存操作账本，后续仅使用实际返回的稳定 ID。

`82720d71` 精确 macOS 包通过普通聊天发起飞书完成任务，核对指定待办详情，持久确认单一目标范围，再批准实际完成操作。平台回读成功，任务进入 `completed`、3/3 节点。创建和完成分别记录，既有待办保持原状。

钉钉创建后的真实详情响应含 `success:true`、`errorCode:null`，原解析器误判为业务失败。锁定 DWS 1.0.67 源码同样将 null 错误码视为无错误，本轮仅在明确成功响应中兼容该值，失败及非零错误码仍拒绝。另为 DWS 工具显式声明空的 `requiredScopes`，避免目标范围确认错误继承 OpenAPI 的 Todo.Read/Todo.Write。DWS 执行时仍校验账号、后端、工具和目标授权，并由官方接口判断实际平台权限。

33 项相关回归及 KUN 类型检查通过，修复后的真实生产 Provider 只读核验该钉钉待办成功。钉钉完成操作须通过包含这两项修复的新精确包继续验证，当前测试待办仍未完成。旧 `82720d71` 包的既有证据保留各自适用范围。


### e1610d91 两平台真实待办写入验收完成

私有精确包源码为 `e1610d912636d21814b670f651231140c3de7329`，版本 0.5.6。Desktop 4411 项通过、8 项跳过，KUN 3718 项通过、22 项跳过，类型检查、生产构建及两条 Quality 通过。该私有构建、Windows 安装/UI 和真实 updater smoke 均成功。[精确包验收运行](https://github.com/railwise-cn/railwise-ai/actions/runs/43005405279)

用户批准的飞书、钉钉“RailWise 验收”待办各创建一次。创建使用已核验账号及锁定官方 CLI，并预先写入操作账本。两次完成均通过 RailWise 正常聊天入口、持久目标范围确认、实际操作确认、真实 Provider 和远端读回完成。飞书完成操作发生于 `82720d71` 包，钉钉完成操作发生于包含 DWS 修复的 `e1610d91` 包。两个任务均为 `completed`、3/3 节点，每个平台只有一条成功完成回执，账号、后端、目标、授权与请求摘要匹配。独立只读复核确认平台最终状态，当前精确包再次启动后仍可查看两个已完成任务。

本次共四次业务写入，分别为两个测试待办的创建和完成。重复完成操作为零，测试记录保留在平台。飞书完成时间为北京时间 18:36:19，钉钉完成时间为北京时间 19:34:44.208。模型实际均返回 `deepseek-flash`，飞书 8 次请求、121038 token，钉钉 8 次请求、105797 token，实际费用未返回。飞书一次多余只读查询被抑制后正常完成，未产生重复写入。

macOS arm64 DMG SHA-256 为 `a602e64786884c99106b8397e6d2939b216ee1d0b732358b19440b9fd56ff586`，ASAR 为 `18d206197d214a06e55db4125a29605cabfc2f539ff67fa6a22289a58b857729`。版本、源码、正式 bundle 身份、签名、公证和 Gatekeeper 均已核对。正式 0.5.4 到该精确包的真实升级及两次目标重启通过，任务、输入、问题、草稿和基线、历史消息及配置引用保持一致。

Windows 同源包安装、10 项中文界面、正常退出、卸载清理及资料保留通过。安装器和应用 EXE 均为 `NotSigned`。其安装包 SHA-256 为 `682109a8792a7f30a6feab10450f17b2d84887b656e7a9e3df7a713762df829a`。

本节为包验收后的文档记录。对应产品制品继续绑定 `e1610d91`，后续文档提交单独记录，产品代码未因此改变。公开发行仍为独立动作。审批同意、拒绝、转交和邮件、消息、上传的真实业务验收继续等待各自明确目标与授权，高德、本机 Zotero、历史 Keychain 样本及 Windows 签名环境仍按原验收边界登记。


## 历史阶段记录

本记录对照用户《Harness 可信执行与连接器闭环整改计划》阶段 A—E，核对生产入口、测试覆盖和验收缺口。首包源码为 `72e4bf9b4ca890152f7a0c7f30d9fb9e223b7455`，随后修复到 `7596843628f96901634198f54cb74ec28099faa4`；当前工作树进一步实现技能与连接器独立页签、飞书首次配置与身份绑定、钉钉官方 DWS。旧源码的测试和安装包结果仅证明各自版本，不能覆盖后续改动。最新源码与精确包证据见本页末尾的连接器工作台增量记录。这些改动尚未发布。

**当前 `0a94e6a7` 精确 macOS 候选包已通过安装身份、签名、公证及钉钉入口实测。** “测试待办读取”两次通过界面返回 1 条，“打开本机钉钉”成功唤起已安装客户端，“重新授权 / 切换账号”显示二维码、官方链接与复制入口。Chrome 已加载官方设备授权及身份认证页面，扫码页可见。验收取消了此次新授权，随后原账号读取再次成功。完整任务执行、审批写入、当前候选的飞书账号与中文 Windows 实机验收仍待完成，详见文末精确包记录。

## 状态口径

| 标记 | 含义 |
| --- | --- |
| 已接线 | 源码中可以从正式生产入口到达实现；不等于真实账户或精确包验收通过 |
| 部分接线 | 已有可运行路径，但没有覆盖原计划的全部入口、权限或界面细节 |
| 待验收 | 需真实外部账户、平台权限、实际安装包或目标操作系统证据 |
| 未宣称 | 代码或测试没有提供相应保证，不能以文字推断为已完成 |

下列“测试覆盖”列说明相应断言所在位置。实际执行范围与结果见文末；未运行的环境、真实账户和实机故障场景继续标为待验收。

## A：Harness 合同和回归保护

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| `TaskIntent`、规则优先识别 | `kun/src/contracts/harness.ts`、`services/external-task-capability.ts`、`services/task-coordinator.ts` 区分知识问答、外部请求、连接请求和双平台歧义；飞书/Feishu 归一为独立的 `lark` Provider，与钉钉分开 | `external-task-capability.test.ts`、`task-coordinator.test.ts`、`server/routes/external-turn-routing.test.ts` | 已接线。不是任意自然语言的无误分类保证；规则之外的归属判断仍受现有协调器约束 |
| 在创建 Turn 前能力预检 | `contextual-external-task-preflight.ts` 在 Provider 诊断后核对持久执行 Thread、工作区信任、Agent 白名单和真实 `listTools`；`runtime-factory.ts` 正式装配；缺能力请求持久为等待任务 | `tests/harness-preflight-context.test.ts`、`contextual-external-task-preflight.test.ts`、`external-turn-routing.test.ts` 覆盖无 Turn、禁止策略、Agent 范围、不可读信任记录和旧 Turn 入口 | 已接线。`networkState: unknown` 不代表已联网成功；预检不额外发业务请求来冒充网络验证 |
| 阻断不调用 Bash、不生成虚构 `dws` | 系统提示、沙箱解析、连接器预检和类型化 Provider 分层限制；钉钉缺配置不会转成飞书或命令教程 | `sandbox-policy.test.ts`、`lark-cli-tool-provider.test.ts`、`dingtalk-tool-provider.test.ts`、连接器 Runtime 测试 | 已接线。`682f4b17` 原始钉钉请求保持等待，未调用模型或生成执行命令；真实授权后业务另验收 |
| `ExecutionGrant` 写入当前执行 | `contracts/permissions.ts`、`loop/agent-loop.ts`、`contracts/turns.ts` 和执行记录保存服务端 Grant；工具边界再次核验版本、范围和有效期 | `sandbox-policy.test.ts`、`explicit-approval.test.ts`、权限与生产预检集成测试 | 已接线。Grant 是服务端确定的当前 Turn 权限，客户端设置本身不是执行授权 |
| 持久 `OperationReceipt`、`ResultEvidence`、`effect` 验收 | `contracts/tasks.ts` 复用旧持久回执结构；`prepared/running` 对应计划的请求准备/已开始语义，保留兼容状态名；`external-effect-evidence.ts` 校验 Provider、操作、目标、当前任务执行和真实核验数据 | `external-effect-evidence.test.ts`、`external-effect-recovery.test.ts`、`tests/task-retry-ledger.test.ts` | 已接线。模型文本、假工具结果、其他任务回执或一项成功不能满足完整 effect 合同 |
| 动态真实工具目录、旧解析入口保护 | `local-tool-host.ts`、`sandbox-policy.ts`、`agent-loop.ts` 按 Grant、沙箱、Agent 和 Provider 过滤；记录目录指纹及变化事件；普通 `workspace-write/read-only` 不广告 Bash | `capability-registry.test.ts`、`sandbox-policy.test.ts`、`tests/harness-connector-runtime.test.ts` | 已接线。尚需用最终模型请求/精确包确认实际展示的工具目录 |
| 解释文本不能误标完成 | `task-controller.ts` 和 `external-effect-evidence.ts` 将“有最终回复”和“目标已执行并核验”分开；宽泛处理任务先确认有限集合 | `external-effect-evidence.test.ts`、`external-effect-scope-tool-provider.test.ts` 覆盖无集合、错目标、缺回执、未知结果和未批准 | 已接线；真实案例验收待补 |

补充闭合的旁路：`flow/runtime-adapters.ts` 现在只允许通用 HTTP 的 GET/HEAD；钉钉、飞书/Lark 官方域连读取也必须经过各自 Provider。写方法、method-override 和平台 URL 在 fetch 前拒绝；禁止自动跟随重定向。`flow/execution-policy.ts` 产生 `external_effect_requires_typed_provider`，Executor 不重试，也不让旧 continue/error-edge 策略把权限阻断变为成功。`flow/runtime-adapters.test.ts` 覆盖零 fetch、一次尝试、正常 GET/HEAD 和原 Flow/版本/定时状态保留。迁移说明见 [可信执行说明](../harness-trusted-execution.md#flow-http-节点兼容迁移)。

## B：权限和授权闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| 工作区信任接入 Runtime | 主进程 `WorkspaceTrustService`、Runtime `services/workspace-trust-reader.ts` 与 AgentLoop Grant 创建/再次核验连接；不因用户选中目录就授予写权限 | `workspace-trust-reader.test.ts`、主进程 `workspace-trust-service.test.ts`、`harness-preflight-context.test.ts` | 已接线。真实旧资料/路径组合迁移尚待验收 |
| 最终权限取交集 | 工作区/Agent 信任、沙箱、工具和 MCP 白名单、Provider、路径/网络/scopes/精确动作目标共同限制；子任务收紧父范围 | `sandbox-policy.test.ts`、`harness-connector-runtime.test.ts`、Provider 精确目标检查 | 已接线。不是 OS 级全能力沙箱声明 |
| 授权卡可解决实际阻断 | `CapabilityRequiredCard.tsx` 提供安装、诊断、Lark 登录、设置、工作区选择、拒绝和重新预检/继续原任务；任务待办复用同一卡片 | `CapabilityRequiredCard.test.ts`、`TaskWorkspaceView.dom.test.ts` | 已接线。已覆盖特定连接器/策略路径，不宣称所有网络、任意路径和错误都已拥有独立的一键修复 |
| 有限期任务权限及版本检查 | `services/task-permission-service.ts`、`server/routes/tasks.ts`、preload 和 `TaskPermissionPanel.tsx` 允许显式审阅后，把当前独立任务的 `never` 调整为有限期 `on-request`；不改变发起聊天或全局信任；修改 Agent 后需重新核对 | `task-permission-service.test.ts`、`task-permissions.test.ts` | 部分接线。服务与 IPC 已实现，`TaskPermissionPanel` 仅有定义及 DOM 测试，尚无生产页面引用；用户侧限时任务授权入口仍缺失。任意路径/网络/Provider 授权继续待实现 |
| 一次主机命令授权 | `scoped-host-shell-tool-provider.ts` 仅给非连接器任务有限入口；审批绑定完整命令哈希、任务、Turn、租约、Grant、版本和期限；复用已有 Shell Adapter | `scoped-host-shell-tool-provider.test.ts`、`task-controller-host-shell.test.ts`、`tests/host-shell-runtime.test.ts` | 已接线。普通 Bash 继续隐藏；连接器 effect 和子 Agent 不可用此入口代理平台操作 |
| Shell 进程身份和未知结果 | 既有持久 Shell 会话保留 PID/指纹/输出；一次授权只能派发原命令，原会话可轮询/受限停止，不能写 stdin 或借旧授权执行新命令 | host-shell 测试覆盖拒绝、假审批、失效、失租、未知结果不重放和会话边界 | 已接线。跨平台 PID/进程组和崩溃实机验收待补 |
| 双 Runtime、迟到提交 | 执行 attempt/fencing、当前 Grant 及权限版本、实际派发前的校验共同阻止旧执行重新用新授权；未知操作阻止“取消再重试”换账本绕过 | `task-controller.test.ts`、`task-permission-service.test.ts`、`task-retry-ledger.test.ts`、`external-operation-verification.test.ts` | 已有针对性回归；不等于已完成双实机 Runtime 长时验收 |
| 不同阻断有不同代码 | 沙箱、路径、网络、scope、连接器缺失、审批拒绝、授权失效分别返回代码；UI 展示原因及可用范围 | 预检、沙箱、Provider、权限服务及卡片测试 | 已接线。当前生产 UI 在预检阻断卡显示部分权限；权限审阅面板尚未挂载，每个 Turn 执行前的完整权限总览仍待实现 |

计划中“授权一次任意工作区路径/网络范围”的通用卡片尚不能由当前有限任务审批和一次命令授权推断为全部交付。现有实现应按实际按钮和服务能力描述；需要扩大到新的路径或外部目标时继续使用明确的配置/范围审阅，不能暗中放宽 Grant。

## C：连接器执行闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| 启动诊断 Lark CLI | `src/main/managed-runtime-process.ts` 启动时诊断受管理 CLI，保存可信状态；`services/managed-tool-service.ts` 区分未安装/未登录/有效身份/错误；Runtime `managed-lark-runtime.ts` 读取状态 | 主进程 `managed-runtime-process.test.ts`、`managed-tool-service.test.ts`、`harness-connector-runtime.test.ts` | 已接线。不能仅凭 CLI 退出码 0 判定用户已授权 |
| 受控安装、设备登录和热刷新 | 安装、设备登录与回调由主进程管理；验证官方 HTTPS 登录域；凭据/设备流程留在主进程；IPC 更新后请求 Runtime refresh；卡片需再次预检再继续原任务 | `managed-tool-service.test.ts`、`register-app-ipc-handlers.test.ts`、`lark-connector-refresh.test.ts`、卡片测试 | 已接线；真实 CLI 下载、真实用户登录和 Scope 授予待验收，尤其国内网络环境 |
| Lark 待办/审批工具 | `lark-cli-tool-provider.ts` 注册任务 list/detail/complete、审批 list/detail/approve/reject；仅传类型化参数和固定 CLI 协议，要求诊断身份、品牌和实际用户 scopes | Provider 测试覆盖工具过滤、错误回包、确认、目标回读和回执 | 已接线。协议核对基于固定上游版本，见 [Lark 说明](harness-lark-provider.md)；不是已运行真实审批的证据 |
| 钉钉官方连接器 | 官方 DWS 受管理安装及设备授权作为主路径，类型化命令绑定精确账号；原 `connectors/dingtalk-auth.ts`、`managed-dingtalk-runtime.ts`、`dingtalk-tool-provider.ts` 和企业应用设置保留高级兼容，个人与企业授权继续分开 | `dingtalk-auth.test.ts`、`managed-dingtalk-runtime.test.ts`、Provider 和设置卡片测试 | 已接线；`0a94e6a7` 精确包的待办只读检查、重新授权页面及本机客户端入口已实测通过。企业审批和写入仍待验收 |
| 写操作确认和有限目标集 | `external-effect-scope-tool-provider.ts` 先审阅完整有限 Provider/动作/目标集合；Provider 每次写前检查当前范围和显式批准，执行前持久记录批准证明 | scope Provider、Lark、钉钉与 evidence 测试 | 已接线；实际平台写操作需要用户指定测试目标，不能自动用真实业务审批做试验 |
| 成功核验、幂等和未知结果 | 工具边界持久回执；Provider 对目标回读；`external-operation-verification.ts` 用只读工具核验未知操作，原未知记录保留；不会自动重放写入或自动恢复任务 | `external-effect-recovery.test.ts`、`external-operation-verification.test.ts`、`task-retry-ledger.test.ts` | 已接线。平台没有返回操作 ID 时不伪造；使用实际可获得的目标状态及哈希证据 |
| 不通过 Bash/HTTP 代替平台 | 平台权限只给类型化 Provider；普通聊天不注册平台写入，子任务不能自行扩大权限；Flow 通用 HTTP 旁路已阻断 | host-shell、connector-runtime、Flow runtime-adapter 测试 | 已接线。现有 Flow 通用 HTTP/Agent 节点没有直接替代任务授权账本的外部写入入口，旧写节点需按迁移说明处理 |

DWS 已在 `0a94e6a7` 精确包通过当前账号的待办只读检查和授权入口实测。完整任务执行、企业审批及写入继续待验收。飞书/Lark 当前候选包的真实账户验收另行记录。

## D：任务和界面闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| `capability_required` 持久待办 | TaskCoordinator 保存原请求、等待任务和卡片 payload；聊天 outbox 与任务中心显示同一阻断；卡片继续原任务，避免跳入隐藏执行聊天 | `task-coordinator.test.ts`、`external-turn-routing.test.ts`、卡片与任务 DOM 测试 | 已接线；`682f4b17` 中文实测等待卡、连接检查和重启恢复原文通过，授权后继续原任务尚未验收 |
| 任务状态、回执和核验证据 | `TaskWorkspaceView.tsx`、`TaskExecutionEvidence.tsx` 展示平台、动作、目标、成功/失败/未知回执和证据；未知结果提供只读核验及配置入口；内部执行 ID 不在普通详情中展开 | `task-operation-receipts.test.ts`、`TaskWorkspaceView.dom.test.ts` | 已接线；仅 UI mock/DOM 断言不能代表实际包视觉和全部操作可用 |
| 状态询问/补充/新任务/暂停 | 协调器在 Turn 前路由；状态本地读取，补充持久入队，新任务独立执行，暂停期间输入不自行唤醒；IM/Schedule 已经过协调入口 | Coordinator、任务控制、schedule-runtime 和 external-turn-routing 测试 | 已接线；真实模型跨回合交互待验收 |
| SSE、恢复和通知 | `task-live-store.ts` 共享一个状态流；main/preload 使用现有 SSE；按序号去重、断线有界退避并补读；持久待办为权威状态，OS 通知失败不变更任务 | `task-live-store.test.ts`、已有 SSE/API 合同与任务事件测试 | 已接线。本实现采用共享流及退避刷新，没有把“2.5 秒全量轮询”当作正常连接策略；端到端断网实机回放待补 |
| 导航 capability gating | `WorkspaceSecondaryNavigation.tsx` 从 Runtime manifest 读取 Schedule/Flow/Design 的 enabled/available/status；默认隐藏未知、preview 和不可用项，当前深链保持可达 | `WorkspaceSecondaryNavigation.test.ts`、WriteSidebar 导航测试 | 已接线至这些工作台入口；不据此宣称所有市场插件/所有调研子入口都完成统一状态和配置页验收 |
| 市场安装、配置与可用状态 | `PluginMarketplaceView.tsx`、`plugin-marketplace-status.ts` 统一列表与详情的可安装、需配置、已配置待验证、已安装及不可用状态；安装记录和 catalog 可用性分开；外部 OAuth/token 仅有凭据引用或安装 health 不显示已授权；不可用包仅提供来源入口，不误导点击安装 | `plugin-marketplace-status.test.ts`、`PluginMarketplaceView.dom.test.ts` 覆盖离线/不可用、保留安装记录、配置计数、授权不误报及中文文案 | 已接线。不增加后台网络请求，不因 catalog 不可用改写、删除或禁用现有配置；真实远端诊断和全部深链配置页仍需独立验收 |
| 旧工作区迁移及隐藏别名 | `workspace-migration-service.ts` 扫描四命名空间、指纹/冲突/真别名，显式确认后创建独占快照和记录；侧栏只合并实时 realpath 相同的目录；独立目录/历史不隐藏 | `workspace-migration-service.test.ts`、IPC schema/handler、Sidebar 和 workspace-path 测试 | 已接线。遇活动数据库会报告需一致性备份而拒绝普通复制，不宣称已自动迁移任意活动 SQLite |
| 默认工作区可清空、切换、改显示名 | navigation/thread actions、Sidebar 和 workspace-label 保留真实路径与历史身份；显式清空不暗中回填旧默认，新任务不借旧选项恢复 | `chat-store-navigation-actions.test.ts`、`chat-store-thread-actions.test.ts`、Sidebar 测试 | 已接线；真实用户含旧配置、凭据引用及多个来源冲突的迁移需实际副本验收 |

文档交付的生产回归还发现并修正了权限路径别名问题：历史 TaskRoot 与 Turn canonical root 经 realpath 核实相同时，文件读取、候选、工程分析及导出沿用 Turn 授权上下文，保留原任务路径；不同工作区、被重新指向的别名和受限 allowlist 继续拒绝。覆盖见 `document-delivery-tool-provider.test.ts` 和 `tests/task-delivery-production.test.ts`。该修复不放宽路径授权。

## E：精确候选包与发布验收

| 交付/检查 | 本记录可确认的证据 | 当前结论 |
| --- | --- | --- |
| 精确源码、相关 CI、聚焦测试、类型检查 | `0a94e6a73eab47144d1f9474c83a30566bff089c` 完成 112 项聚焦回归及本地生产构建，push/PR Quality 各三个 job 全通过，含类型检查、全量测试和构建 | 对应精确源码通过，运行链接见文末 |
| 生产构建 | `0a94e6a7` 本地生产构建与签名候选构建 `42909030668` 成功 | 通过 |
| 精确 macOS 候选包安装、版本、bundle、签名、适用公证 | `0a94e6a7` 版本 `0.5.4`、arm64、bundle `com.wangjiawei508.workwise.candidate.head0a94e6a73eab`，Developer ID `R35G7F4A9U`，签名、公证、Gatekeeper、DMG/ASAR 校验和隔离安装通过 | 复用原隔离候选资料后的签名与 ASAR 再次核验通过 |
| 中文 macOS 主使用场景 | `0a94e6a7` 中文界面完成待办读取、本机钉钉启动、重新授权二维码及官方身份认证页面验收，取消新授权后原账号读取继续成功 | 本轮入口与只读范围通过 |
| 中文 Windows、安装身份和主要交互 | Windows 相关路径/工具安装有自动化分支；没有对应 Windows 机器/精确包证据 | 待验收，不得以 macOS 成功代替 |
| 真实 Lark/Feishu 账户 | 有协议核对与合成回放；用户此前报告浏览器侧成功，但未在当前候选包完成账户登录、Scope、读取或写入核验 | 当前精确候选包仍待验收，不从浏览器结果推断本地账号已连接 |
| 钉钉缺配置 | `682f4b17` 中文原始请求保持一项 `waiting_user`；重启后只读探针中模型 span、持久执行 Turn、工具操作回执均为 0，本地会话条目为 2 | 缺能力阻断、连接检查与重启恢复范围已验证；不是业务执行成功 |
| 钉钉真实 OAuth、个人待办和企业审批 | 精确 `0a94e6a7` UI 两次只读查询均返回 1 条，重新授权展示 208px 二维码和可复制链接，Chrome 官方页面与扫码页加载成功 | 本轮取消新授权，审批写入与完整任务执行仍待验收 |
| 真实旧资料迁移 | 生产迁移服务为实际旧工作区 1670 文件建立私有快照，哈希和幂等重试通过，源目录不变；生产 JsonSettingsStore 对 3 个 profile/4 份真实 V1/V2 设置的私有副本完成读取、保存、重开与 V1 备份核验，敏感配置值均保留，源文件不变 | 上述真实数据副本范围通过；真实样本无 credentialRef，不宣称 Keychain、完整 profile 或 SQLite 迁移通过 |
| 发布说明和回归证据 | [可信执行说明](../harness-trusted-execution.md)、[Lark](harness-lark-provider.md)、[钉钉](../dingtalk-provider.md) 说明实现、边界和迁移 | 需把最终结果追加后形成候选交付证据 |
| 公开发布、版本号、Stable、官网 | 本记录未执行或证明任何公开发布操作 | 未发布，不宣称发行就绪 |

本计划未修改 updater 或新增更新路径时，不因本 Harness 变更额外设真实 updater smoke 为默认门禁。若最终实现触及 updater/新路径，则按 AGENTS.md 对精确包补一次真实 smoke。也不恢复重复私有冻结、全 UI 矩阵、截图档案或独立 AI 审查为默认要求。

## 再次逐项核对发现的实现缺口（2026-11-11）

- 限时任务权限卡片的生产接线缺失。`TaskPermissionPanel.tsx` 仅有定义及 DOM 测试，实际页面未引用。`CapabilityRequiredCard` 的 grant 动作目前打开设置。上表原“已接线”已更正。
- 任意工作区路径、网络范围的一次性授权及每次执行前的完整权限总览仍待实现。现有任务权限确认协议只调整审批策略、期限和版本。
- Flow 统一任务命令入口尚未完成。通用 Agent 节点对钉钉/飞书动作返回阻断，普通文本节点直接调用模型；文档交付适配器直接创建 Turn。聊天与写作聊天已接入 TaskCoordinator。
- 默认 DWS 扫码路径明确拒绝审批转交。高级 OpenAPI Provider 存在转交实现，默认扫码后的转交仍需打通。
- `external-effect-evidence.ts` 的可信工具映射覆盖钉钉与飞书/Lark，计划所列邮件、其他 IM 发送及远端文件操作仍需统一完成验收。

当前候选的两次真实单条待办读取由固定诊断入口执行。完整模型任务的授权、继续、执行、回读和完成状态，以及两平台写入验收仍待完成。中文 Windows、SSE 断线实机回放和完整凭据及资料迁移的验收缺口继续保留。本次核对检查了生产引用关系、当前 PR 和已有证据，源码实现未修改。

## 尚不能关闭的事项与下一步

1. CI、本地精确源码聚焦测试、类型检查和生产构建已通过。保留旧 CI 的翻译插值失败及旧占位归档被误期望为成功的失败记录；后续测试分别验证正常 DOCX/持久审批成功、保留旧归档节点的流程明确失败，未放宽生产拒绝策略。
2. `0a94e6a7` 精确候选包已通过本轮钉钉入口与真实待办只读实测。中文 Windows 仍需实际运行证据。
3. DWS 后续验收完整任务执行、授权失效恢复及用户明确目标的写入和回读。本轮两次界面只读检查通过，重新授权已到达官方扫码页，验收取消后原账号仍可读取。飞书/Lark 在当前候选包的真实连接继续待验收。
4. 真实工作区和设置副本验证已完成上述范围；完整插件/MCP/Skill 及 credentialRef/Keychain 仍需相应真实样本，不能从设置值保留推断整套资料验收。活动 SQLite 走一致性备份，不对原件执行普通目录复制迁移。
5. 逐项核对计划中尚属部分交付的体验：任意路径/网络的一次性范围授权、每次执行前的权限总览、市场提供商的实时诊断及全部深链配置页。市场已根据本地 catalog/安装/配置事实统一显示状态，但这些仍不能被现有任务卡、Shell 授权或三个工作台的导航过滤代替。
6. 取得上述证据后再判断 A—D 是否满足正式产品完成条件及 E 是否可以进入发布；缺少真实平台或目标 OS 能力时明确写待验收，不把模拟结果填成通过。

## 首轮执行证据（历史源码，非当前最终包）

- 精确源码/依赖锁：`72e4bf9b4ca890152f7a0c7f30d9fb9e223b7455`，独立干净工作树 `npm ci`；后续两个测试提交不改变生产代码，候选包仍对应 `72e4bf9b`。
- 聚焦测试：KUN 305 项、Desktop 453 项通过（共 758 项）；翻译与权限面板补充验证 6 项、旧流程 3 项通过。Desktop/KUN 类型检查及 ESLint 均通过。
- 完整 CI：`c6f52a4b` 的 [42804000420](https://github.com/railwise-cn/railwise-ai/actions/runs/42804000420)、[42804010470](https://github.com/railwise-cn/railwise-ai/actions/runs/42804010470) 均成功，含全量测试、生产构建、Windows 路径/进程/持久化及 Electron 生产启动。不是 Windows 交互 UI 或真实平台写入验收。
- 生产构建及精确候选标识：本地生产构建通过；首个私有签名候选构建 [42801605406](https://github.com/railwise-cn/railwise-ai/actions/runs/42801605406)，源码 `72e4bf9b`，不发布、不改 Stable、无重复冻结。
- 首包版本、bundle、签名、公证：`0.5.4` 私有 Candidate、arm64、独立 bundle `com.wangjiawei508.workwise.candidate.head72e4bf9b4ca8`，Developer ID `R35G7F4A9U`，本机 codesign/stapler/Gatekeeper 均通过。DMG SHA-256 `54a44f7bafe3bfe892ce26451a163c5bed8c9f74929c7e5a992c140f86abddbd`，ASAR SHA-256 `4bc8e054f4d8aee32fc56ccf861d0bb1a9d9efa70f38d94dab20f0dc18003dbc`。不代表修复后包通过。
- macOS/Windows 中文包验收：待登记。
- 真实 Provider、实际模型与测试目标：待登记；缺失保持待验收。
- 真实资料副本迁移结果：4 个实际旧工作区、1670 文件私有快照校验通过；3 个 profile 的 4 份真实 V1/V2 设置副本读取/迁移/保存/重开通过，原资料哈希不变。未上传私有内容；未验证真实 Keychain、完整 profile 和活动 SQLite。
- 发布判断与剩余缺陷：待登记。

## 首包 CUA 缺陷记录

| 缺陷 | 实际观察 | 修复与回归要求 |
| --- | --- | --- |
| HUI-01 | 无模型 Key 时，“配置钉钉连接器”请求通用设置，异步加载却覆盖为供应商页 | 移除无 Key 强制重定向，保留提示；DOM 覆盖延迟加载后的通用、供应商、写作和 Agent 显式入口；修复后包再次点击 |
| HUI-02 | Lark 预检已持久等待，模型调用为零，但现有会话持续显示运行中；API 把本地 command 回执重建成 completed Turn | 明确本地会话回执与执行 Turn，SSE 回执不得启动 busy/watchdog；修复后包核对首次建会话与现有会话两入口 |
| HUI-03 | 卡片两个“安装 Lark CLI”按钮，一个安装，另一个只打开市场 | 配置入口明确显示“打开插件市场”；DOM 验证只存在一个安装按钮且市场按钮不触发安装；修复后包检查 |

首包检查结果为“发现缺陷”，并非 passed。原始包、回执和缺陷记录保留；重打包用于验证实际修复，不是重复冻结门禁。验收未使用生产 profile、真实账号或真实审批，也未修改官网/Stable。


## 连接器工作台增量（2026-11-10）

本增量依据用户要求研究了 WorkBuddy 的实际入口与连接前流程，再落实到 RailWise；没有复用其私有代码，也未把竞品的目录描述当作已支持能力。研究与迁移说明见 [技能与连接器工作台](../connector-workspace.md)。

- 入口集中为“技能与连接器”，连接器、技能、插件各自页签。连接器默认展示，旧插件/Skill/MCP/安装及权限记录保留。
- 飞书和钉钉原生连接卡在目录断网时仍可打开。详情说明能力、实际连接状态和操作边界；只有用户点击连接才安装或启动授权。
- 飞书补齐首次 `config init` 官方应用扫码，再进入账号授权；应用/Profile/用户身份和可执行哈希绑定执行 Grant，业务使用同一隔离配置目录和固定 Profile。
- 钉钉已核实存在官方 DWS 和设备授权。本增量增加固定版本、摘要校验、官方源回退、隔离配置/凭据目录、同进程等待和取消、类型化业务命令；原 HTTP 企业配置移入高级兼容入口，不删除旧配置。
- DWS 只读身份诊断没有业务 Scope 清单，本机登录有效不能被显示为已完成审批权限验证。写操作继续经过明确目标确认、回执和回读；未知结果或后端/账号切换不能自动重放。
- 用户无需现在提供账号、密钥或测试 ID。官方页面扫码和授权由用户完成；业务写入验收到执行时再选定具体测试条目。

最新聚焦测试、CI、构建、精确包标识和中文 UI 结果见下方对应 SHA 的记录。未完成真实扫码、远端读取或写入时维持“待验收”，不把合成 fixture 当作真实平台通过。


增量验证记录：

- `a499b8d5` 的生产代码在独立依赖树完成生产构建；Desktop 全量 430 文件、4244 项通过、3 项跳过。初次在共享 `node_modules` 树运行发现的 PDF worker 路径/缺少 Mermaid 构建文件问题，在干净依赖树构建后未复现，未修改生产代码绕过。
- 全量 Runtime 初次运行 3574 项通过、4 项失败、22 项跳过；失败为三项 Lark 权限回归缺少新身份 fixture，以及一项仍断言旧钉钉文案。修复与复跑结果另行追加，不能把该次记录标为全通过。
- 实际官方 DWS 国内下载、固定摘要、版本、空配置只读诊断通过；真实 `ManagedDwsService` 获取设备授权链接后立即取消、捕获子进程退出，通过。无人扫码，无业务操作。
- 用户另报告 Chrome 扫码后本地回跳加载失败。现场观察为本机 `/callback` 的 `ERR_CONNECTION_REFUSED`，对应端口无监听；当时 RailWise 未运行，不能作为本次候选包登录成功或失败的证据。授权码不回显、不重放、不登记到仓库；发起来源和凭据是否保存尚未核实。该案例用于检查授权展示与本地完成状态的分离。

### 授权完成判定与兼容入口复核

- `2e983d73` 恢复被飞书原生卡片合并后的原包管理入口；来源、权限、旧安装版本及更新策略可以从“高级原包管理”到达，安装和 MCP 数据保持原样。相关目录/DOM 回归 27 项、Web 类型检查和 ESLint 通过。
- `ba6342cd` 补齐新身份绑定所需的合成 fixture 后，独立依赖树 Runtime 全量为 3578 项通过、22 项跳过（273 个文件通过、2 个跳过）。`9298fcb0` 两条 Quality 均通过；这些结果不能代替后续源码的 CI。
- `9298fcb0` 候选构建 `42820719210` 因原包管理入口缺陷取消；`2e983d73` 候选构建 `42822693347` 因授权完成判定缺陷取消。两个构建均未用于本轮最终安装或验收。
- `8d01b229` 将钉钉链接展示前的快速退出纳入同一身份核验，并使取消/新登录能够废止异步核验。`d7f8fe9c` 补齐核验成功后的 Runtime 和界面刷新，等待授权不刷新为成功。服务相关 72 项、补充 IPC/界面 58 项回归通过。
- `b29985ce` 修复飞书首次应用配置的快速退出、检查期间取消以及首次诊断期间取消，核验本次唯一命名配置，不借用已有默认配置。相关服务 33 项回归通过；配置到账号登录的精确归属与最终包结果继续以实际验证记录为准。
- `8a25cf38` 将本次配置的 Profile、应用、品牌及 CLI 指纹绑定到账号登录；仅在本轮 `authorization_complete` 用户标识、所需 Scope 和最终身份诊断一致后，持久保存不含 Token 的账号选择。重启按同一 Profile 诊断，损坏的选择记录不回退至默认账号。服务/Runtime 启动相关 82 项回归、Node 类型检查和 ESLint 通过；这是协议与程序回归，尚不是用户真实扫码验收。

### `81f8367f` 精确包与中文场景证据

- 精确源码为 `81f8367fe91e8accb071fa91bd19fe4fa9fe7e1a`。独立依赖树 9 文件/187 项聚焦测试、Node/Web 类型检查及生产构建通过。私有日志为 `connector-81f8367f-integration-tests.log`、`connector-81f8367f-types.log` 和 `connector-81f8367f-build.log`。
- 对应该 SHA 的 [push Quality 42826491760](https://github.com/railwise-cn/railwise-ai/actions/runs/42826491760) 与 [PR Quality 42826501842](https://github.com/railwise-cn/railwise-ai/actions/runs/42826501842) 均为 success，各自三个 job 全通过：OpenSpec/品牌/许可证/lint/类型/测试/生产构建、Windows 路径/进程/持久化、Electron 生产 smoke。原始摘要保存为 `connector-quality-81f8367f.json`。Windows CI 不代替 Windows 中文交互验收。
- [签名候选构建 42826647263](https://github.com/railwise-cn/railwise-ai/actions/runs/42826647263) 成功；安装的精确文件为 `RailWise-AI-Candidate-81f8367fe91e-0.5.4-mac-arm64.dmg`。版本 `0.5.4`，架构 arm64，bundle `com.wangjiawei508.workwise.candidate.head81f8367fe91e`，签名 Team `R35G7F4A9U`；本机 codesign、stapled 公证、Gatekeeper 均通过。
- DMG SHA-256 为 `bc17d2c6427d6aba6551ee6a7a2f3e7310952d405c77114129db13b07622d38f`；ASAR SHA-256 为 `62f093b1efbdf6a93730099701668613990adefe3a1733ab46b8c5147c17fb8b`。构建及安装证据分别为 `candidate-run-81f8367f-evidence.json`、`artifact-81f8367f/package-evidence.json`、`candidate-local-package-81f8367f-evidence.json`。候选隔离安装，未使用生产 profile，未发布、未改 Stable 或官网。
- 中文 macOS 深色界面已实际打开“连接器／技能／插件”三个页签，以及飞书详情的“高级原包管理”和原包详情。钉钉和飞书请求分别保持待授权，任务列表和原会话状态可见，执行线程不出现在普通会话列表；状态查询不创建执行。
- 只读 `candidate-runtime-81f8367f-after-ui.json` 核对该精确运行包的 SQLite/JSONL：任务 2 项，均为 `waiting_user`；公开会话 1 项、内部执行线程 2 项；模型 span、`turn_started`、持久执行 Turn、发送事件、usage 和工具操作回执均为 0。此检查在 `credentialAccess=0` 下完成；持久 Turn 计数为只读投影，不冒称 API 调用计数。
- 随后将隔离候选的 `credentialAccess` 开启为 1 并重启时，出现 capabilities refresh failure。已定位为下述 HTTP transport 缺陷并在 `70496430` 修复，但该修复不在 `81f8367f` 包内。因此未把官方扫码、账号授权成功、平台读取或写入记为通过。该失败与用户先前浏览器本地回跳案例分别记录，不把它们合并为同一根因。
- 精确包仍显示内置 Design Skill 的旧品牌简介。`442fb23d` 仅将应用自带 description/正文改为 RailWise AI Design，并加入品牌公共文案检查；品牌检查及现有 26 项聚焦测试通过。该提交不在 `81f8367f` 包内，不能用此包声明文案修复已安装验收。

上述私有日志、摘要和包校验证据位于 `/private/tmp/railwise-harness-acceptance-20261110`。仓库仅记录必要结果和摘要，不提交账号资料、授权码或私有截图。当前仍不能关闭真实连接器、完整计划或发行验收。

### 精确包后发现的 HTTP transport 缺陷与源码修复

- `704964304cdf6ace399e2d19208ad6937fa3c2de` 修复 `kun/src/server/node-http-server.ts`。Node 的 `IncomingMessage` 即使没有 payload 也始终是可读流；旧转换逻辑把所有非 GET/HEAD 请求都设为非空 Fetch body，导致合法的空 POST 被连接器 refresh 的无请求体校验以 400 拒绝。该问题属于本机 HTTP 适配，不能归因于平台授权失败。
- 无 payload framing 或 `Content-Length: 0` 的请求现在保留 `body: null`；正长度 payload 和 `Transfer-Encoding: chunked` 继续流式传递，包括零字节 chunked。实现不预读、不缓存请求体，路由和授权仍在原边界执行；真正带 body 的 refresh 请求仍返回 400。
- `kun/src/server/node-http-server.test.ts` 与连接器路由聚焦回归共 13 项通过，并通过相应类型检查和 ESLint。新增测试经过真实 Node HTTP/TCP 服务，覆盖两个 Provider 的空 POST refresh、无 framing、正长度内容、空/非空 chunked，以及请求结束前交付首块；这不是仅调用 Router 的 Fetch fixture。
- 此源码修复不在 `81f8367f` 包内。旧包已退出，后续 `682f4b17` 精确包已安装并通过连接检查回归，见下节；真实账号授权与业务执行不由该 transport 结果证明。

### 会话回执持久化与列表索引闭环修复

- `81f8367f` 重启后侧栏显示“还没有会话”，但只读检查确认 3 个 Thread（1 个用户会话、2 个内部执行会话）与 2 项 `waiting_user` 任务均保留；用户会话 JSONL 为 3550 字节。SQLite summary 仍为 `message_count=0`、空 preview、标题“新会话”，因此非活动会话被既有空壳过滤规则隐藏。任务的“打开原会话”可恢复内容；这不是资料丢失或 GET 鉴权故障。
- `682f4b173de9b1ef74791a6ef8fb3570d430b421` 将 canonical 本地 command receipt 纳入会话 count、preview 和活动时间投影，与真实 Turn items 按 ID 去重。回执仍不是执行 Turn，不增加模型调用，也不移除空壳过滤；File backend 使用同一投影。
- `recordCommandExchange` 在所有 JSONL items/events 持久后、outbox 确认前统一 reconcile summary。崩溃后 outbox 重放时，即使回执已存在，也重新 reconcile；重写和编辑回执同步刷新索引。旧索引版本由 1 升为 2，经现有懒更新和后台 rebuild 修复，不删除 JSONL、用户配置、凭据或工作区文件。
- 相关 6 文件/64 项回归、KUN 全量类型检查、变更文件 ESLint 和 diff 检查通过；root 的干净 `682f4b17` 源码生产构建也已通过。回归覆盖即时列表、重复 command、关闭重开、v1 索引修复、当前版本旧索引的重放修复、回执重写移除、File parity、空壳保留规则，以及真实运行 Turn 与本地回执并存而不虚构额外 Turn。私有根因记录为 `candidate-runtime-probe-81f8367f-findings.md`；未提交账号资料或 Runtime token。
- 此修复不在 `81f8367f` 精确包内。后续 `682f4b17` 精确包已验证正常退出后重启可见原会话并恢复原文/等待卡，见下节；真实扫码与平台业务仍待验收。

### `682f4b17` 精确包实测（2026-11-11）

- 精确源码为 `682f4b173de9b1ef74791a6ef8fb3570d430b421`，[签名候选构建 42844447988](https://github.com/railwise-cn/railwise-ai/actions/runs/42844447988) 成功。下载 artifact `13779102665` 为 353112455 字节，ZIP SHA-256 `ff711f57cfc3ad73c9d98a8ed2217e5e8ef67da0fea897d563848fc0c7cad7b1` 与 GitHub artifact digest 一致，ZIP CRC 校验通过；记录为 `artifact-download-682f4b17-evidence.json`，未保存签名下载链接。
- 安装文件为 `RailWise-AI-Candidate-682f4b173de9-0.5.4-mac-arm64.dmg`，DMG SHA-256 `76cef973a44fb5f21a7dcaf0d561edd16b4653424ffa9a2c6ce8c4abce03fd45`，ASAR SHA-256 `4624b1fc565a432a0251c0ac80b54aeb73936c786f1c713503bb9832fd72ac4b`。版本 `0.5.4`、arm64、bundle `com.wangjiawei508.workwise.candidate.head682f4b173de9`，Developer ID Team `R35G7F4A9U`；codesign、stapled 公证、Gatekeeper 和隔离安装通过。证据为 `candidate-local-package-682f4b17-evidence.json`；未发布，未导入或使用生产 profile。
- 干净 `682f4b17` 源码完成生产构建、Desktop 类型检查、7 文件/52 项 Runtime 聚焦测试；日志见 `connector-682f4b17-source-validation.json` 引用。`073b09e2` 与该候选源码仅有文档差异，其 [push Quality 42844825163](https://github.com/railwise-cn/railwise-ai/actions/runs/42844825163) 和 [PR Quality 42844848596](https://github.com/railwise-cn/railwise-ai/actions/runs/42844848596) 均为三个 job 全通过，记录为 `quality-073b09e2-evidence.json`。不改写候选源码 SHA，也不把 Windows CI 作为中文 Windows 实机结果。
- 中文 macOS、`credentialAccess=1` 的空隔离 profile、无模型 key 下，已打开设置与“连接器／技能／插件”三个独立页签。原始“帮我处理钉钉待办”持久为待授权任务；“检查连接”成功返回，不再出现 refresh 400；状态询问返回本地快照。
- 正常退出并重启后，侧栏“帮我处理钉钉待办”可见，点击可恢复原文和待授权卡，内部执行会话继续隐藏。`candidate-runtime-682f4b17-after-restart.json` 严格只读核对：任务 1 项为 `waiting_user`，会话条目 2 项、会话回执 1 项、公开 Thread 1 个、内部 Thread 1 个；模型 span、持久执行 Turn、`turn_started`、发送/usage 事件及工具操作回执均为 0。探针本身不调用 Runtime API，不把持久投影计数冒充业务 API 计数。
- 该精确包的正式连接流程自动安装官方 DWS 并打开官方设备授权扫码页，当时等待用户完成本轮扫码。随后本轮授权到期，应用明确显示“本次授权已过期，请重新连接”，未报告登录成功；用户当时未完成该轮扫码，可重新发起连接。当时仅把工具安装、授权页打开和到期提示记为通过，账号身份、scopes、平台读取、写入或原任务执行恢复尚未验收。到期界面私有证据为 `dingtalk-device-expired-682f4b17.png`，不含临时授权代码；此前含代码的界面截图仍留在私有验收目录，不提交仓库。
- 后续于 2026-11-11 北京时间约 02:54，在同一精确 `682f4b17` 应用重新点击 DWS 连接，官方页面自动打开，随后应用自动转换为“账号已连接 · 平台权限执行时核验”和“登录身份已核验”。用户反馈未看到二维码；再次点击“检查连接”仍显示登录身份已核验，未出现 Runtime 刷新错误。本次仅记录官方新设备流程返回及精确账号身份后验通过，不宣称用户人工扫码，不推断是否复用官方已有会话。未进行业务读取、写入，未恢复原泛化任务，也未新增模型配置；业务 scopes 和操作闭环仍未验收。私有截图为 `dingtalk-connected-20261111.png`，不提交仓库。上条过期记录保留为较早一次流程的实际结果。

### 仅由源码阅读发现的启动风险

以下两项尚未现场确认为本轮侧栏缺失的原因，未实施修复，也不新增为本轮关闭条件：`chat-store-navigation-actions.ts` 的 `boot` 在设置 revision 为 0 且无模型 key 时跳过 Runtime 初次加载；`chat-store-schedulers.ts` 仅安排一次 900ms 启动探测，探测失败后该调度器不自动重试。后续专项核验应区分本地历史读取与模型配置，以及短时启动失败与持久连接失败。当前已确认的侧栏缺失是回执写入后会话索引仍为空，按 Runtime 索引缺陷单独处理，不能用这两项代码风险替代根因。


### 钉钉入口故障复现与修复（2026-11-11）

用户再次报告已安装本机钉钉、连接按钮无法打开授权和二维码。实机复现了 `682f4b17` 在已有登录记录时点击“连接钉钉”只重复诊断的缺陷。`ManagedDingTalkConnection` 的提前返回阻止新授权，界面也缺少重新授权和本机客户端入口。此前“登录身份已核验”读取官方 CLI 本地身份与有效期，远端可用性必须通过实际业务请求检查。

本轮加入明确的重新授权、可复制官方链接、置顶二维码、本机钉钉入口，以及固定读取一条未完成待办的诊断按钮。诊断复用正式 Provider、工具宿主和仅允许该读取的 ExecutionGrant，返回条数与错误分类。设备授权重试时刷新链接和授权码。现有安装与凭据继续使用，重新授权由用户点击发起。

通过 `682f4b17` 精确包内的正式 Provider 和 LocalToolHost，已对当前账号执行一次第一页、最多一条的只读查询，返回成功且条数为 1。仅保留计数及核验状态。实际任务工作流与新按钮的精确包 UI 验收继续记录，审批写入仍待验收。本机 `/Applications/DingTalk.app` 已实际打开。

### `0a94e6a7` 精确包钉钉入口实测（2026-11-11）

- 精确源码 `0a94e6a73eab47144d1f9474c83a30566bff089c` 对应候选构建 `42909030668`。版本 `0.5.4`、macOS arm64、bundle `com.wangjiawei508.workwise.candidate.head0a94e6a73eab`，Developer ID Team `R35G7F4A9U`。签名、装订公证票据、Gatekeeper、下载摘要和安装校验通过。DMG SHA-256 为 `d6056da2757a8cebe387956e91efe4582189c0efe5c38a3a73fbad08e914f41e`，ASAR SHA-256 为 `323527be84f332641aeaf7c387ade6bdbfd97b88bca038e90276b06c37ef65db`。私有回执为 `candidate-local-package-0a94e6a7-evidence.json`。[候选构建](https://github.com/railwise-cn/railwise-ai/actions/runs/42909030668)
- 本次将签名应用复制到原 `candidate-682f4b17` 隔离目录的新应用名称下，复用已有候选登录和资料。环境文件的旧版本已备份，源码标识更新为本次完整 SHA，复制后的签名和 ASAR 再次核验一致。测试使用该隔离候选资料，环境复用记录为 `candidate-0a94e6a7-existing-profile-update.json`。
- 中文界面点击“测试待办读取”通过正式 Provider、工具宿主与受限 ExecutionGrant，第一页最多读取一条，实际返回条数 1。“打开本机钉钉”显示成功，操作系统可见 DingTalk 客户端。检查本地登录后，按钮显示“重新授权 / 切换账号”，点击后窗口内显示 208px 二维码、官方 URL 输入框和复制按钮。
- Chrome 实际加载官方设备授权页，点击登录后到达官方身份认证页，扫码登录页可见二维码与已有账号。此次验收在最终同意新授权前取消，关闭新增验收页面并取消应用内登录流程。随后再次通过“测试待办读取”返回 1 条。本轮两次界面查询均为只读，审批写入与完整任务执行继续待验收。结构化实测记录为 `dingtalk-0a94e6a7-ui-acceptance.json`。保存的私有截图包含 `dingtalk-working-0a94e6a7.png` 及读取/客户端结果。新二维码通过 UI 工具现场观察，本轮未保存其临时代码。
- 112 项聚焦回归及本地生产构建通过。同一 SHA 的 push 和 PR Quality 各三个 job 全部成功，覆盖主质量检查、Electron 生产启动及 Windows 路径/进程/持久化自动化。精简证据为 `quality-0a94e6a7-evidence.json`。中文 Windows 实机交互仍待验收。[push Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/42908909871) · [PR Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/42908924435)
