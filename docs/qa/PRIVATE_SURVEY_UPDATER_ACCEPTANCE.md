# Survey 私有原生升级验收

此流程为隔离候选包补充真实 updater 证据，不发布 GitHub Release、不上传 R2、不修改官网或 stable/frontier feed。入口为 `release.yml` 的 `private_updater_acceptance=true`；该开关排除其他发布、修复和旧公开验收路径。

## 验证范围

- GitHub 托管的临时 macOS arm64 runner；拒绝本机和 self-hosted runner。
- 同一完整源码 HEAD、候选 bundle 身份和签名要求；内部基线版本 `0.0.0` 升至仓库当前版本。版本覆盖只发生于包 metadata，仓库公开版本文件不修改。
- 基线与目标分别签名、公证。构建目录和实际 DMG 安装出的应用均核对完整源码 HEAD、bundle、版本、签名、公证票据和精确 loopback 更新配置。
- HTTPS 服务仅监听 `127.0.0.1`，仅提供本次随机路径下的清单与实际目标 ZIP。不写入系统或用户钥匙串信任；仅在隔离候选验收模式中，为 `electron-updater` 专属 Session 固定一次性证书的完整 SHA256，同时核对 IP SAN 和有效期。请求及重定向必须保持本次 HTTPS origin（含端口）与随机私有路径，不匹配即拒绝。
- 证书策略要求 GitHub hosted macOS 标记、隔离配置、候选安装可执行路径和 user-data 路径均匹配；正式应用与普通验收启动不会修改任何 Session 验证器。GenericProvider 清单请求和 ZIP 下载使用相同的 ElectronHttpExecutor Session。
- 实际应用调用 `electron-updater`，经 Squirrel 安装并重启；必须取得原生阶段报告、HTTPS 下载记录、已安装目标 ASAR 摘要匹配和隔离数据保留证据。手工替换应用或单独下载 ZIP 不能通过。
- HTTPS 覆盖私有清单与目标 ZIP 的下载。ZIP 下载完成后，Squirrel 接收 electron-updater 自带的内部 localhost HTTP 服务，这是库原有行为，不能称为全部阶段均使用 HTTPS。
- 候选安装、配置、工具目录及 updater 缓存独立。失败保留报告，清理失败也判失败；不关闭 TLS 校验，不改变本机 Gatekeeper。

## 执行与结果

从已经验证的分支提交启动：

```sh
gh workflow run release.yml --repo railwise-cn/railwise-ai \
  --ref codex/railwise-survey-convergence \
  -f private_updater_acceptance=true -f candidate_only=true
```

检查 Actions 的 `private-updater-arm64-<完整HEAD>` 附件，必须同时核实 `private-updater.json` 和 `native-updater.json`，另有 `tls-preflight.json` 和去除敏感值的 `native-updater.redacted.log`。报告在工作开始及每步命令执行前后原子落盘。系统命令限时 2 分钟，原生 harness 外层限时 25 分钟，Actions 验收步骤限时 35 分钟；超时和清理失败均判失败。原始运行日志、完整环境、证书私钥不上传。

签名公证成功后，目标安装包单独保留在 `private-updater-target-arm64-<完整HEAD>` 附件中，即使 updater 验收失败也保留，便于独立检查 GUI；包附件存在不表示升级通过。不要将仅有 workflow 绿灯、脚本单元测试或基线安装成功视为往返完成。

打包前先运行真实 Electron 网络预检：默认信任拒绝自签名证书、错误指纹拒绝、错误端口及路径拒绝，正确策略下由 GenericProvider 获取清单并由 ElectronHttpExecutor 下载且校验 SHA512。此预检只验证传输，不安装软件，也不替代签名包的 Squirrel 往返。可用 `--local-transport-only` 在本机临时目录运行相同纯传输预检；它不会修改系统信任，也不运行候选安装。

## 已知失败记录

- Actions `35453380333`：签名要求读取失败，原因是 `codesign -d -r-` 把 designated requirement 写入 stdout，而早期脚本仅检查 stderr。已修复并增加真实 macOS 只读 codesign 回归测试。
- Actions `35455576450`：签名、公证完成后，原生验收步骤超过 32 分钟无输出，取消日志显示遗留 `security` 进程；缺少细粒度日志，无法断言具体子命令。旧同步调用无超时且只在 finally 写报告。现移除交互式信任配置，使用受限证书固定验证，补充超时、持续报告和前置传输预检。此记录是失败证据，不是已通过原生往返的声明。

## 已完成的真实往返

- [Actions 35459471768](https://github.com/wangjiawei508/WorkWise/actions/runs/35459471768) 已成功完成，源码为 `e1708d7ccce7e134c502c3b82bc16e3efcd3290b`；私有 macOS arm64 基线 `0.0.0` 升至候选 `0.5.0`。签名公证完成后，原生验收步骤耗时 90 秒。
- `private-updater.json` 和 `native-updater.json` 均为 `passed`。六阶段完整，目标重启及数据保留终态时间为 `2026-09-19T18:11:48.900Z`。真实 HTTPS 服务收到 1 次清单、1 次 ZIP 请求，发送 `300155476` 字节；日志记录 Squirrel.Mac 实际请求并安装目标 ZIP。
- 目标 ZIP SHA256：`77b1c5e073d1e5c91861caf9fd6613d641f6c52d755b238388ef2784c383bf5a`。目标构建与安装后 ASAR SHA256 均为 `fcaa65bb42d526bffe33a860886e83f3863e8b7c44cfc18fca698d41c5bb6a18`。
- 已复核签名、公证票据、Gatekeeper（assessments enabled）、完整源码 HEAD、隔离数据哨兵以及无浏览器下载。`productionTouched`、`publicFeedUploaded`、`systemTrustModified` 均为 `false`，清理步骤完成。
- 原始附件：`private-updater-arm64-e1708d7ccce7e134c502c3b82bc16e3efcd3290b`；精确目标包附件：`private-updater-target-arm64-e1708d7ccce7e134c502c3b82bc16e3efcd3290b`。此结论仅适用于该完整 HEAD 的私有候选往返，不能代替精确安装包的 GUI 验收及用户确认。

本轮新增流程的专用测试验证 HTTPS 传输、证书指纹/有效期、地址与端口限制、正常模式隔离、命令超时及报告保留、日志脱敏、隔离目录、版本/身份、精确 feed 和工作流互斥；真实往返结果以单独运行记录为准。本流程不证明历史正式用户数据迁移、专业测量结果符合性、用户本人 UI 确认，或 Intel/Windows 平台验收。目标包重新安装后的 GUI 验收仍需按精确源码与包摘要记录。
