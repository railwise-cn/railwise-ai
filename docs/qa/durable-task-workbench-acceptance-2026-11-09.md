# 持续任务与品牌统一：实施及验收记录

本记录对应 `codex/durable-task-document-workbench`。完成情况以生产装配入口、故障回归和实际交付为依据；尚未执行的发行验收单独列出。

## 已接入的生产路径

| 要求 | 实现入口与证据 |
| --- | --- |
| 根任务、隐藏执行、补充与状态查询 | `TaskCoordinator`、`TaskControlService`、聊天命令 IPC；生产 Runtime 集成测试验证状态查询不创建 Turn、新任务不取消原任务、暂停输入不唤醒 |
| 输入持久投递与确认 | SQLite delivery + 文件型会话；JSONL 消息 ID/哈希落盘后进入 delivered，匹配检查点事务后进入 consumed |
| fencing、回执、Shell、共享额度 | 每 attempt 不可变租约凭证，工具边界回执，进程启动指纹与组，根预算账本和容量管理器；测试失租、未知结果、PID 复用和并发预算 |
| 事件与上下文 | Flow nonce/event/outbox、Schedule occurrence 原子提交；固定 Flow 版本与幂等跨库投递；实际出站模型上下文投影与授权 spill 召回 |
| 子任务隔离 | 实际工具调用边界拒绝通用 write/edit/bash 和任意 MCP；仅保留父任务授权内的只读资料及受限候选工具，子任务独立暂存 |
| 文档审阅 | 来源 SHA、目标/候选版本、差异、接受/拒绝、幂等日志与历史；保留真实被替换 inode，迟到外部写入可恢复；不宣称跨应用原子 CAS |
| 章节依赖 | 来源到章节映射，过期章节展示；重新读取来源后产生新候选，未改章节保持字节，拒绝重叠/歧义章节和不完整来源更新 |
| 实时任务界面 | main/preload 聚合 SSE、持久全局水位、固定成员分页快照、共享状态、Flow 待办原 API、持久通知去重与详情入口 |
| 品牌与兼容 | publication manifest 驱动新制品名、更新元数据、官网数据和恢复；保留旧 feed、App ID、数据目录、IPC 和历史文件 |

## 真实模型与文件

显式测试脚本为 `scripts/run-task-delivery-live.mjs`。使用已配置 DeepSeek 官方提供商和固定合成资料，API 请求/实际响应模型均为 `deepseek-flash`。密钥只在本机内存使用，不进入报告或仓库。

2026-11-09 第三轮本机结果：

| 场景 | 样本 | 任务结果 | 实际文件核验 | 墙钟耗时 | 场景内人工介入 |
| --- | --- | --- | --- | --- | --- |
| 监测报告 | 1 | completed | Markdown、DOCX、PDF、确定性 SVG 均通过 | 72,327 ms | 0 |
| 投标技术文件 | 1 | completed | Markdown、DOCX、PDF 均通过 | 102,688 ms | 0 |
| 研究报告 | 1 | completed | 两个候选及各自 DOCX/PDF 均通过 | 126,534 ms | 0 |

共 47 次实际模型请求，提供商返回累计 716,833 tokens（含缓存输入；不等于未缓存计费 token）。未返回账单成本，记录为 null。以上只是 3 个合成样本，不作为与 0.5.4 对比的性能提升比例，也不代表工程专业审定。没有基线对照实测，不填改善百分比。

任务 SQLite 实测的模型/工具累计执行时间依次为 68,618/841 ms、99,540/767 ms、121,628/1,291 ms；排队分别为 16、12、13 ms，均无人工等待。工具回执成功/失败分别为 21/2、19/2、27/3，失败调用包含模型参数自纠正及重复分析被 revision 检查拒绝，不能描述为零错误运行。没有 `outcome_unknown` 回执；重复副作用的故障保证由明确操作键的恢复回归覆盖，本组三个样本不替代崩溃重放测试。

PDF 实际解析和首屏检查：监测 2 页、投标 5 页、研究最终稿 3 页；中文文本可读取，未发现替换字符。DOCX ZIP 结构可读取，表格分别为 1、4、3 个，默认作者为 RailWise AI。图表是独立成果；本组模型没有将其嵌入 DOCX，不能据此宣称本组验证了 DOCX 图片嵌入。

原始私有证据位于 `/private/tmp/railwise-next-live-delivery-20261109-r3/results.json`，同时保留实际会话、工具结果、来源及成果哈希。该轮源为未提交开发树，报告记录 HEAD、tracked diff SHA、编译 Runtime 入口 SHA 和导出桥 SHA；不能替代最终安装包验收。

前两轮失败未删除：第一轮暴露只读目录枚举误算为来源与合成字段类型错误，第二轮暴露独立测试 Electron 导出桥随最后隐藏窗口关闭而退出；已修复并在第三轮实际运行。后续新增的子任务执行限制、成果发现过滤及章节更新通过聚焦回归独立核验。

## 兼容和回退

迁移及数据保留见 `docs/MIGRATION_DURABLE_TASK_WORKBENCH.zh-CN.md` 和 `docs/MIGRATION_RELEASE_IDENTITY.zh-CN.md`。迁移前使用 SQLite 一致性备份，旧数据不删除。`RAILWISE_TASK_SCHEDULING_DISABLED=1` 停止自动恢复和后台派发，任务记录、成果与普通聊天仍可用；显式执行仍保留 fencing 与回执校验。

## 最终发行验收状态

本地验证：应用全套 413 文件、4,082 测试通过（2 文件/3 测试跳过），最新任务 UI 聚焦 9 项通过；KUN 最终全套 238 文件、3,306 测试通过（2 文件/22 测试跳过）。类型检查、lint、OpenSpec 严格验证（13 项）、品牌扫描、文档依赖许可与生产构建通过，构建 freshness 检查覆盖 1,239 项输入。发行清单/门禁及 Windows 安装合同回归通过；本机无法执行的 Windows PowerShell 解析留给 Windows runner。

尚待：最终源码 CI、同一构建精确签名/公证包安装、主要中文任务 UI、Windows 安装属性、正式 0.5.4 到精确下一版的一次真实 updater smoke。新官网路径的配置和校验代码已完成，尚未将下一版官网/Stable/Release 公开部署。历史 v0.5.4 资产不改名。

不将私有 Actions 证据称为公开发行批准，不推进公开 tag、Release、官网或 Stable。
