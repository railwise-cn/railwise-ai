# RailWise AI 0.5.1 发布验收

版本：`0.5.1`；不可变标签：`v0.5.1`；发布提交：`4bcc09fee46dfa4231a0b53905ffa2068c3f88c1`。

应用源码为 `20aead04af10d72cf1e33c1b61c7b81306ff05a6`。之后的 `33c21781` 仅修改发布说明和官网品牌校验；PR #28 的合并树与该准备提交一致。公开发布已获得本版本授权。

## 发布与检查记录

- [PR #28](https://github.com/railwise-cn/railwise-ai/pull/28) 已合并。
- [最终 PR Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/36355077428) 和 [push Quality](https://github.com/railwise-cn/railwise-ai/actions/runs/36355073639) 全部通过，包含 Windows 与 Electron smoke。
- [最终三端候选 #166](https://github.com/railwise-cn/railwise-ai/actions/runs/36343000275) 完整两小时稳定检查、三个文档解析组件、Windows、macOS Intel/arm64、三客户端与最终 DMG 验证全部通过。
- [同源码私有 updater #165](https://github.com/railwise-cn/railwise-ai/actions/runs/36342879401) 完成真实六阶段往返：基线启动、发现更新、下载、请求安装、目标重启、数据保留。签名、公证和启用的 Gatekeeper 检查通过。
- [正式 stable 构建](https://github.com/railwise-cn/railwise-ai/actions/runs/36355577889) 已成功重新构建官方更新源安装包，完成 stable 更新源校验并公开 [GitHub Release](https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.1)。`skip_stability=true` 仅复用上面的同应用源码完整稳定证据；标签自动触发的重复等待已取消。未将私有 feed 的候选二进制推广为 stable。

## 本机最终包验收

#166 的 arm64 包安装为正式应用身份，版本 0.5.1，Developer ID / Team `R35G7F4A9U`。深度严格签名、stapled 公证、5 个 Electron/V8 运行权限均通过。本机 Gatekeeper 原为 disabled，未修改；不将 override 结果当作启用策略检查，独立启用证据来自 #165。

全部 454 个 renderer 文件与已确认界面逐一相同。最终包浅色/深色常规和最大窗口实看，最小窗口沿用已确认且字节相同的界面证据；本轮无效的缩窗拖拽不计为通过。结束时恢复跟随系统主题和常规窗口。截图来源见[清单](../../website/products/screenshots/workwise/release-051-screenshots.json)。

| 项目 | 实际结果 |
| --- | --- |
| 公开合成 IN2 导入、校核、平差 | 4 点、1 测站、5 观测；S1 平差坐标 `(49.99999999284098, 49.999999963710295)` m。 |
| 首次真实模型结果追问 | 两次成功 `survey_read_context`；方差 `1.1387e-8` 约低 8 个数量级，标准差尺度约低 4 个数量级。 |
| 重启后原始点追问 | 一次 `survey_read_evidence` resolved，精确绑定 S1、unknownPoints[0]、项目与网络 rev2 及来源摘要；回答区分本轮原始点记录与此前平差上下文。 |
| 数据保全 | 安装前后 9 库一致；有意生成成果后新建基线，正常退出、重启、只读问答后的 9 库逻辑摘要一致，无新增、删除或修改。 |
| DOCX/PDF/XLSX | GUI 实际生成，文件哈希与界面一致；两页 PDF 渲染可读，DOCX 可解析，XLSX 15 张工作表，坐标、方差、标准差与确定性结果一致。 |
| 恢复行为 | 重启初始进入编程概览，点击内业后工程和历史恢复，Runtime 在线；未声称自动恢复顶层视图或临时预览列表。 |

只使用仓库公开合成夹具，没有重放历史私有会话。真实问答使用已有显式模型 `deepseek-v4-pro`，不把它当作默认 `deepseek-flash` 的全路径验收。保存的工具参数因隐私机制清空，不将其当作原始实参证据。

## 范围

本轮完成发布所需的限定回归；完整 P1/P2、跨功能/全键盘矩阵、真实仪器互操作、生产总体、历史版本真实数据迁移和专业人员签认仍有独立边界。隔离 0.0.0 → 0.5.1 updater 探针不是 #166 的同一二进制，也不是历史 0.5.0 用户数据迁移认证。生成成果保持未归档待审查，不自动授予工程批准。

## 正式下载核验

发布工作流已完整下载三端官方文件并逐项核对字节数、SHA-256 和 Range。本机另完整下载 Apple Silicon 包验证 SHA-256，对 Intel 与 Windows 复核 Range/总字节数；不把后两项写成本机完整下载。stable feed 为 0.5.1，本机回装结果另列于下方。

| 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [WorkWise-0.5.1-mac-Apple-Silicon.dmg](https://www.railwise.cn/downloads/workwise/channels/stable/releases/v0.5.1/WorkWise-0.5.1-mac-Apple-Silicon.dmg) | 295034092 | `81c6d25ae853cf29a4271911cb4dc8333a09bde2e80c89dab5f06d9d23e2fe9a` |
| [WorkWise-0.5.1-mac-Intel.dmg](https://www.railwise.cn/downloads/workwise/channels/stable/releases/v0.5.1/WorkWise-0.5.1-mac-Intel.dmg) | 299835593 | `9c4d575a3194944de5be9f740a1e1eb9048c0f1251b638d1a0c73ccf431d9e6d` |
| [WorkWise-0.5.1-win-x64.exe](https://www.railwise.cn/downloads/workwise/channels/stable/releases/v0.5.1/WorkWise-0.5.1-win-x64.exe) | 246825029 | `79dad522af4fb2c462e99bed83ffeb54f567a23802f7b20cb7f43cebe63dac2c` |

## 官方安装包本机回装

2026-09-28 07:35（北京时间）从官网下载的正式 Apple Silicon DMG 回装至 `/Applications/RailWise AI.app`。旧候选应用保留为独立备份；安装前、正常退出后、回装后和启动后，9 个工程数据库的逻辑 SHA-256 均一致。

- 安装版本为 `0.5.1`，arm64，保留[迁移矩阵](../railwise-ai-migration-matrix.md)中的兼容 bundle ID，Team `R35G7F4A9U`；深度严格签名、stapled 公证和 5 个 Electron/V8 运行权限检查通过。主机原有 Gatekeeper 状态未变。
- 官方 ASAR SHA-256 为 `8992d72a1b4bbe624145729447bafaedb2cad696c165c7a58c3d3126f74d1028`。与最终候选逐项比较 17,330 个打包条目，唯一文件差异是 `package.json` 的 `updateChannel` 从 `frontier` 改为 `stable`；454 个 renderer 文件及 4 个重点 Runtime 模块与已验收内容相同。原生解包二进制不包含在此 ASAR 比较中。
- 正常启动后点击“内业”，公开合成项目、4 条历史消息与平差记录恢复，Runtime 在线。保留跟随系统主题和常规窗口。
- 正式配置指向 `https://www.railwise.cn/downloads/workwise/channels/stable/latest/`；在设置中手动检查更新，界面显示“已是最新版本：0.5.1”。此检查与此前真实 updater 往返各自记录，不混作同一次测试。
- GitHub Release 于北京时间 2026-09-28 07:34:53 公开，非草稿、非预发布；三个安装附件的字节数与 GitHub SHA-256 digest 均与上表一致。
