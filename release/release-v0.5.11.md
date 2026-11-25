# RailWise AI 0.5.11

## 网页来源与演示文稿

- 对话里直接输入 `www.railwise.cn` 这类地址即可作为网页来源。修复在桌面应用中读取 HTTPS 网页时的连接问题。
- 直接读取失败时，任务可通过已连接的 BrowserSkill 读取已授权的网站。成功取得网页正文后，任务可以继续使用实际来源。
- 技能菜单和聊天历史统一显示 **PPT Master**。补交网页资料后，可以从原对话打开交付的 PowerPoint 文件。

## 任务续接

- 较长的工具输入使用简短的记录摘要，审批和实际执行仍使用完整参数。旧版保存的超长摘要也能读回。
- 会话执行问题在原对话正文内显示，技术详情默认折叠。
- 开放式问题可用原对话的输入框回答，问答保存在对话正文里。等待回答时可以暂停，暂停期间问题仍以只读方式显示。继续后系统重新询问，已保存的补充信息会用于原任务。
- 文件写入或修改需要授权时，对话中的确认卡会说明操作、工作区内目标和影响，技术详情保持折叠。

## 内置组件与技能更新

- Univer Sheets 固定为 `1.6.1`，AG-UI 核心协议固定为 `1.0.5`。PPTX 预览器升级到 `3.80.0`，连同其 MPL-2.0 字体解压组件 `mtx-decompressor 1.9.0` 一并校验来源和许可证。KaTeX 升级到 `0.19.1`，微信适配器升级到 `2.4.10`。
- 本地文档提取更新到 MarkItDown `0.1.9`，覆盖 PDF、DOCX、PPTX 和 XLSX。PDF.js 更新到 `6.5.438`，用于 PDF 预览和文字搜索。
- 网页与文档工具更新到 BrowserSkill CLI/扩展 `0.5.0`、Playwright MCP `0.0.86`、Playwright CLI `0.1.25`、Docling MCP `3.5.1`。Superpowers 使用已审计的 `v7.0.2` 提交；Video Shotcraft 更新到提交 `59f3e9b9e936ff2bce0e18446226d770a3f2f61f`，分发包保留 Apache-2.0 代码及署名记录，不包含上游演示媒体。Humanizer-zh 和「说人话」分别按已审计的 MIT 来源快照更新。
- i18next、Hono 和 `@hono/node-server` 分别固定到 `26.7.2`、`4.13.21` 和 `2.1.11`，修复已知生产依赖中危项；保持现有 React 绑定兼容范围。
- PPT Master `6.10.0` 需要 AGPL/商业许可路径且与当前 KUN 运行时不兼容，因此保留现有经审计版本。KUN 上游新版本采用 PolyForm Noncommercial，不并入 MIT 发行。Ego Lite 是独立安装的浏览器，不随 RailWise 重打包。

[验收台账](../docs/qa/release-gates/v0.5.11/acceptance.md)
