# RailWise Survey 0.5.2 私有候选源码与用户表面预检

日期：2026-10-06  
分支：`codex/survey-private-acceptance-20261006`  
源码基线：`f03fe30365e3d79dfe029d4352835471cb78dd6e`  
用途：私有候选验收，不构成公开发布批准。

## 源码链路

“需要处理”、来源检查、历史成果限制和 AI 工程回答均通过展示层文案函数输出：`surveySourceDiagnosticText`、`surveyDiagnosticText`、`engineeringProfessionalAnswerText` 和 `engineeringProfessionalStepText`。持久化记录仍保留原始诊断，用户工作区只读取专业化副本。

本轮补强了 `survey-diagnostic-text.ts` 的最后一道清理，覆盖旧记录中可能绕过格式策略分支的完整前缀（格式目录、解析对象、记录锚点、策略校验及内部格式标识），同时保留点号、观测值、行号、残差和限差等测量证据。

## 自动化证据

- Survey 诊断、面板 DOM、AI 命令中心和工程提问相关测试：178 项通过。
- 先前 AI 用户表面审计：262 项通过；Survey 专项诊断与面板回归：99 项通过；专业文案：60 项通过。
- `npm run typecheck` 通过。
- `npm run dist:mac:arm64:artifacts` 通过；构建新鲜度检查通过（1149 个生产输入），ASAR 完整性通过（18368 个文件、466 个编译文件）。

## CUA 检查清单

- [x] 私有候选包使用 0.5.2，未改版本、未创建 tag、未发布官网。
- [x] 重新生成本地 arm64 候选后保留 DMG、ZIP 与 ASAR。
- [ ] 处理页“需要处理”区域在有历史 `format_detected` 记录的真实任务中复核；需要使用带有该任务数据的候选运行配置完成一次 AX 截图。
- [ ] 中文 / 英文、明亮 / 深色、窄窗口 / 标准窗口的截图归档。
- [ ] AI 抽屉、结果和交付页的用户表面逐项复核。

## 已知风险与边界

候选包未签名且未进行 Apple notarization（构建日志明确跳过签名和公证），因此不能作为公开发布包。源码和单测证明过滤链覆盖已知内部词汇，但最终 UI 证据仍需在带有验收任务数据的安装实例中完成。AI review 只能作为模拟的工程测量、软件工程和产品设计综合审查，不是厂商互操作证据、规范认证、真人签字或生产验收。
