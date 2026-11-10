# RailWise AI Harness 实施状态核对（2026-11-10）

本记录对照用户《Harness 可信执行与连接器闭环整改计划》阶段 A—E，核对生产入口、测试覆盖和验收缺口。首包源码为 `72e4bf9b4ca890152f7a0c7f30d9fb9e223b7455`，随后修复到 `7596843628f96901634198f54cb74ec28099faa4`；当前工作树进一步实现技能与连接器独立页签、飞书首次配置与身份绑定、钉钉官方 DWS。旧源码的测试和安装包结果仅证明各自版本，不能覆盖后续改动。最新源码与精确包证据见本页末尾的连接器工作台增量记录。这些改动尚未发布。

**当前结论：已有主要生产接线和针对性回归，不能据此宣布整个计划或发行验收全部完成。** 类型化连接器代码、模拟协议回放、真实 Runtime/SQLite 集成测试与真实平台业务操作是不同证据等级。真实平台、精确包、中文 Windows/macOS 和真实用户资料验收仍须分别记录。

## 状态口径

| 标记 | 含义 |
| --- | --- |
| 已接线 | 源码中可以从正式生产入口到达实现；不等于真实账户或精确包验收通过 |
| 部分接线 | 已有可运行路径，但没有覆盖原计划的全部入口、权限或界面细节 |
| 待验收 | 需真实外部账户、平台权限、实际安装包或目标操作系统证据 |
| 未宣称 | 代码或测试没有提供相应保证，不能以文字推断为已完成 |

下列“测试覆盖”列说明相应断言所在位置。实际执行范围与结果见文末；未运行的环境、真实账户和实机故障场景继续标为待验收。

## A：Harness 合同和回归保护

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| `TaskIntent`、规则优先识别 | `kun/src/contracts/harness.ts`、`services/external-task-capability.ts`、`services/task-coordinator.ts` 区分知识问答、外部请求、连接请求和双平台歧义；飞书/Feishu 归一为独立的 `lark` Provider，与钉钉分开 | `external-task-capability.test.ts`、`task-coordinator.test.ts`、`server/routes/external-turn-routing.test.ts` | 已接线。不是任意自然语言的无误分类保证；规则之外的归属判断仍受现有协调器约束 |
| 在创建 Turn 前能力预检 | `contextual-external-task-preflight.ts` 在 Provider 诊断后核对持久执行 Thread、工作区信任、Agent 白名单和真实 `listTools`；`runtime-factory.ts` 正式装配；缺能力请求持久为等待任务 | `tests/harness-preflight-context.test.ts`、`contextual-external-task-preflight.test.ts`、`external-turn-routing.test.ts` 覆盖无 Turn、禁止策略、Agent 范围、不可读信任记录和旧 Turn 入口 | 已接线。`networkState: unknown` 不代表已联网成功；预检不额外发业务请求来冒充网络验证 |
| 阻断不调用 Bash、不生成虚构 `dws` | 系统提示、沙箱解析、连接器预检和类型化 Provider 分层限制；钉钉缺配置不会转成飞书或命令教程 | `sandbox-policy.test.ts`、`lark-cli-tool-provider.test.ts`、`dingtalk-tool-provider.test.ts`、连接器 Runtime 测试 | 已接线。仍需精确包回放原始钉钉案例，检查实际模型回复及界面 |
| `ExecutionGrant` 写入当前执行 | `contracts/permissions.ts`、`loop/agent-loop.ts`、`contracts/turns.ts` 和执行记录保存服务端 Grant；工具边界再次核验版本、范围和有效期 | `sandbox-policy.test.ts`、`explicit-approval.test.ts`、权限与生产预检集成测试 | 已接线。Grant 是服务端确定的当前 Turn 权限，客户端设置本身不是执行授权 |
| 持久 `OperationReceipt`、`ResultEvidence`、`effect` 验收 | `contracts/tasks.ts` 复用旧持久回执结构；`prepared/running` 对应计划的请求准备/已开始语义，保留兼容状态名；`external-effect-evidence.ts` 校验 Provider、操作、目标、当前任务执行和真实核验数据 | `external-effect-evidence.test.ts`、`external-effect-recovery.test.ts`、`tests/task-retry-ledger.test.ts` | 已接线。模型文本、假工具结果、其他任务回执或一项成功不能满足完整 effect 合同 |
| 动态真实工具目录、旧解析入口保护 | `local-tool-host.ts`、`sandbox-policy.ts`、`agent-loop.ts` 按 Grant、沙箱、Agent 和 Provider 过滤；记录目录指纹及变化事件；普通 `workspace-write/read-only` 不广告 Bash | `capability-registry.test.ts`、`sandbox-policy.test.ts`、`tests/harness-connector-runtime.test.ts` | 已接线。尚需用最终模型请求/精确包确认实际展示的工具目录 |
| 解释文本不能误标完成 | `task-controller.ts` 和 `external-effect-evidence.ts` 将“有最终回复”和“目标已执行并核验”分开；宽泛处理任务先确认有限集合 | `external-effect-evidence.test.ts`、`external-effect-scope-tool-provider.test.ts` 覆盖无集合、错目标、缺回执、未知结果和未批准 | 已接线；真实案例验收待补 |

补充闭合的旁路：`flow/runtime-adapters.ts` 现在只允许通用 HTTP 的 GET/HEAD；钉钉、飞书/Lark 官方域连读取也必须经过各自 Provider。写方法、method-override 和平台 URL 在 fetch 前拒绝；禁止自动跟随重定向。`flow/execution-policy.ts` 产生 `external_effect_requires_typed_provider`，Executor 不重试，也不让旧 continue/error-edge 策略把权限阻断变为成功。`flow/runtime-adapters.test.ts` 覆盖零 fetch、一次尝试、正常 GET/HEAD 和原 Flow/版本/定时状态保留。迁移说明见 [可信执行说明](../harness-trusted-execution.md#flow-http-节点兼容迁移)。

## B：权限和授权闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| 工作区信任接入 Runtime | 主进程 `WorkspaceTrustService`、Runtime `services/workspace-trust-reader.ts` 与 AgentLoop Grant 创建/再次核验连接；不因用户选中目录就授予写权限 | `workspace-trust-reader.test.ts`、主进程 `workspace-trust-service.test.ts`、`harness-preflight-context.test.ts` | 已接线。真实旧资料/路径组合迁移尚待验收 |
| 最终权限取交集 | 工作区/Agent 信任、沙箱、工具和 MCP 白名单、Provider、路径/网络/scopes/精确动作目标共同限制；子任务收紧父范围 | `sandbox-policy.test.ts`、`harness-connector-runtime.test.ts`、Provider 精确目标检查 | 已接线。不是 OS 级全能力沙箱声明 |
| 授权卡可解决实际阻断 | `CapabilityRequiredCard.tsx` 提供安装、诊断、Lark 登录、设置、工作区选择、拒绝和重新预检/继续原任务；任务待办复用同一卡片 | `CapabilityRequiredCard.test.ts`、`TaskWorkspaceView.dom.test.ts` | 已接线。已覆盖特定连接器/策略路径，不宣称所有网络、任意路径和错误都已拥有独立的一键修复 |
| 有限期任务权限及版本检查 | `services/task-permission-service.ts`、`server/routes/tasks.ts`、preload 和 `TaskPermissionPanel.tsx` 允许显式审阅后，把当前独立任务的 `never` 调整为有限期 `on-request`；不改变发起聊天或全局信任；修改 Agent 后需重新核对 | `task-permission-service.test.ts`、`task-permissions.test.ts` | 已接线。这不是任意路径/网络/Provider 的通用提权器；不自动恢复任务 |
| 一次主机命令授权 | `scoped-host-shell-tool-provider.ts` 仅给非连接器任务有限入口；审批绑定完整命令哈希、任务、Turn、租约、Grant、版本和期限；复用已有 Shell Adapter | `scoped-host-shell-tool-provider.test.ts`、`task-controller-host-shell.test.ts`、`tests/host-shell-runtime.test.ts` | 已接线。普通 Bash 继续隐藏；连接器 effect 和子 Agent 不可用此入口代理平台操作 |
| Shell 进程身份和未知结果 | 既有持久 Shell 会话保留 PID/指纹/输出；一次授权只能派发原命令，原会话可轮询/受限停止，不能写 stdin 或借旧授权执行新命令 | host-shell 测试覆盖拒绝、假审批、失效、失租、未知结果不重放和会话边界 | 已接线。跨平台 PID/进程组和崩溃实机验收待补 |
| 双 Runtime、迟到提交 | 执行 attempt/fencing、当前 Grant 及权限版本、实际派发前的校验共同阻止旧执行重新用新授权；未知操作阻止“取消再重试”换账本绕过 | `task-controller.test.ts`、`task-permission-service.test.ts`、`task-retry-ledger.test.ts`、`external-operation-verification.test.ts` | 已有针对性回归；不等于已完成双实机 Runtime 长时验收 |
| 不同阻断有不同代码 | 沙箱、路径、网络、scope、连接器缺失、审批拒绝、授权失效分别返回代码；UI 展示原因及可用范围 | 预检、沙箱、Provider、权限服务及卡片测试 | 已接线。当前 UI 主要在预检卡和权限审阅处显示权限，不宣称每个普通 Turn 前都弹出完整权限总览 |

计划中“授权一次任意工作区路径/网络范围”的通用卡片尚不能由当前有限任务审批和一次命令授权推断为全部交付。现有实现应按实际按钮和服务能力描述；需要扩大到新的路径或外部目标时继续使用明确的配置/范围审阅，不能暗中放宽 Grant。

## C：连接器执行闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| 启动诊断 Lark CLI | `src/main/managed-runtime-process.ts` 启动时诊断受管理 CLI，保存可信状态；`services/managed-tool-service.ts` 区分未安装/未登录/有效身份/错误；Runtime `managed-lark-runtime.ts` 读取状态 | 主进程 `managed-runtime-process.test.ts`、`managed-tool-service.test.ts`、`harness-connector-runtime.test.ts` | 已接线。不能仅凭 CLI 退出码 0 判定用户已授权 |
| 受控安装、设备登录和热刷新 | 安装、设备登录与回调由主进程管理；验证官方 HTTPS 登录域；凭据/设备流程留在主进程；IPC 更新后请求 Runtime refresh；卡片需再次预检再继续原任务 | `managed-tool-service.test.ts`、`register-app-ipc-handlers.test.ts`、`lark-connector-refresh.test.ts`、卡片测试 | 已接线；真实 CLI 下载、真实用户登录和 Scope 授予待验收，尤其国内网络环境 |
| Lark 待办/审批工具 | `lark-cli-tool-provider.ts` 注册任务 list/detail/complete、审批 list/detail/approve/reject；仅传类型化参数和固定 CLI 协议，要求诊断身份、品牌和实际用户 scopes | Provider 测试覆盖工具过滤、错误回包、确认、目标回读和回执 | 已接线。协议核对基于固定上游版本，见 [Lark 说明](harness-lark-provider.md)；不是已运行真实审批的证据 |
| 钉钉官方连接器 | 官方 DWS 受管理安装及设备授权作为主路径，类型化命令绑定精确账号；原 `connectors/dingtalk-auth.ts`、`managed-dingtalk-runtime.ts`、`dingtalk-tool-provider.ts` 和企业应用设置保留高级兼容，个人与企业授权继续分开 | `dingtalk-auth.test.ts`、`managed-dingtalk-runtime.test.ts`、Provider 和设置卡片测试 | 已接线；真实用户/企业应用权限和业务 API 接受情况待验收。缺配置继续阻断，不声称能力可用 |
| 写操作确认和有限目标集 | `external-effect-scope-tool-provider.ts` 先审阅完整有限 Provider/动作/目标集合；Provider 每次写前检查当前范围和显式批准，执行前持久记录批准证明 | scope Provider、Lark、钉钉与 evidence 测试 | 已接线；实际平台写操作需要用户指定测试目标，不能自动用真实业务审批做试验 |
| 成功核验、幂等和未知结果 | 工具边界持久回执；Provider 对目标回读；`external-operation-verification.ts` 用只读工具核验未知操作，原未知记录保留；不会自动重放写入或自动恢复任务 | `external-effect-recovery.test.ts`、`external-operation-verification.test.ts`、`task-retry-ledger.test.ts` | 已接线。平台没有返回操作 ID 时不伪造；使用实际可获得的目标状态及哈希证据 |
| 不通过 Bash/HTTP 代替平台 | 平台权限只给类型化 Provider；普通聊天不注册平台写入，子任务不能自行扩大权限；Flow 通用 HTTP 旁路已阻断 | host-shell、connector-runtime、Flow runtime-adapter 测试 | 已接线。现有 Flow 通用 HTTP/Agent 节点没有直接替代任务授权账本的外部写入入口，旧写节点需按迁移说明处理 |

真实飞书、Lark 与钉钉均未在此记录中获得“真实账户端到端通过”结论。合成 API/CLI 回包可验证程序分支、权限和持久化，不能证明租户实际 Scope、官方服务可达性、生产 CLI 兼容性或用户身份有效。

## D：任务和界面闭环

| 计划事项 | 实际生产接线 | 关键测试覆盖 | 状态及缺口 |
| --- | --- | --- | --- |
| `capability_required` 持久待办 | TaskCoordinator 保存原请求、等待任务和卡片 payload；聊天 outbox 与任务中心显示同一阻断；卡片继续原任务，避免跳入隐藏执行聊天 | `task-coordinator.test.ts`、`external-turn-routing.test.ts`、卡片与任务 DOM 测试 | 已接线；精确包中文操作待验收 |
| 任务状态、回执和核验证据 | `TaskWorkspaceView.tsx`、`TaskExecutionEvidence.tsx` 展示平台、动作、目标、成功/失败/未知回执和证据；未知结果提供只读核验及配置入口；内部执行 ID 不在普通详情中展开 | `task-operation-receipts.test.ts`、`TaskWorkspaceView.dom.test.ts` | 已接线；仅 UI mock/DOM 断言不能代表实际包视觉和全部操作可用 |
| 状态询问/补充/新任务/暂停 | 协调器在 Turn 前路由；状态本地读取，补充持久入队，新任务独立执行，暂停期间输入不自行唤醒；IM/Schedule 已经过协调入口 | Coordinator、任务控制、schedule-runtime 和 external-turn-routing 测试 | 已接线；真实模型跨回合交互待验收 |
| SSE、恢复和通知 | `task-live-store.ts` 共享一个状态流；main/preload 使用现有 SSE；按序号去重、断线有界退避并补读；持久待办为权威状态，OS 通知失败不变更任务 | `task-live-store.test.ts`、已有 SSE/API 合同与任务事件测试 | 已接线。本实现采用共享流及退避刷新，没有把“2.5 秒全量轮询”当作正常连接策略；端到端断网实机回放待补 |
| 导航 capability gating | `WorkspaceSecondaryNavigation.tsx` 从 Runtime manifest 读取 Schedule/Flow/Design 的 enabled/available/status；默认隐藏未知、preview 和不可用项，当前深链保持可达 | `WorkspaceSecondaryNavigation.test.ts`、WriteSidebar 导航测试 | 已接线至这些工作台入口；不据此宣称所有市场插件/所有调研子入口都完成统一状态和配置页验收 |
| 市场安装、配置与可用状态 | `PluginMarketplaceView.tsx`、`plugin-marketplace-status.ts` 统一列表与详情的可安装、需配置、已配置待验证、已安装及不可用状态；安装记录和 catalog 可用性分开；外部 OAuth/token 仅有凭据引用或安装 health 不显示已授权；不可用包仅提供来源入口，不误导点击安装 | `plugin-marketplace-status.test.ts`、`PluginMarketplaceView.dom.test.ts` 覆盖离线/不可用、保留安装记录、配置计数、授权不误报及中文文案 | 已接线。不增加后台网络请求，不因 catalog 不可用改写、删除或禁用现有配置；真实远端诊断和全部深链配置页仍需独立验收 |
| 旧工作区迁移及隐藏别名 | `workspace-migration-service.ts` 扫描四命名空间、指纹/冲突/真别名，显式确认后创建独占快照和记录；侧栏只合并实时 realpath 相同的目录；独立目录/历史不隐藏 | `workspace-migration-service.test.ts`、IPC schema/handler、Sidebar 和 workspace-path 测试 | 已接线。遇活动数据库会报告需一致性备份而拒绝普通复制，不宣称已自动迁移任意活动 SQLite |
| 默认工作区可清空、切换、改显示名 | navigation/thread actions、Sidebar 和 workspace-label 保留真实路径与历史身份；显式清空不暗中回填旧默认，新任务不借旧选项恢复 | `chat-store-navigation-actions.test.ts`、`chat-store-thread-actions.test.ts`、Sidebar 测试 | 已接线；真实用户含旧配置、凭据引用及多个来源冲突的迁移需实际副本验收 |

文档交付的生产回归还发现并修正了权限路径别名问题：历史 TaskRoot 与 Turn canonical root 经 realpath 核实相同时，文件读取、候选、工程分析及导出沿用 Turn 授权上下文，保留原任务路径；不同工作区、被重新指向的别名和受限 allowlist 继续拒绝。覆盖见 `document-delivery-tool-provider.test.ts` 和 `tests/task-delivery-production.test.ts`。该修复不放宽路径授权。

## E：精确候选包与发布验收

| 交付/检查 | 本记录可确认的证据 | 当前结论 |
| --- | --- | --- |
| 最终精确源码、相关 CI、聚焦测试、类型检查 | `72e4bf9b` 干净独立工作树按锁文件安装；KUN 36 文件/305 项、Desktop 28 文件/453 项通过，双端类型检查及 ESLint 通过；翻译/权限面板 6 项、旧流程 3 项补充验证通过；`c6f52a4b` 两轮自动 Quality 均通过 | 本地及完整 CI 通过；外部平台/精确包另验收 |
| 生产构建 | 同一精确源码 `npm run build` 通过，build freshness 1267 个输入、品牌检查 3227 文件、文档依赖/许可证、OpenSpec 13 项通过 | 本地生产构建通过；精确分发包另验收 |
| 精确 macOS 候选包安装、版本、bundle、签名、适用公证 | 首包 `72e4bf9b` 已安装隔离目录，版本 `0.5.4`，arm64，独立 bundle `com.wangjiawei508.workwise.candidate.head72e4bf9b4ca8`，Developer ID `R35G7F4A9U`；本机 codesign/stapler/Gatekeeper 与 DMG/ASAR hash 校验通过 | 首包身份通过；因发现 UI 缺陷需验收修复后精确包 |
| 中文 macOS 主使用场景 | 首包中文深色 CUA 重放钉钉缺配置、Lark 未安装、状态查询、任务计数与证据面板、工作区改名。实际模型 span/发送/usage/工具回执均为 0，两平台任务保持 waiting_user。发现显式设置跳错页、会话假运行和重复安装标签三项缺陷 | 已执行并发现缺陷，不能标为整体验收通过；修复后回归待补 |
| 中文 Windows、安装身份和主要交互 | Windows 相关路径/工具安装有自动化分支；没有对应 Windows 机器/精确包证据 | 待验收，不得以 macOS 成功代替 |
| 真实 Lark/Feishu 账户 | 有协议核对与合成回放；尚无本轮账户安装→登录→Scope→预检→读取→明确批准→写入→回读结果 | 待真实测试账户和有限目标验收 |
| 钉钉缺配置 | 预检/Runtime/设置卡片有合成覆盖 | 精确包未配置场景待验收 |
| 钉钉真实 OAuth、个人待办和企业审批 | 有官方 API 适配和合成覆盖；个人 OAuth 不代表企业 Workflow 已授权 | 待各自平台实际权限与测试目标验收 |
| 真实旧资料迁移 | 生产迁移服务为实际旧工作区 1670 文件建立私有快照，哈希和幂等重试通过，源目录不变；生产 JsonSettingsStore 对 3 个 profile/4 份真实 V1/V2 设置的私有副本完成读取、保存、重开与 V1 备份核验，敏感配置值均保留，源文件不变 | 上述真实数据副本范围通过；真实样本无 credentialRef，不宣称 Keychain、完整 profile 或 SQLite 迁移通过 |
| 发布说明和回归证据 | [可信执行说明](../harness-trusted-execution.md)、[Lark](harness-lark-provider.md)、[钉钉](../dingtalk-provider.md) 说明实现、边界和迁移 | 需把最终结果追加后形成候选交付证据 |
| 公开发布、版本号、Stable、官网 | 本记录未执行或证明任何公开发布操作 | 未发布，不宣称发行就绪 |

本计划未修改 updater 或新增更新路径时，不因本 Harness 变更额外设真实 updater smoke 为默认门禁。若最终实现触及 updater/新路径，则按 AGENTS.md 对精确包补一次真实 smoke。也不恢复重复私有冻结、全 UI 矩阵、截图档案或独立 AI 审查为默认要求。

## 尚不能关闭的事项与下一步

1. CI、本地精确源码聚焦测试、类型检查和生产构建已通过。保留旧 CI 的翻译插值失败及旧占位归档被误期望为成功的失败记录；后续测试分别验证正常 DOCX/持久审批成功、保留旧归档节点的流程明确失败，未放宽生产拒绝策略。
2. 形成并安装同一精确候选包，核验实际版本、bundle、签名和适用公证，检查主要中文 macOS 场景；另取得中文 Windows 的实际运行证据。
3. 用明确授权的测试账户完成飞书/Lark 与钉钉连接、真实读取、Scope 缺失/过期及恢复；真实写入只针对明确测试待办/审批，保留平台实际响应及回读证据。
4. 真实工作区和设置副本验证已完成上述范围；完整插件/MCP/Skill 及 credentialRef/Keychain 仍需相应真实样本，不能从设置值保留推断整套资料验收。活动 SQLite 走一致性备份，不对原件执行普通目录复制迁移。
5. 逐项核对计划中尚属部分交付的体验：任意路径/网络的一次性范围授权、每次执行前的权限总览、市场提供商的实时诊断及全部深链配置页。市场已根据本地 catalog/安装/配置事实统一显示状态，但这些仍不能被现有任务卡、Shell 授权或三个工作台的导航过滤代替。
6. 取得上述证据后再判断 A—D 是否满足正式产品完成条件及 E 是否可以进入发布；缺少真实平台或目标 OS 能力时明确写待验收，不把模拟结果填成通过。

## 首轮执行证据（历史源码，非当前最终包）

- 精确源码/依赖锁：`72e4bf9b4ca890152f7a0c7f30d9fb9e223b7455`，独立干净工作树 `npm ci`；后续两个测试提交不改变生产代码，候选包仍对应 `72e4bf9b`。
- 聚焦测试：KUN 305 项、Desktop 453 项通过（共 758 项）；翻译与权限面板补充验证 6 项、旧流程 3 项通过。Desktop/KUN 类型检查及 ESLint 均通过。
- 完整 CI：`c6f52a4b` 的 [42804000420](https://github.com/railwise-cn/railwise-ai/actions/runs/42804000420)、[42804010470](https://github.com/railwise-cn/railwise-ai/actions/runs/42804010470) 均成功，含全量测试、生产构建、Windows 路径/进程/持久化及 Electron 生产启动。不是 Windows 交互 UI 或真实平台写入验收。
- 生产构建及精确候选标识：本地生产构建通过；首个私有签名候选构建 [42801605406](https://github.com/railwise-cn/railwise-ai/actions/runs/42801605406)，源码 `72e4bf9b`，不发布、不改 Stable、无重复冻结。
- 首包版本、bundle、签名、公证：`0.5.4` 私有 Candidate、arm64、独立 bundle `com.wangjiawei508.workwise.candidate.head72e4bf9b4ca8`，Developer ID `R35G7F4A9U`，本机 codesign/stapler/Gatekeeper 均通过。DMG SHA-256 `54a44f7bafe3bfe892ce26451a163c5bed8c9f74929c7e5a992c140f86abddbd`，ASAR SHA-256 `4bc8e054f4d8aee32fc56ccf861d0bb1a9d9efa70f38d94dab20f0dc18003dbc`。不代表修复后包通过。
- macOS/Windows 中文包验收：待登记。
- 真实 Provider、实际模型与测试目标：待登记；缺失保持待验收。
- 真实资料副本迁移结果：4 个实际旧工作区、1670 文件私有快照校验通过；3 个 profile 的 4 份真实 V1/V2 设置副本读取/迁移/保存/重开通过，原资料哈希不变。未上传私有内容；未验证真实 Keychain、完整 profile 和活动 SQLite。
- 发布判断与剩余缺陷：待登记。

## 首包 CUA 缺陷记录

| 缺陷 | 实际观察 | 修复与回归要求 |
| --- | --- | --- |
| HUI-01 | 无模型 Key 时，“配置钉钉连接器”请求通用设置，异步加载却覆盖为供应商页 | 移除无 Key 强制重定向，保留提示；DOM 覆盖延迟加载后的通用、供应商、写作和 Agent 显式入口；修复后包再次点击 |
| HUI-02 | Lark 预检已持久等待，模型调用为零，但现有会话持续显示运行中；API 把本地 command 回执重建成 completed Turn | 明确本地会话回执与执行 Turn，SSE 回执不得启动 busy/watchdog；修复后包核对首次建会话与现有会话两入口 |
| HUI-03 | 卡片两个“安装 Lark CLI”按钮，一个安装，另一个只打开市场 | 配置入口明确显示“打开插件市场”；DOM 验证只存在一个安装按钮且市场按钮不触发安装；修复后包检查 |

首包检查结果为“发现缺陷”，并非 passed。原始包、回执和缺陷记录保留；重打包用于验证实际修复，不是重复冻结门禁。验收未使用生产 profile、真实账号或真实审批，也未修改官网/Stable。


## 连接器工作台增量（2026-11-10）

本增量依据用户要求研究了 WorkBuddy 的实际入口与连接前流程，再落实到 RailWise；没有复用其私有代码，也未把竞品的目录描述当作已支持能力。研究与迁移说明见 [技能与连接器工作台](../connector-workspace.md)。

- 入口集中为“技能与连接器”，连接器、技能、插件各自页签。连接器默认展示，旧插件/Skill/MCP/安装及权限记录保留。
- 飞书和钉钉原生连接卡在目录断网时仍可打开。详情说明能力、实际连接状态和操作边界；只有用户点击连接才安装或启动授权。
- 飞书补齐首次 `config init` 官方应用扫码，再进入账号授权；应用/Profile/用户身份和可执行哈希绑定执行 Grant，业务使用同一隔离配置目录和固定 Profile。
- 钉钉已核实存在官方 DWS 和设备授权。本增量增加固定版本、摘要校验、官方源回退、隔离配置/凭据目录、同进程等待和取消、类型化业务命令；原 HTTP 企业配置移入高级兼容入口，不删除旧配置。
- DWS 只读身份诊断没有业务 Scope 清单，本机登录有效不能被显示为已完成审批权限验证。写操作继续经过明确目标确认、回执和回读；未知结果或后端/账号切换不能自动重放。
- 用户无需现在提供账号、密钥或测试 ID。官方页面扫码和授权由用户完成；业务写入验收到执行时再选定具体测试条目。

最新聚焦测试、CI、构建、精确包标识和中文 UI 结果将在对应操作实际完成后登记。未完成真实扫码、远端读取或写入时维持“待验收”，不把合成 fixture 当作真实平台通过。
