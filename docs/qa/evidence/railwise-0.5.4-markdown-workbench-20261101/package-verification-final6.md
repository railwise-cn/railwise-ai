# 私有候选包静态验收（0.5.4 / final6）

final6 修复真实 DOCX 导出中的数字 HTML 实体与嵌套语法高亮保真问题，继承已验收的搜索弹层和活动标签定位修复。本次只在本机建立隔离候选，未改公开版本、标签、发布源或下载页。

| 项目 | 结果 |
|---|---|
| 私有 checkpoint | `1864d44d23f5328d5fc435edec9323b57db53ece` |
| 原仓库 HEAD | `7c904709d25c062dd3a7dbde396eb6273fcf1fd5`；候选包含清单记录的工作区修改 |
| 源码清单 SHA-256 | `cc0589bae079eb093a1bda73322b9cf54bf5ec52a382ce5a9e483e04405cb261` |
| 包版本 | `0.5.4` |
| 候选 Bundle ID | `com.wangjiawei508.workwise.candidate.head1864d44d23f5` |
| 持久安装路径 | `/Users/wangjiawei/Documents/WorkWise/dist/railwise-0.5.4-markdown-workbench-private-final/Applications/RailWise AI Candidate 1864d44d23f5.app` |
| 临时安装路径 | `/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101-final6/Applications/RailWise AI Candidate 1864d44d23f5.app` |
| ASAR SHA-256 | `1661b8e597be4c69634e0c9b1ebdc4941f7defed6bbc96508e5bf6f103dafe07`；打包、临时安装、持久安装三份一致 |
| ASAR 完整性 | 通过；26,026 文件、485 编译文件与 checkpoint `out` 一致，包内 sourceHead 匹配 |
| 原生依赖 | 持久安装包真实 SQLite 查询 smoke 通过；Electron ABI 148、arm64 |
| 签名 | Ad hoc；持久安装包 `codesign --verify --deep --strict` 通过，无 Team ID |
| 公证 | 未公证；构建环境无 Apple 凭据，stapler 检查 exit 66 |
| Gatekeeper | accepted 的理由仍为 `override=security disabled`，不作为可分发信任证据 |
| 文档依赖许可 | 策略检查通过；无 OpenKnowledge 运行时依赖 |
| 包路径安全盘点 | 无意外私钥、证书或实际 `.env`；允许 `.env.example` 模板。此项仅为路径盘点 |
| 文本内容扫描 | 扫描 25,730 个 ASAR 文本、9,094 个外置资源文本及 4 个候选日志；未确认实际私钥或服务凭据，发现 1 个不应随包分发的第三方开发日志，见下文 |
| 更新器 | `--dir` 包无 `app-update.yml`；`WORKWISE_UPDATE_PROVIDER=none`，未执行真实更新往返 |
| checkpoint 状态 | 构建与静态检查后源码工作树干净 |

DOCX 回归：导出套件 50/50 通过，独立 AI 审查代理另行复跑同套件通过；新增真实 OOXML 读回精确比对单/双引号、`&`、`<`、`>`、源码中的实体字面量、TypeScript 模板字符串嵌套高亮及 HTML 标签代码。数字实体支持十进制和十六进制，按单层解码，并保留非法 Unicode/XML 码点的文本形式。完整 Web/Node 类型检查、相关 ESLint 与 diff 检查通过。最终 GUI 导出复验由主任务独占 CUA 进行。

隔离数据：临时 final6 在主任务停止 final5 后克隆其候选专用 user-data/session-data/home，保留此前明确授权的 final3 隔离 fixture 路径。持久安装使用全新的 Chromium session 与独立 runtime root，候选专用 settings 已将工作区指向持久目录 `home/workspace/markdown-workbench`，该目录含实际验收用 `export-check.md`。未复制生产配置、凭据、源码或构建依赖；未覆盖其他生产 dist 应用。相邻 `candidate.env` 由已有候选启动逻辑自动发现。持久和临时安装分别记录在 `package-final6/persistent-runtime.json` 与 `session-clone.json`。

构建使用 Electron 43.1.1、本地缓存 electron-builder 26.8.1、`--publish never --mac --arm64 --dir`。依赖经 APFS 克隆复制到私有 checkpoint；原生重编译未写入原仓库 node_modules。完整构建/打包日志保留在临时 final6 根目录 `build.log` 与 `package-dir.log`。

原有 PPTX 依赖图的不一致仍被打包器报告：`ooxml-core` / `emf-converter` 声明 `@napi-rs/canvas ^1.0.9`，实际为 `0.1.100`。打包继续成功，本轮没有修改该依赖。

追加只读内容扫描发现包内容问题：`app.asar/node_modules/lib0/.playwright-mcp/console-2026-07-11T22-37-21-406Z.log` 是与本地 `lib0@0.2.119` 依赖拷贝一致的第三方开发日志，其中有一个 JWT 格式字面量。本地仅检查字段结构、标准公开示例比较与测试上下文；符合公开 JWT 示例形态，但没有验证签名、有效性或服务访问能力，不能将其认定为有效凭据。该日志不是运行时必需文件，应通过统一依赖打包规则排除，并由 final7 重建验证。其余 26 组候选模式归类为翻译标签、输入类型枚举、MCP 文档示例或 Zod 验证测试数据；候选专用日志没有命中凭据模式，包中没有命中本次验收 fixture 的两个标识。

扫描范围是严格 UTF-8 文本、配置、JS 和候选专用日志；共约 499 MB 文本。跳过不可解码/NUL 二进制、22 个资源符号链接和 3 个大于 32 MiB 的原生转换器/运行库文件。没有检查生产数据、网络流量、进程内存、Keychain、嵌套压缩包或完整混淆/编码内容，因此不等于全面安全认证。报告 `package-final6/secret-content-scan.json` 只保留文件、计数、分类与范围，未保留匹配值或 JWT claims；同目录保留扫描脚本和 `jwt-provenance.json`。final6 应保留为该缺陷的证据，不能凭本页的路径盘点判断没有开发产物。

原始检查在 `package-final6/`。最终包仍为私有候选；公开发布所需的正式签名、公证和真实 updater 往返证据尚未满足。
