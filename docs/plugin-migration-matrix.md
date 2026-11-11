# WorkWise Plugin and Skill Migration Matrix

This matrix is part of the release gate. Existing files and user-installed
Skills remain readable; an item is not removed or replaced silently.

| Existing item | WorkWise status | Reason | Data preservation | User action |
| --- | --- | --- | --- | --- |
| Schedule | Retained as a WorkWise-managed capability | Built into the application | Existing schedules and settings stay in the WorkWise data directory | None |
| Filesystem MCP | Retained | Official MCP package with explicit roots and permission review | Existing MCP V2 record is preserved | Review filesystem roots before enabling |
| Playwright / Puppeteer | Playwright retained; Puppeteer shown as merged | One maintained browser integration avoids duplicate execution paths | Existing Skill directories are left in place | Use Playwright for new installs |
| Context7 | Retained | Maintained documentation source | Existing install record is preserved | Review network permission |
| Memory | Retained | Official local memory server | Existing data directory is not deleted | Review storage permissions |
| Sequential Thinking | Retained | Official reasoning utility | Existing Skill or MCP record is preserved | None |
| GitHub MCP | Replaced by the official remote endpoint | The old package is no longer the supported official path | Old config remains as migration input; V2 stores the new endpoint | Re-authorize GitHub when prompted |
| Postgres MCP | Replaced by DBHub | DBHub is the maintained supported database route | Old config remains readable | Recheck read/write permissions |
| Brave Search | External / unavailable | No independently supported WorkWise install is claimed | No files are removed | Use an external service or leave disabled |
| Slack | External / unavailable | No independently supported WorkWise install is claimed | No files are removed | Configure an external integration if required |
| Lark CLI | WorkWise-managed | Managed toolchain already owns installation and credentials | Existing managed tool data is preserved | Use the managed tool status panel |
| OfficeCLI | WorkWise-managed | Managed document toolchain | Existing managed tool data is preserved | Use the managed tool status panel |
| Ego Browser | External managed integration | It is an external application, not a bundled installer | Existing external app is untouched | Keep the external app installed separately |
| MarkItDown | WorkWise-managed / bundled | Document engine is already managed by WorkWise | Existing conversion configuration is preserved | None |
| Engineering, bidding, document, data-analysis, PPT Master, Humanizer and other local Skills | Browse-only unless explicitly installed from a reviewed source | Local Skills must remain visible and auditable | `~/.agents/skills`, `~/.codex/skills`, `~/.workwise/skills`, project roots and bundled assets are scanned without deletion | Review duplicate, health and update-source labels |
| Restricted or unlicensed third-party content | Source/status only | License or redistribution terms are not sufficient for bundling | Source metadata remains visible | Install only after an independent license review |

## Migration Rules

- `mcp.json` is preserved as a read-only migration source; valid entries are
  copied to `mcp-v2.json` without copying plaintext environment credentials.
- If an existing V2 entry still points to an obsolete temporary WorkWise build,
  WorkWise repairs only the executable path from a matching valid legacy entry.
- Third-party GitHub Skills default to manual updates. Automatic updates are
  reserved for audited bundled sources and explicitly trusted sources.
- A replacement, removal, license restriction or permission expansion requires
  a new review and explicit user confirmation.


## 工程技能与只读连接器补充

| 原条目或资料 | 新状态与原因 | 资料保留 | 用户操作 |
| --- | --- | --- | --- |
| 技能、插件、连接器页签 | 调整为技能、插件、连接器，默认打开技能，任务深链仍直达对应连接器 | 原安装记录、来源、权限与更新设置保留 | 按页签查找，已有连接继续可管理 |
| 四项新增工程技能 | 资料盘点、监测质检、文档差异、会议待办采用可选内置包，每项带合成样例 | 放在独立可选资源目录，已有自定义技能不覆盖 | 点击安装后加入本机技能目录，再按任务选择 |
| MarkItDown、Docling、OfficeCLI、AntV、Playwright | 增加工程常用入口，复用原包与实际安装、检查、权限审阅流程 | 原版本、配置及凭据引用保留 | 打开详情检查或安装 |
| 高德地图 | 新增官方 Streamable HTTP 只读连接预设，固定服务地址和已核对工具目录 | Key 通过现有受保护凭据存储保存，明文不写入 MCP 配置 | 从高德控制台取得 Web 服务 Key，保存并检查，再启用只读工具 |
| Zotero MCP 0.17.0 | 新增社区连接器，仅对固定上游轮子及摘要允许独立安装 | 保留 MIT AND AGPL-3.0-or-later 完整许可证，既有 Zotero 配置与库文件不修改 | 审阅许可证与权限后安装，在 Zotero 启用本机 API，检查后启用只读工具 |

Zotero 使用独立 HOME、配置与缓存目录，关闭本地写入、Claude 配置发现、dotenv 和可选 semantic 工具组。预设仅允许明确列出的读取工具。没有安装 semantic 或 PDF 扩展，不启动嵌入模型下载。上游轮子包含的 Zotero 插件保留其许可证，安装流程不将它部署到 Zotero。

Zotero 的许可例外绑定包名 `zotero-mcp-server`、版本 `0.17.0`、唯一 MCP 组件及 SHA-256 `80f1c67060176eeeb1473a790a3e973c828f9df2fb6cb9199e05e6d1d292c41f`，安装来源固定为上游。其他包继续遵循原许可策略。[上游项目](https://github.com/54yyyu/zotero-mcp) [官方发行元数据](https://pypi.org/project/zotero-mcp-server/0.17.0/)

高德使用官方服务 `https://mcp.amap.com/mcp`，Key 在主进程及 Runtime 内存中解析为请求参数。连接检查要求发现至少一项已核对的只读工具，连接、启用与继续任务分开。[高德官方接入说明](https://developer.amap.com/api/mcp-server/gettingstarted)
