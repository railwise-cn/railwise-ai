# 声明检查关联评估：完整接入独立核查

日期：2026-09-20。结论：本轮未发现尚未关闭的开发接入阻断。

这是从 `8f81d8a` 分出的独立后续变更，明确不属于当前最终候选包。审查没有编辑主树、作者实现、正式版本、发布 feed 或官网。AI 技术核查不构成专业人员签字、工程验收或发布批准。

## 核查证据

最终 81 项相关测试通过：核心 33（作者 13 + 独立 20）、HTTP/保全 20（作者 15 + 独立 5）、客户端/IPC/DOM 28（作者 18 + 独立 10）。对应 `core-tests-final.json`、`route-tests.json`、`ui/final-tests.json`。

独立副本完整 Runtime build 通过，编译 JavaScript 的真实三单位服务链、SQLite 重启、追加来源后旧记录失效与新评估、草稿/成果字节/工程审计不变的 5 组检查通过（最新来源重放见 `compiled-smoke-final.json`）。

为归档后的独立重放新增 `replay-independent.mjs`，给定任意实现仓库绝对路径，在全新 `/private/tmp` 副本中复制来源、链接依赖、运行 25 项独立 Runtime 测试和 10 项独立 DOM 测试、build 及编译案例。已实际运行成功，重放目录 `/private/tmp/railwise-assessment-replay-7XzFWf`。脚本只向自己的临时副本写入。

8 份已冻结评分、采样、静态增量纯核/合同文件与 `8f81d8a` 字节一致，摘要见 `FINAL_SUMMARY.json`。其余来源冻结摘要见 `source-hashes-final.json` 与 `ui/source-hashes-final.json`。

## 已关闭发现

核心详情见 `CORE_REVIEW.md`，包括 2336 条最大合法引用上限、损坏 JSON/结构错误分类、硬资源 limit 与 rate-limit 的区别。

本轮 UI/客户端另外发现并修复：

- 完整评估在来源正常追加后复验失败，旧的“关联齐全”仍停留在当前详情且可点导出。失败现在清除当前 record，历史仍保留，可重新打开或创建新评估。
- 先打开计划 B，再打开历史评估 A，会混留 B 的依据和保存表单。打开评估现在清除先前 plan/selections，并在详情展示时隐藏新计划表单。
- 客户端详情允许在 assessment 路由接收 plan 对象。现在严格校验请求 kind 和响应对象角色，不再跨角色显示。

独立首次失败证据保留于 `ui/independent-initial.json`，修复后的 10 项独立 UI 探针全部通过。另验证：晚到导出在取消/切换项目后不会调用原生保存；不自动选择评分；双语历史明确为保存时摘要；重复 JSON keys、跨项目列表都拒绝。

HTTP 独立验证所有 8 种路由认证先于源读取/保存，非法/重复 query 拒绝，来源变化后的 export 不返回 attachment，超字节请求是硬 limit 而不是 Retry-After 限流。实际 Runtime factory 只注入冻结只读能力，不注入成果 verifyDeliverable、approve、finalize 或源写入方法。

最终追加核查：作者自查并修复非法 SQL id 导致列表整页 schema 拒绝的问题；我新增独立混合健康/非法 id 探针验证隔离。现在非法 id 返回 `unavailable-slot-*`，健康记录保留。最终来源摘要已更新，portable 重放以最后修复后的源码再次完整通过。

## 剩余边界

- 本审查使用合成工程数据，未认证真实外业资料、检查独立性或人员身份。
- DOM 测试使用 happy-dom，PDF renderer 与原生保存调用有明确 mock。Runtime 测试另覆盖真实 PDF/DOCX/XLSX 生成。没有使用 mock 结果冒充安装包验收。
- 未执行本独立变更的打包应用主题/窗口截图、真实原生保存、签名公证或更新器往返；不能因此标记视觉验收完成。
- 两遍来源读取是有界乐观一致性策略，不构成跨库 ACID、独立托管、恶意 ABA 或整库回滚证明。
- 已有八单位软件上限、完整首轮范围、无签名/批准能力和不修改成果草稿的设计继续有效。

## 归档与重放

保留首次失败 JSON 和最终 JSON，不用成功报告覆盖首次失败证据。归档独立测试时使用以下平铺文件名，脚本亦支持原审查目录结构：

```text
replay-independent.mjs
compiled-smoke.mjs
assessment-independent.test.ts
assessment-independent-routes.test.ts
AssessmentIndependent.dom.test.ts
```

其中 `assessment-independent-routes.test.ts` 对应本目录 `src/server/routes/assessment-independent.test.ts`，其余两个对应 core 与 UI 路径。执行：

```sh
node /absolute/path/to/evidence/replay-independent.mjs /absolute/path/to/implementation-repository
```

需要实现仓库已有兼容 Node/npm、根目录与 kun 依赖。原始 `compiled-smoke.mjs` 为当时证据，重放脚本在临时副本自动改写输出位置，归档文件本身不修改。
