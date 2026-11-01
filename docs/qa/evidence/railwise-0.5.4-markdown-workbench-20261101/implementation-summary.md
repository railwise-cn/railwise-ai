# Markdown 工作台实现摘要

2026-11-01 源码证据复核。产品版本仍为 **0.5.4**；本文件不代表私有候选包验收通过或公开发布批准。复核时实现已冻结，未修改生产应用、源码快照、公开版本、标签或发布源。

## 已实现边界

- Markdown/MDX 文件保留为正文权威。多标签、固定、最近关闭/打开、脏文档保存/放弃/取消、工作区内创建/重命名/移动/删除接入既有文件模型。旧 `activeFilePath` 和文件 IPC 保持兼容。
- 可视化编辑使用自主实现的 Markdown 投影，支持核心块内编辑，未修改块保留原始源码。源码、Live、Split、Preview 继续可用；不复制 OpenKnowledge GPL 编辑器或运行时，不引入协作服务。
- 文档属性使用 YAML 字段对象和校验。链接面板提供相对 Markdown/Wiki 链接、有效/断开/不安全状态、反向链接和可导航关系边列表。
- 全文搜索、文档关系与 AI BM25 共用本地文件索引。搜索返回路径、标题、片段和行号，支持路径/标题匹配；无默认远程 Embedding。
- AI 选区改写、压缩、扩写、风格、术语统一与文档提纲/续写/摘要接入审阅差异。应用结果前校验原始文档、路径和选区；工作区资料问答使用带来源的本地检索。写作阶段以文档属性承载。
- 指纹检查写入检测外部修改和删除，冲突保留用户尝试内容与磁盘内容。`expectedRevision: null` 明确表示预期文件不存在，省略字段保留旧调用兼容语义。
- 每次检查写入保留保存前/后的本地历史；恢复追加新历史，不删除后续版本。批注保存锚点、选中文字、内容、开放/解决状态，支持重新打开和加入写作助手，不写入 Markdown 正文。
- HTML、富文本剪贴板、Chromium PDF 和真实 OOXML DOCX 隐藏 frontmatter，保留核心表格/代码语义。本地图片经工作区包含、非链接和大小检查；远程图片不自动下载。HTML 采用严格 CSP；PDF 使用独立临时会话阻断网络、导航、弹窗和权限请求。

## API 与数据位置

| API | 返回/行为 |
|---|---|
| `readDocumentSnapshot` | 正文和 `DocumentRevision`（SHA-256、字节数、修改时间） |
| `writeDocumentChecked` | 成功快照、结构化冲突或错误；同一规范路径串行检查/写入 |
| `searchWorkspaceDocuments` | 匹配结果、索引文件数、跳过数、截断状态、显式限制 |
| `getDocumentSemantics` | `frontmatter`、`outgoing`、`backlinks`、`relations` |
| `listDocumentHistory` | 最新最多 200 条无正文摘要及 `total/truncated/limit` |
| `getDocumentHistoryEntry` | 按历史 ID 单独读取完整正文 |
| `restoreDocumentHistory` | 指定历史 ID 与显式预期修订，检查后追加恢复记录 |
| `list/create/updateDocumentComment` | 本地批注列表、创建、解决或重新打开 |

- 标签会话元数据：浏览器存储 `workwise.write.document-session.v1:<workspace>`，不保存正文；旧 `kun.write.active-file:<workspace>` 保留回退。
- 历史：工作区 `.workwise/document-history/<relative-path-sha256>/<timestamp-uuid>.json`，正文和指纹保存在独立记录中。
- 批注：工作区 `.workwise/document-comments/<relative-path-sha256>/<uuid>.json`。批注状态更新同一个边车文件；“追加式”保证针对历史恢复，不表示批注状态为事件日志。
- 应用内重命名/移动复制并重映射边车记录到新路径标识，保留原目录和记录。外部重命名不会自动猜测对应关系，通过缺失提示和重新定位处理。
- 不使用 `.ok`、shadow Git、Yjs/Hocuspocus 服务或远程共享目录。

## 显式限制与第二阶段

- 脚注、数学、Mermaid、原始 MDX/HTML 和 frontmatter 在可视化模式中是保护块，使用源码/属性入口编辑；跨块原生编辑被阻止。Mermaid 导出为代码，数学/脚注保留源码表达式，不宣称已完成语义渲染。受控 HTML 可视化嵌入及第二阶段扩展尚未实现。
- 关系视图当前为链接列表，不是交互式节点画布。没有多人批注、实时协作、GitHub 分享、远程控制或默认语义网络请求。
- 核心图片预览支持被动 SVG；可视化编辑器主动加载光栅图，SVG 等保护资源可显示占位。跨格式完全相同的复杂图形排版仍需独立验收。
- 普通文件读取预览最多 1,500,000 字节；截断预览进入只读，禁止将预览覆盖回原文件。检查快照/写入另有 8 MiB 上限。
- 共用索引预算：20,000 文件、每文件 2,000,000 字节、总计 64 MiB、最多扫描 200,000 条目录项；BM25 有独立片段/词元预算。超限及跳过状态返回并在搜索界面提示；清单缓存 1 秒，可见搜索/关系强制刷新。
- 历史文件全部保留，当前 UI 只列最新 200 条并提示截断；更早记录没有完整分页浏览入口。列表仅传摘要，选中后读取单条正文。
- 本次范围为本地单机流程。最终安装包的主题/语言/尺寸/辅助功能检查、签名/ASAR/依赖检查和真实更新往返仍由最终候选验收记录证明。

## 已有验证与文档审阅

- 文档服务、工作区、导出和严格 IPC 合约最近一轮 **91 项测试通过**，Node TypeScript 检查通过；共用索引还由独立测试覆盖。完整最终验证以主验收清单为准。
- `export-smoke/` 保存真实 Electron 43.1.1 生成的 HTML、DOCX 和一页 PDF，以及字节数、SHA-256、PDF 文本和 DOCX XML/图片读回。它是源码集成检查，不能替代最终安装包验收。
- `USER_GUIDE.zh-CN.md` 的 Write 章节已补齐多标签、编辑模式、搜索、属性、链接、历史、批注、AI 差异审阅、冲突和大文件保护的操作说明，并提供工程报告使用流程；导出说明与内置 DOCX 引擎一致，明确本地图片、frontmatter 和第二阶段限制。
- 迁移矩阵与当前路径和兼容行为一致。其历史/快照/批注行的“追加记录”需按上文区分历史与批注状态更新；外部重命名不得理解为自动迁移。

## final3 隔离验收夹具

只新增到 `/private/tmp/railwise-0.5.4-markdown-workbench-private-20261101-final3/home/workspace/markdown-workbench/`：

- `large-protection.md`：3,145,728 字节，末尾标识 `FINAL_TAIL_MUST_REMAIN_INTACT_AFTER_READ_ONLY_CHECK`，用于截断只读与原文件不变检查。
- `external-target.md`：外部修改/删除基线文件，末尾标识 `EXTERNAL_TARGET_ORIGINAL_TAIL`。
- `missing-target.md`：故意不存在的重新定位目标名称；本轮没有创建或删除它。
