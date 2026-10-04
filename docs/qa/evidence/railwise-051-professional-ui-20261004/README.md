# RailWise Survey 0.5.1 专业界面复核

## Current-source follow-up (2026-10-04)

The prior scan was performed against app.asar `43a6fdd7…`. After that review, CUA found a P1 state mismatch: a Runtime reconnect could leave a completed result visible while clearing the current survey source and disabling delivery. The source fix retains a project-scoped last valid survey snapshot on empty reconnect responses; its DOM regression passes 64/64. A fresh private arm64 rebuild now has app.asar SHA-256 `023ca43ca76ba88ac9dfd54c00aca1cd8ea188678e5993d9dbb734db65e619dd` and the same ASAR/signature/build checks pass.

This follow-up does not claim full 4.2 closure. The current CUA/AI pass remains Chinese/dark/wide-window only, and the default host data root exposed a legacy completed task without a current source. A frozen source-bound user-data fixture must be used for the remaining locale/theme/window/accessibility/recovery matrix. Task 4.4 remains external licensed COSA/SUC interoperability and authentic professional signoff.

日期：2026-10-04

本轮针对用户反馈的“需要处理”开发提示和 AI 回答内部协议词进行复核。

## 包与运行环境

本包是 `v0.5.1` 公开发布之后的当前源开发候选，沿用工作树版本字段 `0.5.1`，不是对外发布的新版 `0.5.1`。若当前增量完成并获得发布批准，下一公开版本应为 `0.5.2`；本轮没有执行版本提升或公开发布。

- 应用：`/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- 版本：`0.5.1`
- 当前候选 `app.asar` SHA-256：`023ca43ca76ba88ac9dfd54c00aca1cd8ea188678e5993d9dbb734db65e619dd`
- 运行方式：正式 `dist` arm64 包，Electron CDP 端口 `9391`（本轮复核）
- 项目：`0.5.1验收（公开合成控制网）`

## 复核结论

- 处理页“需要处理”只显示坐标基准、控制点、观测关系、闭合差和精度条件；最新候选包已通过真实渲染 DOM 复核。
- AI 抽屉中的历史测量回答保留平差成果、原始依据、残差、精度和专业复核事项。
- 自动提问中的观测记录编号已转换为测量术语，例如 `cosa-in2-6-backsight-reset` 显示为“后视归零方向”。
- 概览、处理、结果、交付四个工作视图、AI 抽屉和展开后的高级详情均未发现 `P0`、格式目录、策略校验、解析器、fixture、TaskRun、Typed Plan、哈希、运行协议、内部 API 或 `WorkWise` 品牌词。
- 本轮扫描结果保存在 `leaks.json`，结果为 `leaks: []`。

## 证据

- `处理.png` / `处理.txt`：处理页截图和 DOM 文本
- `ai-open.png` / `ai-open.txt`：AI 抽屉截图和 DOM 文本
- `概览.txt`、`处理.txt`、`结果.txt`、`交付.txt`：四个工作视图的 DOM 文本扫描
- `leaks.json`：历史 `43a6fdd7…` 候选的术语扫描结果与“需要处理”实际文本；不作为当前 `023ca43c…` 候选的完整包截图证据。
- 早先 `43a6fdd7…` 候选的页面扫描证据保留为历史记录；当前 `023ca43c…` 候选已完成构建完整性和回归验证，但由于隔离数据根未稳定绑定到有效测量来源，本轮不把历史页面截图回填为当前候选的完整包验收。

## 验证

- 定向 Vitest：6 个测试文件，235 项通过
- `npm run build`：通过
- `npm run verify:build-freshness`：通过，检查 1130 个生产输入
- `node scripts/verify-packaged-asar.cjs "dist/mac-arm64/RailWise AI.app/Contents/Resources/app.asar" out`：通过，ASAR 14,072 个文件、编译产物 466 个
- `codesign --verify --deep --strict "dist/mac-arm64/RailWise AI.app"`：通过（adhoc 签名；未公证）
- `npm run typecheck`：仍受工作区既有 Zod 4/6 类型兼容错误阻断，与本轮文本过滤改动无关
- 独立 AI 验收：已完成内业 → 交付的真实流程复核，确认审查稿、DOCX/PDF/XLSX 预览与导出入口，以及处理页、AI 抽屉和高级详情的专业文案；该复核属于模拟工程测量、软件工程和产品设计视角的 AI review。

本记录属于 AI 工程师、测量专业实践和产品设计视角的模拟验收，不代表规范认证、厂商互操作证明或人工签字。
