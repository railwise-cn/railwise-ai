# V4.1 默认模型官方搜索接线修复

**已纠正（2026-09-20）：** 本记录是历史模拟协议验证，不能作为当前能力声明。真实请求和最新官方文档证明 `deepseek-flash` 会忽略内置 `web_search`；后续源码已移除该 ID 的搜索资格。见[真实服务结果与纠正](../railwise-v41-live-20260920/README.md)。下文保留当时结论，以便追溯这一错误。

主默认模型 `deepseek-flash` 先前被官方 Responses 搜索白名单遗漏，导致实际 Runtime factory 不注册官方 web_search。生产修复仅在原白名单中加入该精确 ID，继续兼容 `deepseek-v4-flash` 和 `deepseek-v4-pro`；官方 HTTPS origin、凭据和不支持模型边界保持原样。

先在旧代码复现2项失败；修复后40项 provider、实际 factory/toolHost 与相邻工具回归通过。实际 factory 创建并调用 web_search 后，核对官方 Responses 地址、所选模型原 ID 及授权头；网络返回使用合成 fetch，未进行真实付费服务调用。双端集成状态以总台账为准，不能把协议验证当成真实模型验收。
