# fbb88ea 签名候选验收

源提交 `fbb88ea715571e9689cbc1c0802da08762e4318d`，版本 `0.5.0`。本记录为部分验收，不是公开发布批准；后续 provider 身份、推理档持久化及恢复路径修复不在此包内。

## 包身份与原生更新

- [本机包摘要](./package-summary.json)：ZIP `7ea8cd9efd47c2a42ac61ea8de57053a215d0c76bcc51ada7387e8443d632dae`，ASAR `15c19b63ea39fe5618e9d02ca8d977b348e6a12a8db5a8e64f56274a244ed96e`。签名及 stapled 公证通过，本机 Gatekeeper 原状态为 disabled。
- [私有 updater](./private-updater-summary.json)：[run 35491940609](https://github.com/wangjiawei508/WorkWise/actions/runs/35491940609) 在启用 Gatekeeper 的云端完成同源 `0.0.0 -> 0.5.0` HTTPS 下载、Squirrel 安装、目标重启及数据哨兵保留。没有修改正式 feed。
- 本机安装的是同一应用 ZIP，完整 ZIP 和 ASAR 哈希已核对。外层 GitHub artifact 使用范围下载提取内层 ZIP，未重新计算整个外层压缩档哈希；不把平台提供的 digest 当作本机重算结果。

## 包内复验生命周期

[方法](./packaged-lifecycle-method.md)及[机器结果](./packaged-verification-lifecycle.json)：使用真实包内模块和独立合成数据库，成功/错误两次复验产生两个终态及四个生命周期事件；非审计记录、输出字节及 draft 状态不变。旧 terminal-only 合成副本没有补造开始记录，后续新复验只追加自身事件。这是包内服务检查，不是 GUI 或生产 KPI。

## 原生 GUI 审批

本机通过原生 GUI 新建“审批卡验收（合成数据）”，导入仓库 `golden-plane-control-e2e.in2`。中文浅色界面显示 4 点（3 已知、1 未知）、5 观测、来源准入、阻断 0，尚未校核或平差。

应用退出后，限定候选路径和精确 ASAR 的辅助脚本调用包内 orchestrator，创建两个基于项目修订 2 的待确认改名建议及一个四步待审批计划。没有调用模型、没有伪造模型消息、没有执行计划；这部分明确属于测试准备。

原生界面已验证：

1. 待确认卡片展示修改前后值和影响，项目名尚未变化。
2. 确认其中一个建议后，侧栏、会话及当前项目同步为“审批卡已确认（合成数据）”；只读数据库核对 revision 为 3。
3. 确认第二个旧修订建议被拒绝；重新加载后显示“已过期”，revision 未再次增加。
4. 逐项勾选三个写入/导出步骤，旧计划审批被阻止并标为“已过期”。发现错误提示仍是英文 `engineering context changed after approval; refresh context and replan`，已记录为后续源码修复项，不能称该包全量本地化通过。
5. 点击“按当前上下文重新生成计划”，生成新计划 `eplan_f9a8c3dc-398a-45d2-aeeb-11d2ba1d7ebe`。保留校核、平差、读取、导出四步骤、参数和前序结果绑定；项目修订更新为 3，三个风险确认全部重置为未勾选。界面明确尚未执行。

项目 `project_50aa4738-da8d-4e87-8fea-7dbbc3f5fd83`，会话 `thr_inslys6a`，网络 `network_eb2aeea2-84cc-41ed-984d-db84e49fa5a9`。[GUI 截图与 AX 文本](./gui/)分别记录审批、执行、溯源、重启及旧记录恢复。

01–04 的 AX 文件保留工具原始差量返回，其中可能只有“未变化”提示，不能单独作为完整树证据；对应截图和后续完整树共同支持记录。05 以后明确请求完整树。原始 AX 与日志保留空白，不做影响原文的格式化。

## 真实模型执行与重启

GUI 审批新计划后，经临时回环 relay 到官方 DeepSeek HTTPS 的 `deepseek-flash` 完成五次真实 Chat Completions 请求，全部 HTTP 200。模型依次调用校核、确定性平差、读取结果及导出四个工具；实际生成 DOCX、PDF 和 XLSX。三个模型列表请求也为 HTTP 200，不计入五次对话请求。

[独立审计](./typed-model-execution-audit.json)及[方法与边界](./typed-model-execution-method.md)核对四个调用/结果、批准参数与前序绑定、数据库中的完整确定性结果、文件大小和 SHA-256。DOCX/XLSX ZIP CRC 与格式检查通过，PDF 为 2 页，XLSX 为 15 表。TaskRun 与执行 turn 为 completed；原始 plan 状态仍为 started，界面用 TaskRun 显示已完成。没有生成正式 manifest 或授予交付批准。

模型仅访问已绑定的合成工程。真实凭据没有写进候选；relay 正常退出，临时 token 删除，端口 63835 不再监听，候选八个凭据字段均为空，端点恢复官方地址。原始上游 SSE 未保存，证据由运行日志、实际 relay 代码、候选记录和输出文件交叉支持，不声称能事后逐字还原全部网络响应。

原生 GUI 在结果页将第 10 条距离观测定位到 `cosa-in2-record-10`，显示原行 `C,S,100.000`。正常退出并重启后，8 条会话消息、同一 TaskRun/平差/交付身份及三份成果恢复。

执行结束时主面板仍显示执行前数据，设置页往返后才恢复正确状态；中文回复表格工具的三个标签也仍为英文。这两项真实缺陷已在后续源码修复，但不回填为本包通过。

## 历史依据

在保留原 workspace 绑定下，旧 be0 抽样运行恢复首轮全数 2/2，旧评分恢复 `9141/100`。规范依据中表 43 指向 PDF61，表 44 分为 PDF62/63，引导页另指 PDF60；本次检查链接目标，没有重复声称浏览器打开已验收。旧记录只读字节对照见本目录报告。

完整主题/尺寸/键盘矩阵、最终新增修复包及用户/专业确认尚未完成。合成 GUI 和代理复审不能替代真实生产指标或专业签认。
