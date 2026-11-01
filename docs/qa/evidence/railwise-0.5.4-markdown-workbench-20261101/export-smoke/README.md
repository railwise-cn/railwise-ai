# Markdown 工作台导出集成检查

此目录记录 2026-11-01 对当前源码的真实 Electron 43.1.1 导出检查，不是安装候选包的最终验收，也不构成发布批准。

- 调用实际 `exportWriteDocument`，保存对话框由本地测试运行器返回本目录私有目标路径；没有替换 HTML、DOCX 或 Chromium PDF 渲染器。
- 输入 `document.md` 包含 YAML frontmatter、标题、段落、表格、代码、本地 PNG 和远程图片链接。
- `document.html`、`document.docx`、`document.pdf` 是实际生成的文件；字节数和 Electron 版本见 `real-electron-export-results.json`。
- `export-readback.json` 保存 PDF 页数、完整文本提取、规范化后文本检查、DOCX 表格/图片检查以及三个导出文件的 SHA-256。
- Chromium 的 PDF 文本提取包含单字间空格；匹配标题和表格时仅移除空白，原始提取同时保留。
- frontmatter 没有进入三个格式的正文；远程图片没有进入 HTML，DOCX 仅包含一张本地图片。

后续仍须在最终安装包中检查导出入口、保存对话框和 PDF 视觉版式；本检查不替代该验收。测试图片为 1×1 PNG，仅用于核查本地图片打包链路。
