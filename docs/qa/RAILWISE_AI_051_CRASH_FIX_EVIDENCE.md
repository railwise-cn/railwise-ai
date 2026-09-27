# RailWise AI 0.5.1 崩溃修复验收记录

日期：2026-09-27  
修复提交：`6218815e`（前一提交 `df56bbef` 包含签名修复）

## 结论

用户提供的 0.5.1 崩溃报告对应的首要故障是 macOS Electron/V8 运行时签名缺少以下 hardened-runtime 权限：

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`

旧的 `/Applications/RailWise AI.app` 在 V8 初始化阶段于 `ares_dns_rr_get_ttl` 触发 `EXC_BREAKPOINT (SIGTRAP)`，尚未执行应用 JavaScript。修复将 entitlements 路径固定为绝对路径；ad-hoc/candidate 签名也显式注入同一 plist，并在打包后逐个检查主程序和 helper。

另外，本机当时的 LaunchServices/Spotlight 状态异常（`lsregister` 返回 `-10822`，Spotlight indexing disabled），导致过一次独立的 AppKit `RegisterApplication` `SIGABRT`。按 [LaunchServices 主机修复记录](./LAUNCHSERVICES_HOST_REPAIR_NOTES.md) 重启用户 `lsd` 并 seed 后，候选包可以正常创建原生窗口。

## 已完成验证

- 候选包：`/private/tmp/railwise-fixed-app-dist/mac-arm64/RailWise AI.app`，版本 `0.5.1`。
- `codesign --verify --deep --strict` 通过。
- 5 个 macOS runtime executable 均通过 Electron/V8 entitlements 检查。
- `ELECTRON_RUN_AS_NODE=1` 启动测试通过（Electron `43.1.1`）。
- Computer Use 实机验收通过：主窗口、`内业 / Survey AI`、创建内业任务、`数据资产`、`质量校核`、`测量来源与预检`、`测量平差` 均可打开，未再次退出。
- 本地 `npm run typecheck`、包装配置 21 项测试、相关 ESLint 通过。
- GitHub Quality push/PR runs for `6218815e` both passed：`36297564895`、`36297568003`。
- 旧提交 `c9a221da` 的私有真实 updater round-trip 已通过（run `36289155757`）；修复提交尚待重新跑同一私有 updater 流程。

## 发布门禁

当前本地候选为 ad-hoc diagnostic build，不是可发布的 Developer ID/公证安装包。公开 tag、GitHub Release、stable/frontier feed 和官网更新均未执行。需要在 GitHub Actions 上对 `6218815e` 重新运行隔离签名/公证候选和私有 updater round-trip，并记录签名、公证、安装和更新证据后，才能继续 0.5.1 的公开发布。
