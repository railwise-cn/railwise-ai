# RailWise AI 0.5.1 / #161 最终候选复验

日期：2026-09-27；源码：`5e49d220928c300ac4f1c6d5a6ff5fd35c0aa492`。

**状态：失败，不能发布。** 已安装并通过签名、公证、主题及选定窗口检查；真实模型抄用了历史工具参数中的 `_workwise_summary`，使有效typed引用被拒绝。后续源码 `8d68df67` 修复历史消息组装，不能倒填本包通过。

## 实际安装与失败证据

2026-09-27 21:05左右安装至 `/Applications/RailWise AI.app`，普通入口启动成功。DMG SHA256 `8b12b5e7b83b56a1f39b5c144193083ce7ba80dfc55ba188bddb914d4e265bda`；安装/DMG ASAR均 `395437bb3792154721af8522f74154c12ecaec3c5d44b806767a72ad992bffd9`。deep strict签名、公证和5个可执行文件V8权限通过，原资料保留。身份见 `local-package-identity.json`，图01–11覆盖system/浅色/深色、1280×840/960×640/1920×985逻辑窗口，图12重新定位原始记录8。最终恢复system。

自动legacy追问 `turn_mca8w4ot` 正确选择 `survey_read_context`，第一次因 `_workwise_summary` 未知参数失败，自动重试精确读取成功，见 `automatic-legacy-readback.json`。真正typed原始点位追问 `turn_avxzut0x` 两次 `survey_read_evidence` 返回invalid-reference，context回退也先因同一字段失败后成功；见 `automatic-typed-readback.json`。这不是数据变更或引用过期，模型的“已失效”解释不成立。sourceSha256与计算inputHash语义不同，不能直接比较判定过期。

根因：持久化保护把参数清空，模型适配器却将安全摘要填为合成 `_workwise_summary` 参数，形成错误的历史调用示例。后续修复将摘要放进历史结果说明，明确原参数已隐去、须根据当前请求/schema重建，保留真实调用参数和执行侧严格校验。回归先红后绿；本包不包含此修复。21:42检查未新增崩溃，8787/8788为同一PID；本包未完成最终退出/重启，后续最终包单独验证。

本轮续接用户报告的安装后启动崩溃、未跟随系统深色及最终包验收。已完成两项源码修复：`9a7cd6c3` 为Survey类型化证据工具补显式object schema根，解决真实模型HTTP400；`5e49d220` 为旧版精确引用补明确的context读取路由，避免被误发到typed接口。两次旧包失败记录分别在 [#156](../railwise-051-final-f518878/README.md) 和 [#158](../railwise-051-final-9a7cd6c/README.md)。

## 源码与真实预验证

- 工具schema回归先红后绿，保持原17分支；Runtime2945通过/22跳过。
- legacy路由回归先红后绿；17项针对性和桌面全量2870通过/2跳过，双端类型、构建、改动文件ESLint、OpenSpec strict11项通过。测试需允许localhost监听，沙箱EPERM不能当代码缺陷。
- 在#158实际GUI中手工添加相同路由指令后，真实DeepSeek调用仅有 `survey_read_context`，精确S1读取成功；此项仅为提示验证，不能代替#161自动composer/安装包验收。模型说明中仍出现sourceSha256与计算inputHash直接比较的错误推断；两种哈希语义不同，数值和来源均以Runtime及原件核验为准。

- #158真实typed原始点位读取也已成功：`survey_read_evidence` 返回resolved，并保持network revision2 / unknownPoints[0] / S1身份。详见旧包03证据，后续仍需在本包复验。

## 工件

- 私有三客户端候选#161：Actions `36319278350`。
- 同源码隔离真实updater #160：Actions `36319276156`。
- 版本仍为0.5.1，未改变公开版本、tag、Release、公共feed或官网下载。

## 同源码真实私有updater通过

#160报告见 `updater/`。0.0.0 → 0.5.1，实际完成 base_started → update_available → download_completed → install_requested → target_relaunched → user_data_preserved。签名、公证及开启的Gatekeeper通过，数据哨兵保留，清理完成。目标/安装后ASAR均 `c4dc4004766d9d5397a1fb42e46c92494b14a1abb6db4c93762d1624c8556ec7`；ZIP SHA256 `b39be3b0593d7d8f845ef46de3cd3e0ea380664a5b23769a0b27d82b2b0a5739`。1次manifest、1次ZIP，303009173字节。

这是同源码、独立bundle的更新探针，非历史资料迁移；不宣称与#161正式身份候选为相同二进制。productionTouched、publicFeedUploaded、systemTrustModified、browserOpened均false。报告frontier仅为本地回环测试标签，没有推进公共frontier。

## 验收范围

检查最终安装包版本、签名公证、Electron/V8权限、正常启动/退出/重启、系统/浅色/深色、常规/最大/最小窗口、旧用户内容保留、合成IN2计算和原始记录定位、自动成果追问真实工具调用。私有updater核对真实下载/安装/重启/数据保留六阶段、目标与安装后身份及生产隔离。

限定合成样例不代替仪器、生产和专业签认，也不完成[总计划P1/P2](../../RAILWISE_SURVEY_REMAINING_WORK.md)。本机Gatekeeper原先关闭且未改动；已开启Gatekeeper的hosted runner结果须另行记录。最终仍须用户本人确认精确包UI与功能；任何发布操作须另获明确版本/动作批准。
