# RailWise 版本与计划审计

日期：2026-10-04

## 版本基线

RailWise AI `0.5.1` 已经是公开发布版本，不是当前待发布版本：

- GitHub Release `v0.5.1`：非草稿、非预发布，已公开发布。
- stable feed 当前版本：`0.5.1`。
- 官网下载页当前显示：`0.5.1`。
- 官方 Apple Silicon DMG 可下载并与发布验收记录中的大小和 SHA-256 一致。
- 发布验收记录：`docs/qa/RAILWISE_0.5.1_RELEASE_ACCEPTANCE.md`。

当前工作树仍读取 `package.json` 版本 `0.5.1`，但 HEAD 已在 `v0.5.1` 发布提交之后，且包含未提交的 Survey 专业流程、简化 UI、专业文案和重连状态修复。当前 `dist/mac-arm64/RailWise AI.app` 是私有本地候选，不能代表已发布的 `0.5.1`，也不能覆盖官方安装包的发布证据。

因此，后续若把这些发布后的改动对外发布，目标版本应规划为 `0.5.2`。本轮没有修改公开版本、Git tag、GitHub Release、stable feed 或官网；在取得明确的 `0.5.2` 发布批准前，不执行版本提升和公开发布操作。

## 计划状态

以 OpenSpec 台账为准：

- `survey-professional-workflow`：17/19，未完成 `4.2` 当前源精确候选的 Computer Use 与独立 AI 复核、`4.4` 授权厂商/SUC 对算和真实角色专业签认。
- `workwise-0-5-0-engineering-delivery`：95/126，仍有 31 项未完成。剩余项包括当前目标包全流程验收、真实格式与厂商互操作、P1 质量与高级算法生产接线、P2 设备/空间能力、跨模块协作、生产指标和专业签认。

已完成的源码和定向验证不能把上述外部证据或精确候选门禁标记为完成。当前重连状态修复的 `EngineeringWorkspaceView.dom.test.ts` 64 项通过，专业 UI 定向测试、构建、ASAR 完整性、品牌边界和 OpenSpec 严格校验也已通过；但当前候选的完整主题、语言、窗口尺寸、可访问性、隔离来源恢复和 updater 往返证据仍未齐全。

本轮追加的公开格式与映射验证：Survey 格式注册、原生格式 golden/negative、专业 fixture manifest 共 206 项通过；质量工作流和专业报告的 19 项测试受宿主 Node ABI 147 与 `better-sqlite3` ABI 148 不匹配阻断，未将环境失败写成产品通过。

## 当前验收结论

本轮可确认：

- 用户界面和 AI 回答中的开发内部术语过滤已在当前源码及私有候选的中文、深色、宽窗口范围内复核。
- Runtime 重连空摘要导致“结果已生成”与“当前来源尚未导入”不一致的问题已修复并有回归测试。
- 0.5.1 的公开发布事实已经核对，后续不会再次以 0.5.1 名义发布新的工作树内容。

本轮仍不能确认：

- 当前工作树已满足 `survey-professional-workflow` 的 4.2 完整包验收；
- 真实授权 COSA/SUC 对算、真实仪器格式互操作或角色签认；
- `workwise-0-5-0-engineering-delivery` 的 31 个剩余门禁；
- 任何 0.5.2 版本、tag、Release、stable feed 或官网更新。
