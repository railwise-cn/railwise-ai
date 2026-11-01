# final6 安装包 DOCX 独立读回

2026-11-01，RailWise AI **0.5.4**。主验收代理通过已安装 final6 应用的原生保存对话框，以全新名称 `export-final6.docx` 导出；本次独立检查仅复制并解析文件，没有重新生成导出或操作界面。

- 源码 checkpoint：`1864d44d23f5328d5fc435edec9323b57db53ece`
- ASAR SHA-256：`1661b8e597be4c69634e0c9b1ebdc4941f7defed6bbc96508e5bf6f103dafe07`
- 文件大小：**10,349 字节**；SHA-256：`b59b60ad05310d96c56522a4c394ff7eb45f8e0ccd6a42780997f1ed4869a749`

独立 OOXML 读回通过：Heading1 标题、测点表格、本期值 `1.25 mm`、原字节本地 PNG、frontmatter 正文排除，以及 TypeScript 代码逐字符一致。代码实际文字为 `export const source = 'markdown'`，没有额外 `&#x27;` 或 `&#39;` 字面量。

`PACKAGED-EXPORT-01` 在此 final6 新导出文件中复验通过；final5 的失败文件与报告保留在相邻目录，未覆盖。本次 XML 正文只解码一次，避免过度解码掩盖此前缺陷。完整来源路径、段落、媒体哈希和断言见 `readback.json`；复验脚本为 `readback-docx.mjs`。

随后通过同一安装包界面，以新名称导出 `export-stress-final6.docx`，独立复制并读回两个代码块：TypeScript 的单双引号、`& < >`、模板字符串和字面实体，以及 HTML 的嵌套高亮内容。两个代码段与各自 Markdown 围栏内源码逐字符一致；原本写在代码里的 `&#x27;`、`&quot;`、`&lt;` 和 `&amp;` 保持字面量，没有重复解码或泄漏高亮 `<span>` 标签。

- 压力导出大小：**9,466 字节**；SHA-256：`6ddf668662fd826294f4512ff6ea8a0af8cde82e4bc438fc7d9fac13bd1d1062`
- 压力夹具副本：`export-stress.source.md`；完整逐段 expected/actual 比较见 `stress-readback.json`。
- 界面导出证据：`../screenshots/17-final6-stress-export.png`。

普通夹具的 8 项检查与压力夹具的 5 项检查均通过。此记录证明这些夹具的安装包导出结果，不代表所有格式或任意复杂代码语法均已验收，也不构成公开发布批准。
