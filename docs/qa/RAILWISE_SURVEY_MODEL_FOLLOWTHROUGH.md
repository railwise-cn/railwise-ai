# Survey 模型与审批后续检查

本记录包含 2026-09-20 的调查及后续源码修复。第 1 至 5 节保留首次调查背景；第 6 节是当前实现与验证状态。源码修复属于 fbb88ea 之后的独立批次，不能归入 fbb88ea 签名包验收；未改正式用户模型配置、凭据、公开版本或发布状态。

## 1. 同名模型丢失 provider 身份

**已观察：** 主线程在 be0d7ac 隔离候选 GUI 新增只有 `deepseek-flash` 的 relay provider 后，composer 菜单仍只有 DeepSeek/Agnes，没有 relay。该次基础问答通过临时调整隔离候选既有 DeepSeek 项端点完成，随后恢复；此操作不能算 provider 选择功能通过。

**代码证据：** `src/renderer/src/components/chat/FloatingComposerModelPicker.tsx` 的 `providerMenuGroups` 使用跨全部 provider 的单一 `seen` 集合，按 `modelId` 去重。后一个 provider 的同名项被删除；仅有同名项时整个分组被过滤。`selectedProviderId` 又通过首个包含模型字符串的分组推导。`chat-store-app-actions.ts` 的 `setComposerModel` 仅保存模型字符串，picker 回调也只有 `modelId`，无法表达同名模型属于哪一个 provider。`src/main/upstream-models.ts` 已按 provider 分组合并，因此不是设置资料没有保留。

**最小修复范围：** 选择值必须端到端携带 `{ providerId, modelId }`，包括菜单选中态、composer/store 与持久偏好、普通发送/队列/重试、IPC 与 Runtime 实际 provider 解析。Typed Plan 启动/恢复需要遵守同一模型身份合同。只把 `seen` 移到每组内部会恢复菜单，却仍不能保证请求发往所选端点，不构成完整修复。旧字符串偏好应兼容读取，并按明确的已配置 provider 解析；不能猜测首个同名 provider 或删除旧配置。

最小回归使用两个无真实凭据的合成 provider，均声明同一个模型 ID、分别指向两个本地测试端点：两组都可见；分别选择后 UI 身份、持久恢复和实际请求端点一致；刷新模型、队列重试、provider 不可用时不得静默切到另一同名 provider。需覆盖正式现有配置只读迁移，不能用真实用户配置作为测试写入目标。

## 2. Survey 推理档重置

**已观察：** 主线程在 be0 候选操作中看到选择 Low 后又显示 Ultra；目前缺少可区分原地点击与路由重挂载的连续证据，不能声称已定位该次现象的唯一原因。

**已确认源码事实：** be0 与当前 `EngineeringComposer.tsx` 均以局部 `useState<ComposerReasoningEffort>('max')` 初始化，未将档位存入工程草稿或持久偏好。回调链完整：`EngineeringComposer` 的 `setEffort` 经 `FloatingComposer` 传到 `FloatingComposerModelPicker`，菜单点击实际调用该回调。普通发送将档位转换后传入 `sendMessage`；Low 对应 `off`，Medium/High/Ultra 分别对应 `medium`/`high`/`max`。不能将问题记为缺 callback。

**确定的重置边界：** composer 卸载再挂载时必恢复 `max`。例如离开 Survey 进入设置再返回，会丢失之前的局部档位。普通专业页切换使用持久会话容器，不应仅因切换专业页而重置；仍需在精确包实测。

**最小修复范围：** 先明确档位是每工程草稿偏好还是全局 composer 偏好，再将状态放到相应现有 store，避免另建第二套模型设置。保留旧数据默认值；覆盖重挂载、项目切换、语言切换及失败重试。验证应逐步留证：原地选 Low并重开菜单、输入文字、切专业页、进设置返回、重启；在本地记录端点检查普通发送真实请求档位，不只核对按钮文字。

## 3. Typed Plan 启动未传推理档

**源码确认、尚未单独实机验证：** `EngineeringAiCommandCenter.tsx` 的 `/plans/:id/start` 请求只含修订、上下文哈希、model 和幂等键，没有 `reasoningEffort`。`kun/src/engineering/engineering-ai-orchestrator.ts` 的严格 `EngineeringPlanStartRequest` 也没有该字段，`startPlan` 构造 `startTurn` 请求时未传档位。因此普通咨询的 composer 选择不能作为审批执行回合使用同一推理档的证据。

**最小修复范围：** 将已选档位连同上述 provider/model 身份传到启动与恢复合同、IPC 校验和实际 turn 请求，按现有模型能力映射，不绕过参数校验。为排队、恢复和幂等重试定义稳定行为。至少用本地记录端点验证普通咨询、审批启动、恢复三条路径实际收到一致的已选设置；再补精确包 GUI 与一次真实模型执行回合。

## 4. 修改确认与执行审批的最小 GUI fixture

现有本地工具：`/private/tmp/railwise-seed-review-fixture.mjs`。该临时文件不属于仓库归档，执行前应只读核对脚本内容和当前安装包服务接口；工具丢失时按本节合同重建，不能伪造已有验收结果。

1. 在 `/private/tmp/railwise-survey-*` 隔离候选中，用 GUI 新建名为“审批卡验收（合成数据）”的工程。
2. GUI 导入且仅保留一份 `kun/src/engineering/fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2`，确认工程会话已建立，然后退出应用。
3. 用候选应用自身的 Electron 可执行文件，在 `ELECTRON_RUN_AS_NODE=1` 模式运行脚本，参数依次为候选根目录和其 `Applications` 下的 `.app` 路径。脚本校验隔离路径，通过精确包 `app.asar.unpacked/kun` 中的 Engineering/Survey 服务及 AI orchestrator 创建待确认改名建议和待审批计划；不使用开发源码代替包内模块。
4. 脚本的临时 running turn 明确标记为合成，其 `runTurn` 和 `recordCompletedTurn` 会拒绝调用；输出 `evidence/gui-review-fixture.json` 标明 `fixtureOnly: true`、`modelCalled: false`。不要把此记录写成真实模型生成计划。
5. 重启 GUI，检查建议前后值、影响说明、显式确认后项目 revision/名称及侧栏同步，重启再次检查状态。计划展示具体参数、前序绑定、产物和可逆性；写入/导出步骤逐项勾选后才允许启动。
6. 改名使原计划上下文过期：验证旧计划启动被阻止、没有 TaskRun，然后通过 GUI 重建并核对原步骤和输入选择保留、需要重新审批。先完成这个负例，再创建新计划走正常执行链。

该工具适合验证卡片、持久恢复和审批门禁；它不执行模型回合。要验收审批后的实际执行，仍需通过可用真实模型或明确标识的本地模型 fixture 进入既有 TaskController/AgentLoop，核对步骤回执、运行记录和实际输出。合成模型/人工准备计划的通过结果不得替代真实模型成功、专业人员确认或生产 KPI。旧 `docs/qa/evidence/railwise-convergence-df23e7d354c4/README.md` 仅是流程参考，不是新候选证据。

## 5. Locale 最小补查

本次只读递归键集合检查：中英文 common 各 3,392 键、settings 各 704、quality-assessment 各 92、quality-scoring 各 153、standard-basis 各 28，均无缺键。现有 `survey-fixture-locale.test.ts` 检查实际解析 fixture 诊断；键数和 fixture 覆盖不能证明所有运行异常与旧记录全量翻译。

最小候选矩阵复用上述同一工程：中浅/英深下查看修改建议、过期计划、审批参数、原始记录导航、模型不可用和复验失败。系统文案应翻译，项目名、来源记录及用户数据保留原样。`surveyLegacyDiagnosticText` 对未知旧文案保留原文是当前兼容行为，不能为消除中文而覆盖证据。此调查未发现新的确定缺键问题；本轮不扩大为全部 P1/P2 页面重写。

## 6. 后续实现与迁移矩阵

已补齐 provider/model 身份从菜单、偏好、普通发送、排队、IPC、Turn/Task 到实际模型请求的传递。同名模型只在各自提供商组内去重。新增请求将默认提供商固化到 Turn/Task；缺省 model 仍沿用 agent profile、thread、提供商默认模型的原有优先级。内部 Flow 没有用户选择时沿用配置默认；Auto 分类、压缩、Review、委派子任务和 UI action 续行继承原请求身份。移除提供商后明确返回 `model_provider_unavailable`，中英文提示提供设置恢复入口。模型配置变更通过既有 Runtime 重启链路刷新，启动环境中的提供商凭据 JSON 在 Runtime 初始化时移除，不向工具子进程传播。

普通续行继承 Task 的选择；明确恢复通过内部 `continuationTaskId` 绑定既有 Task，避免依赖自然语言是否匹配“继续”正则而取消原任务。此字段不接受外部 HTTP 请求任意指定。Typed start/resume 传递 provider/model/reasoningEffort；审批开始时捕获同一选择快照，等待审批响应期间切换菜单不改变本次执行。

Survey 推理档现在保存在现有工程草稿 store，以 workspace/project 隔离，设置页卸载、重新挂载和发送后均保留。原地 Low 已生效而设置返回重置 Ultra 的包内观察见 `/private/tmp/railwise-survey-be0d7ac/evidence/model-settings-followthrough/01-low-immediate.txt`、`02-after-settings-return.txt`。本批实现保持草稿原有会话级存储边界：完整退出应用后默认 Ultra，不将临时附件/草稿写入磁盘。模型/provider 偏好独立持久保存。

| 旧项目 | 新状态与原因 | 数据保留 | 用户操作 |
| --- | --- | --- | --- |
| `workwise.composerModel` 字符串 | 继续兼容；新选择同时保存版本化 `{model, providerId}`，避免同名混淆 | 原 key 保留，不重写正式 provider 配置 | 旧偏好沿用明确配置的默认提供商；需要其他端点时选择对应组 |
| 既有 Turn/Task 无 providerId | 可继续读取；旧历史保持既有缺省路由语义，新执行固化提供商 | 不批量重写历史记录、插件、MCP、Skill 或凭据引用 | 无强制迁移 |
| 已保存的 provider 被移除 | 保留选择并明确失败，防止静默切换 | 选择与旧任务不删除 | 在设置恢复原 provider，或显式重新选择后发送 |
| Write/SDD 助手模型字符串 | 添加独立版本化身份偏好及发送字段 | 原助手 model key 保留 | 选择提供商组后使用该端点 |
| Claw 渠道 model-only 配置 | 保留既有渠道合同；显示普通模型列表，不展示无法保存的跨提供商选择 | 不迁移、不删除渠道配置，使用配置默认提供商 | 跨提供商渠道选择不属于本批新增能力 |
| Survey 局部推理档 | 移入现有工程草稿，按 workspace/project 隔离 | 保持原草稿会话级生命周期；空值仍为 Ultra | 设置页往返无需重选；重启后按需重选 |

自动验证：

- `kun/tests/model-provider-routing.test.ts` 使用两个真实本地 HTTP 监听器、无 API key，验证同名模型落点、默认身份、持久重启读取、旧 thread model 优先级、Auto 分类、子任务、Flow、缺失提供商拒绝及普通 resume/retry 的 Turn/Task 一致性。计价用独立拦截响应验证按本次请求模型计价，不把 provider 首模型当作全部请求的价格。
- `kun/src/engineering/engineering-plan-execution.test.ts` 验证 typed start/resume 的 provider/model/effort 及幂等恢复。`review.test.ts`、`ui-action-service.test.ts` 验证私有 Review 与来源消息续行身份。
- 真实 picker DOM 测试验证两个同名菜单与选中标记，存储测试保留旧 key。Survey DOM 覆盖 Low 设置往返、项目隔离、普通发送 `off`、审批 await 期间选择变化；IPC 与队列测试检查序列化和排队身份保留。

这些结果是自动化与合成本地端点验证，不代表厂商真实模型评测、生产数据验收或专业人员签认。新批次仍需独立打包并在安装包中完成中浅/英深、窗口尺寸与同名提供商选择/设置往返实测；公开发布需遵守仓库 release gate。
