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
| BrowserSkill CLI 0.4.0 and installed browser-skill Skill | Preserved; explicit dependency installation now pins official CLI 0.5.0 and Skill source 361da1d75798b99b358dfb434b8ce1921fb90d9e (MIT) | Native target expectations require CLI 0.5.0 and daemon/selected-extension protocol 1.8 or later; legacy 0.4.0/protocol 1.7 remains strict-only | Old binaries, Skill versions, connection settings, MCP records, credential references, active execution snapshots, and unknown-operation receipts remain intact; no external daemon is killed or active Worker silently upgraded | Update through the BrowserSkill connector when needed, update/reconnect the official extension, explicitly confirm the task scope, and continue separately. Verify or cancel unresolved operations before changing their scope; see [BrowserSkill migration](browser-skill-runtime.md#旧技能与配置迁移) |
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

0.17.0 默认目录中的按标签查询由 `zotero_search_items` 的 `tag` 参数承接。新预设采用已实测的 10 项只读工具，旧兼容别名 `zotero_search_by_tag` 属于上游可选工具组。已有 MCP 配置保留，新保存的预设按实际工具目录生成。

Zotero 的许可例外绑定包名 `zotero-mcp-server`、版本 `0.17.0`、唯一 MCP 组件及 SHA-256 `80f1c67060176eeeb1473a790a3e973c828f9df2fb6cb9199e05e6d1d292c41f`，安装来源固定为上游。其他包继续遵循原许可策略。[上游项目](https://github.com/54yyyu/zotero-mcp) [官方发行元数据](https://pypi.org/project/zotero-mcp-server/0.17.0/)

该固定版本依赖仅提供源码包的 `bibtexparser`。安装器仅对此条目允许构建官方 `bibtexparser 1.4.4`，固定源码 SHA-256 `093b6c824f7a71d3a748867c4057b71f77c55b8dbc07efc993b781771520d8fb` 与构建后端 `setuptools 84.2.1` 的官方 wheel 摘要。使用独立构建环境，依赖锁和安装记录保留来源与哈希。其他依赖继续要求 wheel，原本禁止的任意源码构建保持关闭。上游提供 LGPLv3 或 BSD 双许可，安装保留其许可文件。[官方源码包元数据](https://pypi.org/pypi/bibtexparser/1.4.4/json)

高德使用官方服务 `https://mcp.amap.com/mcp`，Key 在主进程及 Runtime 内存中解析为请求参数。连接检查要求发现至少一项已核对的只读工具，连接、启用与继续任务分开。[高德官方接入说明](https://developer.amap.com/api/mcp-server/gettingstarted)

## GitHub 0.5.5 连接入口整改

| 原条目 | 新状态 | 原因 | 资料保留 | 用户操作 |
| --- | --- | --- | --- | --- |
| GitHub 官方远端 MCP，目录标记 OAuth ready | 归入连接器，提供专用个人访问令牌配置、协议检查及独立启用入口 | 宿主未注册 OAuth Client ID，通用连接流程在授权前失败；官方远端服务支持个人访问令牌 | 原 MCP ID、名称、工作区、端点、工具规则、OAuth 配置与凭据引用全部保留，打开详情和目录升级不自动改写 | 已有连接先检查；新连接通过 GitHub 官方入口创建有期限、限定仓库范围的令牌，保存检查后启用 |

新连接默认选择官方只读端点，用户可以明确选择按令牌权限启用读写。旧连接保留原端点和启用状态。用户主动更换令牌时先停用该条目，再使用现有凭据轮换流程保存新引用，检查后单独启用。多项已有连接分别选择管理，同名自定义服务保留。[GitHub 连接操作说明](github-connector.md)

## 飞书 CLI 1.0.100 伴随技能目录

| 原条目 | 新状态与原因 | 资料保留 | 用户操作 |
| --- | --- | --- | --- |
| `lark-minutes`、`lark-vc-agent`、`lark-vc` 伴随技能 | 锁定的 1.0.100 上游源码提供 `lark-meeting` 会议统一入口，新安装按该版本实际的 25 项技能目录执行 | 升级保留已有旧目录和用户修改，新安装不再要求上游已移除的三个目录 | 在技能页检查新会议入口，按实际需要继续保留或管理旧技能 |

安装仍校验锁定源码的 SHA-256。若新版本缺少清单中的技能，保留原技能并报告安装警告。冷安装验收逐项检查所有预期技能文件。[锁定的官方会议技能](https://github.com/larksuite/cli/blob/ac22a60a23d66c37d43a7ec6d9e99b99a4320356/skills/lark-meeting/SKILL.md)

已安装同版 CLI、但前次伴随技能安装失败时，连接详情保留缺失警告并提供“修复配套工具”。该操作重新执行相同锁定版本的校验与安装，补齐缺失技能目录，保留已有用户目录。登录和类型化业务工具仍按实际认证状态工作。


## AutoCAD 双技能固定来源目录

| 条目 | 新状态与原因 | 资料保留 | 用户操作 |
| --- | --- | --- | --- |
| `autocad-dwg-redraw`、`autocad-image-redraw` | 原 external-only 条目改为用户主动的 upstream-only 安装。固定版本没有 LICENSE、COPYING、NOTICE 或脚本内授权声明，许可证状态保留为未知；精确上游导入使用独立的来源和摘要校验 | 上游作者 `pengxiaoan` 保留署名。已有用户技能、绘图、配置和权限维持原状态 | 点击“从上游安装”，审阅固定来源、依赖与权限后导入完整技能；脚本执行使用对应任务权限 |

已检查版本为 `ed182ec5966caaaf1d82d6ad4015435a27a8a909`。上游 codeload ZIP 大小为 64,359 字节，SHA-256 为 `1981737a34085f1e9d1e9f9cb5a1d989b6bb75506f2d9b064bc20cda35239b0e`。本轮交付目录、安装预览与上游下载流程。下载后先验证固定归档摘要，再安装完整脚本和参考资料。公司镜像和应用资源排除这两项源码；安装入口使用上游固定版本归档。[上游固定版本](https://github.com/pengxiaoan/autocad-dwg-redraw-skill/tree/ed182ec5966caaaf1d82d6ad4015435a27a8a909)

源 DWG 重绘与 DWG 生成、检查依赖 Windows AutoCAD COM、Python 3.10+ 和 pywin32。图片路径还需 Pillow、NumPy、OpenCV、ezdxf、PyMuPDF。macOS/Linux 的图片描线和矢量 PDF 路径生成粗略 DXF 基线，尺寸精度需要权威尺寸与约束核验。目录示例列出重绘 DWG、规格和标定 JSON、核验记录、PNG/PDF 预览及对比结果的适用交付范围。实际 CAD 执行与工程精度验收留待具备环境和明确任务范围后完成。

已核对 `dwg_prompt_builder.py` 与 `dwg_redraw.py` 的 `--restart-autocad` 会调用 `taskkill /IM acad.exe /F`。目录明确提示保存未完成文档并单独确认重启。图片转换中的部分 DWG 转存路径会删除已有输出后保存，因此目录要求确认覆盖范围或使用新路径。安装技能和授予主机执行、输出写入权限分别处理。


## CAD Python 依赖兼容补充

固定上游图片重绘脚本在 OpenCV 5.0.0.93 下因直线数组维度变化失败。已用独立 Python 3.12 环境、`opencv-python-headless==4.14.0.94` 运行合成图，生成可编辑 DXF、PNG/PDF 和视觉对比记录，DXF 审计零错误。目录依赖与使用说明固定到该已验证版本，用户在独立环境选择安装。Skill 上游 commit、原始文件、已有安装记录及权限保留。

该开源描线脚本写入毫米单位，使用前需给出毫米/像素比例。本次合成图的比例为已知 0.25 mm/px，产物包含 9 个 LINE 与 1 个 CIRCLE。双边缘描线作为粗略基线记录，尺寸精度待具体图纸核验。严格尺寸模式缺少标定时的阻断也已验证。此验收补充市场使用说明，许可 AutoCAD 的 DWG 运行环境继续作为功能依赖展示。

BrowserSkill macOS 历史所有权 `darwin:` 指纹保留。新的 `darwin-utc:` 使用固定语言和时区；旧记录无法可靠比较时维持身份未知，避免因中英文启动环境差异误杀或错误接管。用户资料、扩展配置与未知动作记录保持原样，可在原进程退出后重新检查连接。
