# DeepSeek Harness 历史接入记录（0.4.0—0.4.2）

本文只记录 WorkWise 0.4.0 至 0.4.2 实际接入并验证的内容。`DeepSeek Harness` 是上游项目名称；本文不把上游仓库的全部能力、最新变更或官方模型能力自动归入 WorkWise。

当前默认与自动模式使用 DeepSeek V4.1 Flash（官方 API ID `deepseek-flash`），支持文本、图片和工具调用；明确保存的其他模型配置保持原样。以下 0.4.0–0.4.2 内容保留为当时实现和验证的历史记录。

## 0.4.0 使用的内容

WorkWise Runtime 使用自己的 DeepSeek 兼容模型适配器、结构化附件合约和 Agent Loop：

- 默认模型配置包含 `deepseek-v4-pro`、`deepseek-v4-flash`；`deepseek-v4-flash-vision-exp` 配置声明支持 `text` 与 `image` 输入。
- 附件先通过 `attachmentIds` 进入 Runtime，不把图片直接写入线程 JSONL。模型请求根据能力构造结构化 `text` 和 `image_url` 消息部分。
- 文本模型不能直接接收图片时，Runtime 调用配置的 `VisionEvidencePort`。本机回环分析器返回 OCR、布局、语义、视觉摘要和不确定性字段，再以不可信证据注入模型上下文。
- 视觉证据分析使用缓存、并发请求共享、超时、取消、图片大小/MIME 校验和回环地址校验。分析器不可用、超时、返回无效数据或失败时，本回合进入明确的 `attachment_analysis_unavailable` 失败终态。
- 视觉证据被标记为不可信资料，只能帮助回答用户问题，不能覆盖系统指令、授权工具或审批边界。

## 0.4.2 增加的内容

- 桌面端和 Runtime 支持 JPEG、PNG、GIF、WebP 图片导入，并按真实内容签名识别格式；只为仍使用历史默认图片白名单的配置增加 GIF，自定义白名单保持原样。
- 图片回合使用 `auto` 时，桌面端只接受三种可用性证据：当前配置使用 DeepSeek 官方地址、当前 Provider 显式配置 `deepseek-v4-flash-vision-exp`，或当前 Provider 的模型发现结果包含该模型。选择只覆盖当前回合，不写回 Provider 或持久化模型设置。
- 未确认模型可用或读取模型设置失败时，请求不会发送，编辑器中的文字和附件保持原样并显示错误。手动选模和 PDF/Office 文档解析链不变。
- WorkWise 的模型适配器已通过自动化测试验证 Chat Completions 的 `image_url`、Responses 的 `input_image` 和 Anthropic Messages 的 base64 image block；这些测试证明 WorkWise 能按已配置协议生成请求，不表示 DeepSeek 官方 API 默认开放全部三种协议。
- 隔离候选包已使用配置明确包含该模型的第三方 Provider 完成真实 GIF 问答。该结果验证了本次 WorkWise 链路，不应写成 DeepSeek 官方服务或所有第三方服务都已支持。

## 两种数据边界

“不把图片退回为 Base64”只针对模型提示和模型请求：

1. 发送给支持图片的模型时，WorkWise 使用结构化图片消息部分，不把图片拼进普通文本。
2. 发送给文本模型时，WorkWise 发送结构化 OCR、布局、语义和视觉证据，不发送图片 Base64 文本。
3. 本机视觉分析器的内部 HTTP 输入可以使用 `dataBase64` 传输图片字节。这是受回环地址、大小和 MIME 校验保护的本地传输格式，不是模型上下文，也不是对外宣传的模型能力。

## 当前没有宣称的内容

- 客户端没有把上游 DeepSeek Harness 仓库作为独立 npm 依赖或源码副本打包进安装包。
- 0.4.0 至 0.4.2 没有宣称自动获得上游项目的全部新功能，也没有把上游更新日期当作 WorkWise 版本能力。
- DeepSeek 官方文档、第三方兼容服务和用户账户的模型可用性、额度、计费与接口行为仍以对应服务为准。
- 0.4.2 已覆盖 Responses 和 Anthropic Messages 的结构化图片序列化测试，但没有把它们写成 DeepSeek 官方默认协议或任一 Provider 的默认路径；实际可用性仍取决于用户配置的服务。

## 实现与验收索引

- Runtime 入口与模型能力配置：[managed-runtime-process.ts](../src/main/managed-runtime-process.ts)
- `auto` 图片回合选择：[attachment-aware-model.ts](../src/renderer/src/lib/attachment-aware-model.ts)
- DeepSeek 兼容模型适配：[deepseek-compat-model-client.ts](../kun/src/adapters/model/deepseek-compat-model-client.ts)
- 附件分流与失败契约：[agent-loop.ts](../kun/src/loop/agent-loop.ts)
- 视觉证据合约：[vision-evidence.ts](../kun/src/contracts/vision-evidence.ts)
- 本机回环分析器客户端：[vision-evidence-service.ts](../kun/src/vision/vision-evidence-service.ts)
- 真实图片与 OCR 验收：[WORKWISE_REAL_VISION_OCR_ACCEPTANCE_2026-08-22.zh-CN.md](./qa/WORKWISE_REAL_VISION_OCR_ACCEPTANCE_2026-08-22.zh-CN.md)
- 计划完成审计：[WORKWISE_PLAN_COMPLETION_AUDIT_2026-08-19.zh-CN.md](./qa/WORKWISE_PLAN_COMPLETION_AUDIT_2026-08-19.zh-CN.md)

上游 DeepSeek Harness 的接口、代码和更新以其官方开源仓库及发布说明为准。WorkWise 只有在完成自身实现、测试和真实服务验收后，才会把对应能力加入产品介绍或稳定能力列表。
