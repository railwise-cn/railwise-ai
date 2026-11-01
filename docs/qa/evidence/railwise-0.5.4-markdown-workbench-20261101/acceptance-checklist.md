# RailWise AI 0.5.4 Markdown 工作台私有候选验收清单

状态：首期实现、源码验证、隔离实包功能检查与独立 AI 审查证据已保存。最终候选为 **final7**，其 HTML 代码块实际编辑/源码往返/GUI DOCX 导出已独立读回通过；final3/final5/final6 的证据按版本保留。真实模型端到端、正式签名/公证和更新往返未完成，不能据此公开发布。

本目录记录 `RailWise AI 0.5.4` 本地 Markdown 工作台的私有候选验收准备。它不代表公开发布，也不改变版本号、标签、更新源或下载页。

## 候选包准备

候选包必须从干净的冻结提交构建。`electron-builder.cjs` 在 `WORKWISE_CANDIDATE=1` 时要求 `WORKWISE_CANDIDATE_SOURCE_HEAD` 为当前 40 位小写提交且工作树无改动，并将候选应用 ID、应用名、artifact 名和更新地址隔离。

建议命令（在冻结提交和隔离目录中执行）：

```sh
export WORKWISE_CANDIDATE=1
export WORKWISE_CANDIDATE_SOURCE_HEAD="$(git rev-parse HEAD)"
export WORKWISE_DIST_DIR="/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101/dist"
export WORKWISE_UPDATE_PROVIDER=none
npm run build
npx --yes electron-builder@26.8.1 --config electron-builder.cjs --publish never --mac dmg --arm64
```

可先使用本目录 `prepare-private-snapshot.py --source <工作仓库> --destination /private/tmp/<新目录> --execute` 从冻结内容建立仅存在本机的 Git checkpoint。`source-inventory.json` 保存原仓库 HEAD、diff SHA、纳入/排除的未跟踪清单和逐文件 SHA；候选来源 HEAD 是新 checkpoint，不能冒充上游 HEAD。脚本复制依赖，避免原生重编译修改原仓库 node_modules。

本机可用的 `electron-builder 26.8.1` 缓存 CLI：`/Users/wangjiawei/.npm/_npx/c354746b45425777/node_modules/electron-builder/out/cli/cli.js`。可用 `node <该CLI> ...` 替代 npx，避免下载新的构建工具。

候选用户数据、缓存、日志和工作目录应位于同一隔离根目录，不能使用生产 `~/.workwise` 或 `/Applications/RailWise AI.app`。构建前运行 `node scripts/verify-build-freshness.cjs`；构建后运行 `node scripts/verify-packaged-asar.cjs "<candidate-app>/Contents/Resources/app.asar" out <source-head>` 与 `node scripts/verify-packaged-runtime-native.cjs <candidate-dist-dir> mac`。

## 功能检查

- [x] 从隔离工作区打开 `fixtures/markdown-workbench/`，文件树正常懒加载；创建、重命名、移动、删除文件和目录，移动不覆盖已有目标。
- [x] 打开至少 20 个 Markdown/MDX 文件；标签可切换、固定、关闭、恢复关闭。
- [x] 重启候选后，打开标签、固定状态、最近关闭和活动文档恢复；旧 `kun.write.active-file:<root>` 仍可迁移。
- [x] 核心语法源码/可视化往返已有专项回归；实包完成可视化段落编辑、源码切换、任务/代码语言保留与属性修改。frontmatter 在可视化中保护，使用属性面板或源码编辑。
- [x] 搜索显示路径、标题、匹配片段和行号；断链、反向链接和关系视图结果与文件一致。
- [ ] 选区改写、压缩、扩写、换风格、术语统一和提纲/摘要生成均以可审阅差异进入文档，不静默覆盖输入。
- [x] 外部编辑后保存返回结构化冲突；当前编辑和外部内容都可查看。外部重命名、移动、删除有重新定位入口。
- [x] 本地批注可创建、解决、重新打开、按文档查看，且不写入 Markdown 正文。
- [x] 核心 HTML、PDF、DOCX 实际 GUI 导出检查标题、表格、代码、图片和 frontmatter；DOCX 是真实 OOXML。final5 HTML/PDF 与 final6 DOCX 逐项读回通过，高级语法边界见下。
- [x] 超过编辑上限的大文件以只读/截断状态打开，不能继续写回被截断内容。
- [x] 图片、表格、代码块、Mermaid/HTML（如已启用）无越界路径或默认外网请求。
- [x] 中文界面、浅色/深色主题、窄窗口和宽窗口均可读，键盘焦点和关闭操作可达。
- [x] final7 ASAR 匹配冻结源码；真实原生 SQLite 通过；签名和公证状态已如实记录，包路径盘点未发现意外私钥/证书/实际环境文件。
- [x] 对 final7 包内 UTF-8 文本及启动后候选日志完成有明确范围的凭据/夹具标识扫描，未确认实际凭据或夹具正文混入；二进制/编码内容等限制见包报告，不宣称全面安全认证。
- [x] 依赖开发日志和 Playwright 报告统一排除；实际 ASAR 与 managed runtime 在 after-pack 阶段检查，残留会阻断打包。
- [ ] 正式签名、公证和真实 updater 往返（私有候选禁用更新器）。

## 证据记录

每次候选验收保存：包版本和 SHA、候选环境文件、安装路径、ASAR 检查结果、签名/公证结果、窗口截图、功能勾选结果、失败日志、缺陷编号和修复提交。失败或未完成的本地验收阻止公开发布。

## 当前已知边界

实时协作、Hocuspocus/Yjs、GitHub 分享、远程控制和默认语义 Embedding 不属于本期验收。AI 工程审查只能作为内部质量门，不代表监管、厂商互操作或专业签章。

## 电脑验收准备观察

- CUA 原生应用 API 可用，已读取可用应用清单与工具说明。
- 生产 RailWise AI 进程当前使用 `com.wangjiawei508.workgpt`，候选必须用完整私有 bundle 路径或候选 ID 绑定。
- 旧 `dist/railwise-0.5.4-layout-fix-final/mac-arm64/RailWise AI.app` 的版本为 0.5.4；该旧包不作为本轮新功能验收证据。
- 示例目录包含 26 个 Markdown 文档、1 个 MDX 文档、本地 PNG 和 SVG；无远程资源或凭据。

## 源码专项检查

2026-11-01：工作区 store/tab 专项 27 个测试通过；move/IPC/locale/工作区联合 5 个测试文件共 103 个测试通过；`npm run typecheck`（web + node）、专项 ESLint 与 `git diff --check` 通过。此记录属于源码验证，不替代私有候选 UI 验收。

主实现综合验证 32 个测试文件、348 项通过；后续编辑器/UI 专项 21 项、弹层/标签专项 4 项通过。final6 DOCX 导出套件 50/50，独立 AI 审查代理另行复跑同套件通过；相关类型检查、ESLint 和最终 diff 检查通过。这些统计存在重叠，不相加为独立测试总数。

final7 窄修增量：富文本编辑器 16/16、打包策略/真实 ASAR 正反例 2/2，独立 AI 审查另行复跑及相关 ESLint 通过。生产 `src` 相对 final6 只有 HTML 围栏保护语言正则一处变化；DOCX、主进程、preload、共享文件逐字节一致。

## 已执行的电脑操作（final3 / final5）

- final3：打开 index.md 和 20 个工程文档，共 21 标签，随后打开 syntax.md。切换、固定、关闭、恢复关闭、退出重启后 22 标签及固定状态恢复。原始 AX 记录在 screenshots/03、06。
- final3：可视化编辑段落并保存，切源码确认强调、任务、代码语言和 Mermaid 源码完整；源码继续编辑自动保存。frontmatter 错误 title 类型显示校验消息，有效属性保存。批注创建/解决/重新打开成功，正文未污染。恢复历史后新增 restore 和 external 两条，原 6 条仍在；磁盘读回见 final3-functional-readback.json。
- final5：搜索弹层裁切、活动标签不可见均已实包复验修复（screenshots/07、08）。命中显示标题/路径/行/片段；大文件被略过的提示可见。
- final5：并发编辑实际触发冲突，磁盘 EXTERNAL_CONCURRENT_KEEP 和草稿 LOCAL_DRAFT_KEEP_2 同时保留（09）。保存并关闭失败时仍在对话框，取消返回保留草稿，放弃后才关闭。外部 rename 后显示重新定位，定位 relocated-target.md 成功。
- final5：3 MiB 文档显示部分载入、只读、保存禁用（10）；独立 SHA 读回确认原始文件及尾部未变。
- final5：测试文件 disposable-qa.md 经创建、重命名 renamed-qa.md、移动到 assets、删除后 UI/磁盘一致。只操作隔离测试夹具。
- final5：实际 GUI 导出 HTML、PDF、DOCX；HTML/PDF 内容读回通过。DOCX 单引号实体问题记录为 PACKAGED-EXPORT-01 并阻止该包验收，修复后的 final6 需重新导出。
- final5：中文浅色、英文深色，截图尺寸 2560×1680 与 3840×1980（对应 Retina 1280×840、1920×990 窗口）；正文、图片、表格可读。标签 Home/End 导航到首尾，工具模态 Escape 返回。

## final6 最终电脑复验

- 产品版本 **0.5.4**；checkpoint `1864d44d23f5328d5fc435edec9323b57db53ece`；ASAR `1661b8e597be4c69634e0c9b1ebdc4941f7defed6bbc96508e5bf6f103dafe07`。持久隔离安装路径见 `package-verification-final6.md`。
- CUA 按完整路径初次绑定超时，随后按候选 bundle ID 绑定已运行应用成功；未绕过系统安全提示，未操作生产应用。
- 从 Write 文件树打开 `export-check.md`，界面显示本地 PNG、表格和带单引号的代码；通过应用 Export → DOCX → 模板对话框 → 原生保存面板生成新文件 `export-final6.docx`，界面显示导出成功。截图 `15-final6-editor.png`、`16-final6-docx-success.png`。
- 独立读回复制后的真实 OOXML：8 项检查通过，代码精确为 `export const source = 'markdown'`，PNG 哈希与源图一致，表格/标题正确，frontmatter 不进入正文。PACKAGED-EXPORT-01 在此实际产物中修复；保留 final5 失败产物。
- 在隔离夹具中新增 `export-stress.md`，通过相同 GUI 路径导出 `export-stress-final6.docx`。独立读回 5 项检查通过，TypeScript 模板字符串和 HTML 代码逐字符匹配源码，实体字面量保持原样，无嵌套高亮标签泄漏；截图 `17-final6-stress-export.png`。
- 两份新产物、源码、SHA、逐字符结果和独立读回脚本在 `packaged-export-final6/`。final5 与 final6 全部 renderer/preload/shared 字节一致；完整 2,216 个 `src` 文件仅 DOCX 实现与其测试不同，之前的 UI 证据保留原版本标签使用。

## 尚未通过及限定

- AI 实际远程生成：隔离候选不导入生产凭据；真实界面尝试摘要得到 Missing API key，文档未修改。AI 差异预览/接受拒绝、基线保护已有源码测试与独立审查，不能冒充真实模型端到端通过。
- DOCX：final5 字符保真失败已由 final6 两份新 GUI 产物独立读回确认修复；50 项导出测试覆盖更广的数字实体、无效码点与嵌套高亮边界。
- 签名/公证/更新往返：本机 ad hoc 签名通过，无公证且 updater 关闭，未执行真实升级往返。既有 PPTX canvas 依赖版本不一致另见包报告。全部不构成公开发布验收。
- 数学、脚注、Mermaid、MDX/HTML 高级可视化属于第二阶段；首期保护原始源码，预览/导出仍以源码表达，不标为完整语义渲染通过。

## final7 最终候选收尾

- 产品版本 **0.5.4**；checkpoint `5c88bfd6de0a65e0436cb33bcc1c6528154e20dd`；源码清单 `3ccf6e06d0b36e1ebe67af293c9cb302aabc9ab3412c9cfbf2ddad577c2bd7b9`；ASAR `487f5c5ff8236e9e92f4d83f4e52c87afd2e06503b72918fcb07856545cccc4a`。
- 安装在 `dist/railwise-0.5.4-markdown-workbench-private-final7/Applications/RailWise AI Candidate 5c88bfd6de0a.app`，使用独立 `candidate.env`、工作区和新 session；未覆盖生产或 final6。
- final6 内容扫描发现依赖中的开发浏览器日志包含标准测试样例形态的 JWT，未验证其凭据有效性。final7 统一排除依赖 `.log`、`.playwright-mcp`、`playwright-report`、`test-results`，并在 after-pack 检查真正的包布局；移除 3 个开发文件，不删除用户或源依赖文件。
- CUA 实际从文件树打开 `export-stress.md`，在富文本 HTML 代码块中选择 `card` 并改为 `panel`，保存后切源码，两个语言围栏和全部实体/模板字符串仍完整。截图 `18-final7-html-code-source.png`，独立磁盘比较确认只有这一处文字修改。
- 通过应用 Export → DOCX → 模板 → 原生保存面板生成新的 `export-stress-final7.docx`。首次保存工具的自动审批检查超时，读取确认面板未变后按工具允许重试一次成功；不涉及拒绝、权限扩大或安全绕过。成功通知在保存后的 CUA 输出中可见；截图 `19-final7-docx-success.png` 是通知消失后的文档状态，不能冒称截图中仍有通知。
- 独立复制及标准 XML 读回 **10/10** 检查通过：9,467 字节，SHA `d2665c89c024a15223c784f3ec1142e0d3798a02ad5159c5beb85c94797e388a`，两个代码段与已保存源码逐字符相同。产物、源码、脚本和报告见 `packaged-export-final7/`。
- ASAR 26,023 文件/485 编译文件匹配 checkpoint；实际 SQLite ABI 148 通过；依赖开发产物为 0。内容扫描覆盖 25,727 ASAR 文本、9,094 外置文本及启动后 2 个候选日志；扫描时点、跳过项和未覆盖范围全部记录在 `package-verification-final7.md`。
- 最终 AI 审查和功能记录保留独立审查身份、精确候选和来源，不将之前 UI 截图改标成 final7。正式签名、公证、真实 updater 往返及实际模型端到端仍受上方限定。
