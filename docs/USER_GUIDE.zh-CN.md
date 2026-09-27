# WorkWise 操作文档

本文档用于快速上手 WorkWise 桌面端。更多背景、源码和发布包请查看：

- 项目主页：https://github.com/railwise-cn/railwise-ai
- 产品与下载：https://www.railwise.cn/products/workwise/
- 问题反馈：https://github.com/railwise-cn/railwise-ai/issues
- 维护者：https://github.com/wangjiawei508

## DeepSeek V4 Pro 与 DeepSeek Harness

DeepSeek 已于 2026 年 8 月 13 日正式发布 `DeepSeek-V4-Pro-0813`。WorkWise 中继续选择 `deepseek-v4-pro` 即可使用正式服务端版本，不需要为模型更新重新安装应用。默认官方服务地址是 `https://api.deepseek.com`；只有 Write 的 FIM/前缀续写会使用 `/beta` 接口。

正式模型提供 100 万 token 上下文和最高 384K 输出。WorkWise 已将 DeepSeek Harness 接入 Runtime 的附件处理链：模型支持图片时使用结构化 `text/image` 消息部分；文本模型使用本机回环视觉证据分析器生成 OCR、布局、语义和视觉摘要。分析器不可用或失败时，本回合明确失败，不把图片改写成 Base64 文本。这里的名称指上游 DeepSeek Harness 项目；本文只记录 WorkWise 实际接入的适配和证据链，不宣称支持上游尚未接入的能力。

0.4.2 支持 JPEG、PNG、GIF 和 WebP 图片。图片回合使用 `auto` 时，WorkWise 只会在当前配置使用 DeepSeek 官方地址，或当前 Provider 显式配置或实际发现 `deepseek-v4-flash-vision-exp` 时，为这一回合选择该模型；发送前未确认可用或模型设置读取失败时，编辑器中的文字和附件保持原样。手动选模和 PDF/Office 文档解析方式不变。

实现边界、数据传输边界和配置说明见 [DeepSeek Harness 接入说明](./DEEPSEEK_HARNESS.zh-CN.md)。

## 产品定位

WorkWise 是面向工程、基础设施、城市更新与企业运营场景的智能体工作台。产品把 Code、Write、Design、Skills、知识库和文档解析放在同一个 Agent Runtime 中。

| 状态 | 范围 |
| --- | --- |
| 正式可用 | Code、Write、Design、DeepSeek Harness 结构化附件处理、定时任务、持久化任务、Agent、权限、MCP V2、Git checkpoint、Repo Map、PDF/Office 解析与成果验证 |
| Preview | Flow 画布、节点测试、发布、运行历史、审批和失败恢复 |
| 可选能力 | Unlimited-OCR / MinerU 高精度解析、在线 Skill 更新、连接手机和外部 CLI |
| 路线图 | 更多多模态模型和行业智能体 |

## 下载安装

前往 WorkWise 产品页获取产品介绍和下载入口。国内用户优先使用公司官网产品页；GitHub 主要保留为项目主页、源码协作、Issues 和开发者备用渠道。后续正式发布只保留三个安装包：

| 系统 | 下载说明 |
| --- | --- |
| macOS Apple 芯片 | 下载 `WorkWise-版本号-mac-Apple-Silicon.dmg` |
| macOS Intel 芯片 | 下载 `WorkWise-版本号-mac-Intel.dmg` |
| Windows 64 位 | 下载 `WorkWise-版本号-win-x64.exe` |
| Linux | 当前不发布 Linux 客户端 |

0.3.2 用户需要最后一次从产品页手动安装已签名、公证的 0.3.3。自 0.3.3 起，顶部蓝色更新入口会先在后台下载；下载完成后点击“重启并更新”，应用会保存编辑内容、列出活动任务并在确认后自动安装和重新启动。产品页下载安装仅作为更新故障时的诊断兜底。

## 对话文档附件

输入框加号支持 PDF、DOCX、XLSX、PPTX、TXT、Markdown、CSV、PNG、JPEG、GIF 和 WebP，也可以把受支持文件拖入输入框。每轮最多 8 个附件，单文件最多 200 MiB，单批次最多 500 MiB；解析完成前不能发送。

文档在本机托管目录解析并建立分段索引。模型最初只看到文件清单和短摘要，需要正文时通过附件检索读取相关段落，因此百页招标文件不会整份塞进模型上下文。检索结果保留 PDF 页码、工作表、幻灯片、标题或表格来源。扫描 PDF 在本机没有可用 OCR 时会显示降级；加密、损坏或伪装格式会明确报错。文档内容始终按不可信资料处理，不能代替系统指令或授权工具操作。

图片附件会按当前模型能力分流：支持图片的模型直接接收结构化图片部分；手动选择文本模型时，Runtime 可以调用配置好的本机回环视觉证据分析器，再把结构化证据作为不可信参考提供给模型。证据包括 OCR、布局、语义、视觉摘要和不确定性字段。图片不会通过 Base64 文本回退到模型提示；本机分析器内部传输图片字节时可以使用 `dataBase64`，这不属于模型上下文。`auto` 不会把图片交给未确认支持图片的文本模型；未配置或不可用时会显示明确失败原因，不会假装已经完成图片理解。

## Flow Preview

侧边栏 Flow 入口默认可见并标记 Preview。画布支持手动、定时和 Webhook 触发器，以及 Agent、知识检索、条件、循环、并行、人工审批和 DOCX/XLSX/PDF/PPTX 输出等节点。节点端口按字符串、JSON、表格、文件、文档、图片和 Agent 消息等类型校验；发布前会检查必填参数、循环边界、递归和缺失能力。

“定时任务”保留独立列表和编辑器；页面中的“查看定时 Flow”是显式跳转，不会在点击定时任务时自动替换成 Flow。新建 Flow 会自动生成“手动触发 → Agent”起始图；运行历史可查看每个节点的输入、输出和错误，也可审批、取消、从失败节点重试或从可恢复检查点继续。

## 首次配置

1. 选择界面语言、主题和字体大小。
2. 在设置中填写 DeepSeek API Key，或选择/配置兼容 OpenAI / DeepSeek 协议的模型服务。
3. 内置模型供应商包含 DeepSeek 和 Agnes AI；Agnes AI 默认使用 `https://apihub.agnes-ai.com/v1`、`chat_completions` 协议和 `agnes-2.0-flash` 文本模型。
4. 如使用其他兼容服务，在 Base URL 中填入服务地址并选择默认模型。
5. 选择默认工作区，后续每个会话都可以切换到不同项目目录。
6. 在通用设置中检查 GUI 更新，确认当前版本是否为最新。

Agnes AI 文本模型通过“模型供应商”接入；API Key、额度、计费和可用模型以 Agnes 官方账户规则为准。WorkWise 不承诺模型永久免费。

## Code 工作台

Code 模式适合项目开发、代码审查、需求拆解和自动化执行。

- 在左侧选择工作区后开始对话。
- 使用 `/plan` 让 AI 先生成执行计划。
- 使用 `/review` 审查当前改动、指定分支或指定 commit。
- 文件变更会显示在时间线中，执行前后都可以查看差异。
- 对敏感命令或高风险操作，先阅读提示再决定是否继续。

### 任务状态与自动继续

- 每个新任务保存目标、验收条件、执行节点、checkpoint 和成果。
- 单次模型尝试达到步骤或时间上限时，WorkWise 会保存进度并开启下一次内部尝试，不会把阶段性文字当作完成。
- 连续无进展会自动重新规划；仍无法推进时进入“已停滞”，提供继续、换模型和调整要求。
- 应用重启后会恢复可安全重试的任务；不确定的外部副作用会先请求确认。
- 只有审批、必要输入、安全阻断、明确预算耗尽、不可恢复错误或主动取消才暂停。

### 对话显示模式

- **简洁**（默认）：只显示对话、合并后的短进度、审批、错误和成果。
- **标准**：额外显示“读取 3 个文件”“正在验证 PPT”等语义操作。
- **开发者**：显示脱敏后的工具、相对路径、命令摘要、输出、Diff 和指标。

脚本、工具参数和长输出默认收入“工作详情”。密钥、请求头、用户目录和绝对路径会脱敏；模型私有思维链不会显示。

### Agent 与子任务

设置中的 Agent 配置中心提供 General、Explore、Review、Research 四个内置模板。内置模板不可直接修改，可克隆为 `~/.workwise/agents/*.md` 全局 Agent 或工作区 `.workwise/agents/*.md`。子任务拥有独立预算、状态和成果，可在任务详情中查看、终止或恢复。

## Write 写作模式

Write 模式用于 Markdown 写作、预览、工程文档起草和导出。

右侧写作助手的加号可添加 PDF、DOCX、XLSX、PPTX、TXT、Markdown、CSV 和图片，解析完成后可直接按页码、工作表或幻灯片检索，不需要切换到 Code。需要编制投标文件时，点击“编制投标文件”，添加招标文件后让 Tender Master 先整理评分、实质性要求和风险台账，再在确认后逐章编制。

- `Live`：当前行保留 Markdown 源码，其他内容实时渲染。
- `Source`：纯源码编辑。
- `Split`：左侧编辑、右侧预览，适合长文校对。
- `Preview`：最终阅读视图，适合导出前检查。

导出支持 `HTML / PDF / DOC / DOCX`：

- PDF 使用应用内置 Chromium 渲染，适合固定版式交付。
- DOC 使用 Word 兼容 HTML，适合快速交给 Word 或 WPS 编辑。
- DOCX 会优先使用随应用携带的平台转换器，失败时使用 WorkWise 内置生成器兜底。
- 复杂版式、特殊表格和跨平台完全一致性仍属于预览能力，导出前建议打开结果文件复核。
- 相对路径图片会按当前 Markdown 文件所在目录解析。

导出 Word（DOCX）时可以选择模板：

- 内置四个模板：学术论文、行政公文、商务报告、技术文档。
- 可在导出对话框里分别调整一级标题、二级标题、三级标题、正文、表格、代码块的中西文字体、字号、颜色、粗斜体、段前段后、行距、对齐和缩进（含首行缩进 N 字符）。
- 调整后的样式可"另存为新模板"，设为默认或删除。内置模板不可删除，但可基于它另存。
- 公文模板使用方正小标宋简体二号标题、仿宋_GB2312 三号正文、首行缩进 2 字符，符合 GB/T 9704 常见排版。方正小标宋简体、仿宋_GB2312 等特殊字体需用户自行安装，未安装时 Word 会用系统字体兜底显示。
- 不选模板直接导出时，使用默认模板，输出与旧版本一致。

写作工具栏提供 Agnes AI 文生图入口，可从内置提示词模板生成封面图、监测数据背景、施工/运维示意图、商务写作配图和图标式插画。图片会保存到当前写作工作区的 `img` 目录，并可自动插入当前 Markdown。当前 MVP 支持文生图；视频生成、完整图生图编辑和多图合成属于后续扩展。

## Design 设计模式

Design 是结构化 SVG 画板，适合制作报告配图、流程图、信息图和演示文稿页面。

- 支持多页画板、基础形状、文本、图片、路径、PowerPoint preset 和真实 group。
- 编辑会自动保存到当前工作区的 `.workwise/design`；重启或切换回来后恢复活动文档。
- 每个 Design 文档有独立助手会话；画布选中的元素会显示为“AI 修改目标”。Design 助手可以添加、修改、删除、组合和取消组合元素，只操作当前工作区、当前文档和当前页面。
- 可直接导出 PNG、SVG 和经过验证的 PPTX。
- 可把当前页面作为 PNG/SVG 插入 Write 文档。
- 导入 PPTX 默认按“可读优先”保留为整页视觉参考，可选择该参考并添加或让 AI 添加标注、重做元素。原始文字、图表和动画不会被伪装为逐元素可编辑对象。

导出或切换前 WorkWise 会先保存画板。图片资源缺失、页面尺寸不一致、PPT Master 不可用或文件结构验证失败时会明确报错，不会用 HTML 冒充 PowerPoint。

## 插件市场与 Skills

在设置的 Skills 和外部工具页面，可以安装、启用、禁用和更新扩展能力。

- 内置 Skills 可被 Code、Write、连接手机和定时任务参考。
- 内置 Skills 随安装包提供，默认本地可用，不依赖 GitHub 或 npm。
- 在线 Skill 更新是可选动作；网络不可用时，WorkWise 会继续使用本地内置版本。
- MCP 工具属于高级扩展，可接入外部系统、仓库、文档或企业工具，可能需要外部网络、授权、API Key 或本机运行环境。
- WorkWise 已内置工程与基础设施智能体套件、地保监测、运营期监测和写作增强相关 Skills。
- PPT Master 4.3.0 作为内置 Skill 出现在插件市场，可把 Markdown、报告、方案、网页或已有 PPTX 整理为原生可编辑 PowerPoint。

PPT Master 使用固定上游提交的受控瘦身快照，不是完整官方仓库。它保留核心 `SKILL.md`、文本参考、工作流、64 个顶层脚本及模块、图表模板、品牌、Deck、通用布局、确认页和轻量示例；不包含大体积图标 SVG、AI 对比 PNG、用户真实 projects、生成 exports、backup 或私有 PPT 文件。正式客户端把预设图形、PPTX 导入和原生 PPTX 导出所需的 PPT Master 4.3.0 脚本封装在本地 sidecar 中，不要求用户另装 Python；上游的高级开发脚本、localhost 确认页和实时预览仍可能需要 Python 3.10+ 与 `flask`。WorkWise 不安装 Pandoc。

## 工作区权限、MCP 与 Git 保护

- WorkWise 新建目录默认“工作区写入”，外部添加目录默认“只读”。提升到“可信”或“完全访问”必须明确确认。
- Agent、Skill、MCP 和 Shell 的有效权限不能超过工作区权限；符号链接或 Windows junction 不会继承授权。
- MCP V2 支持全局/工作区配置、stdio cwd、HTTP、超时、工具级授权和 OAuth PKCE。凭据使用系统安全存储；没有安全加密能力时只保留在当前会话。
- Git 写入前创建 checkpoint；回滚先显示 Diff，只撤销能确认属于当前任务的改动。检测到用户并发修改时拒绝覆盖，并创建救援引用。

## PDF 与 Office 文档

- 普通 PDF、DOCX、PPTX、XLSX 默认由随客户端分发的 MarkItDown 本地解析，不依赖系统 Python。
- PDF.js 提供页面显示、缩放、搜索和按页定位；Agent 使用结构化 Markdown 和页码引用。
- 自动模式保持使用 MarkItDown 快解析；发现扫描件、弱文本层、乱码、复杂多栏、公式或低文本密度时，会明确提示用户选择高精度重试，不会强制切换。
- 用户选择高精度解析后，优先使用已配置的本机 Unlimited-OCR，失败时回退 MinerU。两者都不在安装包内，WorkWise 不会自动上传到官方公共云端。
- Office 压缩包会先检查路径穿越、链接、加密条目、异常压缩比和解压大小。密码文件、损坏文件或超限文件会返回明确错误，不会无限重试。

## 成果交付

成果卡提供“打开、另存为、显示位置”。请求 PowerPoint、Word、Excel 或 PDF 时，WorkWise 会验证真实文件结构；HTML 预览或纯文本改扩展名不能满足任务验收。操作失败会直接显示原因。

## 连接手机

连接手机用于把 WorkWise 接入飞书 / Lark、微信或本地 webhook。

1. 在设置中启用手机连接。
2. 创建或绑定一个手机 Agent。
3. 设置 Agent 名称、描述、角色、人设、用户上下文和回复规则。
4. 按平台要求完成扫码或 webhook 配置。
5. 如需后台自动化，可添加一次性、每日、间隔或手动定时任务。

## 在线更新

进入 `设置 -> 通用 -> GUI 更新`：

- 点击检查更新，查看当前版本、最新版本和发布说明。
- 正式版从 `railwise.cn` Stable/Frontier 更新源检查新版本；顶部蓝色图标先后台下载，完成后变为“重启并更新”。
- 重启前会保存编辑内容并列出活动 Agent、Flow 和定时任务；确认后由平台更新器替换应用并自动重新启动，不打开浏览器。
- 产品页下载安装仅作为更新失败时的诊断兜底。开发包或未签名包不具备正式自动更新资格。

## 本地数据

新安装默认使用 `workwise` 命名目录；从旧版本升级时，已有历史目录仍会被兼容读取，不会自动删除历史会话或文件：

| 数据 | 默认位置 |
| --- | --- |
| 默认工作区 | `~/.workwise/default_workspace` |
| 写作空间 | `~/.workwise/write_workspace` |
| 运行时与会话数据 | `~/.workwise/runtime` 或系统应用数据目录 |
| Agent 配置 | `~/.workwise/agents` 与工作区 `.workwise/agents` |
| 文档与工具缓存 | `~/.workwise/tools` 与工作区 `.workwise/cache` |
| 设置文件 | macOS: `~/Library/Application Support/WorkWise/workwise-settings.json`；Windows: `%APPDATA%\WorkWise\workwise-settings.json`；历史设置会由迁移模块只读导入 |
| 日志 | 可在设置的通用页面打开 |

卸载应用不会自动删除这些数据。彻底清理前请确认不再需要历史会话、MCP 配置和 Skills。

## 作者与反馈

WorkWise 由 wangjiawei508 维护，面向工程、基础设施与企业运营场景持续开发。欢迎把真实使用中遇到的问题、希望内置的行业 Skills、需要支持的文档格式和插件需求反馈到 GitHub Issues。

反馈问题时建议附带：

- WorkWise 版本号。
- 操作系统和芯片架构。
- 问题截图或错误日志。
- 复现步骤。
- 如果是导出问题，请附最小 Markdown 样例。
- 如果是 Skill / MCP 问题，请说明安装来源、触发方式和报错内容。
