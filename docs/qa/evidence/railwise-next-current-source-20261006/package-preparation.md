# 私有候选打包、发布身份与真实更新准备审计

审计日期：2026-10-06。角色：AI 软件/产品交付审查。此记录是准备审计，不是安装包验收通过结论。

本次仅读取源代码、签名身份清单、工具版本、GitHub Release/Tag/Actions 元数据和 secret **名称**，并写本文件。未构建、安装、启动应用；未执行 CUA；未改版本、标签、Release、公开 feed、官网或用户数据；未读取或输出 secret 值。

## 1. 已发布版本和当前来源

| 项目 | 直接核对结果 |
| --- | --- |
| 公开 Release | `v0.5.2`，非 draft、非 prerelease |
| 发布时间 | `2026-10-05T13:07:18Z` |
| Release URL | https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.2 |
| 注解 Tag 对象 | `8f1986cce1144e07769de04d9a3c443b399e4d07` |
| Tag 解引用源码提交 | `ea763458567ccf069067a165d812f561e9af6b62` |
| 发布工作流 | `37293834362`，success，HEAD 同上 |
| 本轮工作区起始 HEAD | `2a56f5de3ce91f931d22de9f64ffd0fab216098e`，`codex/survey-reliability` |
| 当前桌面源版本 | 根 `package.json` 为 `0.5.2` |
| 工作树 | 存在本轮多个代理的 tracked/untracked 修复，尚不能作为冻结候选来源 |

使用 `gh release view v0.5.2 --json tagName,publishedAt,url,targetCommitish,isDraft,isPrerelease`、Git refs API 和 annotated-tag API 相互核对，未仅凭本地文档推断。`targetCommitish=main` 不是精确源码，解引用后的 40 位提交才是发布来源。

**不得覆盖或移动公开 0.5.2 来装入这些新改动。** 当前新源码可以保留 `0.5.2` 元数据用于隔离候选验证，但必须同时标记候选 bundle ID、源码 HEAD 和包哈希；不能称为公开 0.5.2 的复验。下一次公开发布须由主代理处理准确版本和用户授权，本文不选择或修改下一公开版本。

## 2. 本机和 GitHub 签名/公证条件

| 条件 | 本次结果 | 证据边界 |
| --- | --- | --- |
| Developer ID Application | 本机有效身份 1 个：`Ningbo Ruiwei Engineering Technology Co., Ltd. (R35G7F4A9U)`；SHA-1 `A292073D67BF1DCEE21D039220218D156332ECEC` | `security find-identity -v -p codesigning`；未做真实 codesign，不证明无交互私钥访问已通过 |
| Apple 公证工具 | `xcrun notarytool --version`：`1.1.3 (42)` | 工具可用，不证明 Apple 凭据有效或新包获准 |
| 本机签名/公证环境变量 | 当前进程与 `scripts/release.local.env` 均未设置下列凭据 | 只检查存在/非空布尔值，未输出值 |
| GitHub signing/notary secrets | `MAC_CODESIGN_P12_BASE64`、`CSC_KEY_PASSWORD`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 名称齐全 | `gh secret list` 仅证明名称存在；有效性由候选签名/公证作业实测 |
| 本机运行工具 | Node `v26.10.0`；Python `3.12.7` | CI 固定 Node `22.22.0`、Python `3.12`，不要混称相同环境 |
| 本机文档 sidecar | `build/sidecars/markitdown-darwin-arm64/workwise-markitdown/workwise-markitdown` 存在 | 还需新构建的 SBOM、依赖许可与最终包验证，不以存在代替通过 |

检查的环境变量名称：`MAC_SIGN`、`CSC_LINK`、`CSC_NAME`、`CSC_KEY_PASSWORD`、`MAC_CODESIGN_P12_PATH`、`MAC_CODESIGN_P12_BASE64`、`MAC_CODESIGN_P12_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。

可用正式候选路径是已有 GitHub Actions secrets，在短生命周期 runner 中构建。`with-mac-signing-keychain.mjs` 创建独立 keychain，正确区分 keychain 密码和 P12 密码，在 finally 恢复原 keychain 列表并删除临时 keychain。`mac-notarize.cjs` 校验 Electron/V8 entitlements、嵌套签名/secure timestamps，提交 Apple 后要求 `Accepted` 并 staple/validate。

仅本机 `MAC_SIGN=1` 或 `CSC_NAME` 可启用 Developer ID 签名；没有 Apple API 凭据时 hook 会跳过公证，**不能当作正式签名公证候选验收通过**。现有 hook 未提供 `notarytool --keychain-profile` 路径。本次未探查、不导出系统 Keychain 的私密项目。

## 3. 包与运行环境隔离

已有隔离实现可复用，不必改公共 builder 配置。

| 隔离项 | 当前实现 |
| --- | --- |
| Bundle ID | `com.wangjiawei508.workwise.candidate.head<冻结提交前12位>`；生产 ID `com.wangjiawei508.workgpt` 保持独立 |
| 应用/可执行文件名 | `RailWise AI Candidate <前12位>.app` / 同名 executable |
| 产物名 | `WorkWise-Candidate-<前12位>-<内部版本>-mac-arm64.dmg` / `.zip` |
| 来源约束 | `WORKWISE_CANDIDATE_SOURCE_HEAD` 必须 40 位小写 SHA，HEAD 相等且 tracked/untracked 工作树完全干净；builder 调用 `verifyCandidateSourceTree()` 失败即阻断 |
| 内部版本 | `WORKWISE_APP_VERSION` 只覆盖包 metadata，不编辑公共 package 文件；当前只接受 `x.y.z`，不可直接填 `-rc` suffix |
| 更新源 | 候选强制 `generic` + `https://127.0.0.1/`，不能继承公开 feed；channel metadata 为 `frontier` 但仅 loopback，未推广至公开 Frontier |
| 数据 | 独立 root 下 `user-data`、`cache`、`logs`、`home`、`home/.workwise/tools`；`sessionData`、crash dumps 和 Chromium helper 路径同样隔离 |
| 项目/MCP/插件 | 独立 `home/.workwise`、MCP 和 tools 根，不迁移/删除生产配置或数据 |
| 通信 | `WORKWISE_CANDIDATE_OUTBOUND_DISABLED=1`、`WORKWISE_CANDIDATE_INBOUND_DISABLED=1`；默认 `WORKWISE_CANDIDATE_CREDENTIAL_ACCESS=0` |
| 服务端口 | Runtime 申请端口 0；schedule/IM 保留互异的 loopback ephemeral listeners，启动后验证三服务身份，不占用生产固定端口 |
| 启动/重启 | 用 `--workwise-candidate-env-file=/绝对隔离根/candidate.env`；Squirrel 重启丢失 argv 时从隔离根的 sibling env 恢复；候选缺配置 fail closed，exit 78 |
| 更新 cache | 私有 updater 覆盖 package name 为 `workwise-private-updater-<前12位>`，要求独立 `*-updater` cache；cache 已存在时拒绝复用/清理旧数据 |

`authorize-workwise-candidate.sh --prepare` 在最终干净来源上写正确 `candidate.env`。当前 dirty tree 不能运行该步骤；本轮不制造带旧 HEAD 的 env。后续 root 应先冻结源码，再在干净 checkout 运行它；root 给定冻结提交前禁止构建。该脚本的确认短语是隔离目录准备控制，不是再次要求用户做常规验收。

实际模型验收需要后续主代理使用既有、明确授权的候选 credential helper。helper 必须可执行且位于候选根，使用 env 明确引用；默认无凭据的更新往返不测试模型。不能使用 `--use-mock-keychain` 代替真实模型或凭据验收，也不能为此复制生产数据库/全部配置。

## 4. 推荐的冻结后执行路径

推荐直接运行 **Private candidate native updater**，然后下载它保留的 **同一 target DMG** 做本机 CUA/独立 AI 高级工程师复核。这样不用先验收独立重构的 DMG、再把不同 target 当成同一安装包。

入口是 `.github/workflows/release.yml` 的布尔输入 `private_updater_acceptance=true`，调用 `.github/workflows/private-updater-acceptance.yml`。Private workflow 本身只有 `workflow_call`，不能直接 `gh workflow run private-updater-acceptance.yml`。

示例由主代理填入已冻结并推送的 **专用 codex 分支**（本次未执行以下命令）：

```bash
candidate_ref='codex/FINAL_FROZEN_CANDIDATE_BRANCH'
gh workflow run release.yml \
  --repo railwise-cn/railwise-ai \
  --ref "$candidate_ref" \
  -f private_updater_acceptance=true \
  -f candidate_only=true
```

使用唯一分支指向最终冻结 HEAD，启动后立刻核对 run 的 `headSha` 与冻结 SHA 相同，期间不要移动该分支。不要用 public tag，也不要用 `candidate_only=true` 的三客户端常规路径替代隔离 identity。Private 路径使 `prepare` 跳过，其依赖稳定性/公共构建和 publish jobs 随之不运行，**不需要设置 skip_stability**；已经完成的源码质量检查仍应附到候选记录。

```bash
candidate_run_id='EXACT_PRIVATE_RUN_ID'
frozen_head='EXACT_40_CHARACTER_COMMIT'
candidate_artifacts='/absolute/path/outside/source/private-candidate-artifacts'
gh run view "$candidate_run_id" --repo railwise-cn/railwise-ai \
  --json headSha,status,conclusion,jobs,url
gh run download "$candidate_run_id" --repo railwise-cn/railwise-ai \
  --name "private-updater-arm64-$frozen_head" \
  --dir "$candidate_artifacts/evidence"
gh run download "$candidate_run_id" --repo railwise-cn/railwise-ai \
  --name "private-updater-target-arm64-$frozen_head" \
  --dir "$candidate_artifacts/target"
```

只获得签名候选、暂不做更新往返时，可将第一个命令的输入改为 `isolated_survey_candidate=true`，下载 `isolated-survey-arm64-<40位HEAD>`。该 workflow 的 `package-evidence.json` 明确 `updaterRoundTrip=not-tested`、`guiAcceptance=not-tested`，不能提前关闭这些门禁。单独构建的包可能和 updater target 字节不同，必须重新绑定 GUI 证据。

本机安装 updater 的 target DMG 后应记录安装路径、Info.plist version/bundle ID、DMG/ZIP/ASAR SHA-256、`codesign --verify --deep --strict`、`xcrun stapler validate`、`spctl --assess --type execute`。ASAR SHA-256 必须和 `private-updater.json.targetAsarSha256` 及 `installedAsarSha256` 相同。候选保留在隔离根的 `Applications/`，不要覆盖 `/Applications/RailWise AI.app`。

## 5. 真实 updater 脚本审计

`run-private-macos-updater-acceptance.mjs` 会阻断非 `github-hosted`、非 `GITHUB_ACTIONS=true`、非 `RUNNER_OS=macOS`、非 absolute `RUNNER_TEMP` 的运行；所有 artifact/evidence 路径必须在 runner temp 内。**不能伪造这些环境变量把本机称为短生命周期 runner，也不能直接在本机运行此 private harness。**

实际流程是：

1. 相同冻结源码构建 baseline `0.0.0` 和目标 `package.json.version`；独立同名 identity 与相同 designated signing requirement。
2. 先严格校验两包 Info.plist、codesign、stapled notarization、Gatekeeper、loopback update metadata 和 packaged ASAR。
3. 创建临时 pinned HTTPS loopback feed、随机私有路径，清除运行进程的签名/Apple/S3/R2/官网凭据及公开更新环境变量，不修改系统 trust。
4. 从 baseline DMG 实际安装至隔离 Applications，用真实 `checkGuiUpdate`、`downloadGuiUpdate`、`installGuiUpdate`；不能退化为 manualOnly 或浏览器下载。
5. feed 必须记录真正的 manifest 请求、ZIP 请求与已发送字节；Squirrel 使用 electron-updater 的内部 localhost HTTP 安装传输。
6. 更新后真实重启目标应用；核对 target version、签名/公证/包身份、target ASAR 哈希和 user-data nonce/sentinel 保留。
7. 报告需包含 `update_available`、`download_completed`、`install_requested`、`target_relaunched`、`user_data_preserved`；任一步失败记录 failed，而不是靠已下载的 DMG补判。
8. 仅 retain 明确的 evidence JSON 与脱敏 log，停止本次候选进程、关闭 feed、移除本次创建的临时 root/cache。

这是真实 Squirrel 更新往返，**同源 0.0.0 baseline 的用途是候选 updater 协议/安装验证，不是历史 0.5.1/0.5.2 数据迁移**。如发布声明需要证明历史迁移或所有三客户端更新，还需要对应版本/平台的真实证据，不能用本轮 arm64 private harness 补称覆盖。

必须保留并检查：`private-updater.json`、`native-updater.json`、`tls-preflight.json`、`native-updater.redacted.log`，以及 exact target DMG/ZIP。Workflow retain 时间为 7 天，下载归档必须在过期前完成；不要将 candidate.env、私钥、原始 log 或数据库纳入证据仓库。

## 6. 本轮结论与下一门禁

准备审计完成，现有源码已经具备冻结来源、候选身份/数据/端口隔离、Developer ID/Apple 公证、真实 private updater 和保留 exact target artifact 的路径。本轮没有声称这些新包已实测通过。

仍待主代理推进：完成共享修改整合/独立代码复核 → 冻结并推送 exact HEAD → 执行私有签名公证/update workflow → 安装 retained target → 真实模型/测量/成果/恢复/多主题语言尺寸/键盘矩阵 CUA → 独立 AI 综合工程师复核并绑定同包 → 准确处理下一公开版本与发布授权。失败应修复并冻结新 HEAD，不可沿用旧包验收。

本记录未代替真人持证签章、厂商 COSA/SUC 互操作认证或规范认证。
