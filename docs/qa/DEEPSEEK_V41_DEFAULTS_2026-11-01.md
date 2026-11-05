# DeepSeek V4.1 Flash 默认与自动模式

## 当前官方依据

2026-11-01 读取 [官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing)，并使用现有配置只读查询 `https://api.deepseek.com/models`（HTTP 200）：

- `deepseek-flash` 是 DeepSeek V4.1 Flash 的正式 API ID，当前版本为 `DeepSeek-V4.1-Flash-1017`。
- 此产品版本的定时任务与 Claw IM 设置只显示当前 Flash 模型。其他服务商可继续使用自己的模型 ID。
- 旧 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 对应模型已退役，服务端仍接受旧名称并交由 V4.1 Flash 处理。

默认与自动模式统一使用 `deepseek-flash`。复杂任务仍可使用 `max` 思考强度；自动分类器失效、返回旧模型建议或长提示词均不会把默认模型切回旧 ID。

## 迁移矩阵

| 原项目或状态 | 新状态 | 原因 | 数据保留行为 | 用户操作 |
| --- | --- | --- | --- | --- |
| 新安装、未配置的主 Agent / Write / Runtime 默认 | 保持 `deepseek-flash`，明确显示 V4.1 Flash | 原默认 ID 已正确，补齐说明 | 不写入正式用户配置 | 无 |
| `auto` 的复杂、长任务与失败回退曾选择 V4 Pro | 所有任务使用 `deepseek-flash`，保留分类思考强度 | 用户要求当前默认统一 V4.1 | 历史对话和已记录模型不重写 | 无 |
| 自动分类器返回旧 Pro 或 Flash 建议 | 归一为 `deepseek-flash`，保留有效思考强度 | 不能让旧建议改变当前默认 | 仅影响新 `auto` 回合 | 无 |
| 内置 DeepSeek 的定时任务和 Claw IM 中保存的 `deepseek-v4-*` 选择 | 迁移到 `deepseek-flash` | 相关入口统一使用当前 Flash 模型 | 只更新模型 ID；会话、凭据、历史和工作区不变 | 无 |
| 自定义服务商下的同名旧 ID 或自定义模型 | 原样保留 | 这些 ID 由用户配置的服务商定义 | 设置与任务内容保留 | 无 |
| Claw 的 `/model pro` 与旧模型命令 | 作为兼容别名接受；内置 DeepSeek 保存并显示 `deepseek-flash` | 避免旧命令再次选择退役模型 | 不删除历史对话 | 无 |
| 插件、MCP、Skill、凭据和工作区文件 | 全部保留 | 仅调整模型默认路由及说明 | 无删除、替换或凭据迁移 | 无 |

## 改动与验证边界

- 新安装默认值此前已是 `deepseek-flash`；本次将同一迁移应用到保存的定时任务、Claw IM 模型和运行时模型提示。第三方提供商模型 ID 保留。
- 当前用户指南、中英文默认说明、README 和配置示例改为 V4.1 Flash；历史验收记录不重写。
- 回归覆盖旧建议归一、复杂和长提示词回退、AgentLoop 实际请求、显式 Pro / 旧 Flash / 自定义模型与历史线程选择保留。
- 官方查询的精简证据位于 `evidence/railwise-0.5.4-markdown-advanced-20261101/deepseek-v41-defaults/`，不含凭据值、请求头或完整用户设置。
- 真实模型 GUI 验收及重新签名候选的结果由最终包记录绑定；已签名的 `ab68c2b297f1` 不包含本次自动选模代码增量，不能据此宣称新自动路径已完成包验收。
- 公开版本保持 0.5.4，未创建标签、公开 Release 或更新公开下载源。

## 最终源码检查

- Runtime 全量：221 文件、3,209 项通过；2 文件、22 项跳过。
- 桌面全量：389 文件、3,748 项通过；2 文件、2 项跳过。
- Runtime 与桌面 typecheck、生产 build、改动 TypeScript ESLint 全部通过。
- Runtime 初次全跑有 3 条旧自动 Pro 预期失败。按新行为更新自动模型断言后完整复跑通过，思考强度、provider、显式模型和历史线程保留断言均未删减。
