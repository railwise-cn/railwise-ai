# 精确候选启动诊断（2026-10-02）

候选：`be1d6fef2e070a4996c14ec9413a331292e246f0`，版本 `0.5.1`，arm64。

## 复现

- 通过 Computer Use 连接精确安装路径 `/private/tmp/railwise-survey-candidate.5xcEqY/installed/RailWise AI Candidate be1d6fef2e07.app`，等待后返回 `-10005 timeoutReached`。
- 直接启动该包的 `Contents/MacOS/RailWise AI Candidate be1d6fef2e07`，进程收到 `SIGABRT`（exit 134）。
- 同一时间尝试连接已运行过的历史候选 `2ac333b7fd88`、`69842e5c5376`，两者也在启动阶段产生相同崩溃；这排除了当前候选业务代码或包身份单独导致故障的解释。

## 系统证据

`~/Library/Logs/DiagnosticReports/RailWise AI Candidate be1d6fef2e07-2026-10-02-065810.ips` 的故障栈位于：

`RegisterApplication -> GetCurrentProcess -> NSMenuBarPresentationInstance -> NSInitializeAppContext -> NSApplication init`

同一报告的后台线程同时停在 `LaunchServices::Database::Context::_get` / `_LSContextInitCommon`。历史候选报告（例如 `...2ac333b7fd88-2026-10-02-065813.ips`）具有相同的 AppKit/LaunchServices 栈。

包本身仍通过 `codesign --verify --deep --strict`，主可执行文件为 arm64 且具有运行权限。此前记录的 Spotlight/LaunchServices 服务异常仍存在；本次没有重建数据库、启用索引、重启系统服务或修改任何安全设置。

## 结论与边界

该主机故障阻断了**当前精确候选**的窗口创建，因此 4.2 的当前包 CUA 截图、流程、键盘/无障碍和安装后 updater round-trip 仍未完成。历史候选的截图只能作为历史版本证据，不能替代 `be1d6fef` 的验收。源码级测试和静态包审查已完成，但不改变这一安装包门禁结论。
