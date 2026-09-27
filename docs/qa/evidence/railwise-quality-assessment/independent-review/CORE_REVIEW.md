# 声明检查关联评估：独立核心核查

日期：2026-09-20。审查角色：AI 技术核查，不是工程专业人员签字或质量验收。

审查对象：`/private/tmp/railwise-quality-assessment`，从主树 `8f81d8a` 分出的下一项独立变更。未编辑主树或作者实现；在本目录复制冻结来源后运行探针。此变更明确不属于当前最终候选包。

## 结果

最终 31 项核心测试通过：作者跨服务测试 12 项；独立补充 19 项。独立副本 `npm run build` 通过。编译后的 JavaScript 真实跨服务案例另有 5 个断言组通过，包含 3 单位全数样本、SQLite 重启、追加 head 后旧评估失效、新评估成功、草稿/工程审计/文件字节不变。

证据：`core-tests-final.json`、`compiled-smoke.json`、`source-hashes-final.json`。独立测试源码：`src/engineering/assessment-independent.test.ts`。编译案例：`compiled-smoke.mjs`。

本轮没有未关闭核心发现。HTTP、IPC、客户端和 GUI 接入待冻结后单独核查；本结论不覆盖打包应用视觉、原生保存或更新器。

## 发现及修复

1. 原 contract 每单位证据引用限额 2304，遗漏 weighted aggregation 的 32 条引用。合法最大单位评分包含 2336 条（根 32 + 精度项 64×32 + A 32 + weighted 32 + 六扣分叶 6×32）。原实现真实源评分保存成功，但关联计算抛裸 ZodError。修复为每单位 2336、8 单位计数上界 18688，独立实测单单位 2336 条 unresolved 正确保存且无完成误标；整体 recordBytes 上限仍有效。
2. 保全源 event 结构错误或损坏 JSON 被泛化成 unavailable。固定源读取边界仅把 ZodError/SyntaxError 映射 integrity；未知源故障仍 unavailable。真实 SQLite 结构/JSON 损坏与独立故障探针通过。
3. 来源硬 limit 原被误标为 rate-limit，可能诱导无效的 60 秒重试。修复保留 limit；实际 rate-limit 继续单独传播。

首次两项失败及堆栈保留于 `independent-tests-initial.json`，未删除失败证据。最初本地副本缺少 node_modules 根依赖和 PDF 字体属于审查环境设置问题；补齐依赖链接及复制 assets 后运行了完整测试，未修改生产代码以迁就环境。

## 独立验证重点

- 完整 nonconforming 单位可同时有 complete-declared-linkage，明确 contains-declared-nonconforming；不变成合格或批准。
- 每份原始保全计划的所有 requiredCheckIds 都须满足，即使分数和映射齐全，未映射的原要求仍能阻止完整关联。
- 单位引用只解析该单位的明确映射；不能借用另一单位映射。跨项目、不同单位、accuracy component 和不同 profile 的评分被拒绝。
- 冻结完整抽样集合。作者测试还覆盖漏项、逆序、重复以及 9 单位不切片；最大 8 单位两遍评分严格读取 224 work units，后续超预算为 rate-limit。
- 普通输出字节变化为 stale；保留 blob 损坏为 integrity。真实评分/采样/保全 SQLite 损坏均经原源 reader 拒绝。
- 在独立重算全部普通存储 hashes 后，伪造评分结果仍被评分纯核重放拒绝。作者另外覆盖 assessment 结果及其全部 hashes 的一致伪造。
- 正常追加保全 head：旧 assessment 的当前详情返回 source-changed；旧 plan 仍可读且能创建新的 assessment。历史记录不删除。
- 10 条列表不调用保全/抽样/评分 sources，明确 saved-summary-only / not-performed-on-list，不能当作当前源核验。
- 已编译服务不调用 verifyDeliverable，不写工程五项复验审计，不修改成果输出字节、manifest reviewStatus。固定边界明确成果复验并非 assessment 执行。
- 未知/临时源故障和限流不保存为“工程检查失败”。客户端注入 approved、actor、signature、reviewStatus 被拒绝。

## 重放命令

在本目录：

```sh
npm test -- --run src/engineering/survey-quality-assessment.test.ts src/engineering/assessment-independent.test.ts --reporter=json --outputFile=/private/tmp/railwise-assessment-independent-review/core-tests-final.json
npm run build
node compiled-smoke.mjs
```

来源依赖通过真实 EngineeringService、SurveyQualityWorkspaceService、SurveySamplingWorkspaceService、SurveyQualityScoringWorkspaceService 接入。本审查使用合成 fixture，不宣称真实外业数据已经验真；两遍读取不构成跨库 ACID、独立托管或恶意 ABA/整库回滚防护。
