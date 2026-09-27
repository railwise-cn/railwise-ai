# V4.1 真实适配器调用与搜索能力纠正

2026-09-20 使用本机已经配置的 DeepSeek 官方服务和现有凭据，通过编译后的产品 `DeepseekCompatModelClient` 发出最小合成请求。凭据只在内存用于对应的 `https://api.deepseek.com`，未复制进候选配置、写入报告或修改已有模型设置。这里是实际网络适配器检查，不是安装包 GUI、AgentLoop 审批或工程任务验收。

两次 `deepseek-flash` Chat Completions 请求均返回 HTTP 200、`stop` 和完整预期 `RAILWISE_V41_OK`，分别耗时 412 / 540 ms。不能继续把本机现有服务统称为未配置或认证失败；其他候选的历史 401 仍保留为当时结果。

随后 `capabilities-probe.mjs` 经纠正后的编译适配器另外完成三项真实 HTTP 200：JSON 精确字段匹配（561 ms）、单一声明函数名与参数匹配（463 ms）、结构化 PNG 图片的两蓝圆/一红方计数匹配（748 ms）。函数只验证模型返回的调用结构，没有执行工具，也不构成审批门禁验证。图片由脚本生成，只有合成几何图形；图像 SHA-256 随 `live-v41-capabilities.json` 保存。脚本首跑因多余括号在解析阶段失败，未发送请求，修正后这三项均通过。

两次 Responses 搜索请求均 HTTP 200，但没有可用引用，适配器正确拒绝。第二次诊断显示 `status: completed`，只有 reasoning/message 输出，没有 `web_search_call` 或引用。报告没有保存推理正文。搜索验收失败，不把 HTTP 200 当搜索成功。

当天核读 [DeepSeek 官方 Responses 文档](https://api-docs.deepseek.com/guides/responses_api)：

- `tools`: "Partially supported. function supported; other types ignored"。
- `web_search / file_search / code_interpreter / computer_use / mcp / other built-in tools`: "Ignored"。
- "Unsupported parameters are silently ignored and do not cause errors"。
- `model` 列当前列出 `deepseek-flash`。

因此撤回此前把 `deepseek-flash` 加入官方搜索白名单的错误变更：V4.1 不再注册这一内置搜索能力，尝试使用时返回 `provider_unavailable`。普通模型、function tools、网页抓取及用户另行配置的浏览器/MCP 不受此白名单变更影响。历史 V4 ID 路径暂保留兼容，但本记录不确认那些服务当前仍可用，也不自动切换模型。没有可用的独立搜索工具时，应如实报告搜索不可用。

`live-v41-adapters.json` 是首次结果；`live-v41-adapters-diagnosis.json` 保留第二次结构化诊断。`probe.mjs` 是第二次实际脚本来源，路径指向当时开发环境且只输出有限元数据；它不是无凭据可自动复跑的单元测试。它使用当时已编译、尚包含错误搜索白名单的适配器；后续修复后相同搜索在发请求前即被阻断。

纠正后的 provider、真实 Runtime factory/toolHost 和相邻 Web 工具共 41 项合成回归通过，包含默认 V4.1 不发网络请求且明确报不可用。旧 40 项模拟网络通过仅证明了自设协议，不能用来反驳实际服务和官方能力说明。完整精确包内的咨询、证据追问、修改建议、审批、工具与视觉流程仍待验收。
