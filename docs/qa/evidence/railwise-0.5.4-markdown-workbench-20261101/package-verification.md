# 私有候选包静态验收（0.5.4 / final3）

本次只构建和安装本机隔离候选；未公开发布、未修改版本、未创建标签、未推广更新源。源码工作区保持原样。

| 项目 | 结果 |
|---|---|
| 私有 checkpoint | `c3377f463b496f5db794343ac77b437f924dfcee` |
| 原仓库 HEAD | `7c904709d25c062dd3a7dbde396eb6273fcf1fd5`；候选包含已记录的工作区修改，不能把它当作原 HEAD 构建 |
| 源码清单 SHA-256 | `452f2bcb5dd72ea5c198ea222ad994f03f43872fa51365b5e2fbe2612c25ccd1` |
| 包版本 | `0.5.4` |
| 候选 Bundle ID | `com.wangjiawei508.workwise.candidate.headc3377f463b49` |
| 安装路径 | `/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101-final3/Applications/RailWise AI Candidate c3377f463b49.app` |
| ASAR SHA-256 | `2c623cd6e03d80c1bc936fdc1ce4dc6f8bf7a28df493e7ce691bc7a71845880d` |
| ASAR 完整性 | 通过；26,026 文件、485 编译文件与 checkpoint `out` 内容一致 |
| 原生依赖 | SQLite 真实运行通过，Electron ABI 148，arm64 |
| 签名 | Ad hoc；`codesign --verify --deep --strict` 通过；无 Team ID |
| 公证 | 未公证；构建日志明确无 Apple 凭据，stapler 检查失败（exit 66） |
| Gatekeeper | 机器返回 accepted，但理由为 `override=security disabled`，不能当作可分发信任证据 |
| 依赖许可检查 | 文档依赖许可策略通过；未加入 OpenKnowledge 运行时依赖 |
| 包内容安全盘点 | 路径扫描未发现私钥、签名证书或实际 .env；包含明确的 `.env.example` 模板 |
| 更新器 | 本次 `--dir` 候选没有 `app-update.yml`，无公共更新源；未做真实更新往返 |

构建使用本地缓存 `electron-builder 26.8.1`、Electron 43.1.1、`--publish never --mac --arm64 --dir`。依赖目录通过 APFS 克隆复制，原生重编译仅发生于私有 checkpoint；未将原仓库 node_modules 作为可写链接。

第一次 `final1` 是早于最后异步写入修复的烟测，已被替代；`final2` 在复制后发现审查文档更新而 fail-closed，未用于构建。只有本页 final3 对应当前候选。

已知包级问题：现有 PPTX 依赖图的 `ooxml-core` / `emf-converter` 声明 `@napi-rs/canvas ^1.0.9`，实际依赖为 `0.1.100`；`npm ls` 返回 1。打包继续成功，这不是新增 Markdown 依赖，但仍是需要单独修复的依赖不一致。

启动诊断：shell `open` 对临时目录内候选返回 `-10827 kLSNoExecutableErr`；直接 shell UI 启动在 macOS `_RegisterApplication` / `NSApplication init` 中 SIGABRT，发生在 Electron JavaScript 之前。随后使用原生 CUA 按应用完整路径启动成功，已看见隔离 fixture 工作区，GUI 启动阻塞解除。final3 的真实界面验收正在进行；启动成功本身不代表其余功能检查通过。

详细原始日志在 `package-final3/`；构建与打包完整日志保留在私有根目录的 `build.log`、`package-dir.log`。上面检查不替代最终 GUI、真实模型调用或真实 updater 往返验收。没有公开发布授权。
