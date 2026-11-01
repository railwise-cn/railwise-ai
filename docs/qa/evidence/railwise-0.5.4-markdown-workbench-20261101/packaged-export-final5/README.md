# final5 安装包导出独立读回

2026-11-01，产品 **0.5.4**。本记录是 AI 独立文件检查，不是发布批准。三个输入由主验收代理在已安装 final5 应用的界面中导出；本次仅复制并解析已有文件，没有重新生成、操作界面或修改源码。

- 源码 checkpoint：`209a17ecc2ab8359dd22e210d22c806c1633744f`
- ASAR SHA-256：`12c4f2e8b0a2e6b173a63227e98ad00ec6d0daef5da9c043c212f732461d9bad`
- 导出源路径：final3 隔离 home 工作区中的 `markdown-workbench/export-check.{html,pdf,docx}`；目录名 final3 不表示导出所用程序版本。
- 本目录保存三份原样副本、输入 Markdown 副本与完整 `readback.json`。每份副本与原文件的 SHA-256 相同。

| 格式 | 大小 | 独立结果 |
|---|---:|---|
| HTML | 5,894 B | 标题、表格、TypeScript 代码和本地 data 图片存在；图片字节与原 PNG 一致；frontmatter 未进入正文；严格 CSP 存在，没有远程/file 图片 src。 |
| PDF | 76,188 B | 1 页，1 次图片绘制；标题、表格 `DB-01 / 1.25 mm / 正常` 和完整代码可读回；frontmatter 未进入正文。PDF 字体文本将部分汉字映射到兼容部首，断言使用 NFKC 及空白规范化，保留原始文本。 |
| DOCX | 10,352 B | Heading1 标题、1 个表格、1 张原字节 PNG 和代码主体存在；frontmatter 未进入正文。**代码中的单引号被错误转换为实体字面量，未通过代码保真检查。** |

发现 `PACKAGED-EXPORT-01`（P2）：输入代码为 `export const source = 'markdown'`，DOCX 实际文字为 `export const source = &#x27;markdown&#x27;`。OOXML 中保存的是 `&amp;#x27;`，因此不是读回工具少解码一层，而是 Word 正文已含实体文字。HTML 和 PDF 保留原单引号。此问题已报告主代理；本记录未修改安装包或源码。

3 MiB 只读保护夹具仍为 **3,145,728 字节**，SHA-256 `60dc074dc5e61af2f43a1f902c6730dc54a4eb2b62592010e81269d7aeec83b4`，与创建时完全一致，末尾保护标识仍存在。

结论：HTML/PDF 内容与资源检查通过；DOCX 引号代码保真失败。详尽字段、图片尺寸、原始文本、文件哈希和缺陷见 `readback.json`。
