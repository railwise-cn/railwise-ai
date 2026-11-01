# 真实模型 Write 服务集成验收

2026-11-01 执行生产 Write 请求构造器与 `requestWriteInlineCompletion` 服务，实际访问当前已配置的 `https://api.deepseek.com`，模型为 `deepseek-v4-pro`。没有替换 fetch、模型响应或服务边界。此记录是服务集成检查，**不是安装包 GUI 的端到端审阅验收**。

现有 API Key 仅从本机配置读入进程内存，未复制到证据、源码、命令参数或日志。生产配置未改动。检索和知识库均关闭，服务记录 `referenceCount: 0`；发送的内容只有脚本中明示的合成报告及改写指令，不读取真实项目正文。

## 最终结果

| 操作 | 实际耗时 | 结果 |
|---|---:|---|
| 选区正式改写，要求增加“监测结果：”前缀 | 1,854 ms | 成功返回不同于原文的提案，保持 5、2、2.1、3.0 与合成数据声明 |
| 根据完整合成文档生成摘要，追加到文末 | 1,098 ms | 成功返回摘要提案，保留 2.1 / 3.0 与合成数据声明 |

两次请求均保持原文磁盘 SHA-256 不变。拒绝提案的服务级模拟仍保留原文；用同一生产替换函数生成的接受预览只改变选定范围或文末追加区，不删除前后文。此处并未写入接受后的正文，也不能代替 GUI 中真正点击“接受/放弃”、基线变动保护或实际保存的验证。

首次改写返回了原文。初始实际响应保留在 `live-model-service-readback-initial.json`；最终脚本增加明确前缀要求及 `proposalChangesScope` 断言后重新调用，两个操作均产生真实差异，`live-model-service-readback.json` 的全部检查通过。只报告服务成功和数据保留，不将合成数据作为真实工程结论。

## 复验方法

脚本必须显式传入 `--real-provider`，并核对现有配置的 origin 与允许值相同。无需、也不应把 Key 作为参数传入：

```sh
node scripts/run-write-live-model-acceptance.mjs \
  --real-provider \
  --settings '/Users/wangjiawei/Library/Application Support/RailWise AI/workwise-settings.json' \
  --allow-origin https://api.deepseek.com \
  --output docs/qa/evidence/railwise-0.5.4-markdown-advanced-20261101/live-model-service-readback.json
```

脚本以 esbuild 打包现有 TS 服务和请求构造器到一次性临时目录；完成后删除该目录。`node --check` 与该脚本 ESLint 检查通过。输出只含合成输入/提案、来源 SHA、时长、是否修改配置和检查结果，不含凭据、HTTP headers、完整配置或任意远程错误正文。

下一步由主任务在最终隔离安装包中配置同一现有供应商，并通过真实界面验证生成、差异、拒绝、接受和保存；这部分必须另存具体包版本、截图及读回结果。
