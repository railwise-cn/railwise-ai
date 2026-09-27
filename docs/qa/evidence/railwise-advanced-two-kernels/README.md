# Huber 与预声明统计检验族接入高级试算工作区

本批把已独立复核、冻结的两项只读纯核接入现有 advanced-trials 保存、列表、恢复、重新计算和原生另存为 JSON 路径。新增 `huber` 与 `statistical-family`，保留 `generalized-w`、`vce`；没有从项目观测、广义 w 结果或正式成果自动推断模型，也不改变正式权或删点。

## 输入、记录及旧数据兼容

HTTP、IPC、renderer 和持久层均按显式 kind 选择严格合同。固定外部尺度、独立性、完整统计族、标量精度范围和数值政策均来自冻结内核。统计族输入是调用方声明的精确标量，不自动接收广义 w 近似值并忽略其上游误差。

原始 UTF-8 请求、原始 declaration JSON、模型依据与标准化模型分别保存和绑定哈希。新记录的 algorithmVersion 从实际结果提取，record schema 进一步约束 kind/algorithm/outcome。每次读取、历史页、恢复、重验和导出都进行原始字节校验、项目/运行环境绑定校验和完整数值重算。Renderer 校验结果中的 request 与 declaration 及其内核请求哈希（统计核既定地仅按 memberId 排序 statistics 子集，因此以显式归一副本核验结果，原始字节/declaration 顺序/modelHash 保持不变），导出必须重新获取完整已重算记录。

SQLite 结构和只追加触发器不变，无迁移、回写或删除。旧 kind 不新增字段，原始字节及哈希行为保持兼容；`familyMemberCount` 仅统计族记录必需且允许，旧 kind 必须不存在。统计族的 observationCount/parameterCount 必须为 0，表示没有观测网络模型；familyMemberCount 与完整声明成员数一致。其他 kind 的这两个计数仍必须大于 0。

模型、来源和预声明真实性未经验证；任意 sourceAnchor 是调用方填写的锚点，并非经过认证的来源。

## 工作量和容量

继续使用每项目每分钟 240 工作单位、每页最多 10 条、单记录最多 4 MiB、项目总存储最多 64 MiB 的政策。费用按声明上限计，不因早停、统计量缺失/失败降低：

- Huber：`max(1,ceil(n*p*p*maxIterations/327680))`，支持范围内最高 20；
- 统计族：`max(1,ceil(fullDeclaredMemberCount/16))`，最高 16；
- 每页固定 1，每条读取另加 3 和模型费用，最高 Huber 231/240，统计族 191/240；
- 单项恢复另收固定 5 和模型费用；创建、写入速率、持久容量限制沿用现有政策。

这些是有界计算工作的软件配额，不是生产 SLA。最大模型测试使用实际完整记录和重算，没有模拟求解器，也没有只检验 schema。

`capacity-replay.mjs` 在编译后的 Node ESM 运行时中实际创建和恢复最大输入，保存本机结果 `capacity-result.json`：Huber n=128、p=16、迭代上限 200，真实产生 201 个状态和 iteration-limit（不接受参数），记录约 2.925 MB；统计族 256 个不同高自由度卡方成员，记录约 0.482 MB。两者均低于 4 MiB。单机时延仅用于复核这次回放，不代表外业数据、生产性能承诺或质量门槛。

## 用户界面

方法选择、解释、历史名称、结果和主要失败状态支持中英文。Huber 显示固定尺度/k/停止政策、接受参数（若有）、逐步目标/score/舍入预算/残差/试算乘子及派生 IRLS 权。保留平坦解、严格内点充分条件与“唯一性未认证”区别，不显示 Gaussian WLS 精度。

统计族显示完整分母、总体及成员 alpha、成员分布、自由度/声明先验尺度及调用方来源、已声明统计量、p、Bonferroni 调整后 p、临界值/分辨区间及数值比较。缺失/不可探测/失败成员保留显示且留在分母中；小于 alpha 不被改写成粗差判定或自动处理动作。分辨区间明确是软件政策而非认证误差界；临界值和端点使用完整双精度字符串，避免通用 12 位显示将窄区间舍入为同一个数字。

所有新 UI 都使用既有不透明工作面和可键盘滚动表格。Huber 仅挂载当前展开迭代的观测表，避免最大记录一次创建 201 张表。DOM 测试并不替代签名安装包在明暗主题、不同窗口尺寸下的实际 UI 验收；打包、截图、原生文件对话框和用户确认由主交付任务继续执行。本批不包含版本、官网、发布 feed、tag 或 Release 操作。

## 验证和回放

新增两 kind 的完整 HTTP/后台/IPC/renderer 路径经过验证，包括跨进程重启恢复、幂等键、修改后重哈希结果仍被数值重放拦截、真实最大记录导出、最大成本十条历史页及剩余额度拦截。DOM 从真实 workspace service 取得记录，验证中英文切换、历史恢复、重新计算、UTF-8 导出 payload、缺失成员保留、平坦解唯一性未建立以及迭代耗尽不输出接受参数。

```sh
npm --prefix kun run typecheck
npm --prefix kun run build
npm --prefix kun test -- src/engineering/survey-huber-trial.test.ts src/engineering/survey-statistical-family.test.ts src/engineering/survey-generalized-w.test.ts src/engineering/survey-vce-trial.test.ts src/engineering/survey-advanced-trials-workspace.test.ts tests/survey-advanced-trials-workspace-http.test.ts tests/runtime-advanced-trials-wiring.test.ts
npm run typecheck
npm test -- src/main/ipc/app-ipc-advanced-trials.test.ts src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.dom.test.ts src/renderer/src/locales/localization-parity.test.ts
node docs/qa/evidence/railwise-advanced-two-kernels/capacity-replay.mjs
node_modules/.bin/electron-vite build
```

最终自动验证：441 条 runtime/数值/HTTP 回归及 35 条桌面 IPC/DOM/i18n 测试通过；两侧 typecheck、runtime build、production bundle、变更文件 ESLint 和 diff-check 通过。

本记录与相邻 `railwise-huber-trial`、`railwise-statistical-family-20260920` 数值证据配合阅读。本批没有读取新外部规范，也不提供真人专业签字。

独立接入审查已归档 `independent-review/REVIEW.md`：client 7、service 4、GUI 7，共 18 项通过，统计排序兼容 P1 已复现、修复并复验；源文件哈希逐项核对一致。使用 `bash docs/qa/evidence/railwise-advanced-two-kernels/independent-review/replay.sh /absolute/checkout` 可独立回放。
