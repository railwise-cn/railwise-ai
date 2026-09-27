# Typed Plan 完成守卫

## 修复前反例

源提交 `9974e69c65e2f76bf3318e713191b4125cb0e75e`。独立合成 Runtime 测试批准四步测量计划，本地 HTTP 模型替身仅回答一次“已完成”，没有发出任何工具调用。

[原始结果](./before-text-only-result.json)记录：四步回执均为 `null`，工具调用和新增平差均为 0，但 Task 与 Turn 为 `completed`，原始 plan 仍为 `started`。这证明完成判定缺少批准步骤回执检查；不是外部模型可用性问题。[原始反例脚本](./before-text-only-probe.ts)保留当时绝对路径和漏洞期望，不能当作修复后通过的回归用例直接运行。

既有 fbb 实际模型验收另有四个持久调用及成果文件，未受该反例推翻。成功路径不能证明空执行、部分执行或错误后的完成条件正确。

## 修复

TaskController 在通用回答/文件验收前，要求批准计划的每步成功回执、精确参数和前序绑定一致；缺失走已有有界重试/停滞流程。内部 Task/Turn 计划身份贯穿继续和重启，HTTP 普通发言不能注入执行标记。丢失绑定拒绝完成，普通咨询仍可正常回答。

Runtime 的只读 plan 投影返回 `execution.complete/completedStepIds/pendingStepIds`，界面按这些回执显示每步状态。历史缺回执的完成记录显示需处理，不补造回执、不改写历史、不自动执行副作用。部分执行后停滞/等待也会触发受作用域保护的权威数据刷新。

独立复核发现并修复了两个恢复入口：升级前没有新字段的 Task 通过既有 thread/project/task 绑定查回原计划；工程任务的通用 retry/resume 在任何 mutation 前返回 409，引导使用 typed plan 的继续或重规划，防止降级为普通聊天而绕过完成守卫。新旧记录的真实 Runtime shutdown/recreate 回归保留原 Task、首步回执和网络 revision，只执行剩余步骤。

Runtime 定向 7 文件 97 项及最终全量 2807 项通过/22 跳过。桌面最终全量 2790 项通过/2 跳过。双端类型、构建、严格 OpenSpec 11项通过；lint为0错误及1条既有 Workbench Hook warning。本目录保留最终命令原日志。界面覆盖中英文零步/部分/全部回执、历史误完成、停滞刷新与只读无 POST。最终源码验证和独立审查不能代替新签名包复验；9974 签名包仍保留为缺陷基线。

## 显式继续入口

界面现通过 typed plan 的专用 resume 路由继续 stalled、waiting_user 或 waiting_approval 任务，要求同一项目、会话、Task、已批准计划及待完成回执；零成功回执的停滞也可显式继续。请求一次捕获 provider/model/effort，并保护同步重复点击、跨作用域迟到响应和较旧 revision。failed/cancelled 或历史误完成记录只能重新规划并重新审批。没有回退到通用任务 retry/resume。

新增界面定向检查为2文件43项通过。独立复核再发现恢复启动失败可能遗留 retrying，以及计划保存失败可能留下未运行的 running Turn。Runtime 现以 revision/status/activeTurnId 校验恢复未附加新轮次的原 Task；已补偿的失败 Turn 保留，仍运行或并发推进的记录不回滚。初次启动和恢复后的计划保存失败均结束尚未运行的轮次和绑定任务，保留原错误并允许显式重规划或重试。若补偿持久化本身也失败，保留原错误；该双重故障后的重启恢复未在本次新增用例中验证。

新增 Runtime 4文件43项通过；最终整合 Runtime 全量2819项通过/22跳过，桌面全量2807项通过/2跳过，双端类型、构建、严格 OpenSpec 11项通过，lint为0错误/1条既有warning。`resume-*.log`保留本轮原始日志。此入口尚待新精确签名包的实际停滞与继续验收。

## 包内反例方法

[`verify-packaged-text-only.cjs`](./verify-packaged-text-only.cjs)绑定独立记录的 ASAR 摘要、精确源提交、0.5.0 版本和候选路径，导入前重新校验 codesign。它只在新建临时合成目录启动实际包内 Runtime，由回环 HTTP 模型替身返回固定完成文字；要求文字真实写入 transcript、四步回执为空、调用/平差数为0。`reproduce` 模式要求旧缺陷存在；`reject` 模式要求因明确的缺回执代码而进入非成功终态，防止把网络/解析失败误判为守卫有效。

9974 的签名包反例也已复现，见[精确包原始记录](../railwise-convergence-9974e69c65e2/README.md)。[9cf修复包](../railwise-convergence-9cf70d71919e/README.md)的 reject 已通过：7次真实落盘的假完成文字、0工具、4空回执、0平差，Task stalled、Turn failed，明确原因为 engineering_plan_steps_incomplete。原生中文浅色界面将复制的9974历史记录显示为需要处理、0/4步及重新规划；全部复制文件与源文件摘要不变。9cf不含上述显式继续入口及启动失败修正，不能代替下一候选验收。

本测试只使用本地合成网络和 HTTP 模型替身，没有真实模型请求、生产工程、专业签认或公开发布操作。
