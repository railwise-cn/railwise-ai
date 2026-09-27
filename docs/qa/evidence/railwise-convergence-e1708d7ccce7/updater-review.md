# 私有候选原生升级证据复核

复核时间：2026-09-20（Asia/Shanghai）。结论：下述精确源码的 macOS arm64 私有候选原生升级往返通过。

## 来源与范围

- 工作流：[35459471768](https://github.com/wangjiawei508/WorkWise/actions/runs/35459471768)，状态 `completed/success`。
- 完整源码：`e1708d7ccce7e134c502c3b82bc16e3efcd3290b`。
- 原始证据附件：`private-updater-arm64-e1708d7ccce7e134c502c3b82bc16e3efcd3290b`。
- 精确目标包附件：`private-updater-target-arm64-e1708d7ccce7e134c502c3b82bc16e3efcd3290b`。本目录不归档目标二进制、运行日志、私钥或完整环境。
- 基线 `0.0.0` 与目标 `0.5.0` 来自同一完整源码。这是隔离候选升级探针，不是历史正式版本或旧用户数据迁移测试。
- 报告里的 `frontier` 是验收调用的内部通道枚举。清单和 ZIP 均来自 runner 本次随机路径下的 loopback 服务，不代表公开 frontier feed，更没有执行公开 feed 提升。

## 核验结果

| 项目 | 证据 |
| --- | --- |
| 传输预检 | 默认信任拒绝自签名证书；错误指纹、端口、路径均拒绝；正确证书下真实 GenericProvider 清单和 ElectronHttpExecutor ZIP 下载成功 |
| 实际下载 | HTTPS 清单 1 次、ZIP 1 次，发送 `300155476` 字节；请求拒绝数 0 |
| 原生流程 | `base_started`、`update_available`、`download_completed`、`install_requested`、`target_relaunched`、`user_data_preserved` 六阶段完整 |
| 原生终态 | `2026-09-19T18:11:48.900Z`，`status=passed`，`browserOpened=false`，`userDataPreserved=true` |
| 签名与公证 | 基线、目标及实际安装后的目标通过签名、公证票据和完整源码核对；Gatekeeper 为 `assessments enabled` |
| 安装一致性 | 安装后 ASAR SHA256 与签名目标相同；隔离数据哨兵完整保留 |
| 隔离与清理 | `productionTouched=false`、`publicFeedUploaded=false`、`systemTrustModified=false`；清理步骤 `completed` |

实际原生验收步骤从 `18:10:27Z` 至 `18:11:57Z`，耗时 90 秒。HTTPS 负责私有清单和目标 ZIP 的下载；Squirrel 接收 electron-updater 自带的内部 localhost HTTP 服务，这是库原有流程，不能据此表述为全部阶段均使用 HTTPS。

目标 ZIP SHA256：`77b1c5e073d1e5c91861caf9fd6613d641f6c52d755b238388ef2784c383bf5a`。

目标构建和实际安装后 ASAR SHA256：`fcaa65bb42d526bffe33a860886e83f3863e8b7c44cfc18fca698d41c5bb6a18`。

## 归档与脱敏

已经逐项检查三个 JSON 的字段。`private-updater.json` 和 `tls-preflight.json` 仅含状态、阶段、摘要和隔离证明，没有凭据、私钥或完整环境，按原始字节归档。证书 SHA256 是证书摘要，不是密钥。

`native-updater.json` 仅修改 `feedUrl` 的随机私有路径为 `/private-[redacted]/`，保留真实 `https://127.0.0.1:49262`，增加 `redaction` 字段说明原因、原附件名及原始证据 SHA256。六阶段、时间、版本、数据保留和终态均保持原值。

| 文件 | 归档文件 SHA256 |
| --- | --- |
| `private-updater.json` | `bc5a2b9168acfcf04b89b8cb5473db0098b698b46d6d1e05db9e0bafaabee21f` |
| `native-updater.json`（脱敏） | `00a6cf462c68d05647ff9e6a401666bdd196f4b7b49ee517c378571ae6b21a12` |
| `tls-preflight.json` | `45f183bdf7f05187a14f09aca4c12123a1c8821efa0790fe11c2ee7052ecf069` |

原始未脱敏 `native-updater.json` SHA256：`6c1c966e765b21dc431214285e10da25e51c1e2ae2f4a1bf376190a5aa169af2`，可与原 Actions 附件复核。

本结论不覆盖 Intel/Windows、历史用户数据迁移、专业测量结果符合性、精确安装包 GUI 验收或用户本人确认，也不构成公开发布批准。
