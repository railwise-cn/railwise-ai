# 高级 Markdown 源码集成导出证据

2026-11-01，产品版本仍为 0.5.4。真实 Electron **43.1.1** 在独立 `/private/tmp` 工作区和 session 中生成本目录 HTML、PDF 和 DOCX；这不是已安装候选包的 UI 验收，也不是公证、签名或更新器证据。

- Mermaid 使用本机打包依赖的脚本，在独立 sandbox BrowserWindow 绘制；网络、权限、导航及弹窗全部禁用。输出经过共享 SVG 白名单清理。实际 `diagram.png` 已查看，资料 → 草稿 → 审定三处中文标签、节点和箭头均可见，SVG 无 foreignObject/script。
- HTML 内含 KaTeX 公式 HTML/MathML、data 字体、脚注及清理后的 SVG。PDF 使用独立 Chromium 会话打印一页，独立 PDF 文本读回确认脚注、图标签、公式符号及 frontmatter 隐藏。
- DOCX 的分式、根式、下上标及三组矩阵为可编辑 Office Math；脚注有真正的 `word/footnotes.xml` 与引用，脚注内公式仍为 Office Math。Mermaid 以本地绘制 PNG 嵌入；XML/媒体读回通过。
- 不完全支持的 MathML 布局采用本机 KaTeX 图像回退，避免改变公式结构。`boxed-formula.png` 是真实生成并检查的盒框公式图像。独立测试覆盖无横线二项式，以及对齐、分段、叠字、颜色和显式间隔的图像回退。

首次 Mermaid 实测发现，仅设置 flowchart.htmlLabels=false 不足以禁用所有 HTML 标签。增加顶层 htmlLabels=false 后，节点文字以 SVG text 保留；本目录只保存修复后产物。

`semantic-readback.json` 保存 13 项 HTML/DOCX 检查与产物 SHA，`pdf-readback.json` 保存 4 项 PDF 文本检查。`smoke-entry.ts` 为执行入口；编译为私有临时 CJS 后由真实 Electron 执行，生成内容均为合成夹具，无用户凭据、远程模型或外部资料。最终安装包仍需单独验收。
