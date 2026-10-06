# 冻结候选 f03fe303 的私有更新证据索引

记录日期：2026-10-06。范围仅为隔离的 macOS arm64 候选包签名、公证和真实更新往返；这不是已公开 `v0.5.2` 的复验，也不构成安装包界面、专业功能或历史版本数据迁移验收。

| 项目 | 已核对值 |
| --- | --- |
| 源码提交 | `f03fe30365e3d79dfe029d4352835471cb78dd6e` |
| GitHub Actions 运行 | [Release #37396697416](https://github.com/railwise-cn/railwise-ai/actions/runs/37396697416)，`workflow_dispatch`，`headSha` 与源码提交一致，结论 `success` |
| 实际执行作业 | `private-updater-acceptance / Private macOS arm64 native updater round-trip`，结论 `success`；公开发布及网站相关作业均为 `skipped` |
| 私有证据产物 | `private-updater-arm64-f03fe30365e3d79dfe029d4352835471cb78dd6e`，artifact ID `11384211986` |
| 精确目标包产物 | `private-updater-target-arm64-f03fe30365e3d79dfe029d4352835471cb78dd6e`，artifact ID `11383562664` |
| 候选身份 | `com.wangjiawei508.workwise.candidate.headf03fe30365e3`，目标版本元数据 `0.5.2`；使用独立候选身份和私有回环更新源 |
| 签名、公证、Gatekeeper | `private-updater.json` 记录签名和 stapled notarization 为 `verified`，Gatekeeper 命令退出码为 0 |
| 真实更新 | macOS arm64 `0.0.0` 同源码隔离基线更新至候选 `0.5.2`；`native-updater.json` 记录发现更新、下载、请求安装、目标重启和用户数据 sentinel 保留，最终 `passed` |
| 精确字节 | ZIP SHA-256 `71c335930760b55f82e285c739a648f1a66aa04f7f5968800266159056776ae6`；目标和更新后安装 ASAR SHA-256 均为 `4253753276a9f29afa20c62fca720af0bb44fa9b4a0dd456badff3d0488a53c2` |
| 私有源隔离 | 报告记录 `productionTouched=false`、`publicFeedUploaded=false`、`systemTrustModified=false`，证书固定的回环 HTTPS；私有源请求为 manifest 1、ZIP 1、拒绝 0 |

核对方法：用 `gh run view` 读取运行的 `headSha`、作业及结论；用 GitHub artifacts API 读取两个产物的名称、ID 和未过期状态；读取下载在 `/private/tmp/railwise-candidate-f03fe303/` 的 `private-updater.json`、`native-updater.json` 和 `tls-preflight.json`，并与另一份 CI 下载副本逐字节比较。三份报告的本地 SHA-256 分别为 `a0b40642b52bf442b9bcf46750dd5e2d564b742aa1c235986dcb0e4cdfa04fb4`、`077b23aeafe4d972e8483f60501bf43560f941e701e7e0a6a93b32d778af293b`、`777cb75a24be63acd77a4d445bedee6b21c75c99c6262d83aa9c7acad079b5f4`。原始 `native-updater.json` 包含短期回环源路径，本索引不复制该 URL 或日志。

证据边界：基线 `0.0.0` 只验证同源码的私有 Squirrel 更新和数据保留，不能代表从公开 `0.5.1` 或 `0.5.2` 的真实迁移，也不能覆盖 Windows、Intel macOS、稳定/前沿公开源。目标包 artifact 按 workflow 设置保留 7 天，应在到期前归档，并用**同一目标包字节**完成本机安装、Computer Use 界面/功能矩阵及独立高级工程师视角 AI 审查。仅在这些验收通过后，才可据实更新计划勾选状态；本索引不改变任何公开版本、标签、Release 或下载页。
