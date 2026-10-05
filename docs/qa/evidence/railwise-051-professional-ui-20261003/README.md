# RailWise Survey 专业用户界面验收记录

## 范围

- 候选包版本：`0.5.1`
- 候选包位置：`/tmp/railwise-candidate-20261003-2358/RailWise AI.app`
- `app.asar` SHA-256：`b349a6061d6f9db1f7747a044429fd0240af42da4845e3a210349691fe04ef58`
- 验收项目：`0.5.1验收（公开合成控制网）`
- 资料：`golden-plane-control-e2e.in2` / `COSA IN2`
- 验收方式：Electron CDP DOM 检查与截图；CUA 通道本轮不可用，因此未将 CUA 结果冒充为已完成。

## 功能检查

| 项目 | 结果 |
| --- | --- |
| 内业项目可打开 | 通过 |
| 处理页“需要处理”只显示测量专业提示 | 通过 |
| 结果页显示网形、基准、点位和精度相关信息 | 通过 |
| 交付页显示审查稿及 DOCX/PDF/XLSX 交付入口 | 通过 |
| AI 历史回答保留测量结论、来源和数值 | 通过 |
| AI 默认隐藏工具名、运行协议、参数、哈希和内部路由 | 通过 |
| 计划/证据读取错误使用用户可理解的测量文案 | 通过 |
| `P0`、格式目录、解析器、fixture 等内部提示不出现在工作面 | 通过 |

## 文案扫描

对概览、处理、结果、交付和 AI 抽屉的可见 DOM 文本扫描以下词汇，均未发现：`P0`、`格式目录`、`策略校验`、`解析器`、`fixture`、`TaskRun`、`Typed Plan`、`contextHash`、`execution receipt`、`tool_storm`、`projectRevision`、`networkRevision`、`survey_read_*`、`manifest`、`sourceEligibility`、`rawSourceIntegrity`、`JSON`、`WorkWise`、`开发`。

## 自动化验证

定向回归测试：5 个测试文件、214 项通过。

```text
survey-diagnostic-text.test.ts
engineering-professional-text.test.ts
EngineeringAiCommandCenter.dom.test.ts
side-conversation-professional.test.ts
SurveyAdjustmentPanel.dom.test.ts
```

`npm run build` 通过。全量 `npm test` 未完成：工作区中多个既有主进程测试触发 Electron 下载并返回 `TypeError: fetch failed`，测试进程在约 7 分钟后停止；这不影响上述定向测试结论，但保留为当前环境限制。

## AI review 边界

本记录包含 AI 模拟的工程测量实践、软件工程和产品设计复核，不代表测绘主管部门、厂商互操作证明、规范符合性认证、专业签字或人工生产验收。
