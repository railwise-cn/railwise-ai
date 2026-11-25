# 说人话来源与兼容说明

- 官方仓库：<https://github.com/MrGeDiao/shuorenhua>
- 最新正式版：[`v2.7.1`](https://github.com/MrGeDiao/shuorenhua/releases/tag/v2.7.1)
- 审计提交：`709acdd71ea841186b6bcd75f8f40849474ea4ba`，标签解析后的提交与当前官方 HEAD 一致。
- 上游运行目录：`skills/shuorenhua/`。
- 同步文件：`SKILL.md`、`references/editing-guide.md`、`references/examples.md`、`references/revision.md`；根目录 `LICENSE` 内容核对一致。逐文件上游 SHA-256 记录在 `.workwise-skill-source.json`。
- 许可：[MIT](../LICENSE)，原版权声明保留。

## RailWise 适配

主规则增加「RailWise 编辑约束」：修订清单中有歧义的解读仍可作为建议列出，但正文、定稿与文件写回必须等待用户明确选择；不能把候选解读当作已核验事实。此项优先于上游修订模式允许直接猜测替换的规则，保留原有“不新增事实”的产品约束。审阅与补资料在原对话中处理。

旧 `references/`、安装和评测文档保留用于历史链接兼容；未链接的旧规则不覆盖本次运行文件。没有新增运行时、网络安装、自动更新或默认权限。

## 已安装副本

旧来源身份 `MrGeDiao/shuorenhua`、空路径、`main` 保留，确切上游快照和新的官方目录分别记录为 `installedSha` 与 `upstreamPath`。这样内置更新仍可识别旧副本，不因上游目录搬迁把它认成另一来源。技能 ID、启用范围、配置和用户数据继续沿用原身份；自动第三方更新保持关闭。

本次新增可撤销修订稿、繁体与方言边界和承诺语义保护，默认来源不明的论断保留归属并提示缺口。上游对部分模型仍记录了语义误改限制，不能把结构检查或上游结果当作 RailWise 模型效果验收。
