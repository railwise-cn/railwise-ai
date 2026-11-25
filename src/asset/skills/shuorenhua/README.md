# 说人话 · RailWise 内置版

编辑用户已有的中英文文字，让表达直接、自然，保留事实、术语、责任主体和作者语气。正常文字可以原样保留；不判断作者身份或输出 AI 含量。

在当前对话选择「说人话」技能或点名 `shuorenhua`，然后贴原文并说明要求。默认交改写全文；「只标问题，不改写」交审稿意见；「写平实点」允许降低无内容的夸饰；「修订稿，逐条列出改动让我选」交可撤销建议。

运行文件来自官方 [v2.7.1](https://github.com/MrGeDiao/shuorenhua/tree/709acdd71ea841186b6bcd75f8f40849474ea4ba)，提交 `709acdd71ea841186b6bcd75f8f40849474ea4ba`：

- [主规则](SKILL.md)
- [编辑边界](references/editing-guide.md)
- [改写对照](references/examples.md)
- [修订模式](references/revision.md)

RailWise 增补保真约束：有歧义的解读只列为建议，原文在修订稿正文中保留；用户明确选择后才纳入定稿或写回文件。补资料和文稿审阅留在原对话，不另建任务或执行审批。

随包保留 [MIT License](LICENSE) 和旧参考材料，来源、适配和已安装副本兼容说明见 [上游记录](references/upstream.md)。RailWise 通过安装包提供当前规则，无需运行第三方安装命令，自动第三方更新关闭。旧的参考、安装和评测文档保留供历史链接读取，当前行为以 `SKILL.md` 及其链接的三个参考文件为准。

完整官方说明和上游模型测试限制见 [官方 README](https://github.com/MrGeDiao/shuorenhua/tree/709acdd71ea841186b6bcd75f8f40849474ea4ba/README.md)；这些上游测试数字不代表 RailWise 已完成真实模型验收。
