# RailWise Survey 专业界面修复验收

日期：2026-10-03。状态：代码、DOM 和最终包验收完成；本轮 Computer Use 视觉复验因传输通道故障未取得新鲜截图。

本次针对用户反馈的“需要处理”动态提示及测量 AI 回答中的开发术语，覆盖处理、结果、交付、高级专业详情及历史会话。检查原则是保留专业数值、单位、源文件与记录位置、阻断结论和待复核事项；不能以删除工程信息来消除技术术语。原始资料和历史会话仅改变展示，不改写保存内容。

这是 AI 模拟高级测量工程师、软件工程师和产品设计师视角的产品/软件验收，不是人工专业签认、规范符合性认证或厂商互操作证明。历史 AI 答复中的专业判断不因本轮文案转换而得到重新认证。

## 最终包

- 版本：`0.5.1`
- 安装路径：`/Applications/RailWise AI.app`
- 用户实际打开的候选路径：`/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- ASAR SHA-256：`35d087051b52bbf89014089d2e7300503ddd247e480faf39607a377b796f4063`
- 两个路径与构建暂存包的 ASAR 哈希一致：`/tmp/railwise-professional-final3-20261003/mac-arm64/RailWise AI.app`
- Runtime dist tree SHA-256：`b19afa1b8453daa29761fdb0a35a186f7347198b3e4f2f8f715f240688011dd7`
- 原生依赖：Electron ABI 148，打包完整性检查通过（13,363 个 ASAR 文件、466 个编译输出）
- 签名：ad hoc；`codesign --verify --deep --strict` 通过；Team ID 未设置
- Apple 公证：未执行
- 更新与发布：`WORKWISE_UPDATE_PROVIDER=none`，未发布、未更新官网、未创建标签或 Release

## 自动验证

- `SurveyAdjustmentPanel.dom.test.ts`、`engineering-professional-text.test.ts`、`survey-diagnostic-text.test.ts`：128/128 通过。
- 工程 AI / 工作台定向 DOM 测试：126/126 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过，渲染包包含 `资料质量提示仍待处理` 的专业文案。
- `electron-builder --mac dir --arm64`：通过；`better-sqlite3` 已按 Electron ABI 148 重编译。
- `node scripts/verify-packaged-asar.cjs ... out`：通过，13,363 个文件、466 个编译输出逐项匹配。
- `node scripts/verify-packaged-runtime-native.cjs /tmp/railwise-professional-final3-20261003 mac`：通过，`WORKWISE_PACKAGED_SQLITE_OK ABI=148`。
- `git diff --check`：通过。
- 普通 Node 运行器的全量测试仍受本机 `better-sqlite3` Node ABI 与 Electron ABI 差异影响；本轮以 Electron ABI 打包检查和定向 DOM/文本测试为准，未将环境型失败当作产品通过。
- 直接系统截图 `/tmp/railwise-final3-screen-20261003.png` 仅作为辅助记录：窗口启动时出现 macOS Documents 访问授权提示，且停留在编程工作区；它不是本轮 Survey 最终视觉证据。

## 实际应用检查表

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 原 0.5.1 合成任务“需要处理” | 代码/DOM 通过 | `SurveyAdjustmentPanel.dom.test.ts` 的格式目录与 compact needs-attention 回归；最终包 `Workbench-lOB5XwwX.js` 含专业文案 |
| 格式识别与高级来源说明 | 代码/DOM 通过 | 来源诊断统一经过 `surveySourceDiagnosticText`，保留 COSA、点数、观测数、单位和可计算条件 |
| 结果观测名称、数值、单位与来源 | 代码/DOM 通过 | 工程测量相关 DOM 测试与专业文本回归 |
| 交付预览、导出入口和专业限制 | 代码/DOM 通过 | 工作台/交付相关现有回归通过 |
| 历史 AI 答复与证据不足说明 | 文本回归通过 | 45 条历史回答样本与本轮安装包样本均过滤协议、哈希、模型和工具词，保留数值与复核限制 |
| 新鲜公开合成样例问答 | 未取得新鲜屏幕证据 | 需在 Computer Use 通道恢复后补做；不能用旧截图代替 |
| 中文/英文、浅色/深色、窗口尺寸 | 既有证据 + 代码通过 | 既有 `zh-dark-processing.jpg`、`zh-dark-source-details.jpg`；本轮未取得新鲜截图 |
| 键盘关闭抽屉和焦点恢复 | 代码/DOM 通过 | 抽屉与工作台可访问性回归；本轮未取得新鲜屏幕证据 |
| 独立 AI 复核 | 已完成（AI 模拟复核） | `/root/observation_labels_cleanup` 核对源码、最终包和三项定向回归；不构成人类签字、规范认证或厂商互操作证明 |

## 边界

本轮不作公开发布，不修改版本、标签、官网或更新源。测试包采用本地临时签名，未公证；不作为正式发布安装包。全局编程与连接配置能力仍保留，本轮针对 Survey 专业工作流程。

前轮检查观察到本地计算服务三次启动超时，随后同包成功启动；原因未被证明。本轮最终包已启动并完成运行时打包检查，但 Computer Use 在读取最终窗口时连续返回 `SyntaxError: Unexpected token ':'`，重启 CUA 进程后又返回 `Transport closed`，因此没有把旧截图标成最终视觉通过。待通道恢复后，必须补录“需要处理”、高级详情、历史 AI 回答、结果和交付页的真实 AX 文本与截图。

## 本轮修复

- `engineering-professional-text.ts` 对历史 AI 回答做整句重写和内部协议过滤，隐藏工具名、模型名、协议字段、哈希、修订号、选择器、运行回执与 JSON 字段，同时保留测量数值、单位、源文件行号、阻断条件和专业复核意见。
- `SurveyAdjustmentPanel.tsx` 的 compact needs-attention 与高级质量门禁统一使用专业来源诊断文案。截图中的开发提示现在归一为：`资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。`
- 旧资料、历史会话、插件、MCP、Skill、路由和内部追溯数据未删除；本轮只改变用户可见展示层。
