# 私有候选包静态验收（0.5.4 / final5）

final5 包含搜索弹层越界裁切修复和活动标签自动滚入可见区域修复。只构建、安装到隔离本机目录；未改公开版本、标签、发布源或下载页。final4 为搜索修复后的中间烟测包，已由 final5 替代。

| 项目 | 结果 |
|---|---|
| 私有 checkpoint | `209a17ecc2ab8359dd22e210d22c806c1633744f` |
| 原仓库 HEAD | `7c904709d25c062dd3a7dbde396eb6273fcf1fd5`；候选包含已记录的工作区修改 |
| 源码清单 SHA-256 | `831fdf6cbca2e62a720b3f607ec5dbbe26c58ad5c035f524e77950e389784d2a` |
| 包版本 | `0.5.4` |
| 候选 Bundle ID | `com.wangjiawei508.workwise.candidate.head209a17ecc2ab` |
| 安装路径 | `/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101-final5/Applications/RailWise AI Candidate 209a17ecc2ab.app` |
| ASAR SHA-256 | `12c4f2e8b0a2e6b173a63227e98ad00ec6d0daef5da9c043c212f732461d9bad` |
| ASAR 完整性 | 通过；26,026 文件、485 编译文件与 checkpoint `out` 内容一致，包内 sourceHead 匹配 |
| 原生依赖 | SQLite 真实运行通过；Electron ABI 148、arm64 |
| 签名 | Ad hoc；深度严格签名校验通过，无 Team ID |
| 公证 | 未公证；构建环境无 Apple 凭据，stapler 检查 exit 66 |
| Gatekeeper | 机器返回 accepted，理由是 `override=security disabled`，不作为可分发信任证据 |
| 文档依赖许可 | 策略检查通过；包无 OpenKnowledge 运行时依赖 |
| 包路径安全盘点 | 无意外私钥、证书或实际 `.env`；允许 `.env.example` 模板。此项仅为路径盘点 |
| 更新器 | `--dir` 包无 `app-update.yml`；未进行真实更新往返 |
| 源码 checkpoint | 打包和静态检查后工作树干净 |

构建使用 Electron 43.1.1、本地缓存 electron-builder 26.8.1、`--publish never --mac --arm64 --dir`。依赖目录通过 APFS 克隆复制，原生重编译发生在私有 checkpoint，未复用原仓库可写 node_modules 链接。原始构建日志保留于 final5 根目录 `build.log` 和 `package-dir.log`。

两项界面修复的 4 个回归测试、完整 Web/Node 类型检查、相关 ESLint 和 diff 检查均通过。实际 GUI 复验由主任务使用 CUA 独占操作；本静态报告不代替最终截图与功能清单。

隔离会话继承：主任务先通过 CUA 停止 final3，再克隆其 `user-data`、`session-data` 和 `home` 到 final5。保留 final3 隔离 fixture 的绝对路径是已确认的验收安排；未迁移或修改 Chromium 数据库键值。final5 使用独立 user-data/session-data、Bundle ID 和 candidate.env，生产用户配置与凭据未复制。主任务已在 final3 真实重启后看见 22 个标签；final5 会话继承仍需实际 UI 检查。详情见 `package-final5/session-clone.json`。

已知包级问题仍为原有 PPTX 依赖图：`ooxml-core` / `emf-converter` 声明 `@napi-rs/canvas ^1.0.9`，实际为 `0.1.100`；打包依赖收集报告不一致并继续成功。未在本次 Markdown UI 修复中变更该依赖。

原始静态检查与身份记录保存在 `package-final5/`。本候选未公开发布，也不具备公开发布所需的签名、公证或真实 updater 往返验收证据。
