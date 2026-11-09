# RailWise AI 发布标识迁移

本变更只统一后续版本的公开名称和发布数据，不改写已发布的 0.5.4 安装包、历史哈希、回执或 GitHub Release。

| 旧项 | 后续状态 | 原因 | 数据保留及用户操作 |
| --- | --- | --- | --- |
| `WorkWise-<version>-…` 安装包和更新包名称 | 新构建统一使用 `RailWise-AI-<version>-…`；Mac 官网安装包架构显示 `Apple-Silicon` / `Intel` | 与应用展示名称一致 | 历史下载和验证器继续识别旧文件名，无需手动改名 |
| `/downloads/workwise/` | 官网使用 `/downloads/railwise-ai/`，本轮包内默认更新根仍保留旧地址 | 公开入口与产品名称一致，并保持已验证的更新路径 | 两个地址指向同一物理发布目录，不建立第二套 Stable 指针；现有和新客户端都可从原更新根取得新命名制品 |
| 手工维护官网下载版本、大小、URL 和 SHA-256 | 后续由 `publication-manifest.json` 生成 | 避免官网、GitHub 和更新器指向不同制品 | 保留页面说明和能力文案；不手工更新已发布版本的文件元数据 |

发布名称和 URL 约定集中在 `src/shared/product-brand.json`，由 `scripts/release-publication.cjs` 读取。准备公开制品时生成带版本、完整源码、平台、架构、产物角色、文件大小、SHA-256、SHA-512 和不可变 URL 的 publication manifest；它同时封存安装包、更新 ZIP、blockmap、`latest-mac.yml` 和 `latest.yml`，防止更新元数据在封存后漂移。GitHub 安装包复制、R2 上传、官网数据生成和故障恢复读取同一份声明，并在操作前核对文件内容。R2 的物理 key 继续保留 `workwise`，官网 canonical 目录是指向旧物理目录的受控别名。已有 canonical 目录若不指向相同位置，部署会停止，不覆盖未知内容。

应用的 `com.wangjiawei508.workgpt` bundle ID、npm 包名 `workwise`、`.workwise` 用户目录、数据库路径、旧 IPC、凭据引用、插件、MCP 和 Skills 不变。新欢迎语、运行时展示、导出作者与诊断文件名使用 RailWise AI；历史记录里的旧名称保持原样。用户无需迁移工作区或重新配置凭据。

## 历史应用资料目录识别

本变更不调用 `app.setPath('userData', …)`，也不移动现有应用资料目录。当前目录已有内容时始终以当前资料为准；只有当前目录不存在或为空时，才考虑同一系统 Application Support/AppData 下的历史来源。

| 来源目录 | 识别条件 | 空目标的处理 | 保留与冲突 |
| --- | --- | --- | --- |
| `WorkWise` / `workwise` | 含可识别的设置文件 | 唯一有效来源时复制并核验 | 原目录不修改；同一 inode 的大小写别名只计一次 |
| `RailWise AI` / `RailWise-AI` / `Railwise AI` / `railwise-ai` | 同上 | 同上 | 不更改应用当前 userData 路径 |
| `WorkGPT` / `workgpt` / `WORKGPT` / `Kun` / `DeepSeek GUI` / `deepseek-gui` | 可读取的 `workgpt-settings.json`、`kun-settings.json`、`deepseek-gui-settings.json` 或 `workwise-settings.json` | 同上；兼容历史 `{ "version": 1 }` | 旧文件名和设置迁移读取器继续保留 |
| 空目录、仅浏览器缓存、无法解析的兄弟目录设置 | 不作为有效来源 | 不自动导入 | 原件保留；当前目录内损坏设置仍走既有备份恢复流程 |
| 两个或更多有效历史目录 | 多来源冲突 | 不选择、不合并、不创建新资料 | 返回 `outcome: conflict` / `legacy_profile_conflict` 并记录来源路径；需要明确选定来源后重新导入 |

复制先在同一父目录的临时目录完成，核对复制前、复制后和来源的文件清单、大小及 SHA-256，再安装到空目标。符号链接原样保留，只核验链接目标文本，不遍历或复制链接外的文件。清单写入 `.workwise-migration-v2.json`；已有迁移记录作为 `previousMarker` 保留。`verifyImportedUserData()` 可核验导入后的文件是否仍与回执相同，后续正常用户修改会使该核验返回 false，不会被当成需要自动覆盖的理由。

设置读取器使用同一目录集合和有效性判断，不能绕过多来源冲突偷选第一个目录。当前资料目录内的旧设置文件继续优先读取；导入后由既有设置服务写入 V2 信封，并保留源设置备份。本变更不删除插件、MCP、Skills、凭据引用、历史记录或任何来源目录。

分发前需要在精确安装包上验证版本、bundle ID、签名和适用公证。本轮不强制迁移包内更新根；更新元数据中的文件名称改为 RailWise-AI。若发布涉及更新器或新的更新路径，应按 AGENTS.md 执行一次精确包 updater smoke。合成文件测试只验证名称、数据投影和防篡改行为，不代替签名、部署和更新器实测。官网生成页若部署后验证失败，只恢复该页的服务器备份；已提交的正式 Release 不因页面错误自动降级。

## 一次构建对应一次私有更新验收

`release.yml` 的 `exact_package_updater_smoke=true` 只消费同一次运行产生的 `release-mac` 制品，不再构建第二份目标包。配合 `candidate_only=false`、`prepare_public_artifacts=false`、`publish_release=false`、`skip_stability=true`，可以在工作分支上构建下一补丁版本的正式应用身份包，完成签名、公证和一次私有更新验收；这些输入不会创建 tag、GitHub Release、官网上传或 Stable 更新。两小时稳定性检查属于可选项，相关 CI、聚焦测试和精确包验证继续执行。

更新基线固定读取正式 v0.5.4 的官方安装包及独立 SHA-256/大小 pin；目标包来自当前运行。helper 会校验两个架构的安装包、更新 ZIP 和元数据存在且为非空普通文件，再验证运行架构目标的源码、版本、签名、公证、签名要求和更新后 ASAR；测试同时读回合成资料与惰性的兼容配置引用。实际 Squirrel 更新使用临时 HTTPS capability feed，结束后保留脱敏原始报告和失败记录。未通过不会自动重试，也不会产生可用于公开提升的 reviewed-build 回执。

该模式验证重命名制品能被真实更新器安装及数据保留；它不会把私有临时 feed 的结果写成“官网已部署通过”。新旧官网下载入口的一致性仍须在实际暂存/部署后核验。

同一个输入还在干净的 GitHub-hosted Windows runner 上下载本次 `release-win`，校验 EXE 与 `latest.yml` 的大小和 SHA-512，再临时安装这一份 EXE。验收读取安装器及已安装 EXE 的实际版本/产品属性、安装 ASAR 的版本/源码/摘要、原 App ID 派生的 NSIS 卸载 GUID、桌面与开始菜单快捷方式以及卸载展示名称；之后只卸载经过路径和注册表归属复核的本次临时实例，并确认两个合成资料目录的探针保持不变。已有安装身份或快捷方式时直接停止，不卸载或覆盖未知实例。原始失败记录同样保留为 Actions 制品。

Windows Authenticode 记录实际状态：有效签名核验签发身份，未配置 Windows 签名证书时明确记录 `NotSigned` / `windowsSigning: not-configured`；不能将其写成已签名。无效、损坏或无法判定的签名拒绝通过。此 Windows 安装验收不代替主要中文界面的包内人工检查，也不声称覆盖 Windows 更新器往返。
