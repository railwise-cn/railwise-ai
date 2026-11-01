# WorkWise Design 工作区架构

本文记录 WorkWise 0.3.1 开发分支上的真实 Design 实现。它用于代码审查和后续维护，不把“代码已写”冒充“安装包已验收”。

## 1. 产品边界

Design 是与 Code、Write 平级的一级工作区，按文档类型提供自由画布和 PPTX 专用编辑模式。

- Design、Write 和 PPT 共用 WorkWise Agent Runtime，不增加第二套 Agent 提供商、模型切换器或诊断系统。
- 自由画布负责海报、配图、插画和标注；PPTX 文档通过专用编辑器适配器进入幻灯片工作区。
- PPT Master 负责 PowerPoint 语义、模板、生成、导入导出和质量检查。
- 请求 PowerPoint 时必须交付经过验证的 `.pptx`，HTML 或图片预览不能替代 PPTX。
- PNG、SVG 和 Write 插图是直接导出能力，不依赖 PPTX 转换成功。

## 2. 文档与资源模型

共享模型位于 `src/shared/design-document.ts`。

```ts
type DesignDocumentV1 = {
  schemaVersion: 'v1' | 'v2'
  id: string
  revision: number
  name: string
  documentKind?: 'free-canvas' | 'pptx'
  format: DesignCanvasFormat
  pages: DesignPage[]
  assets: DesignAsset[]
  pptx?: {
    editorBackend: 'pptx-vanilla-viewer' | 'pptist' | 'legacy-svg'
    editorVersion: string
    source?: { sha256?: string; bytes?: number; cachedFilename?: string }
  }
  importReport?: DesignImportReportV1
  designTokens?: {
    colors?: string[]
    fonts?: string[]
    spacing?: number[]
  }
  createdAt: number
  updatedAt: number
}
```

每个页面包含有序元素。支持矩形、椭圆、线、路径、文本、图片、PowerPoint preset 和结构化 group。

关键约束：

- `revision` 单调递增，用于阻止旧窗口或旧 Agent 命令覆盖新画板。
- 图片元素只保存 `imageAssetId`，不保存任意本地绝对路径。
- group 通过 `childIds` 建立结构，必须无环、无重复归属；边界由后代元素计算。
- 复制页面时会重写元素、group 和后代引用的 ID。
- 颜色在数据层使用规范化十六进制，渲染和 SVG 序列化时补 `#`。

## 3. 持久化

主进程服务位于 `src/main/services/design-document-service.ts`。每个工作区写入：

```text
<workspace>/.workwise/design/
├── index.json
├── <document-id>.workwise-design.json
└── assets/
    └── <document-id>/
        ├── <asset-id>.<ext>
        └── source.pptx (PPTX documents only)
```

持久化保证：

- 工作区根、文档路径和资源路径经过 canonical containment 检查。
- 拒绝路径逃逸、符号链接替换和非法 ID/文件名。
- 文档与索引使用同目录临时文件、fsync 和原子替换。
- 写入前再次检查父目录，降低 TOCTOU 风险。
- 同一工作区的写入通过串行队列执行。
- `expectedRevision` 不匹配时返回 `stale_request`，不覆盖磁盘数据。
- 启动读取可恢复原子写入遗留文件；损坏文件返回明确状态，不创建空文档覆盖。

Renderer 在工作区切换时加载活动文档，编辑后自动保存；导出、切换和联动 Write 前会先 `flush`。

## 4. 图片和 group

图片导入支持 PNG、JPEG、WebP 和 GIF：

- 单文件上限 12 MiB。
- 必须是普通文件，拒绝符号链接。
- 主进程验证扩展名、MIME、文件签名和 Electron 解码结果。
- 存入当前工作区的 Design 资源目录，再通过受限 API 读取为 data URL。

group 是真实结构，不只是 UI 选区：

- 移动、缩放、旋转 group 会变换后代元素。
- 删除 group 会按操作语义处理后代；复制会重写引用。
- 撤销/重做把一次 group 或 Agent 操作记录为一个历史步骤。
- SVG、PNG、PPTX 和持久化使用同一结构化文档。

## 5. Agent Design Rail

Runtime 工具位于 `kun/src/adapters/tool/design-tool-provider.ts`，正式工具为 `design_apply_canvas_commands`。

命令只针对用户当前打开的：

- canonical workspace；
- document ID；
- page ID；
- expected revision。

支持的操作为 add、update、remove、group 和 ungroup。工具参数经过共享 schema 验证，并带幂等键。Runtime 不直接另写一份 SVG 文件冒充画板变更。

执行流程：

1. Agent 返回经过验证的 `DesignCanvasCommandV1`。
2. runtime mapper 将命令作为结构化结果交给 renderer。
3. renderer 校验当前工作区、文档、页面、revision 和幂等键。
4. store 原子应用整批操作，写入一个 undo 历史步骤。
5. 命令记录随 Design 文档原子保存；只有 `flushSave()` 成功后才显示完成状态。保存失败会自动限次重试并显示错误，同一幂等键重放时返回原确认而不重复修改画板。

Design 助手复用 WorkWise 的会话、模型、审批、任务状态和诊断。界面只显示简洁进度和结果，不显示私有思维链。

## 6. PPT Master 6.8.0

内置快照固定为：

- 上游：`hugohe3/ppt-master`
- Release：`v6.8.0`
- Commit：`5e8856be0da8e6bc85c4aa28acc614478f7b7137`

受控快照保留新版路由与工作流、归因完整性检查、PPTX 导入/编辑/导出脚本、图表模板、品牌、Deck、`presentation_core` 布局和 preset shape 定义。

为控制安装包体积，不分发大体积图标 SVG 库、AI 对比 PNG、用户项目、生成导出物、备份和私有 PPTX。缺失的图标库不会导致整个 PPT 任务失败；工作流使用原生形状、项目内图标或已授权来源。

来源与差异记录在：

```text
src/asset/skills/ppt-master/.workwise-skill-source.json
```

`scripts/prompt_audit_manifest.json` 是 WorkWise 瘦身包适配层；它不参与 runtime prompt，只用于验证路径、引用、注册表和 Token 预算。审计不得出现缺失路径或错误。

正式客户端把 MarkItDown 与上述 PPT Master 6.8.0 导入、导出、原生 PPTX 编辑和 preset 脚本一起冻结为按平台/架构构建的本地 sidecar。打包后的核心路径不依赖系统 Python；每个平台的构建都会用该冻结程序执行一次 SVG → PPTX → SVG 往返验证。开发模式可以回退到审计快照中的 Python 脚本，但不得绕过 `attribution_guard.py` 或新版路由约束。

## 7. PPTX 专用工作区与导入

PPTX 文档使用 `PptxEditorAdapter` 作为稳定边界，当前挂载固定版本的 `pptx-vanilla-viewer`（Apache-2.0，仓库 `ChristopherVR/ooxml`，提交 `d8f80c291c1f9ecc23278c4b2ac8674915d30828`）。PPTist 的 AGPL-3.0 来源记录保留为暂停状态，不进入安装包。自由画布文档不会进入该路径。

编辑器来源、npm SRI、制品摘要和许可证入口记录在 `src/asset/pptx-editors/pptx-vanilla-viewer-source.json`。主包同时保留上游 `LICENSE`、`NOTICE`，以及 NOTICE 中单独许可的 MPL-2.0 `mtx-decompressor` 的源码/许可证材料；不能把整个依赖树描述为单一许可证。

导入首先对原始 PPTX 做有界 ZIP/OOXML 预检并以只读字节交给本地 Vanilla 编辑器；源 PPTX 以 `source.pptx` 原位保留，并记录 SHA-256。兼容 SVG 只用于质量报告和明确标注的参考预览，不能冒充原始 PPT 视觉，也不能在转换失败时阻止有效原件进入原生编辑器。

导入文档同时持久化 `editorModel` 原生对象索引和 `protectedObjects` 保护清单；这两项经过有界 JSON 归一化，供 AI 提案、锁定检查、页面诊断和修订恢复使用。原生编辑器的 AI 只提交经过审核的一次性对象更新，不能改写对象来源、关系或受保护 OOXML。

已支持的保真范围：

- 页面顺序和元素 z-order；
- 基础形状、文本、路径和多路径 preset；
- 图片资源提取、签名校验、工作区存储和 ID 重映射；
- 支持的 transform/rotation；
- 可识别 group 的结构和边界。

导入安全限制：

- 最多 64 个图片资源；
- 单图片最多 12 MiB，合计最多 48 MiB；
- 拒绝绝对路径、NUL、路径逃逸、符号链接和错误文件签名。

不支持或可能降级的滤镜、mask、渐变、透明度、复杂嵌套 transform 等必须返回 `DesignFidelityWarning`，并写入持久化 `importReport`；不能静默声称无损。页数不一致、极端坐标和无效几何会阻断导入。

## 8. 导出

### SVG

`documentToSvgStrings` 直接从当前文档序列化。图片必须能从工作区资源解析为安全 data URL；可见图片缺失或签名不合法时导出失败，不生成破损文件。

### PNG

Renderer 使用当前 SVG 和真实资源渲染 PNG。导出限制为最长边 8192 px、总像素 40 MP，避免主进程或 renderer 内存失控。

### PPTX

导出前要求：

- 至少一页；
- 所有页面尺寸一致；
- 每边在 PowerPoint 支持范围；
- 可见图片资源完整。

PPTX 专用编辑器使用 Vanilla 的原生导出路径；主进程把导出字节做 ZIP、关系、页数和媒体校验。保存编辑结果时写入按 SHA-256 内容寻址的修订，只有预检与 OOXML 校验通过后才切换活动修订；原件和旧修订可恢复。未支持对象保持受保护状态，不得静默扁平化为错误形状。自由画布仍使用 PPT Master 的 SVG → PPTX 兼容导出路径。

PPT Master 要求明确的发布契约，因此 WorkWise 会在受限临时项目中生成 `spec_lock.md`，声明画布、主题字体、主题颜色和 `pptx_structure.mode: flat`。候选 PPTX 通过页数、关系、媒体和 OOXML 检查后才原子替换用户目标文件。

### Write 联动

Design 页面可以作为 PNG 或 SVG 保存到当前 Write 工作区并插入 Markdown。步骤为：

1. flush 当前 Design 文档；
2. 生成目标格式；
3. 原子写入 Write 资源目录；
4. 更新 Markdown；
5. 任一步失败时不报告成功，并保留可恢复的原文档。

## 9. API

公开接口通过 `window.workwise` 暴露：

- `loadDesignDocument`
- `listDesignDocuments`
- `saveDesignDocument`
- `importDesignImageAsset`
- `readDesignAsset`
- `importPptxToDesign`
- `readDesignPptxRevision` / `saveDesignPptxRevision`
- `exportDesignPptxBytes`
- `exportDesignToPptx`
- `saveDesignAssetToWrite`
- `listPresetShapes`
- `renderPresetShape`

所有 payload 由 IPC schema 校验。renderer 业务代码不直接访问内部 Runtime 路径或任意主机文件。

## 10. 验收状态

代码完成不等于发布完成。以下各项全部通过后，才可以在发布说明中称为可用：

- 文档结构、持久化、图片、group、Agent 命令、导入导出和 Write 联动单元/集成测试；
- PPT Master prompt/path/provenance 审计；
- TypeScript、ESLint、Vitest、生产构建、品牌边界和 OpenSpec strict；
- 打包后真实 WorkWise 应用中完成新建、编辑、重启恢复、Agent 改图、导入 PPTX、导出 PPTX/PNG/SVG、插入 Write 和成果卡操作；
- 发布包只包含允许的产品文件和受控 Skill 资源。

若真实安装包测试受环境阻断，必须记录具体阻断和可复现替代测试，不能把它写成“已完成”。
