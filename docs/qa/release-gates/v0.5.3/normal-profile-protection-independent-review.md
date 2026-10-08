# 0.5.3 正常公开身份验收：用户资料保护工具独立 AI 审查

审查日期：2026-10-08。审查者：独立 AI 子代理 `profile_guard_review`。

## 结论与范围

对下述固定版本的保护脚本和操作说明，未发现尚未修复的阻断缺陷。主代理可以在确认最终安装包身份、应用及服务已退出、没有竞争写入后，推进真实 `inventory → snapshot → activate` 准备工作。

这是用户资料保护工具的独立 AI review，不能表示 0.5.3 产品、真实用户资料恢复、安装包界面、真实更新往返或公开发布已通过验收。本代理未启动应用、未操作真实 UI、未激活真实用户资料，也未作厂商兼容认证、专业签认或真人批准。

初次审查绑定（保留为历史证据）：

| 文件 | SHA-256 |
| --- | --- |
| `normal-profile-protection.mjs` | `2b65d8390f0d6641b43b28d64834b0146105d5e9e62ac128203e252ba40f5a6c` |
| `normal-profile-protection.md` | `3378df874ffe51eb69a1169a745c3214811588c7f085bd7025354530d17684db` |

2026-10-08 文档增量复核：操作说明已明确旧冻结源码 `d3f9158a6fd26cd40e4f0bd3dd4d92e4686d1f51` / run `37749218440` 已取消，修订源码仍须 PR 合并及重新冻结；没有把待完成的正常公开身份激活或最终安装包验收写成完成。本代理复核了该首段及其上下文，更新后的 `normal-profile-protection.md` SHA-256 为 `4d1b59e84692f9ed86344fa42953ea2b423f8cd2cb862137b228d80cfcfc3311`。脚本 SHA-256 未变；此次为文档状态复核，没有重新执行真实激活或产品验收，也没有必要重复未改变脚本的合成测试。

脚本限定安装包版本 `0.5.3` 和正常公开 bundle identity `com.wangjiawei508.workgpt`。真实执行时必须继续绑定主验收报告所记录的最终构建与包哈希；本报告不绑定先前构建产物。

## 已复核的保护及恢复行为

- 快照初始 journal 包含完整唯一 entry IDs，先持久化 journal，再保留 active session；未激活的中断快照可验证原件未变后 `abort-snapshot`。
- journal 以私人权限写入，文件同步后原子 rename，并在平台支持时同步父目录。终态 journal 已写但 reservation 尚未移除时，`verify` 和 `abort-snapshot` 可重试。
- 原应用根目录 rename 保留，另有独立 `ditto --rsrc --extattr --acl` 快照；逐项 fingerprint 覆盖内容、大小、权限、uid/gid 和存在/缺失状态。
- `.codex` 只保护实际安装包以及现代/旧版 installed manifests 的有限资产并集和 sidecars，不移动整个 `.codex`；无关资产保持原状。
- pack 恢复先创建并验证 staging，再归档当前验收资料、rename 恢复；归档后中断和不完整 staging 复制可以从 journal 恢复。
- 死锁恢复须匹配 session、确认原 owner PID 返回 `ESRCH`、确认应用退出；活 owner 被拒绝，原锁保留为恢复证据。
- 设置 JSON 无法读取或解析时只输出通用错误；可选复用仅限既有官方 DeepSeek 提供方字段，真实凭据不打印。
- 最后增量已复核：原 preferences domain 存在而 `defaults delete` 失败时，激活立即中止并要求恢复，不会把清理失败当作成功。
- 最后增量已复核：包身份还绑定 pack 全目录 fingerprint，避免 ASAR/manifest 不变而 pack extraResource 内容变化；递归 fingerprint 在 inventory 阶段拒绝包目录内嵌套 symlink。以上两点经过代码审查；本次 15 项合成结果不单独列为这两点的动态故障覆盖。

## 独立验证

本代理针对上述最终脚本重新执行：

```sh
node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs self-test
```

退出码 0，`status=passed`，15 项合成检查通过：会话冲突、激活前原件改变、完整可逆循环、原缺失路径恢复、旧元数据和废弃资产并集、无关 Codex 文件保留、新设置和迁移目标、pack 归档/部分复制中断、最终登录项证据必填、未激活快照中断、终态重试、journal/reservation 中断、根目录移动中断、死锁恢复/活 owner 拒绝、symlink 逃逸拒绝。全部使用临时合成目录，没有真实 profile 激活。

## 真实执行仍须完成的边界

- 不重新定义 `HOME` 或 `CODEX_HOME`；candidate 模式或单独 `--user-data-dir` 不能替代正常公开身份验收。
- 验收期间不能有竞争应用、安装器或对受保护路径的并行编辑；出现未知变化应保留 evidence 并停止自动覆盖。
- `ditto` 保留 ACL/xattr，但 fingerprint 未独立逐项校验全部 ACL/xattr；preferences 按 plist 内容语义恢复，不能声称重新序列化的 bytes 与原件相同。
- 共享 Keychain 的正常访问允许，不能宣称完全不访问；不清理共享 Keychain/TCC/后台任务数据库。
- 主代理必须在恢复后用 CUA 比较真实登录项：RailWise 不在 Open at Login，RailWise AI 背景活动仍开启，再执行 `verify`。
- 缺失/畸形 lock owner，以及电源或文件系统故障，要求保留证据并进行恢复检查；本报告不保证此类场景全自动恢复。
- 最终包的功能、界面、语言/主题/尺寸、可访问性、签名/公证、真实 updater 往返和独立产品 AI review 必须分别完成；单维护者模式不取消这些质量门禁。

工具修改后应重新确认绑定哈希，按修改范围重做审查。原私人快照、用户设置和登录项列表均不能提交到 Git。
