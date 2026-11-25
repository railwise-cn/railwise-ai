# RailWise AI 0.5.11 验收台账

每次实测在对应条目补录版本、源码提交、平台及架构、安装包和实装 ASAR 的 SHA-256、运行号、实际结果与限制。旧制品和受控夹具的结果只证明各自的覆盖范围。当前候选的通过结果以同批制品原始回执为准。

## 来源与续接

| 用户要求 | 复验步骤与通过标准 | 已有证据及本轮状态 |
| --- | --- | --- |
| 0.5.10 原对话补交网址后生成可编辑 PPTX | 在正式 Win x64 与 Apple Silicon 包通过 `/` 选择 PPT Master，由真实测试模型询问资料，仅回复 `www.railwise.cn`。记录真实正文及地址，核对同一任务交付，从正文打开文件，验证 OOXML 文字可编辑。另测超长摘要、旧对话读回和续接。 | `45118772308` 在精确 Windows 安装包上通过受控模型与真实 Chrome 扩展完成原对话补答、BrowserSkill 读取、可编辑 PPTX 交付及原问题保留。它没有证明真实模型读取 `www.railwise.cn`。真实模型官网任务待 QA 模型配置。Mac arm64 `45143497923` 已走完原对话提问与补答、官网读取、可编辑 PPTX 登记，失败发生于成果卡触发系统打开后，旧验收驱动又通过 CDP 重复调用打开 IPC 并等待第二次调用返回。现改为只点击一次并检查 LibreOffice 中的实际文件窗口，尚待精确包复跑。 |
| 0.5.7 BrowserSkill 真实读取 | 受控动态页令直接读取失败，实际 Chrome 或 Edge 扩展接管，只读读取正文并反馈来源。访问非授权站点、交互和未知动作保持原限制，成功回退整轮正常完成。复验公开采购入口、详情与正文核对。 | `45118772308` 在精确 Windows 包上通过受控网页、Chrome 扩展只读回退及来源校验。公开采购入口/详情的完整核验和现场已登录来源仍待。 |
| 0.5.7 Ego、大单网及 HTML 成果 | 隔离 Ego Space 读取已登录订阅，制造登录中断，在原 Space 恢复。按工程测量、测绘、监测筛选，逐页记录覆盖、去重和排除理由。原文可核验时记录日期、预算、截止和资格，缺证据标待核验。打开原对话中保存的可打印中文 HTML，分别核验文件和来源，检查自动预览及手动重开。 | `45118773004` 在精确 Windows 包上验证 HTML 成果登记、自动预览和手动重开。当前候选没有 Ego Space、大单网登录、数据覆盖或采购正文实测；该现场旅程仍待。 |
| 0.5.7 两次定时交付 | 读回北京时间 08:30、16:30 启动与 09:00、17:00 交付。用实际系统时钟触发测试计划，核对成果回原对话。复验过期单次、停用、撤权、保存与旧轮询竞态，以及其他计划和历史保全。 | `45118773004` 在精确 Windows 包上读回两个每日启动时间，并由真实系统时钟触发一次计划任务、将成果回到原对话。第二次自然交付、修改竞态、撤权/停用与历史保全全边界尚未覆盖。 |
| 0.5.10 原对话正文及一次审批 | 进展、补资料、审批、暂停、继续、取消和成果均出现在正文。普通开放问题在聊天框答复。批准一次后原任务继续，重复点击无额外执行，未知动作先核验，拒绝、过期、范围变动、暂停和取消均保持约束。历史任务链接与通知回原会话。 | `45118772308` 验证开放问题按原 request ID 补答、同任务续接及问题/成果回到原对话。完整 UI 审批、拒绝、过期、暂停、取消和未知操作边界仍待。将复用 Video Shotcraft 实装补齐批准后恢复。 |
| 0.5.8–0.5.10 AG-UI、KUN 与灰色执行详情 | 用首段前失败、输出后断流、缺结束信号、工具输入不完整、重启及长历史重连验证原任务。部分回复和审批只出现一次，取消释放队列，反复失败收敛。正文报告真实阻塞及操作，命令、退出码、哈希和重试默认折叠。按 KUN 0.4.1–0.4.5 及 #1460/#1463 对照行为，沿用原 MIT 基线。 | 精确源码 KUN 全量回归 5,450 项通过、24 项跳过；精确 Windows 包的普通任务和原对话补答有实装回执。该结果不覆盖全部中断/重连和 UI 审批边界。 |

## 聊天与内置能力

| 用户要求 | 复验步骤与通过标准 | 已有证据及本轮状态 |
| --- | --- | --- |
| 0.5.8–0.5.10 技能与「＋」 | 用 `/`、`/skills`、「＋」按中英文名及 ID 选取首屏外技能。核对 PPT Master、Video Shotcraft、标签移除及旧历史。实际调用技能与插件，切工作区、停用后复核列表、排队和发送，草稿与附件保留。验证目标设置、改、暂停、继续、清除及计划模式。 | `45118772862` 在精确 Windows 包上通过技能/插件选择与实际调用、草稿保留及 PDF/菜单交互。PPT Master、完整 Video Shotcraft 渲染、目标全生命周期、`/plan`、切工作区和停用状态仍未全部实测。 |
| 0.5.9–0.5.10 附件和 PDF | Windows Explorer、Mac Finder 的选择、拖放、文件粘贴及文本图片粘贴。混合 1、2、8 项及长名、同名，核对一排、扩展名和单项重试移除。以 40 MiB 左右扫描版、中文文字版、加密和损坏样本验证原件、页数、文字层、只附 PDF、OCR 和跨页引用。 | `45118772862` 在精确 Windows 包上验证约 40 MiB 扫描 PDF、中文文字 PDF、选择/粘贴/拖放及附件草稿保留。加密、损坏、扫描 OCR、文本/图片剪贴板、跨页引用和当前 Mac Finder 流程仍待。 |
| 0.5.9–0.5.10 跨端布局和启动 | 1280×840、960×640，Windows 100/125/150%、Mac Retina，深色和紧凑写作、双侧栏。检查 General、模型、菜单翻转、可滚动、Esc、焦点和发送。冷启动验证标志、英文名、中文全称、进度、无版本行。核对同源字体及首次首页更新。 | `45118772862` 验证 Windows 窄窗口、四个菜单键盘操作；`45118772843` 三条升级路径中首页更新提示实际可见。Mac 精确包 `45123172020` 两架构分别验证中英文启动界面和工作台打开，但后续旅程失败；完整缩放/DPI矩阵及 Windows 本版启动截图仍待。 |
| 0.5.8–0.5.10 国内市场与视频 | 干净用户和工作区安装 Superpowers、Blender 子技能并实际加载。校验 21 项与依赖版本、大小和摘要。阻断 GitHub/npm/PyPI 后冷安装及调用，再用大陆实体 Windows 普通网络验证。实测 Playwright MCP 和 Docling。用合成 PDF 驱动 Video Shotcraft 并按适用许可渲染，从正文打开并完整解码 MP4。检查已安装项、配置、凭据引用与授权保留。 | `45118772470` 在精确 Windows 包上通过冷缓存镜像安装、Playwright 页面读取和 Docling 启动。大陆实体 Windows、完整 Video Shotcraft 渲染/审批恢复/解码及既有配置迁移仍待；市场通过不等于视频通过。 |
| 0.5.8 Univer | 三端断网编辑多表、公式、撤销、中文 CSV 及当前表导出，保存重开。覆盖保存冲突和另存，打开工作区及成果中的 Excel 只读网格，检查表名、行列、原件摘要和复杂文件系统打开。记录包体积和首次打开耗时。 | Mac Apple Silicon 与 Intel 精确候选均在 `45140540694` 通过公式 `=SUM(4,5)` 得值 9、撤销、外部保存冲突保留原件并另存、中文 CSV 前导零和精度、多工作表保存重开及 XLSX 只读网格的名称/稀疏位置/原文件摘要。Windows 精确候选 `45150932776` 通过同一工作表流程并补验可见网格重开。三份桌面回执绑定构建 `45115646587`，Windows 安装器和 ASAR SHA 分别为 `098fcc85396c35f48fa30fe3d9a41499e21aa431dcd601d10bfef889b24e914e` 与 `2b63f6e3f81bfba805a7fe864875b7db5ea357fffd7f16cd63b7851b70d26244`。Mac 两架构回执和摘要见上文。本轮只验证 XLSX 的系统应用入口可见，没有实际点击打开；三端首次打开耗时尚未采集。 |

## 安装及升级

| 用户要求 | 复验步骤与通过标准 | 已有证据及本轮状态 |
| --- | --- | --- |
| 三端、签名及版本 | 安装同批 Win x64、Apple Silicon、Intel，核对版本、安装身份及文件摘要。记录 Windows Authenticode 实际状态。Mac 验证签名、公证、Gatekeeper、冷启动并保留中文启动截图。 | `45115646587` 已生成三端 0.5.11 候选；Windows 精确包在 Windows 实装回执中校验版本与 SHA-256，Authenticode 为 `NotSigned`。Mac 两架构签名、公证通过；`45123172020` 与 `45127315934` 已确认中文启动界面和工作台打开，后续旅程尚未全过。 |
| 0.5.10 双入口升级、0.5.9 对照 | 旧版左下角和设置页分别升级，检查折叠导航、共享进度、坏缓存重新下载、安装器启动错误反馈、自动重启、原会话、工作区和设置。复验 0.5.9 双入口。 | `45118772843` 以同一 0.5.11 候选通过 0.5.10 侧栏和设置页升级，提示可见且用户资料保留。坏缓存、安装器启动失败回退与 0.5.9 对照仍待。 |
| 0.5.7 历史故障与覆盖安装 | 对 Windows 旧版已知的关停失败走官方安装器覆盖，核对真实应用启动及数据。Mac 历史故障与当前可复现问题分别记录。 | `45118772843` 通过 Windows 0.5.7 → 0.5.11 覆盖安装并读回资料、版本和更新提示。Mac 历史故障的当次原因仍缺当次日志。 |
| 正式发布回读 | 通过必跑门禁及取得本版发布授权后，核对 GitHub、官网、新旧稳定更新源、安装包大小和 SHA-256。遇到发布中断按事务回执恢复。 | 当前正式渠道为 0.5.10。 |

历史回执：[0.5.7 大单网](https://github.com/railwise-cn/railwise-ai/blob/v0.5.7/docs/qa/release-gates/v0.5.7/h11/business-acceptance.json) · [0.5.8](https://github.com/railwise-cn/railwise-ai/blob/v0.5.8/docs/qa/release-gates/v0.5.8/acceptance.md) · [0.5.9](https://github.com/railwise-cn/railwise-ai/blob/v0.5.9/docs/qa/release-gates/v0.5.9/acceptance.md) · [0.5.10](https://github.com/railwise-cn/railwise-ai/blob/v0.5.10/docs/qa/release-gates/v0.5.10/acceptance.md) · [Mac 官网直升](https://github.com/railwise-cn/railwise-ai/actions/runs/44997671945) · [Windows 覆盖安装](https://github.com/railwise-cn/railwise-ai/actions/runs/44998972203)

## 当前构建与本轮代码验证

旧候选工作流 `45022128830` 使用源码 `68d7f8db`，在 BrowserSkill 补充网址续接修复之前构建。它不会用于本轮最终验收。当前源码的 KUN 全量回归为 5,450/5,450、24 项跳过；主仓测试 5,033 项通过、14 项跳过；release-gate 584 项通过、1 项因当前宿主缺少 PowerShell 解析器而跳过，生产构建及跨端 TypeScript 检查通过。PPT Master 内置技能安装曾因复制被清单排除的素材并把 `.pyc` 缓存计入 16 MiB 上限而失败；安装验证与复制现共用清单排除，专项 30 项通过。平台回执只要求对应平台实际提供的流程，Windows 负责任务、浏览器回退和市场，Mac 负责启动、表格和实时模型 PPT；Mac 的已登录大单网/Ego 属单独现场回执，KUN/AG-UI 协议回放由精确源码测试覆盖。当前源码提交后仍须构建同批安装包，并只用精确 SHA-256 生成实装回执。

大陆普通网络 Windows 与已登录大单网/Ego Space 是现场条件，托管 runner 无法证明。相关旅程保持未通过，直到有带原始报告和安装包摘要的实体环境回执。真实模型网站到 PPT、Mac/Windows 其他用户界面旅程、Mac 更新失败的当次日志及发布渠道回读亦未完成。正式渠道仍为 0.5.10，本台账不构成 0.5.11 发布授权。

## 2026-11-22 精确候选实装复测

下列回执全部使用 release workflow `45036271277` 生成的旧候选包，源码为 `2f53a38200a0b3f3a523911e3f789bbff46f9b2a`。Windows x64 安装包 SHA-256 为 `a7ba8de044ab20001ebf20f0a2374847e602d7f9d3bef5fee38db6867c65b94d`，安装后 ASAR SHA-256 为 `9fb7fd6b74a1616f918747043988a999a1305efdef96b8034b250ee75920ad60`。这些结果证明该候选包的对应流程，不代表以下源码补丁已经进入安装包。

| 流程及回执 | 结果 | 根因与后续 |
| --- | --- | --- |
| Windows 普通任务、原对话 HTML 成果和真实时钟每日计划，`45044229452` | 通过。`conversation-task` 与 `daily-schedule` 回执都绑定上述安装包及 ASAR 摘要。 | 回执覆盖自动预览、手动打开、08:30/16:30 计划读回及到期结果回原对话。另补强门禁，要求原对话明确显示任务状态并列出成果名称。该新门禁尚待新源码候选包实测。 |
| Windows 聊天附件、技能/插件、窄窗口菜单，`45044245693` | 通过。覆盖 40 MiB 扫描 PDF、中文文字 PDF、损坏 PDF、8 件混合附件、文件选择、系统粘贴、拖放、草稿保留和实际技能/插件调用。 | 实测附件移除后只留下其他文件和原草稿。加密 PDF、OCR 配置、跨页引用和普通文本/图片剪贴板未被该回执覆盖。 |
| Windows 冷缓存市场镜像、Superpowers/Blender Skills、Playwright、Docling，`45044259205` | 通过。 | 通过范围为该工作流脚本记录的 Windows 镜像安装及工具启动。大陆普通网络、另一安装范围、已有配置迁移仍需分别验收。 |
| Mac Apple Silicon 与 Intel 启动画面和 Univer，`45044206236` | 中文深色启动画面、全称、无版本行及启动到工作台均通过，Apple Silicon 截图摘要为 `a796c84d796dff3670b723d4ff0a1a3a0956c35ffe4a096489b8ba3e5cf4ce07`，Intel 截图摘要为 `f0d5fa76efb622739002203cef63f83d9c068eeb4f70d45a0f832c1b7e3e9b83`。两个工作流整体失败于后续表格自动化的“找不到保存表格按钮”。 | Apple Silicon 已完成公式保存、撤销、外部保存冲突、中文 CSV 导入/导出。Intel 在新建表格后即无法定位保存按钮。两个安装器签名和公证均验证通过。已给表格驱动增加失败现场 DOM 记录和截图，需用相同候选重跑，确定目标是被遮挡、位置变化还是自动化定位错误。 |
| Windows BrowserSkill 网页回退，`45044276294` | 失败，未读取网页或生成 PPT。 | 真实 Windows 截图显示任务正文已提出网址问题并提示“在下方输入框直接回复”，但输入框仍使用普通新消息占位文字。任务问题没有登记到原会话输入框，网页地址不能答到 KUN 原问题。这是产品缺陷。源码现已把单个开放式任务问题注册到原对话输入框，并按原 `requestId` 提交、刷新并续接同一任务；DOM 回归通过，需新安装包再次完成网址到可编辑 PPT 的完整流程。 |
| 最新源码回归 | KUN 与主仓问题尚无完整发布构建。任务问题 DOM 测试 7/7、Windows UI/任务回执及启动驱动 173 项通过，Web/Node TypeScript 检查、四个文件 ESLint 通过。质量 workflow `45044144960` 通过，但它不包含后续任务答复修复。 | 必须对含任务答复修复的提交重新跑完整 Quality、生产构建及精确安装包实测。 |

新源码候选仍缺 Windows 浏览器回退及任务补充后续接的安装包回执、Mac 表格失败诊断及通过回执、Windows 0.5.10/0.5.7 原地升级、Video Shotcraft 审批恢复和完整解码、真实模型网址到 PPT、现场大单网/Ego、Intel 和 Windows 表格、扫描 OCR、加密 PDF 与跨页引用。仓库没有配置 `RAILWISE_QA_MODEL_BASE_URL`、`RAILWISE_QA_MODEL` 或 `RAILWISE_QA_MODEL_API_KEY`，所以托管流程无法提供真实模型证明。

BrowserSkill 回退失败运行 `45052647651` 的根因现已由原始 Windows 日志确认：检查器要求 `task.threadId` 等于聊天 ID；实测任务执行线程为 `thr_task_31b7ce6ff45aa4a294f2b7f1`，原对话线程为 `thr_j4x1bpxp`。任务有独立执行线程是 KUN 的正常结构，任务与用户对话的关联由 `originThreadId` 表示。修正后的驱动分别核对会话 ID、执行线程 ID、问题和成果在原对话正文可见，并从执行线程读取 Turn。定向 150 项驱动测试、ESLint 与差异检查通过。该修正尚未在候选安装包上实装，仍需同包重跑 BrowserSkill 网页回退及 PPTX 交付。

首次重跑运行 `45055146678` 与升级矩阵运行 `45055209546` 都在安装器启动前被拒绝。`prepare-windows-install-smoke.mjs` 的差异白名单遗漏了本轮验收台账，故把文档更新错误分类为应用源变化。现在只将精确的 `docs/qa/release-gates/v0.5.11/acceptance.md` 加入测试源白名单，其他 QA 文档仍被拒绝。相关工作流源码门禁、浏览器回退驱动和回执测试共 171 项通过。

第二次升级矩阵 `45055752779` 已进入 Windows runner，但升级脚本要求仅正式冻结构建才会生成的 `reviewed-build.json`，因此仍未安装。正式冻结只能从 `main` 生成，不能为分支候选绕开。已添加隔离候选专用验证，绑定原构建 run、`release-win` Artifact ID/摘要和驱动源码 SHA，逐项验证候选 `latest.yml`、安装包 SHA-512、准确版本、单一文件列表及 blockmap。只接受本轮固定的 0.5.10 原地升级或 0.5.7 覆盖安装到 0.5.11。此路径保留候选的 loopback update 源，正式冻结凭据校验不变。隔离候选和既有兼容路径专项测试 14/14、相关四组 Windows 驱动测试 184/184、ESLint 与差异检查通过。新源码尚未构建，以上验收均待重新运行。

后续 Windows 实装运行 `45056797885` 已通过精确候选来源、安装包和更新清单校验，并启动 0.5.10 基线。随后失败在升级动作前的旧断言，错误地检查 0.5.10 首页提示必须未读，没有按升级目标 0.5.11 读取提示键。现在验收驱动按目标版本检查提示键，并为 0.5.10 与 0.5.11 增加独立回归。原安装到升级后的版本回读仍需重跑。

Mac 实装尝试 `45055951379` 在原构建 run 仍为 `in_progress` 时过早读取来源，按设计被拒绝。等待构建完成后的 `45057069532` 正确识别到 `f74c8bff` 之后只变更了验收驱动，但 Mac 源码白名单还缺 Windows 升级验收脚本、对应测试和本轮验收台账，因此仍在下载前失败。Mac 来源白名单现补入这些精确 QA 文件，并明确测试拒绝其他 QA 文档和应用源文件。需重新用同一 Mac Artifact ID 实装两架构启动与表格。

BrowserSkill 实装运行 `45056785005` 已通过精确安装来源、Windows 安装、Pinned Chrome 与扩展连接，并由原对话首次发起了一次受控模型请求。180 秒内任务未完成，原对话也未显示完成状态。该回执没有保留 task 快照。驱动现会在任务等待人工输入时立即失败，并在超时时只留任务状态、请求种类和执行 Turn 状态以定位补答、审批或循环问题，不保留用户回答和工具正文。需新源码候选重新完成同一网页读取与 PPTX 流程。

计划逐项审计还确认，现有准确制品旅程不覆盖所有列出的细节。受控 KUN 测试覆盖部分断流、去重、撤销和过期状态，但精确 UI 包尚未覆盖全部审批恢复边界。当前驱动没有目标生命周期和 `/plan` 模式实装旅程、40 MiB OCR/加密 PDF、文字与图片剪贴板、三档 Windows DPI、Mac Retina 对照、Windows Univer、内地普通网络市场安装及旧配置迁移回执。已登录大单网/Ego、真实生产模型和正式渠道读取需要现场条件或发布凭据。上述项目不能据相邻的单项测试标为通过。

分支 `f74c8bff9912185014d7ef2f997c374d144ccb4f` 上的三端 `prepare_public_artifacts=true` 工作流 `45048183630` 在 Windows 的“Record frozen public package identity”步骤失败。根因是 `verify-reviewed-release-artifacts.mjs` 明确只允许 `refs/heads/main` 冻结可发布身份；该保护不得通过分支产物绕过。工作流按原设置没有发布。该 run 的 Mac 打包步骤在 Windows 失败后继续运行并被取消，未留下可验收的安装包。随后以 `candidate_only=true`、`prepare_public_artifacts=false` 启动隔离候选工作流 `45050824863`，Windows 构建已通过，Mac 双架构仍在签名打包。候选制品不可直接提升为正式版本。

## 2026-11-23 BrowserSkill 续接修复复验

Windows 候选验收运行 `45064571256` 使用 release run `45062552331` 的精确安装包，安装及应用启动通过。网页到 PPT 流程仍失败，记录状态为 task `paused`、旧 Turn `running`、`user_input` 项 `pending`、`request_user_input` 工具项 `aborted`。根因已在实际 `LocalToolHost` 和 `AgentLoop` 路径复现：暂停后中断 GUI 输入工具，AgentLoop 原本会因没有 Host 结果把已派发的本地 `request_user_input` 操作记为 `outcome_unknown`。`TaskControlService` 因存在未核实操作拒绝从 checkpoint 恢复，协调器又把 `outcome_unknown` 留作排队返回，令任务一直 paused。这个工具只等待用户输入，不会产生外部副作用。

源码修复在 `AgentLoop.executeToolCall` 中把中断的 `request_user_input`/`user_input` 明确登记为取消结果，让原操作账本变为已处理的失败记录。新增集成回归使用真实 `LocalToolHost`、`AgentLoop`、`TurnService`、持久门禁和 `TaskCoordinator`，断言原请求取消、旧 Turn aborted、同一任务的新 Turn 自动启动。定向门禁/协调器测试 46 项通过；两个全量运行曾在并行负载下超时的 Ego/BrowserSkill readiness 文件已各自复跑通过，KUN 全量运行仍保留 2 项并行负载超时，且这两项单独运行均通过。ESLint、KUN TypeScript、生产构建及发布门禁 585 项通过，另有 1 项因宿主缺少 PowerShell 跳过。

新修复尚未进入安装包。旧 BrowserSkill 实装结果不用于证明此修复。含该修复的源码候选构建和 Windows 精确安装包回归待执行。先前将 BrowserSkill 回退和三条 Windows 升级路径放在同一验收 run 的调用被验收脚本正确拒绝为互斥范围，后续分开运行升级与浏览器流程。Mac 双架构新候选签名包也待同一源码构建。真实模型凭据、已登录大单网/Ego、本地 OCR 和国内普通网络市场环境仍各自缺少实测证据，正式渠道仍是 0.5.10。

Windows BrowserSkill 重跑 `45068852871` 使用修复 KUN 中断记账的候选包，旧 Turn 与新 Turn 续接路径已越过前一个 `outcome_unknown` 卡点。任务问题仍未答复，正文继续等待网址，答案则作为普通 supplement 被加入任务。根因确认在两处互相配合的 UI 条件：任务栏只在对话没有其他控制项时注册任务问题到 Composer；`isInline` 同时把该问题从任务卡隐藏。修复让唯一待处理的开放任务问题独立绑定到原对话 Composer，即使会话正文另有控制项也可以答复。若普通 `user_input` 控件与任务问题属于同一请求，发送时优先提交精确 task request。`TaskRunStatusBar.dom.test.ts` 的多控制项回归 8/8 通过。该 UI 修复仍未进入安装包，必须重建候选并分开重跑浏览器回退与升级旅程。

同一批 Windows 0.5.10 双入口与 0.5.7 覆盖安装已完成 GUI 升级并启动目标版本；回执运行 `45068881905`、`45068914692` 在记录阶段失败，因为验收器将 `latest.yml` 的 SHA-512 Base64 字段误按十六进制格式校验。安装包本身仍按 SHA-512、blockmap、Artifact 和版本清单验证。现按 Windows 清单的 88 字符 Base64 格式校验该字段并增加拒绝错误编码的回归。该改动只涉及 QA 记录器，可复用同批安装包重跑升级矩阵。

2026-11-23 源码复核：`TaskRunStatusBar.dom.test.ts` 8/8、KUN `task-coordinator.test.ts` 与 `task-coordinator-runtime.test.ts` 42/42、核心旅程回执与发布门禁测试 26/26 通过；稳定发布门禁 585 项通过、1 项因宿主没有 PowerShell 跳过。`npm run typecheck`、改动文件 ESLint、`git diff --check` 与本机 `NODE_OPTIONS=--max-old-space-size=6144 npm run build` 通过。回执校验现在接受 64 字节 SHA-512 的规范 Base64 和旧十六进制记录，并拒绝非规范 Base64。以上均为源码级结果，尚未证明提交 `e1ddd587` 已进入安装包。下一步需以该提交生成新的三端候选，重跑 Windows 0.5.10 双入口及 0.5.7 覆盖安装、macOS 双架构启动和表格，以及原对话补充网址后使用真实 BrowserSkill 完成网页到可编辑 PPTX 流程。真实模型端点、密钥、已登录大单网/Ego、Windows 国内网络与扫描 OCR 等现场验收继续标为待测。

## 2026-11-23 最新精确候选实测

候选 Release workflow `45072115774` 对提交 `79bcef84`，完成状态 success。Windows 安装包通过构建和运行时检查，Artifact `14774292782`（328,873,661 bytes）；Mac Apple Silicon/Intel 签名包 Artifact `14776155513`（1,662,830,382 bytes），候选身份、更新元数据及签名制品核验通过。Windows 安装器 SHA-256 为 `620868d23b831471e8252ca8357b4ade126631d087b42c81b156a53c905f2511`，安装后 ASAR SHA-256 为 `8b6476cce10c4d7249bbf3ddb49aba3a7e8ebf765f155c469d89b0e96ce4fe17`。该流程的 `candidate_only=true`，`prepare_public_artifacts=false`，正式发布工作跳过。以下 Windows 实装均绑定该 Release run 中同一个 Windows 安装包，不能证明之后的源码补丁已进入制品。

| 实装流程 | 实际结果与修复 |
| --- | --- |
| 冷启动 | `45075680273` 安装后实际冷启动通过。中文启动界面验收和安装身份回执已生成。 |
| 普通任务、HTML、每日计划 | `45075680863` 通过。任务在原对话正文显示完成状态和 HTML 文件名，成果哈希核对一致、能从对话预览。每日计划使用真实系统时钟触发独立到期任务，结果回到原对话且没有重新询问用户。任务列表和导航链接计数均为零，符合任务内容留在对话正文的要求。 |
| 0.5.7 覆盖安装 | `45075680323` 的 0.5.7 → 0.5.11 安装器覆盖和原数据读回通过。 |
| 0.5.10 左下角及设置页升级 | `45075680323` 两个入口均完成原地升级并启动 0.5.11，工作区、会话及偏好读回通过。回执脚本误把 Windows 安装器下载计数 `installerBytes` 当成 ZIP 下载 `zip`，所以 run 的总结果被记录步骤标成失败。修正后已对原始侧栏、设置及覆盖安装回执执行 `windowsUpdaterCoreJourney`，三条均成功，目标包和 ASAR 摘要一致。 |
| BrowserSkill 网页回退 | `45075680357` 和 `45084343092` 均失败。第二次实装绑定 `40c9e9c4`、安装包 SHA-256 `16689de14a04d8e0bc47f5123884197df71b6b0619e8b500490e069e5a904eb7`、ASAR SHA-256 `402fb2a9d90d8b7fce9cc8d39c17a3a6e50da94eb1c0355fd43157e91fb9d632`。它记录 `attention: []`，同时有一个 pending `user_input` 和被中断的 `request_user_input`，所以唯一网址问题未进入 Composer，最终被作为普通补充发送，任务停在更新只读网址范围。此前 9/9 仅覆盖任务 attention 存在时的组件回调，没有覆盖实际回执状态。现改为在其他审批或能力卡同时出现时仍识别唯一 pending 自由文本问题；多个开放问题和选项题仍不绑定。组件与选择器回归 16/16、类型检查和 lint 通过。精确运行包与同一 request ID 的 HTTP POST、自动续接仍待新候选实测。 |
| 附件、PDF、技能和插件 | `45075680466` 在尚未进入附件操作前失败。验收驱动在启动画面切到主窗口的短暂阶段立即读取 OS 窗口边界，`GetWindowRect` 未就绪后被误判为 UI 失败。驱动现在只针对已验证应用 PID 重取窗口句柄，并最多等待两秒读取尺寸。窗口驱动和相邻回归已通过，须经新 workflow 源码检查后用精确安装包重跑附件流程。 |
| Docling 和 Blender Skills | 单独 Docling 运行 `45075680440` 启动 Docling 并执行 CSV 转换，后续 Blender Director 回执失败。全量市场回执 `45075680662` 随后在同包成功验证 Docling 19 个工具、Superpowers 和 Blender Director 实际说明读取。失败运行驱动现增加经过脱敏的阶段码，保留后续诊断能力。 |
| 全量冷缓存市场 | `45075680662` 通过。Superpowers 与 Blender Skills 均经市场安装，`/` 选择准确子技能，在当前对话确认注入说明并读取安装包的原始 `SKILL.md`。Docling 发现 19 个工具；Playwright MCP 通过 stdio 实际打开并读取 2 个页面。验收仍未覆盖国内普通网络 Windows。 |
| Mac Apple Silicon/Intel 启动与表格 | `45078462000` 精确制品安装、启动到工作台、字体和工作区读取通过，但旅程未通过。Intel 表格驱动在 `click` 函数初始化前调用它，触发 JavaScript TDZ。Apple Silicon 冷启动的 1.2 秒时长从创建 BrowserWindow 起算，慢启动时 Splash 真实显示不足或漏拍。现把计时锚定到 Splash `ready-to-show` 后实际调用 `show()` 的时间，主窗口等待完整最短可见间隔；另将表格验收函数定义前移，并把启动 target 诊断写进失败回执。Splash 单测及任务 UI 测试 13/13、TypeScript、改动文件 ESLint 与差异检查通过。修复需进入新候选后再跑 Mac 双架构启动与完整离线表格旅程。 |

截至本段更新，`79bcef84` 候选的 Windows 普通任务和计划、冷启动、全量冷缓存市场、0.5.7 覆盖安装及 0.5.10 两个 GUI 入口实装均通过，原升级报告用修正后的回执代码逐项读取成功。BrowserSkill 原对话补答、Mac 启动可见时长、Intel 表格驱动缺陷和验收窗口过渡问题均已有源码修复，尚未进入候选。附件全流程需在新包重跑。真实模型所需的三个 Actions 配置项仍未检测到，国内普通网络和已登录大单网现场验收仍待补，正式渠道仍为 0.5.10，不能发布 0.5.11。

## 2026-11-23 启动画面异常回退

对 Mac 冷启动路径做代码复核时发现，如果启动画面一直未触发 `ready-to-show`，主窗口会每 25 毫秒重试显示并无限等待。现在最多等待 5 秒，超时关闭未显示的启动画面并显示主窗口；正常启动仍从启动画面实际显示时开始计算 1.2 秒最短展示时间。新增超时边界测试 4/4、类型检查、改动文件 ESLint 及差异检查通过，OpenSpec 严格校验 13/13 通过。全量本机测试在 Node 24 下重建 SQLite 原生依赖后为 5,036 通过、14 跳过。该改动尚未进入安装包，必须以包含此修复的新三端候选完成构建和实装验收。

## 2026-11-23 BrowserSkill 精确包失败复盘

Windows 实装 `45084343092` 使用 `45082249126` 的精确安装包。失效回执确认输入框同时显示网址草稿和发送按钮，前端将其提交成普通补充；运行时 attention 列表为空，原 Turn 的用户输入仍 pending，`request_user_input` 工具已 aborted，任务停在“正在根据补充网址更新只读网页读取范围”。修复前候选不再用于 BrowserSkill 结论。新的 `composerReplyQuestion` 选择器、任务栏混合控件回归 16/16、类型检查、lint 均通过；新候选尚未生成。并行启动界面验收 `45084343835` 在 `release-mac` 制品上传前启动，Apple Silicon 与 Intel 都在“解析 macOS 安装包”阶段失败，尚未安装应用，必须待新候选包齐备后重跑 Mac 检查。

同一候选的升级矩阵 `45084343320` 中，0.5.7 覆盖安装和 0.5.10 左下角升级均通过，版本、安装目录、ASAR、工作区、偏好和会话回读一致。设置页路径完成了原生安装阶段并检测到新窗口，但在后续 teardown 等待所有同路径进程退出时超时，阻断了版本与数据回读。候选安装器已下载完整，回执不表示设置页路径已验收通过。已将验收清理改为等待本次升级后启动的主窗口 PID，再以新包重跑并确认读回。

Windows BrowserSkill 回退在候选 `ea0de273` 再次失败，实装 `45088487514` 绑定安装器 SHA-256 `ca46c525c9fd86b4aa69328c8510907e6601fde37db2c6714a05ba608dba01bb` 和 ASAR SHA-256 `8a558471e7420cb4a20405a91741a7796dfb5ca1c552e4f0cba128e2a3aa2461`。提交后运行状态仍是等待网址，URL 成为普通补充，原问题 pending，未开始新 Turn。继续复核发现 TaskRunStatusBar 与 TaskAttentionCard 同时更新同一个 Composer 问题状态，子卡随消息内联而卸载时可能清掉任务问题绑定；Workbench 又先处理不同 request ID 的普通问题，可能绕过任务专属回答接口。现收敛为任务栏单一绑定来源，任务回答优先使用精确请求 ID；验收在发送前核对 Composer request ID 与唯一待答事项一致，发送后核对同任务开启新 Turn。修复已在源码，尚未进入制品。

## 2026-11-23 对话内补答回执修复

提交 `0c0952f5` 让任务问题在唯一的任务栏状态源中绑定到原问题 ID；任务补答优先走 KUN 的 `/v1/user-inputs/{id}` 路径，普通对话问题仍走原消息输入路径。验收现在检查输入框绑定 ID 与待答事项一致、KUN 以 `user-input:{id}` 幂等键恰好保存一次补充、待答问题已结算、任务仍属于原对话。普通补答保留当前 Turn，浏览器只读范围扩展单独要求新 Turn。发布回执拒绝问题 ID 不匹配、重复输入、任务或对话错绑。另将锚定菜单测试改为等待实际关闭，避免固定 30 毫秒时延误判。

源码级验证通过。`npm test` 在 Node `v26.13.0` 加 `--localstorage-file` 后为 5,038 通过、14 跳过；首次无该 Node 本地存储参数的运行有 3 个 DOM 测试文件失败，补参数后均通过。`npm run test:release-gate` 为 585 通过、1 跳过，缺少 PowerShell 的用例由宿主跳过。网站到 PPT、核心回执、启动、Windows 更新与 UI 验收驱动 183/183；任务问题和锚定菜单 DOM 用例 20/20；KUN 任务协调器与持久化输入门 46/46。类型检查、修改文件 ESLint、差异检查和生产构建通过。

本机 KUN 运行时的受控模型旅程读取真实 `https://www.railwise.cn/` 首页正文 39,126 字节，调用内置 PPT Master 和原生质量检查，生成并解包校验可编辑 PPTX 13,116 字节。回执存于 [source-web-ppt-controlled-0c0952f5.json](../../evidence/v0.5.11/source-web-ppt-controlled-0c0952f5.json)，本机临时绝对路径已替换为仓库相对路径，来源和成品摘要保持原值。该文件 SHA-256 为 `deaa1efe7f5ea4609ddfee40310f7115eba1b09722ffe4c253da1a0af71ff411`。这是本机运行时及合成模型证据，不是安装包界面或真实模型验收。

`0c0952f5` 尚未进入 GitHub Actions 的新质量运行或三端候选安装包。下一步需推送代码，重跑 Quality 和候选构建，再对同批包重跑 Windows BrowserSkill 与任务补答、附件/PDF/技能插件、0.5.7 覆盖和 0.5.10 两个升级入口，以及 Mac 双架构启动和表格。真实模型三个 Actions 配置项、已登录大单网/Ego、国内普通网络 Windows 与现场 OCR 仍待补实测。正式渠道仍为 0.5.10，此处没有发布验收结论。

## 2026-11-23 精确候选安装验收与对话记录修复

精确三端候选构建 `45095979078` 对源码 `a6731f38` 成功，Windows 安装包及 Mac arm64/x64 签名、公证、资源完整性通过，三端候选清单通过；发布与更新源仍跳过。Mac 安装包 SHA-256 分别为 arm64 `5bdb0daeabce789786cadcfd875861f09e841b0a5604306a517696083f241a41`、Intel `c41239cffd4e0f1dd2866b8adb96e4fc6d90f1fc9956798714fd36fb294f5bab`；Windows ASAR SHA-256 为 `9aa7465feeb8b9090ed92b5bd74b115208d33c21a267b44b95573bf6c6527c61`。

同包实装回执为以下结果。

| 验收项 | 实测结果 |
| --- | --- |
| Windows 任务、计划、附件、PDF、技能与插件 | `45103889871` 通过。包括原对话 HTML 成果/每日计划、附件导入和 PDF、技能与插件选择、窄导航及窗口菜单。它不是 BrowserSkill 回退流程。 |
| Windows 启动外观 | `45102709339` 通过，运行 `a6731f38` 的确切候选。 |
| Windows 冷缓存市场 | `45102306812` 通过。Superpowers、Blender Skills、Docling 与 Playwright MCP 的实际安装/调用检查均通过。 |
| Windows 更新 | `45102307656` 通过，0.5.10 设置页、左下角两种入口及 0.5.7 覆盖安装都完成版本和原数据读回。 |
| Windows BrowserSkill 网页回退 | `45103889026` 未通过最终对话可见性断言。精确候选实际启动浏览器并走到交付阶段，但原问题随待办从收件箱移除后，没有在正文保留。现在任务正文从 KUN 任务输入记录恢复已答问题及回复，显示来源问题和答案。该应用改动在 `a2a0fae1`，必须由新候选验证后才计通过。 |
| Mac Apple Silicon 网页到 PPT、Intel 表格 | `45102280580` 实装发现两个验收缺陷。arm64 回执等待已从待处理收件箱消失的问题仍返回“已解决”状态，造成误报。Intel 表格脚本按同名按钮文字点中了顶部禁用的新建会话，而没选侧栏可用按钮。驱动已分别改为确认问题从待办消失，并等待和点选启用的无障碍按钮。 |
| Mac 后续包校验 | `45103889555`、`45104363845` 都在加载应用前被精确源码白名单拦截，因为变更后的驱动源不在包后验收白名单。已补上仅限该验收测试脚本的条目。重跑时发现 `TaskRunStatusBar` 读取问题提示早于时间线挂载也会抛错，现用空内容读取处理。含这些驱动修复的 Mac 实装已启动于 `45104363845` 前的旧候选批次但需用新包重跑。 |

同轮中先后两次将互斥的“启动外观”和任务/网页流程组合到 Windows run，分别在产品验收入口前失败。已拆成独立运行。之后精确 Mac 候选在应用实装中确认 Windows 式禁用按钮选择和待办移除探针问题，Windows BrowserSkill 则确认真实来源问题未留在正文。三项均已在源码修复。`a2a0fae1` 增加原对话内的“需要的信息/你的回复”记录，并以任务 ID 和 KUN `user-input:{requestId}` 回执恢复；DOM 测试 11/11、全量 Vitest 5,039/5,053、类型检查及修改文件 lint 通过。全量测试另有 6 个文件、14 个测试按项目现状跳过。

最新应用修复已提交为 `a2a0fae1`。GitHub Quality `45105469762` 正在运行，三端候选 `45105520580` 正在构建。其候选通过后，将复跑 macOS 双架构表格与 arm64 受控 PPT、Windows BrowserSkill 正文记录，并复验已通过的 Windows 主任务和附件流程。Windows 更新、市场和启动回执绑定前一候选 `a6731f38`，可作为该提交中的相同应用制品历史实装证据。真实模型官网到 PPT、已登录大单网/Ego、国内普通网络 Windows 与 OCR 现场条件仍未完成。正式渠道仍为 0.5.10，不是发布授权。

## 2026-11-23 补答后原问题丢失修复

精确 Windows 安装验收 `45108408534` 使用 `a2a0fae1` 候选及其原始 ASAR，已实际运行 BrowserSkill、读取验收网页、生成并打开 `website.pptx`。该次仍失败，因为答复后的对话正文只显示网址、完成状态和成果，未保留最初的问题。截图确认这是真实呈现缺陷，不是验收定位器问题。根因是问答历史只放在 `TaskRunStatusBar` 的 React 本地状态中，而 `MessageTimeline` 会把任务内容从旧 Turn 移到最新 Turn，导致组件重挂载；重开对话也会丢失该状态。

当前源码改为在原对话任务内容中从 KUN 执行线程读取已保存的自由文本 `user_input`，并以同一个 `requestId` 匹配任务输入中的 `user-input:{requestId}` 幂等回执。组件重挂载和重开会话都可重建“需要的信息/你的回复”。网页到 PPT 验收现在等待原问题恢复后再断言；DOM 回归显式卸载并重开组件验证历史持久恢复。定向回归 79/79、全量 Vitest 5,039 通过/14 跳过、发布门禁 585 通过/1 项因宿主缺少 PowerShell 跳过、类型检查、修改文件 ESLint 和差异检查通过。

以上修复尚未进入安装包。`45105520580` 的三端候选来自 `a2a0fae1`，Mac 双架构制品检查通过，但不能证明此处代码。必须把当前源码打成新候选后重跑 Windows BrowserSkill/原对话问答/成果、Windows 附件与市场，以及 Mac 双架构启动和 Univer。真实模型三项 Actions 配置仍未出现，故真实模型官网到 PPT 仍待凭据；大单网/Ego 和中国大陆普通网络 Windows 仍需对应现场回执。正式渠道保持 0.5.10。

## 2026-11-23 更新提示可见性修复

同批 Windows 0.5.7 覆盖安装、0.5.10 设置页和侧栏双入口实装 `45113044068` 都完成 0.5.11 安装并保留工作区文件、偏好和原会话。安装器 SHA-256 为 `02b5bf40f8d24fc16a855a2a341218b004082633f100e7bced4f82cce3aead44`，安装后 ASAR SHA-256 为 `ac72ce325d3a0a5692aed7e715e49c7da37aa18effb063008e8c6f48208bb83c`。不过，设置页和侧栏升级回执都显示 `releaseHighlightsVisible=false`、`releaseHighlightsFirstLaunchRecorded=true`。旧验收器把显示标记当成用户看到提示，误判通过；覆盖安装路径实际显示了更新提示。

根因是 `ReleaseHighlights` 首次渲染时就写入已看标记，再安排提示状态更新。更新后路由或窗口切换可能卸载组件，使用户没看到提示，但后续挂载又因标记已写入而不再显示。现将持久化移至用户点击关闭时，并让验收等待首页实际出现当前版本提示；标记已写入但提示不可见会判失败。回归覆盖显示前卸载/重挂载、关闭后不再显示；`ReleaseHighlights` 定向测试 3/3，Windows 更新器回执测试 152/152，类型检查及修改文件 ESLint 通过。

`45113044068` 只证明此前候选的升级和资料迁移，不能证明提示可见性。后续精确候选结果见下方 2026-11-23 实装复核。

## 2026-11-23 精确候选实装复核

发布构建 `45115646587` 的 0.5.11 候选基于提交 `21ba17032908c8942143715981313f05f283d2dc`。此候选未发布到稳定渠道。

Windows 更新矩阵 `45118772843` 对同一候选完成三条实际升级路径。侧栏和设置页从 0.5.10 升级，覆盖安装从 0.5.7 升级。三份原始回执均显示版本读回通过、`releaseHighlightsVisible=true`、`releaseHighlightsDismissalRecorded=false`，配置、工作区文件、偏好及原会话均保留。Windows 安装包 SHA-256 为 `098fcc85396c35f48fa30fe3d9a41499e21aa431dcd601d10bfef889b24e914e`，安装后 ASAR SHA-256 为 `2b63f6e3f81bfba805a7fe864875b7db5ea357fffd7f16cd63b7851b70d26244`。原始回执随 Actions run 保存在 `frozen-windows-gui-upgrade-45118772843-{sidebar,settings,overlay}` artifacts 中。

Mac 双架构精确候选实装 `45123172020` 已验证安装包签名、公证及启动界面中文全称，两个架构都实际打开工作台。arm64 安装包 SHA-256 为 `4b651c4fa1bb066b47728e5be6e0a04b822dc91c548f0fd8644d666ceadc63a4`，实装 ASAR 为 `e51f9bf525464b5176f34ee6cd1c0d7ba788599dd253faf93da9942cbc45b412`；Intel 安装包 SHA-256 为 `fc6d364ae613327bcc430eb043e3fec9aed2a6a3615c9d40a67f7d35dcfade4a`，实装 ASAR 为 `26d9270d4250b238932178bd2e8d96bc504db83e452c4f729916b09f0942feba`。两个端到端作业未通过后续旅程，因此启动结果不能替代网页到 PPT 或离线表格的验收。

同候选 Windows 安装包的核心旅程原始回执已下载复核，均绑定源码 `21ba17032908c8942143715981313f05f283d2dc`、安装包 SHA-256 `098fcc85396c35f48fa30fe3d9a41499e21aa431dcd601d10bfef889b24e914e` 和安装后 ASAR SHA-256 `2b63f6e3f81bfba805a7fe864875b7db5ea357fffd7f16cd63b7851b70d26244`。

| Windows 实装回执 | 已证明的旅程 |
| --- | --- |
| `45118773004` | 原对话内任务、HTML 自动/手动预览、实际系统时钟到期计划。 |
| `45118772862` | 技能/插件实际调用、约 40 MiB 扫描 PDF 与中文文字 PDF、文件选择/剪贴板/拖放、窄窗口菜单。 |
| `45118772470` | 国内镜像配置下的冷缓存技能安装、Playwright 页面读取、Docling 启动。未证明 Docling 转换。 |
| `45118772308` | 真实 Chrome 扩展执行的 BrowserSkill 只读回退、原对话补答和同一任务续接、可编辑 PPTX 交付。模型为受控夹具，不能证明真实模型读取官网。 |
| `45118772843` | 0.5.10 设置页与侧栏升级、0.5.7 覆盖安装、三条路径更新提示可见和资料读回。 |

Windows 核心门禁的 Video Shotcraft 与审批续接已通过同批候选实装 `45130202679`，包括合成 PDF 读取、同任务中断恢复、一次审批、登记 MP4、24 帧解码及从对话打开。Windows 启动画面在 `45130202068` 通过，中文全称、无版本行、100/125/150% 三种缩放和工作台冷启动均有实装记录。Windows 仍缺真实模型官网 PPT 和大陆实体网络安装回执。

Mac 旧实装 `45135093179` 与 `45138758705` 的失败均已保留为历史回执。前者发现 LibreOffice 默认关联未注册，后者的 Intel 失败来自 XLSX 夹具共享字符串索引错误；arm64 受控 PPT 只留下 `Runtime.evaluate timed out`，没有记录超时发生在哪个对话步骤。当前驱动已修复夹具和入口定位，并新增逐阶段原始回执，等待重跑以定位受控 PPT 的超时。`45140540694` 不运行 PPT，只验证了 Mac 双架构启动和离线表格。

Windows Video Shotcraft/审批续接实装 `45130202679` 和启动实装 `45130202068` 绑定同一候选安装包和 ASAR，均通过。Mac PPT/Univer 驱动专项测试与精确安装来源测试 36/36、Windows 验收合同测试 21/21、类型检查、lint、差异检查通过。发布门禁最近本地运行 585 项通过、1 项因宿主缺少 PowerShell 解析器跳过。Quality `45135062604` 已通过；Quality `45140507656` 在 Mac 双架构实装期间也已通过。

## 2026-11-23 Mac 双架构启动与 Univer 实装

精确候选实装 `45140540694` 对 Apple Silicon 与 Intel 均通过。两架构使用发布构建 `45115646587` 的同一 0.5.11 候选，候选源代码为 `21ba17032908c8942143715981313f05f283d2dc`，验收驱动为 `31872ec4445aa4f46c6891adced60bf60d4fa83a`。两端都通过安装器签名、公证、工作台冷启动、中英文启动画面及 Univer 离线表格流程。

| 架构 | 安装器 SHA-256 | 安装后 ASAR SHA-256 | 启动画面回执 SHA-256 | 表格回执 SHA-256 |
| --- | --- | --- | --- | --- |
| Apple Silicon | `4b651c4fa1bb066b47728e5be6e0a04b822dc91c548f0fd8644d666ceadc63a4` | `e51f9bf525464b5176f34ee6cd1c0d7ba788599dd253faf93da9942cbc45b412` | `6f297c37e1c83a8bf22fe721c902c382f81bd9293d7481e8270a344957f15c33` | `a6cb94be720f69a97b3879ecca4c3194cac2a0ebbb72186687ca0e6ee7bf0de3` |
| Intel | `fc6d364ae613327bcc430eb043e3fec9aed2a6a3615c9d40a67f7d35dcfade4a` | `26d9270d4250b238932178bd2e8d96bc504db83e452c4f729916b09f0942feba` | `b7d7fb8caa162adbbb04f516b1fd8a79572297bb85a5feae26dd63edd6582a62` | `e1aef42fd0ddaa52590de9631459b6861f65d0083515721d46180c00c78134d6` |

每个架构均验证 `=SUM(4,5)` 计算结果 9、撤销、外部修改冲突时保护原件并保存副本、中文 CSV 导入/导出保留前导零与小数、多工作表保存重开，以及 Excel 只读网格中的工作表名、稀疏行列位置和原文件字节不变。候选安装包大小分别为 arm64 `410514030` 字节、Intel `419389274` 字节。启动截图回执含中文全称、无版本行、深色中文界面截图和工作台启动确认。

这次表格旅程确认了“在系统应用打开”入口可见，但没有点击该入口；首次打开耗时也未采集。Windows 表格仍无同批安装包实装结果。真实模型官网到 PPT 仍等专用 Actions 模型配置，Mac 受控 PPT 的逐阶段复跑待本次验收驱动更新进入 CI。正式渠道仍为 0.5.10。

## 2026-11-23 Windows 表格与 Mac PPT 验收修正

Windows 安装验收新增独立 `run_windows_spreadsheet` 路径，下载指定 release run 的精确 Windows 安装包，在已安装应用的临时配置中离线实测表格。验收覆盖公式、Ctrl+Z、外部修改冲突另存、中文 CSV、表格保存后通过可见工作区网格重开，以及 Excel 只读网格和原件摘要。`offline-spreadsheet` 已加入 Windows 核心旅程，回执绑定验收运行读取的版本、源码提交、安装器 SHA-256、安装后 ASAR SHA-256 和构建运行号，不固定到单一版本。

Windows 实装 `45150932776` 已通过。安装器 SHA-256 为 `098fcc85396c35f48fa30fe3d9a41499e21aa431dcd601d10bfef889b24e914e`，安装后 ASAR SHA-256 为 `2b63f6e3f81bfba805a7fe864875b7db5ea357fffd7f16cd63b7851b70d26244`。实装验证公式 `=SUM(4,5)` 得 9、Ctrl+Z、冲突另存、中文 CSV、双工作表保存后在可见网格重开并读回公式、Excel 只读网格及原文件摘要。UI、安装与核心回执的摘要依次为 `2f47948568034f4ba0b5320149e5280417aa1f2bb3afdfee889eeb64932ed5f5`、`44c58f2d1d964b7516f60748c34699af8f43ec367a2ae9106afc7f4a23474cab`、`705da8abc5a76d419244b2b5e45d601f9029a6e135e4568b85ce25ca545eab0f`。第一次运行的表格检查已全部通过，失败的是表格后多余的通用导航流程；隔离专用旅程后复测通过。XLSX 系统应用入口目前仅验证可见，没有点击 Office/LibreOffice；首次打开耗时未记录。

Mac PPT 受控旅程在 `45150552625` 到达外部打开阶段。原验收流程先用 headless LibreOffice 预热，再从成果卡调用系统打开；回执观察到 LibreOffice 进程存在却没有窗口。headless 预热已移除，PPTX 关联仍在隔离 HOME 下注册，更新后的精确候选复跑为 `45152019866`，结果待回执。真实模型三项 Actions 配置仍未存在；`gh secret list` 中没有 `RAILWISE_QA_MODEL_API_KEY`，Actions variables 中也没有 `RAILWISE_QA_MODEL_BASE_URL` 或 `RAILWISE_QA_MODEL`。当前正式渠道仍为 0.5.10，没有发布。

## 2026-11-23 最新验收进展

对 0.5.11 精确候选 `45115646587` 的 Mac 双架构实装 `45158416825` 未通过。Apple Silicon 到达成果打开阶段；回执中原对话任务、网页读取、可编辑 PPTX 检查均已完成，但没有观察到 LibreOffice 进程或目标文档窗口。随后运行的 Intel 流程在公式保存阶段失败，公式落在第二行。两个结果都绑定原候选安装包，不能作为通过回执。

Intel 表格坐标偏移的原因是 `ed8862bf` 将点击位置由网格 `y + 30` 移到 `y + 59`，比一行 22 像素多 29 像素。Apple Silicon 回执原本声明点击 A1，实际保存公式在 A2。验收驱动现在通过 Univer 的单元格地址组件核对界面选区，必要时根据真实选中单元格校准点击偏移，并继续严格校验 A1/B1、撤销和冲突另存位置。地址解析与坐标映射测试 3/3 通过，修改文件 ESLint、差异检查、主仓/KUN 类型检查通过。新驱动还未随新候选包实装验证。

Mac PPT 打开阶段的诊断也已加强。驱动记录 PPTX 默认应用、LibreOffice/soffice 进程、前台应用窗口和原对话中显示的错误原因；验收不会重复触发打开动作。驱动移除了在应用临时 HOME 中调用 `duti -s` 的步骤，避免误将 HOME 当作系统 LaunchServices 隔离。诊断测试 3/3 通过。`45158416825` 使用旧诊断脚本失败，具体系统打开原因仍待新驱动对同一候选复测。

成果卡还发现真实错误原因被渲染层丢弃，只显示通用失败文案。现改为展示主进程返回的可读原因，并新增任务成果打开失败 DOM 回归。该项修改了应用 UI，必须包含在下一候选包及同包验收中。

Windows Docling 专项 `45164369592` 使用候选 `45115646587`，工具启动、冷缓存镜像 CSV 后端、中文内容保留以及两个技能调用通过。回执明确表示实际文档转换依赖 Docling 服务或本机扩展，因此 **没有证明 PDF/DOCX 转换**。

本机验证结果为 `npm run openspec:validate` 13/13、release gate 586 项通过且 1 项因缺 PowerShell 跳过、全量 Vitest 5040 项通过且 14 项跳过、主仓与 KUN 类型检查、生产构建和修改文件 ESLint 通过。全量 Vitest 需要通过 `NODE_OPTIONS=--localstorage-file=...` 提供 Node 本地存储文件；不带该参数的运行有 3 个 DOM 文件因宿主环境缺失 `localStorage` 失败。本机生产构建和测试不等于安装包验收。新增应用改动及最新验收驱动仍需进入 Quality CI 和下一批精确候选。

尚未关闭的发布阻塞包括 Mac 双架构 Univer 修正驱动实装、Mac PPT 系统应用打开、真实模型官网 PPT、Ego 登录后的原 Space 与大单网只读流程、国内普通网络 Windows 安装以及 Docling 实际文档转换。Ego 页当前提示账号已在其他设备登录，现场只读核查已暂停并交还原 Space，等待用户重新登录。稳定渠道仍为 0.5.10，本轮未发布。

## 2026-11-23 暂停任务问题回答修复

根因确认：KUN 只接受 `waiting_user` 状态下的任务问题答复。任务被用户暂停后，任务专用输入框仍提交到 `/v1/user-inputs/:id`，返回 409；同一问题若镜像在会话时间线中，普通 `UserInputBubble` 也会调用该接口，造成另一条失败路径。共享输入框还可能优先绑定任务问题，覆盖另一个普通会话待答问题。

当前源码只在 `waiting_user` 且没有其他不同的待答会话问题时绑定任务回答。暂停任务的问题在任务卡和时间线都改为只读说明，并指向现有「继续任务」操作；Workbench 从任务快照排除暂停任务的问题，再选择普通会话可答问题。KUN 对暂停态答复的拒绝规则保持不变。

该修复合并前，源码聚焦 UI/路由回归 24/24、全量 Vitest 5045 项通过且 14 项跳过、发布门禁 586 项通过且 1 项因宿主缺 PowerShell 跳过、OpenSpec 13/13、主仓与 KUN TypeScript 检查、修改文件 ESLint、差异检查及生产构建均通过。Vitest 中 DevBrowserPanel 的本地预览夹具会输出连接拒绝日志，测试进程仍以 0 退出且全部断言通过。合并前的源码尚未进入候选包；候选构建和包体证据见后续记录。暂停后继续、镜像问题只读显示及普通会话问题仍可回答尚无安装包实装回执。真实模型官网 PPT 所需 Actions 模型配置目前仍未出现。正式渠道仍为 0.5.10。

## 2026-11-23 合并候选与 Apple Silicon 包验签

修复已合并到 `main`，提交 `cd2abcf0c9bf17a0c087d1cf2506530de576dc75`。最终提交的 GitHub Quality 两组 run 均通过，包含 OpenSpec、品牌边界、license、ESLint、主仓和 KUN 类型检查、全量主仓/KUN 测试、发布门禁、生产构建、Electron smoke 与 Windows 持久化检查。

候选构建 `45183135008` 使用 `candidate_only=true`、`prepare_public_artifacts=true`、`publish_release=false`，来源为上述 `main` 提交。三端候选构建、PPT Master sidecar 往返验证、镜像锁覆盖、三客户端制品摘要校验以及 macOS 双架构签名/公证复核均通过。正式渠道未改变，候选未发布。

从候选 artifact `candidate-installers-0.5.11-410` 选择性提取 Apple Silicon DMG。DMG 为 410,509,343 字节，SHA-256 `7dead1d1ef872e0159c654c83fc20989bffd91a8d9016650b4047847c583d686`，与同包 `SHA256SUMS.txt` 匹配。复制到隔离临时目录后，`codesign --verify --deep --strict`、Gatekeeper `spctl --assess` 和 `xcrun stapler validate` 均通过；系统报告 Developer ID 签名及已公证。Info.plist 与 ASAR 版本为 0.5.11，Bundle ID 为 `com.wangjiawei508.workgpt`，ASAR SHA-256 为 `2a13b5c628d5e394cf5f7c66c2e6d74930a4878800a92ba8d7da83ea1a22a30c`。候选清单中的 Intel DMG SHA-256 为 `c20409249dddc940cfcd4b26c45e789163d229ad31a397718825e6f02942a398`，Windows x64 EXE 为 `492b7a7027048f57c8124d5285ff0d3de932b0add0648f233e02978dfdee635e`。

**实装 UI 验收仍未通过或未执行。** 本机已有多个正式 RailWise 窗口使用相同 Bundle ID。Computer Use 对临时路径启动返回超时，Finder 打开也复用已有窗口。为避免关闭用户当前窗口，没有通过强制退出正式应用来规避同 Bundle ID 冲突。因此这份已验签 DMG 的冷启动、暂停任务问题只读态、继续后答复及其他任务旅程尚无候选包实装证据。Windows EXE 也未在 Windows 设备安装。真实模型官网 PPT 所需 Actions 配置仍缺 `RAILWISE_QA_MODEL_BASE_URL`、`RAILWISE_QA_MODEL`、`RAILWISE_QA_MODEL_API_KEY`。正式渠道仍为 0.5.10，不能据此发布 0.5.11。

## 2026-11-24 原对话续接与首次运行授权修复

根因与修复：首次运行创建的默认工作区之前没有对应的工作区信任记录，内置 PPT 导出器因此遇到持续的权限拦截。现在只有设置文件不存在、应用亲自创建其受管默认目录时才将该目录登记为 `workspace-write`。既有目录、符号链接、已保存配置和显式限制保持原值。Electron 与 KUN 读取同一份信任清单。任务暂停与输入竞态也已复现，KUN 会先将问题记为取消，晚到的状态更新造成一次性读取看不到原问题。暂停卡现在也接纳该中间态作为只读显示；继续后重新询问未答问题，已经保存的答案不重复询问。等待用户回复时，对话正文显示「暂停」操作。

隔离的 macOS Apple Silicon 源码预览回执保留在本机临时验收目录，未纳入版本库。测试源码提交为 `fb0d9daf95b67835cbd746d8dbd3edb4e36f9ea2`，渲染包 SHA-256 为 `2925303dba2d78c56d6c850c1824d1a6807ac135e7e02c646aa1b1e7dda7bd11`。空配置冷启动创建 `default_workspace` 并读回 `workspace-write/workwise-created`。界面内暂停后原问题仍显示、输入框解除旧请求绑定；在原对话继续、答复及单次批准后，同一任务完成。回执确认一条答案记录、一次文件写入调用和实际文件内容。该源预览不等于签名候选安装包验收，暂停后的应用重启恢复未测。

本次聚焦界面测试 17/17，工作区首次初始化、KUN 用户输入恢复及权限相关聚焦测试 141 项通过，主仓与 KUN 类型检查、ESLint、生产构建及隔离 UI 流程通过。最终修订前源码 `0d6f428a` 的 GitHub Quality CI run `45278698866` attempt 2 三项必需检查均通过。该源码检查之后只更新了本台账记录。当前仍须用下一批精确 macOS 与 Windows 安装包复验；真实模型官网到 PPT、Windows 安装包实装和旧版原地升级、付费登录站点及现场网络流程仍未形成这批源码的制品回执。正式渠道仍为 0.5.10。

## 2026-11-24 精确候选实装复验

应用修复合入提交为 `bf61f10d95a23bbe6c7c8f98d54b718e6a33f049`。Release workflow `45286904679` 仅构建候选，`candidate_only=true`、`prepare_public_artifacts=true`、`publish_release=false`。Windows x64 构建、macOS 两架构、三端候选身份和更新元数据核对通过；GitHub Release、Stable 更新源和官网发布均跳过。

Windows 精确安装包来自该 run，版本 `0.5.11`，安装器 SHA-256 `21b559a958f8e810c37ba20961de5819d6ece83cc3e4e2bd2e37063143600709`，安装后 ASAR SHA-256 `a605ebb36f89d822836fa23feba6e730d646fb88202e11a319e816c851147c9d`。此候选 EXE 的 Authenticode 状态为 `NotSigned`。macOS Apple Silicon DMG SHA-256 `a4171d87e02faa8097419b9dde3084e95dc89d41b21dbe0588269643332b5b19`，Intel DMG SHA-256 `1f07503fdeccfb26ca80f1a8a8841d80377f580986cabbb5f85a6ac8ca38a4df`。两架构在 workflow `45308995334` 的精确安装、代码签名、notarization staple、启动和离线表格检查均通过。启动截图和原始 JSON 回执保留在该 Actions run 的两个 `exact-mac-startup-appearance-*` artifacts。

已通过的精确安装包流程如下。

- Windows 对话任务与浏览器 `45296531733`。实际安装包中任务在原会话完成，HTML 经过文件摘要校验、自动预览及手动预览，计划结果回到原对话。浏览器技能安装并在任务中热加载，读取两个受控来源、核对来源回执，并生成 HTML。
- Windows 附件、技能与插件 `45296578338`。文件选择、拖放和系统剪贴板导入均实际执行。8 个混合附件折叠为 2 行、展开后保留草稿，损坏项提示通过；包括 40 MiB 合成扫描 PDF、中文 PDF、损坏 PDF、图片、中英文长名和同名文件。扫描与文字 PDF 均实际发送。Video Shotcraft 技能和插件入口实际调用。
- Windows 冷缓存市场 `45296663378`。阻断 GitHub、npm、PyPI 等上游主机后，Superpowers 从内置包离线安装并调用，Blender Skills 经睿威镜像安装并调用；Docling 发现 19 个工具，镜像 CSV 后端保留中文内容。回执不证明 Docling 对 PDF/DOCX 的完整转换，也不证明 Blender Skills 可以断网安装。
- Windows 网址到 PPT 浏览器回退 `45296747874`。直接网页读取被策略阻断后，隔离 Chrome 与 BrowserSkill 扩展读取受控来源，生成原生可编辑 PPTX，成果按钮在原会话内点击。
- Windows 启动画面 `45296792601`。浅色英文和深色中文启动均显示完整中文全称且隐藏版本行；100%、125%、150% 缩放读回通过，窄工作区宽度无水平溢出，首次打开显示「本版更新」。
- Windows 离线 Univer `45296837530`。公式计算、撤销、外部修改冲突另存、中文 CSV 保留前导零和精度、多工作表保存重开及 XLSX 只读预览全部通过。
- Windows Video Shotcraft `45296910991`。在私有协议夹具和合成素材上通过中断后原任务恢复、审批、技能资源读取、视频登记、原对话打开及 MP4 24 帧解码。该私有非商用评估不分发 Remotion，不能替代用户真实素材/模型验收。
- Windows 更新 `45297023133`。从正式 0.5.10 设置页和侧栏分别升级到同一候选，从正式 0.5.7 覆盖安装到同一候选，三项均通过并读回原有资料。
- macOS Apple Silicon 与 Intel 表格 `45308995334`。原失败是驱动将首个点击点设在 `y + 59`，相对 22 像素行距多偏一行，并依赖未显示的单元格地址标签。驱动修复后，在同一批签名 DMG 上两架构均通过公式 `=SUM(4,5)` 得值 9、撤销、冲突另存、中文 CSV、多工作表保存重开及 XLSX 只读预览。该 run 的驱动源码来自主分支提交 `afe5f902c05ae5a572a21577e915960a935d3ea4`，应用 DMG 与先前候选字节一致。

## 2026-11-25 最新上游与实装状态

版本快照截至 2026-11-25 11:48 UTC：当时 Univer 最新 `1.6.1`（Apache-2.0）。11:49 UTC 上游发布 `1.6.2` 后，旧候选版本随即过时，详见下方刷新记录。AG-UI 的 npm 核心包仍为 `1.0.5`（MIT）；上游 11 月 21 日发布没有产生新的 `@ag-ui/core` 版本。BrowserSkill CLI 和扩展仍为 `0.5.0`。Playwright MCP/CLI 最新为 `0.0.86`/`0.1.25`（Apache-2.0）；Docling MCP 最新为 `3.5.1`（MIT）。它们的目录版本和启动参数已更新，但离线镜像锁及重建后的 Windows、macOS 安装包尚未通过验证。Superpowers `v7.0.2`（MIT）已固定到 release tag 对应的 commit `22f0b463e7a5e579904dd6211a520321035526f7`，catalog 列出 15 个 skill，现有三平台锁条目通过目录校验。Video Shotcraft 已从审计过的 `59f3e9b9e936ff2bce0e18446226d770a3f2f61f` 前进到 11 月 25 日已验证签名的上游 HEAD `226813b3e2e6a0a346358210bfa0d83b24b3a8d3`。完整 diff 仅增加 5 份 README 的 OpenLux 赞助与推荐链接文案、更新赞助归属说明、增加一张赞助 PNG；Apache-2.0 LICENSE 的 Git blob SHA `71ffb8bd20fc152507c1b3dd48f2890bef493ca6` 未变。当前过滤保留 README 和归属文本、排除赞助 PNG；新文本含上游赞助链接及价格宣传。已从与旧锁摘要、大小逐字节匹配的 Mac/Windows 旧镜像重建新分发包：通过 GitHub API 对照固定 commit tree blob SHA 获取新版文档、LICENSE 和 Skill；只应用完整审计 diff 中的文档变化，PNG 路径列入分发回执并从 ZIP 排除。两平台 ZIP 的 Apache LICENSE 字节均匹配上游 SHA-256 `b2ce9877a55547ada9b870150664d1468ff777e67cc9888806a73927d31c5771`，ZIP 完整性校验通过；Mac arm64/x64 共用 `85b5f42fd16fd53533ce973f770caafdf73573443db852888d40c11064a4a6e5`（3,054,774 bytes），Windows x64 使用 `3fae5608c3ec2f19de4ea99b9967574fe0beac45eb35977cb5ff8ef66a636ff0`（3,067,600 bytes）；package review SHA-256 为 `72ee2e260daa89f37d1daed0047d341c7b94bd231f984d4a498148ce0ab2c88e`。这记录的是目标平台归档生成与内容核验，不代表本轮已在真实 Windows 安装包上实装验收。Blender Skills 最新提交只改 README，RailWise 只分发的 `.claude/skills` 子目录无变化，因此保留现有 pin。PPT Master `6.10.0` 含不适用于整包发行的 AGPL PyMuPDF 路径且有 KUN 不兼容改动，不做整包替换。PDF.js `6.5.438` 为跨主版本升级；MarkItDown `0.1.9` 需要重建 sidecar，均不作为未经兼容验收的替换。KUN 上游 `0.4.6` 使用 PolyForm Noncommercial，不直接并入 RailWise MIT 运行时。Ego Lite 桌面端不随 RailWise 安装包分发；本机 `ego-browser upgrade` 已报告最新，CLI 为 `0.6.3.17`，RailWise 当前支持已审计 `0.6.3` 协议系列的构建号 14 及以上。

QA 模型凭据随后已配置在仓库 Actions secrets/variables 中。精确 0.5.11 候选的 Windows 实装 `45373293407` 和 Mac Apple Silicon 实装 `45373293596` 均确实启用了实时 DeepSeek 流程；Windows 报告“Live model acceptance did not complete”。Mac 原始回执绑定构建 `45357920557` 的候选包与安装后 ASAR，任务已收取网址答复，但随后进入 `waiting_approval`，等待对 `https://www.railwise.cn` 的只读网页读取批准。验收驱动没有处理这张审批卡，故超时退出；它没有证明网页读取或 PPTX 交付通过，也不能归因于凭据缺失。该回执的下一步是修复/验证一次有界审批后原任务续接，并用更新后的精确候选重跑。

**仍待完成的验收与发布条件**

- 真实模型官网到 PPTX 尚无成功回执。`RAILWISE_QA_MODEL_BASE_URL`、`RAILWISE_QA_MODEL` 和 `RAILWISE_QA_MODEL_API_KEY` 已配置为仓库 Actions variable/secret；此前 Mac 实装实际到达 `waiting_approval`，验收驱动未处理原对话中的只读网页读取审批，因此超时失败。Windows 实装也未完成。需修复审批卡的稳定定位与受限批准流程，再用新构建候选执行真实模型旅程。受控/合成结果不替代此回执。
- 任务续接和单次批准的隔离源码预览通过，精确 Windows 包也通过任务、浏览器和 Video 流程；但新候选安装包对“等待开放式回答时点击暂停、重启后原问题仍在正文、继续后回答并只批准一次”的单独回执尚缺。Mac 源码预览通过该流程，不能代替包验收。
- Windows 专项实际任务和计划任务使用受控协议，验证了原会话、HTML 成果、真实系统时钟回执及原会话记录；国内普通网络的实体 Windows 和此前遇到问题的用户电脑仍待现场环境复测。
- 大单网与 Ego 的原登录空间/会话未重新登录核验。Docling MCP 已启动并执行本地 CSV 后端，完整 PDF/DOCX Docling 转换需要另外配置 Docling Serve 或本地转换环境。加密 PDF、OCR 与跨页引用未验。
- 2026-11-20 与更早记录中当时未验证的内容见历史条目。正式 Stable 渠道仍是 `0.5.10`，`0.5.11` 仅为私有候选。此前记录的 Windows 候选 Authenticode 为 `NotSigned`，公开发布前仍需按正式分发签名要求确认适用制品。

截至本次记录，上游依赖版本变更尚未全部进入离线包与安装包；本节中的未通过/待测事项都仍是发布阻塞。正式渠道没有改变。

## 2026-11-25 验收驱动补齐

本轮新增两条隔离的 Windows 精确安装包验收入口：`run_task_pause_restart` 从原对话提交 PPT 任务，在首次开放问题处暂停、正常关闭并以同一配置重启应用，然后在同一对话继续、回答原问题、对唯一的 PPT Master 归属核验审批点一次允许，并校验只有一条持久化答案和一条审批决定；`run_docling_conversion` 在隔离的 Python 3.11 环境安装固定版 Docling Serve `1.39.0`，再通过安装包中精确版本 `3.5.1` 的 Docling MCP stdio 工具转换合成 PDF/DOCX，读取 Markdown 并核对各自唯一标记。回执校验绑定安装 ASAR 摘要和转换服务依赖集摘要。两项分别需要独立的新候选包实装运行；目前仅有脚本/门禁测试，没有据此宣称运行旅程已通过。

Video Shotcraft 镜像现固定到 `226813b3e2e6a0a346358210bfa0d83b24b3a8d3`，本地归档重建、Apache-2.0 许可证字节、三平台 63 个锁项和对应测试均已验证。更新后的归档仍须随当前源码构建新候选，并以精确候选复跑市场与技能调用。当前 PR #120 的 GitHub Quality 检查所用提交为 `c5d92fd0`，不包含本节这些新增改动；Windows 专项与 Electron smoke 已通过，Quality 主作业已通过测试并进入生产构建，最终状态需以最新 PR 检查为准。

本机 Ego Lite CLI 可用；本轮在新建独立 Space 中打开已登录的大单网订阅页并读取到页面内容。这只证明本机 Ego 会话与来源可用，不证明 RailWise 精确候选调用 Ego、登录中断后在同一 Space 恢复，或完成大单网的去重与字段核验。大陆普通网络实体 Windows、原 Mac 升级失败的当次日志仍需现场设备/日志。正式渠道仍为 `0.5.10`，尚未发布 `0.5.11`。

## 2026-11-25 Univer 1.6.2 刷新

Univer 上游在 `2026-11-25 11:49 UTC` 发布 `v1.6.2`（Apache-2.0），包含工作表/范围保护绕过修复、Excel 粘贴保留换行、排序和取值修复。本分支将 `@univerjs/presets`、`@univerjs/preset-sheets-core` 与全部锁定的 Univer 运行依赖更新至 `1.6.2`，并同步随包 NOTICE。依赖差异仅涉及 Univer 组件及其上游删除的四个传递依赖。

本机验证：工作表组件测试 `2/2`；Windows/macOS 表格验收驱动测试 `7/7`；`npm run test:release-gate` 为 `589` 通过、`1` 项因本机缺少 PowerShell 跳过；许可证核对、类型检查和生产构建通过。这些源码结果不替代新候选包的安装和表格实测。Release run `45613679212` 使用旧锁定版本 `1.6.1`，不纳入本轮验收；它的 Windows 精确安装步骤在下载 EXE 前取消，不能算作安装通过。新提交仍需构建同一批 Windows x64、macOS Apple Silicon 和 Intel 包，再运行相应安装和 Univer 表格旅程。
