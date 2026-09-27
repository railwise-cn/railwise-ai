# 两新核 Runtime/UI 集成独立审查

日期：2026-09-20。审查树 `/private/tmp/railwise-huber-trial`。仅只读实现；独立 probes、报告写本目录。应用 code-review 技能。结果：**18 / 18 独立探针通过；发现的 1 项 P1 已由实现者修复并复验；目前无未解决集成阻断。**

## 发现及修复证据

P1 — 合法非排序统计输入保存成功后无法恢复/导出。冻结 `declared-statistical-family-1` 内核将 `request.statistics` 按 memberId 排序；持久层 `declaration` 保留 schema parse 后的原数组顺序。初版 renderer 用 `hash(JSON.stringify(record.declaration))` 核对内核 `requestSha256`，又直接要求内核 request 与 declaration 相等。因此 `[c,a]` 的合法 statistics（包括 trim 可归一字段）通过预检和真实 SQLite 保存，但 renderer 的 `readAdvancedTrial` 抛 `invalid-response`。独立 client 测试先得到 6 通过 / 1 失败，并定位旧 client 第131行。

实现者在 renderer 添加 `statisticalResultRequest`：拷贝 declaration 并仅排序 statistics，用于内核 request 及内核 requestSha256 绑定。原始 requestJson、declarationJson、declaration、modelHash 原意保留，冻结算法未改。独立同例复验通过；旧 generalized-w、vce 和 Huber 原字节恢复继续通过。

## 独立覆盖

- **client 7 项**：四个 kind 的真实 service 记录带 UTF-8 中文、emoji、前后空白和多行 JSON，保存原文并在移除全局 Buffer 的 renderer 恢复；统计族逆序 statistics 与 trim 身份/来源；两新 kind 重复 JSON 键预检拒绝。
- **service 4 项**：分别创建十条真实最大新核记录，关闭并重开 SQLite 后完整页逐条重算；Huber n=128/p=16/maxIterations=200，真实 iteration-limit 且保留201状态、无接受参数；统计族256个不同卡方成员完整保留。单记录均低于4 MiB。SQL request/declaration BLOB SHA256与公开记录一致。两新kind原字节幂等重试一致、相同key不同原字节冲突。
- **计费行为**：每分钟240配额。新会话最大Huber页成本231，随后25成本单读失败；最大统计族页成本191，随后21成本单读成功两次，第三次失败。模型收费依声明尺寸，不因早停/缺失成员降低。测试使用可控时钟，但没有模拟算法或SQL。
- **GUI 7 项**：happy-dom 通过真实 service记录恢复，两种最大结果完整显示；Huber201步仅最后一步展开且未显示接受参数，统计族256行含末成员；英文界面无缺失翻译key、NaN、Infinity、undefined，无Buffer依赖。两kind原生另存桥的UTF-8 base64完整等于重新验证记录JSON加换行；项目改变后晚到的export不调用save。workspace、revision、runtime连接状态改变后晚到restore不污染新会话。

## 边界与限制

这不是签名安装包的视觉检查、真人专业签署、正式发布批准或生产性能SLA。GUI采用happy-dom，原生另存为调用被mock；验证的是桥接payload及迟到请求隔离，不是操作系统文件对话框。最大模型使用实现者现有合成fixture，通过真实算法/SQLite重放验证集成容量；纯核数值正确性由已独立完成的 Fraction/mpmath 证据另行覆盖。

旧kind兼容在本次运行中使用未新增统计字段的真实记录完整保存/恢复，结合只读检查SQLite结构、旧kind算法名/字段/重算路径未变；未将新算法支持当作历史数据迁移授权。此次没有运行打包安装、更新器、官网或release操作。

最后成功运行：3文件18测试，Vitest4.1.7；2026-09-20本地07:44:33，约7.55秒。源文件与探针SHA256在 `source-hashes.json`，测试结果摘要在 `summary.json`。

## Portable replay

从任何带正常项目依赖的完整checkout执行：

```sh
/path/to/evidence/replay.sh /absolute/path/to/checkout
```

runner通过 `REVIEW_REPO` 解析源码/依赖，证据目录可移动；不写生产源码。临时SQLite目录由各测试创建和清理。GUI范围需根项目 React/happy-dom/Vitest 依赖，native service需可用 better-sqlite3。

## 最后显示修复复验

07:47:41 追加GUI复验7/7通过。统计族完整double临界值及区间逐成员核对String值，实际包含会被12有效位旧formatter显示为相同端点的窄区间；最新UI保留端点差异。Huber最新折叠按需渲染复验：201个状态摘要保留，初始仅最后一张观测表，展开首状态后只保持一个展开和一张表，首状态完整行可见。该显示优化未改冻结数值核。

最终可见分布参数复验：07:51:09 GUI7/7通过；256成员逐项核对各自自由度、先验标准差和单位均可见，完整端点精度断言继续通过。最后source-hashes覆盖该结果组件及当前两语言文案。
