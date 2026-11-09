# WorkWise Agent Runtime GUI 单运行时方案

本文记录 WorkWise Agent Runtime 桌面应用现在应该如何围绕一个专门服务 GUI 的
WorkWise Agent Runtime 改造。结论先说清楚：GUI 只保留一个 agent，唯一 ID 是
`kun`；Code、Write、连接手机都通过同一条 `kun serve`
HTTP/SSE 边界工作；CodeWhale、Reasonix、绘画/设计类入口、运行时
诊断面板、agent 切换都不再是产品表面。

## 目标边界

```text
Renderer (React + Zustand)
  Code / Write / Connect phone UI
        |
        | window.workwise.runtimeRequest(path, method, body)
        | window.workwise.startSse(threadId, sinceSeq)
        v
Preload IPC bridge
        |
        v
Main process
  RuntimeHost -> kunRuntimeAdapter
  process/config/port/token management only
        |
        v
kun serve (TypeScript package)
  /health
  /v1/threads
  /v1/threads/{id}/turns
  /v1/threads/{id}/events
  /v1/threads/{id}/fork
  /v1/sessions/{id}/resume-thread
  /v1/approvals/{id}
  /v1/user-inputs/{id}
  /v1/usage
  /v1/workspace/status
```

这个边界借鉴 TUI/CodeWhale 的 serve HTTP 架构：GUI 不直接嵌 agent
loop，不通过 stdio/RPC 混跑多个状态机，只把本地 HTTP 服务当成稳定
协议。WorkWise Agent Runtime 内部再吸收 Reasonix 的 cache-first loop：immutable
prefix、append-only log、bounded LRU/TTL cache、inflight cleanup、
steering queue、context compaction、usage/cache telemetry。

## 缓存命中优化

WorkWise Agent Runtime 的缓存命中率要按 Reasonix 的 DeepSeek 原生口径计算和优化：

- 模型 client 优先解析 DeepSeek 原生
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。只有原生字段缺失
  时，才退回 `prompt_tokens_details.cached_tokens`、`cache_read_input_tokens`
  等兼容字段。
- cache hit rate 使用 `hit / (hit + miss)`，不使用
  `hit / prompt_tokens`。DeepSeek 原生 miss 不一定等于 `prompt_tokens - hit`，
  Reasonix 也是按 hit+miss 作为缓存统计分母。
- `kun/src/prompt/kun-system-prompt.ts` 是稳定前缀。它只放长期
  不变的 WorkWise Agent Runtime 运行契约，不能放 workspace、时间戳、文件片段、选中文本、
  用户动态信息或一次性工具结果。
- `ImmutablePrefix` 在每次 model step 前调用 `verifyImmutablePrefix()`。
  如果有人绕过 `setSystemPrompt` / `setTools` / `setFewShots` 直接改 prefix，
  开发和测试期会立即暴露 fingerprint drift，而不是悄悄牺牲缓存。
- few-shot fingerprint 只计算真正会发给模型的内容，不计算 item id、turn id、
  thread id、时间戳等 GUI/存储层动态字段。
- 工具 schema 在发送到模型前 canonical sort，避免同一工具集合因为顺序或
  schema key 顺序变化造成 prefix churn。
- 每个 turn 会持久化 canonical tool catalog fingerprint 和 tool count；同一
  scope 下工具定义漂移时会标记 `toolCatalogDrift`，便于排查 cache miss。
- 历史消息发送给 DeepSeek 前会做共享的 model-history repair：孤儿
  `tool_result` 不发，缺少对应 result 的 `tool_call` 不发；同一次响应里的
  多个 tool call 会重组为一个合法 assistant `tool_calls` 消息，避免
  400/retry 造成额外延迟和缓存浪费。
- 同一模型回合里连续的 built-in 只读工具 `read` / `grep` / `find` / `ls`
  会小批量并发执行，但 `tool_result` 仍按 call 顺序写入，减少等待时间的同时
  不让动态历史随完成顺序抖动。
- Serve runtime 会从 persisted usage event 恢复累计 cache hit/miss counters，
  重启或 resume 后 runtime usage 面板不重新从 0 计算。
- 动态上下文必须追加在稳定前缀之后。compaction、resume、fork、plan context
  也不得改写稳定系统前缀。

冷启动第一轮可能仍然低或为 0，因为服务端还没有同一前缀可读；热起来后应稳定
超过 90%。2026-06-02 的真实 WorkWise Agent Runtime 临时线程验证：

- 12 轮短消息：去掉冷启动后的热命中 `94.7%`，最新一轮 `93.6%`。
- 同一稳定前缀热身后 24 轮短消息：整体含冷启动 `95.2%`，最新一轮 `98.1%`。

优化前已经持久化的旧 usage 事件不会被事后改写，因为当时没有保存 DeepSeek
原生缓存字段；这些历史数据只能作为旧实现的证据，不能证明新实现仍然低命中。

Reasonix 资料里仍可作为下一阶段的借鉴项：

- 工具集合 mutation gate：新增工具允许 append，编辑、重排、删除工具时要求
  restart 或新会话边界，避免热前缀突然全量 miss。当前 WorkWise Agent Runtime 已排序工具
  schema，但还没有把“工具集合变更策略”做成显式产品规则。
- LLM fold summarizer：现在 `ContextCompactor` 是本地摘要骨架，没有额外请求
  模型。未来如果改成模型摘要，应复用主 agent 的 system/tools/few-shot 前缀，
  让 summarizer call 也命中同一段缓存。
- 大工具结果 token cap 和长参数 markerize：当前本地工具输出较小；一旦加入
  shell、文件全文、网页抓取类工具，需要在进入历史窗口前按 token 截断或标记化，
  不让超大 tool result 把 append-only log 撑爆。
- volatile scratch 边界：assistant reasoning 现在不会上传给模型，但仍会落 GUI
  历史。未来若加入内部计划、临时草稿或子 agent scratch，应保持“可展示”和
  “可重放给模型”分离。

## GUI 要拆的东西

Renderer 只应展示 WorkWise Agent Runtime。需要删除或保持删除的 UI 面包括：

- Agent 切换器：`AgentSwitcher` 不再出现，`AGENT_CATALOG` 只有
  `kun`。
- 顶部连接状态条和 runtime 诊断按钮：不再把运行时检测作为用户入口。
- Runtime insights/right panel：右侧面板只保留 Changes、Preview、Plan、
  File 等 GUI 工作区视图，不再有 runtime/usage 控制台。
- 斜杠菜单里的 `/usage`、`/runtime`：这些命令会暗示还有可切换运行时。
- 设置页 provider selector：Settings -> Agents 直接展示 WorkWise Agent Runtime 配置，
  包含 binary path、port、autoStart、API key、base URL、runtime token、
  data dir、model、approval policy、sandbox mode、insecure。
- 绘画/设计 starter：GUI 首页不再放设计/绘画入口，只保留 Code、Write、
  连接手机相关核心流。

## Main / Preload 要拆的东西

主进程和 preload 不再暴露旧 agent IPC：

- 删除 `deepseek:spawn-if-needed`、`deepseek:update-*`、
  `deepseek:diagnostics`。
- 删除 `reasonix:rpc-send`、`reasonix:spawn-if-needed`、
  `reasonix` RPC event bridge。
- 删除 CodeWhale adapter、Reasonix adapter、Reasonix HTTP bridge、
  DeepSeek/CodeWhale updater、旧 binary resolver、旧 process manager。
- 删除 WorkWise Agent Runtime 之外的 diagnostics/importer 模块。用户要的是可用的单
  agent，不是运行时检测中心。

主进程现在只需要：

- `kunRuntimeAdapter`：启动/停止 `kun serve`、同步 config、
  计算 base URL、附加 auth header。
- `runtimeRequestViaHost`：确保 WorkWise Agent Runtime running 后转发 `/v1/*`。
- `startSse/stopSse`：按 `threadId + sinceSeq` 转发 WorkWise Agent Runtime SSE。

## Settings / Migration

保存后的 settings 结构只应有：

```json
{
  "agentProvider": "kun",
  "agents": {
    "kun": {
      "binaryPath": "",
      "port": 8899,
      "autoStart": true,
      "apiKey": "",
      "baseUrl": "https://api.deepseek.com",
      "runtimeToken": "",
      "dataDir": "~/.workwise/runtime",
      "model": "deepseek-flash",
      "approvalPolicy": "auto",
      "sandboxMode": "workspace-write",
      "insecure": false
    }
  }
}
```

代码里仍允许出现 `codewhale` / `reasonix` 字符串的唯一原因是读取旧
settings 文件时做一次性迁移：

- `agentProvider: codewhale | reasonix | deepseek-runtime` 归一为
  `kun`。
- 旧 `deepseek`/`agents.codewhale` 的 port、autoStart、API key、
  base URL、runtime token、approval、sandbox 会种到 `agents.kun`。
- 旧 `agents.reasonix` 的 API key、base URL、model、autoStart 会种到
  `agents.kun`。
- 迁移后的落盘文件不再保留 `agents.codewhale` 或 `agents.reasonix`。
- 连接手机（内部旧名 Claw）旧 `agentThreadIds.codewhale/reasonix` 只折叠成
  `agentThreadIds.kun`，不保留 per-agent map。

## Code / Write / 连接手机如何走 WorkWise Agent Runtime

- Code：`KunRuntimeProvider` 负责 list/create thread、send turn、
  steer、interrupt、compact、approval、SSE 映射。Chat UI 不知道旧
  provider。
- Write：写作助手和 inline completion 读取同一份 WorkWise Agent Runtime API key /
  base URL 配置。Write thread registry 只把写作线程识别为 WorkWise Agent Runtime
  thread，不再区分 Reasonix 会话。
- 连接手机：定时任务、飞书/Lark/微信、IM webhook 创建或复用 WorkWise Agent Runtime thread。
  代码内部仍沿用 `claw` route / settings key / runtime 文件名，作为旧命名兼容。
  `threadId` / `localThreadId` 字段只作为旧 settings 兼容字段存在，真正
  当前映射写入 `agentThreadIds.kun`。

## CodeWhale 功能等价面

替换 CodeWhale 不是只保留聊天。WorkWise Agent Runtime 的 GUI HTTP 面必须覆盖旧
provider 已经暴露给 store/UI 的能力：

- `GET /v1/threads` 支持 `limit`、`search`、`include_archived`、
  `archived_only`。默认隐藏 archived/deleted，会话搜索和归档视图不依赖
  GUI 本地猜测。
- `POST /v1/threads/{id}/fork` 复制 thread 历史、写入 fork lineage，
  并把历史 item 写回新 thread 的 session store。复制时会把 pending
  approval/user-input 规整为不可继续操作的历史状态，避免新会话悬挂旧 gate。
- `POST /v1/sessions/{id}/resume-thread` 沿用旧 CodeWhale resume 路径。
  WorkWise Agent Runtime 优先从同名 thread 恢复；没有 thread 时从 session snapshot
  或 JSONL items 重建 turns；找不到时返回 404，而不是在 GUI 抛
  unsupported。
- `POST /v1/user-inputs/{id}` 和旧兼容路径 `/v1/user-input/{id}` 都可接收
  `{ answers }` 或 `{ cancelled: true }`。AgentLoop 通过 `request_user_input`
  / `user_input` tool 暂停，GUI 回答后继续模型回合。
- `POST /v1/approvals/{id}` 继续支持工具审批；approval 和 user-input 都是
  gate/route/service 分层，不在 renderer 内实现 agent 逻辑。
- `GET /v1/usage?group_by=thread|day` 返回累计 token、turn、cache hit 数据。
  Workbench 首页和 composer 底部只消费 WorkWise Agent Runtime usage，不再打开 runtime
  insights 面板。

## 已删除/应保持删除的旧路径

旧 agent 运行路径不应再回来：

- `src/renderer/src/agent/codewhale-runtime.ts`
- `src/renderer/src/agent/reasonix-runtime.ts`
- `src/renderer/src/agent/reasonix-event-mapper.ts`
- `src/main/runtime/codewhale-adapter.ts`
- `src/main/runtime/reasonix-adapter.ts`
- `src/main/runtime/reasonix-http-bridge.ts`
- `src/main/deepseek-process.ts`
- `src/main/resolve-deepseek-binary.ts`
- `src/main/deepseek-updater.ts`
- `src/main/reasonix-process.ts`
- `src/main/reasonix-config.ts`
- `src/main/resolve-reasonix-binary.ts`
- `src/shared/reasonix-protocol.ts`
- `src/shared/deepseek-update.ts`
- Runtime diagnostics/importers for old agent paths

旧 UI 入口不应再回来：

- `AgentSwitcher`
- `ConnectionStatusBar`
- `RuntimeDiagnosticsDialog`
- `RuntimeInsightsPanel`
- `ReasonixInsightsPanel`
- 设计/绘画 starter card

## 设计模式约束

WorkWise Agent Runtime 包按 ports & adapters 组织：

- `contracts/`：HTTP/SSE DTO 和 zod schema。
- `ports/`：ModelClient、ToolHost、ThreadStore、SessionStore、
  ApprovalGate、EventBus、WorkspaceInspector、Clock。
- `adapters/`：DeepSeek-compatible model client、local tool host、
  file/in-memory stores、workspace inspector。
- `loop/`：AgentLoop、InflightTracker、SteeringQueue、ContextCompactor。
- `cache/`：ImmutablePrefix、LRU、TTL-LRU。
- `server/`：Router、auth、SSE、routes。

GUI 侧不实现 agent 逻辑，只做 HTTP client、SSE subscription 和状态映射。
新增能力时优先加 WorkWise Agent Runtime tool 或 HTTP endpoint，不新增 GUI 内第二个
agent。

## 验证清单

每次改这条线至少跑：

```bash
npm run typecheck
npm test
npm run build
```

手动冒烟：

1. 打开 WorkWise Agent Runtime 桌面应用。
2. Code 新建会话，能创建 thread、发送消息、流式返回、审批/中断可用。
3. Write 打开写作空间，inline completion 和选中文本助手能用同一个 API key。
4. 连接手机能保存设置、运行手动 task、把 thread id 写回 WorkWise Agent Runtime mapping。
5. Settings -> Agents 只看得到 WorkWise Agent Runtime，没有 provider switch、runtime
   diagnostics、CodeWhale/Reasonix 配置块。
6. `GET /v1/usage?group_by=thread` 有历史 usage 时，GUI 首页/底部不显示
   “暂无用量”，而显示 token、回合、缓存命中等指标。
7. 线程搜索、归档视图、fork、resume session、request_user_input 回答/取消
   都能通过 WorkWise Agent Runtime HTTP 路径完成。

## 持续任务与文档交付工作台

本节补充下一版任务工作台的持久化合同。现有 KUN 运行时仍是唯一运行时；聊天、Write、Flow 和任务工作台共用本地 HTTP/SSE 边界。

### 任务恢复与幂等

- `TaskRun` 是长期目标的权威记录，Flow 通过 `flowId`/`flowRunId` 关联但不取代 Flow 自己的节点状态。
- 任务输入、人工待办、操作回执和 outbox 写入 `tasks.sqlite3`；Flow 数据继续写入 `flow.sqlite`，不假设跨库原子事务。
- 输入先持久化再消费；相同幂等键重放返回原输入，不同内容复用同键返回冲突。
- 所有任务变更携带期望 revision；外部动作结果不明时标记 `outcome_unknown`，确认前不得盲目重放。
- 恢复同时检查租约、进程身份和持久回执；lock 文件或等待超时本身不构成重启依据。

### 人工介入与子任务

审批和用户问题持久化为 Inbox 项目。回答先落库，再由活跃 gate 或持久 outbox 唤醒任务；重启后会创建带已保存回答的继续回合。暂停或取消的任务不会因为迟到回答自行恢复。

子任务会话保存在运行时数据目录，权限取父任务授权与子任务需求的交集，包含工作区、工具、MCP、外部目标和预算；交接包记录结论、证据、成果、已完成操作和剩余事项。

### 工程文档交付

内置模板为监测报告、招投标技术文件和通用研究与文档。Flow 节点 `railwise.task_delivery` 启动或恢复持久 `TaskRun`，通过固定的隐藏执行 thread 关联同一交付任务。等待期间协调器只检查本地持久状态，不请求模型；只有 `verifyTaskDelivery` 核验草稿、来源、适用的 DOCX/PDF 和监测图表后，才把任务结果交回原 Flow。

文档交付 profile 使用明确的只读资料工具清单（`read`、`ls`、`find`、`grep` 和附件分节读取），加上 `read_delivery_sources`、`propose_document`、`export_document`、`analyze_delivery_monitoring` 与 `read_task_context`。它不会因为 Runtime 新增工具而自动获得 Shell、普通文件写入、MCP、Flow 或外发能力。该限制用于新建的内置模板执行，不改写用户已有 Agent profile。

`propose_document` 把 Markdown 写入 `.workwise/delivery-candidates/<taskId>/`，以独占创建保留已有文件。旁置 `.sources.json` 记录候选哈希、目标基线、来源哈希和 `contextBundleId`；来源在读取后发生变化时拒绝生成，要求重新读取受影响资料。图片链接按候选位置重写，现有本地图片须在授权工作区内，并纳入来源校验。任务界面展示来源和正文差异；接受候选通过主进程文档服务再次校验候选及目标版本，保留替换前内容并追加文档历史。冲突和结果不明不等于已提交。

候选同时记录 `sections`（稳定 ID、标题、级别、行范围、来源路径）与每个来源支持的章节。`source_refs.sections` 可以指定唯一标题或 section ID；省略时保守关联全部章节。标题解析支持 ATX/Setext，排除 frontmatter 和 fenced code。局部重生成使用 `base_candidate_path`、`expected_candidate_hash` 与 `section_patches`，写入新的候选路径，记录递增版本和被替代候选的路径/哈希。补丁替换章节正文，保留原标题、子标题结构及未选区域的原始字节；同名标题需用稳定 ID，父子重叠补丁会拒绝。结构重排需生成整篇新候选。

来源更新只能在重新读取实际新版本、且补丁覆盖该来源全部受影响章节时纳入新候选；未受影响内容和其他来源版本保持。目标正文在此过程中完全不写入，原候选的目标基线也不能悄悄改成外部新版本。完成校验仅要求显式替代链末端的候选导出成功，旧候选和旧操作回执仍保留。

已结束任务的局部重生成可在新的隐藏执行任务中引用同一授权工作区内的旧候选；必须给出旧文件精确哈希，且 namespace 与元数据中的旧任务一致。新候选写入新任务 namespace 的对应相对目录；需要保留的局部图片按字节哈希核验后复制到新 namespace，避免改写未选正文的相对链接。显式 `source_refs` 只替换所选章节的来源依赖，未选章节仍保留旧来源；无法核验的旧来源不会自动变成新版本。

`analyze_delivery_monitoring` 把用户 CSV/XLSX/JSON 和项目 JSON 交给现有确定性工程服务，完成导入、校验、统计及 SVG 图表。阈值、单位、规范版本等业务条件仅来自用户资料。模型组织解释，不生成测值或专业签署。

`export_document` 通过主进程临时开启的 loopback capability bridge 调用写作工作台现有 DOCX、HTML 和 Electron PDF 渲染器。桥的随机 bearer 只传给本轮受管 Runtime，不保存到用户设置。产物写到 `.workwise/delivery-exports/<taskId>/`，每种格式单独记录哈希、大小及操作回执。重放先核验已生成文件；丢失 HTTP 回包时只查询持久回执，不能重新 POST 渲染。桥不可用、部分失败或结果待核实均保留草稿和待办，不显示全部交付完成。

### 来源事件、待办与上下文

Webhook 验签通过后，将 nonce、请求指纹、固定 Flow 发布版本、原始事件、queued run 和派发 outbox 在 `flow.sqlite` 的同一事务内提交。Schedule 的本次 `dueAt` 事件与下一次时间也在同一事务内提交；保留现有逾期调度语义。Task 消费成功后再确认 Flow outbox，跨库重复投递通过稳定事件及执行实例标识去重。

独立 Flow 的审批或断点会生成带 `flowId`、`flowRunId`、`nodeId` 和工作区的持久 Attention，通过 Flow outbox 投影到任务 Inbox。消费方只接受更新的 Flow revision，旧 pending 事件不能重新打开已处理事项。取消等待中的 Flow 会持久取消；同一审批节点的不同执行 occurrence 使用不同操作键，保留既有决定回执。审批与继续仍调用原 Flow 服务，不把它伪装成 Agent Turn。

`TaskContextRepository` 复用任务仓储的 SQLite 连接和事务；来源投递、TaskInput、订阅消费和交接 outbox 可在任务库内一并提交。来源规则先筛选，明确拒绝或仅记录的事件不唤醒模型。重叠订阅按“事件＋目标 ExecutionSession”合并，暂停任务只收件，不恢复执行。

模型执行前保存实际上下文的 `ContextBundle`。文档来源只来自成功的内容读取和确定性分析输入；目录列举、文件属性及生成物路径不会被当作已读证据。读取工具返回实际字节 SHA-256；后续检查保留该读版本，比较当前文件，不能把新文件哈希冒充模型已读版本。来源变化或消失会把相关 bundle 标为过期。大内容保存在带哈希的本机对象中；`read_task_context` 只能读取当前任务 bundle，复核范围与完整性，并按有界偏移返回内容。具体请求投影保留不可变前缀与工具协议结构，不把来源内容当作新增授权。

### 记忆与迁移

中文记忆检索使用本地分词和字符片段回退；无确定项目归属的记忆保留为“待关联”，不自动注入其他项目。经验候选默认关闭并需审阅。

任务数据库迁移是增量的，迁移前备份为 `tasks.sqlite3.pre-durable-v1.bak`；Flow 数据库沿用 `flow.sqlite.before-delivery-v1.sqlite` 备份名。旧 `.workwise`、插件、MCP、Skill、凭据引用、工作区路径、`activeFilePath` 和旧 IPC 继续可读。
