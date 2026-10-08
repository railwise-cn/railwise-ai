# 官方 0.5.2 精确安装包验收失败基线

验收日期：2026-10-05 UTC / 2026-10-06 中国时间。总判定：**不通过**。

这是使用 native Computer Use 操作真实安装包的产品/软件验收，结合工程测量、软件和产品设计视角的 **AI 审查**。不是厂商认证、现场事实认证、真实专业签认或人类批准。较新源码中的修复不在本报告的官方包内。

## 精确包与隔离

- 版本：`0.5.2`；tag source：`ea763458567ccf069067a165d812f561e9af6b62`。
- 安装包：`/tmp/railwise-official-052/RailWise AI.app`；ASAR SHA-256：`ce33ebb88d156a129c599ab8ec8d08094014d3d578c2704fe564b2fa9d8fb3bb`。
- 官方 ARM DMG SHA-256：`09dae4a270bbf06fb3fc79771eef3faa2afaba43eea9e6696762fa7ba5cf99e0`。
- strict/deep signature 和 stapled notarization 通过；Developer ID Team `R35G7F4A9U`。原始身份/检查日志见 `../railwise-public-052-exact-package-20261005/`。
- clean run 使用 `/private/tmp/railwise-public-052-cua-clean`，只继承 provider，其他产品默认设置隔离；inbound/outbound disabled，credentialAccess false。未操作用户项目或真实工程资料，未保存配置原件或聊天数据库。
- `launch-identity.json` 记录先前隔离启动，`clean-launch-identity.json` 记录本次干净默认启动；两者不混淆为同一次运行。

## 已实际执行的范围

| 检查 | 实测结果 | 证据 |
| --- | --- | --- |
| 内业入口、四阶段与专业资料入口 | 可进入，中文明亮主题可操作 | `zh-light-survey-empty.*`、IN2/GSI 各页面 AX/截图 |
| COSA IN2 导入→预检→平差→交付 | 4 点、5 观测，已知 A/B/C、未知 S1；生成 DOCX/PDF/XLSX | `zh-light-in2-clean-results-1280x840.*`、`exports/` |
| Leica GSI 起算点缺失阻断 | 计算按钮禁用，但校验文案矛盾，判失败 | `zh-light-gsi-blocked-passed-copy.*` |
| GSI 起算点修复→重新导入→平差→交付 | 明确设置 BM=100m 后，4 点、4 观测；独立闭合 0.4mm，限差未配置仍为未评估 | `zh-light-gsi-result-1280x800.*`、`zh-light-gsi-delivery-1280x800.*`、`gsi-exports/` |
| GSI 数值独立对照 | 独立 Fraction 闭合环按测段长配赋，导出高程与参考差 <1e-10m；不认证精度或规范 | `gsi-exports/independent-leveling-comparison.json` |
| 三格式真实原生导出与回读 | IN2/GSI 各三份文件真实生成；DOCX XML、PDF 全文及 XLSX 工作表回读 | `native-export-readback-summary.json`、各导出目录 |
| AI 精确点位专业问答 | 默认 Flash 意图及显式 Pro 默认设置均发问；专业语义存在失败 | 对应 Flash/Pro AX/截图、`explicit-pro-default-model.ax.txt` |
| 实际模型身份 | UI 已明确设置 Pro；保存的 event 未附实际响应 model ID，因此身份不能独立证实 | `pro-s1-event-identity.json` |
| 1280×800 | native Retina 截图为 2560×1600，尺寸属实 | `actual-screenshot-dimensions.json` |

GSI 原生 Save Dialog 将输入的绝对路径当作文件名，把 `/` 转成 `:`，文件实际保存在隔离工作区。随后将**真实 native 导出的原始字节无损复制**到 `gsi-exports/`，逐文件哈希与来源在 `native-gsi-export-provenance.json`；未宣称原生保存到了预期证据目录。先前误名为 1440×900 的图实际仍为 1280×800，已重命名为 `zh-light-gsi-delivery-resize-attempt-still-1280x800.jpg`。

## 不通过项

| ID | 严重度 | 发现 | 证据与修复验收要求 |
| --- | --- | --- | --- |
| F1 | P0 | 默认交付页直接显示 `professional-review.json` | `zh-light-clean-delivery-json-exposed-1280x840.*`；默认只显示专业成果/审查稿，内部记录进高级详情 |
| F2 | P0 | PDF/DOCX 专业成果附录继续外露 parser、内部 network/adjustment ID、hash、catalog、状态枚举、方法 ID | `exports/report.pdf.txt` 与 `gsi-exports/report.pdf.txt` 第6–7页、对应 render；普通成果只显示专业结论、来源文件/原始行和专业复核事项 |
| F3 | P0 | AI 回答把平差后 residual norm 说成“平差前闭合检核” | `zh-light-in2-explicit-pro-s1-answer.*`；实际平面独立闭合未评估，必须与残差统计区分；需真实问答复测 |
| F4 | P0 | 缺少起算点时同时显示“3个阻断项”、禁用计算及“资料已通过当前计算条件校验”，默认列表仅2项 | `zh-light-gsi-blocked-passed-copy.*`；阻断数量、完整原因及修复入口必须与实际计算资格一致 |
| F5 | P1 | 单期平差的坐标改正数被报告附件称为“位移”；缺失高程改正数却显示模长0 | 两份 PDF 第6–7页；专业成果应区分坐标改正数与多期位移，缺数据不可用不可写0 |
| F6 | P2 | GSI PDF 第1页末尾只留“闭合与附合检核”标题，表格在下一页 | `gsi-exports/report-page-1.png`；标题与表格首段保持同页，需渲染复查 |

## 未覆盖而不能关闭的验收

- 完整中文/英文×明亮/深色×1280×800/1440×900/窄窗×四主页面（48屏）矩阵、最大化，以及 AI/高级抽屉开关恢复。
- CSV/XLSX 打包全链、质量整改/复查/重抽、高级试算所有类型的 native 导出与损坏/过期拒绝。
- 完整键盘流程、抽屉焦点进入与返回、live region、44px 点击区域。
- 离线、过期、取消、重试、重新规划、中断/历史恢复、实际模型身份及真实默认模型执行方案审批。
- 当前冻结目标包的重启保全、独立高级工程师 AI 复核、真实 private updater 下载→quit-install→目标启动往返。

发现 P0 失败后保留本基线，停止继续消耗旧官方包的全矩阵。修复后应冻结新的私有候选，由同一精确目标字节完成上述验收；旧包签名成功、源码测试或历史截图都不替代。

## 证据安全与边界

文本/JSON/Markdown 的凭据筛查0命中，见 `credential-screening.json`。目录包含公开合成样例坐标、隔离记录编号、截图和真实导出，不含用户配置原件、凭据或聊天数据库。正则筛查有局限；文档/截图人工复核不将 hash 或合成数据误当凭据。

公开 0.5.2 已存在。此目录不改公开版本、tag、Release、feed 或官网，也不把修复后的源代码冒充为官方 0.5.2。尚未完成的 33 条计划逐项状态另见 `../railwise-plan-status-20261006/`。
