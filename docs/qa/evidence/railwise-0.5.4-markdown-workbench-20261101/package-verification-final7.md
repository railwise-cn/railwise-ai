# 私有候选包验收（0.5.4 / final7）

final7 排除依赖中的浏览器开发日志/报告，并修复 HTML 围栏代码在可视化编辑器中被误判为受保护 HTML 的问题。DOCX 实体和嵌套高亮修复与 final6 相同。本次只建立本机隔离候选，未改变公开版本、标签、发布源或下载页。

| 项目 | 结果 |
|---|---|
| 私有 checkpoint | `5c88bfd6de0a65e0436cb33bcc1c6528154e20dd` |
| 原仓库 HEAD | `7c904709d25c062dd3a7dbde396eb6273fcf1fd5`；候选包含清单记录的工作区修改 |
| 源码清单 SHA-256 | `3ccf6e06d0b36e1ebe67af293c9cb302aabc9ab3412c9cfbf2ddad577c2bd7b9` |
| 包版本 | `0.5.4` |
| Bundle ID | `com.wangjiawei508.workwise.candidate.head5c88bfd6de0a` |
| 持久安装路径 | `/Users/wangjiawei/Documents/WorkWise/dist/railwise-0.5.4-markdown-workbench-private-final7/Applications/RailWise AI Candidate 5c88bfd6de0a.app` |
| ASAR SHA-256 | `487f5c5ff8236e9e92f4d83f4e52c87afd2e06503b72918fcb07856545cccc4a`；打包、临时安装、持久安装三份一致 |
| ASAR 完整性 | 通过；26,023 文件、485 编译文件与 checkpoint `out` 一致，包内 sourceHead 匹配 |
| 原生依赖 | 持久安装包真实 SQLite 查询通过；Electron ABI 148、arm64 |
| 签名 | Ad hoc，深度严格签名校验通过，无 Team ID |
| 公证 | 未公证；构建环境无 Apple 凭据，stapler exit 66 |
| Gatekeeper | accepted 理由为 `override=security disabled`，不作为可分发信任证据 |
| 文档依赖许可 | 检查通过；无 OpenKnowledge 运行时依赖 |
| 依赖开发产物 | main ASAR 与 managed-runtime 实际包扫描均通过，无 `.playwright-mcp`、`playwright-report`、`test-results` 或依赖 `.log` 文件 |
| 包路径安全盘点 | 无意外私钥、证书或实际 `.env`；允许明确的 `.env.example` 模板 |
| 更新器 | `--dir` 包无 `app-update.yml`；候选 `WORKWISE_UPDATE_PROVIDER=none`，未执行真实更新往返 |

开发产物处理：final6 的 `lib0/.playwright-mcp/console-*.log`、同目录 `page-*.yml` 和 `cytoscape/test-results/.last-run.json` 共 3 个文件已从 final7 删除。只删除候选包中不需要的依赖开发产物，不改用户日志、配置或源依赖目录。排除规则同时作用于主依赖与 managed-runtime，after-pack 在激活 managed-runtime 依赖后检查实际布局并拒绝残留。配置与实际 ASAR 正反例测试 2/2、相关 ESLint 通过，独立 AI 代理另行复跑通过。路径比较记录见 `package-final7/artifact-removal.json`。

源兼容性：按清单逐文件 SHA-256 比较，final6→final7 的生产 `src` 变化只有 `write-rich-projection.ts` 中受保护围栏语言匹配移除 `html`；对应编辑器测试同步增加。普通 HTML 围栏作为惰性代码文本可编辑，真正的原始 HTML 仍受保护，Mermaid/math/latex 不受此修改影响。编辑器套件 16/16 与独立复核通过。DOCX 和其他生产源文件逐字节不变，见 `source-lineage.json`。真实 UI/导出复验由主任务使用 CUA 独占执行，不能由静态结果替代。

最终 CUA 复验已完成：在 HTML 代码块中将 `card` 改为 `panel`，保存并切源码确认围栏和实体完整；实际 GUI 导出 `export-stress-final7.docx` 后由另一 AI 代理独立复制/XML 读回，10/10 检查通过。文件 9,467 字节、SHA-256 `d2665c89c024a15223c784f3ec1142e0d3798a02ad5159c5beb85c94797e388a`；两段代码逐字符匹配保存后的源码。见 `packaged-export-final7/` 和截图 18/19。此前图片/表格及 HTML/PDF 证据按 final5/final6 来源保留，不冒充新包截图。

内容扫描于 `2026-11-01T07:28:51.949Z`（本地 15:28）覆盖 25,727 个 ASAR 文本、9,094 个外置资源文本及启动后 2 个候选专用日志（3,265 字节），共约 499 MB；没有确认实际私钥/服务凭据，候选日志没有命中凭据模式，未命中验收 fixture 的两个标识。剩余形态匹配属于翻译文本、输入类型枚举、MCP/EventSource 文档示例和 Zod 验证测试数据；开发日志中的示例 JWT 已随开发产物排除。扫描方法只读取 UTF-8 文本，私钥块规则额外处理字面转义换行；跳过不可解码/NUL 二进制、22 个资源符号链接和 3 个大于 32 MiB 的原生运行库/转换器。不检查生产数据、网络、内存、Keychain、嵌套压缩包或完整混淆/编码内容，不等于凭据有效性验证或全面安全认证。扫描脚本含 3 个合成规则阳性对照；报告只保留文件、计数与分类，不输出任何匹配值或 JWT claims。日志可能在本次扫描之后继续增加。

持久安装采用新 root、新 session 和候选专用 settings，工作区位于该 root 的 `home/workspace/markdown-workbench`，包含实际验收用 `export-check.md`、`export-stress.md`。未复制生产配置、凭据、源码或构建依赖，未覆盖 final6 或生产应用。相邻 `candidate.env` 由已有候选启动逻辑自动发现。

构建使用 Electron 43.1.1、electron-builder 26.8.1、`--publish never --mac --arm64 --dir`。构建、打包日志保留在临时 final7 根目录；原始校验在 `package-final7/`。原有 PPTX `@napi-rs/canvas` 声明与实装版本不一致仍被打包器报告；本轮未改变该依赖。正式签名、公证及真实 updater 往返等公开发布条件尚未满足。
