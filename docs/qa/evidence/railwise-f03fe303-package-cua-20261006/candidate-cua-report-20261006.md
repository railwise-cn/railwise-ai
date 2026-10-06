# 0.5.2 私有候选包 CUA 验收记录（AI review）

日期：2026-10-06  
候选源码：`f03fe30365e3d79dfe029d4352835471cb78dd6e`  
候选版本：`0.5.2`  
候选 Bundle：`com.wangjiawei508.workwise.candidate.headf03fe30365e3`  
候选路径：`/private/tmp/railwise-f03fe303-cua-20261006-01/RailWise AI Candidate f03fe30365e3.app`  
隔离数据根：`/private/tmp/railwise-f03fe303-cua-20261006-01/runtime-root`  

本记录是工程测量实践、数值/报告语义、软件质量和产品设计综合视角的 **AI review**。它不构成厂商互操作证明、规范认证、真人签认或外部生产验收。

## 已完成的同包检查

- 通过精确候选 Bundle 启动；进程使用隔离 `WORKWISE_CANDIDATE_ROOT`，未连接 `/Applications/RailWise AI.app`。
- Survey 工作台默认显示“概览 / 处理 / 结果 / 交付”；新建任务后进入专业资料与计算页面。
- 默认处理页仅展示测量语义：资料来源、网络类型、点/站/观测规模、基准与单位、可计算状态、专业检查、资料检查和开始计算。
- 专业字段可见且有直接入口：坐标系统、 高程基准、已知控制点、网络/观测/点位检查。
- AI 侧栏默认可关闭；关闭后主工作区保持可扫描。
- 候选首屏/空状态中未见 `Typed Plan`、`TaskRun`、工具 ID、参数 JSON、`contextHash`、解析器版本、`P0/P1`、`manifest` 或 `execution receipt`。
- 候选首屏打开资料选择器成功；截图：`candidate-screens/01-open-file-dialog.png`。

## 当前阻断与未完成

### F4（阻断）：基准未确认时仍显示可计算

新建任务处理页同时显示：

- `Datum and units: Unconfirmed · Unconfirmed`
- `Calculation readiness: Not imported`（空状态）

此前同候选的有资料基线已记录为：基准待确认、同时显示“可计算/资料已通过当前计算条件校验”。这与专业前置条件冲突；上传资料后必须复核，若坐标系/高程基准未确认，应明确标记“需要确认基准”并阻断开始计算，或仅允许数值结构检查而不称“可计算”。

修复动作要求：指出缺少的具体字段，提供聚焦输入或补录动作；补录后更新状态，并保留原始资料和声明修订链。

### 尚未执行

- IN2/GSI/CSV/XLSX 实际导入、负例阻断、计算和专业数值逐项核对；
- DOCX/PDF/XLSX 原生导出与读回；
- AI 回答真实会话中的开发术语扫描；
- 48 屏主题/语言/窗口矩阵、键盘焦点和 live-region 实测；
- 重启持久性和候选内真实 updater round-trip 关联；
- 独立 senior-engineer-mode AI review（应基于本候选同包截图和文件）。

## 结论

该候选包目前 **未通过完整验收，也不得作为新的公开发布依据**。当前已获得的是精确候选身份和部分 UI 证据；F4 及上述未执行项必须完成后，才能更新 OpenSpec 4.2 的状态。真实厂商资料、现场复核和真人签认仍是外部门禁，不能由 AI review 代替。

## 证据身份边界

CUA 候选在构建提交 `f03fe303` 时冻结。构建后工作树中的 `survey-diagnostic-text.ts` 有未提交文案过滤修改；这些修改不属于本候选字节，不能用本候选证据证明其效果。若要验收该修改，必须重新构建新的私有候选并重复身份、签名、更新往返及相关 CUA。

## 自动化补充

当前工作树针对 SurveyAdjustmentPanel 与 survey-diagnostic-text 的 99 项定向测试通过（2 个测试文件，0 失败）。该结果只验证源码测试，不替代本候选包的功能验收。
