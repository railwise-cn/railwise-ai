# RailWise AI 0.5.10 发布验收

## 本批制品

构建提交为 `822a8d748990432c0dbf87c3dea0e0538de849e0`。安装器和更新文件的字节数及 SHA-256 见[安装包回执](installed-package.json)。 [生产构建与原生验收](https://github.com/railwise-cn/railwise-ai/actions/runs/44989484932) · [必需 CI](https://github.com/railwise-cn/railwise-ai/actions/runs/44989474270)

- Windows x64 实际安装并启动中文工作台，核对 0.5.10、程序名称和安装身份。安装器与程序的 Authenticode 状态分别为 `NotSigned` 和 `NotSigned`。 [Windows 原始回执](windows-install-smoke.json)
- macOS Apple Silicon 和 Intel 从各自的签名 DMG 原样安装，验证版本、应用标识、Developer ID、公证附票、Gatekeeper 和中文启动画面。 [界面回执](packaged-ui.json)
- macOS Apple Silicon 从固定摘要的正式 0.5.9 经临时 HTTPS 源原地升级到 0.5.10，自动重新启动。升级后与签名 DMG 的工作台内容摘要一致，旧数据和设置按回执所列范围读回。 [升级回执](updater-acceptance.json)
- 同批 Windows x64 从正式 0.5.9 经隔离 HTTPS 分别使用左下角和设置页升级，均自动启动 0.5.10，原工作区、会话和设置通过读回，实装 ASAR 摘要与同批全新安装一致。 [双入口升级](https://github.com/railwise-cn/railwise-ai/actions/runs/44993394417)
- Apple Silicon 首次托管验收错过了短暂的中文启动画面，同一 DMG 复测通过。两种架构的冷启动截图已归档。 [实装复测](https://github.com/railwise-cn/railwise-ai/actions/runs/44993471086/attempts/2)

## 前序候选专项验收

以下项目记录各次实际安装的候选包，供核对功能范围和定位回归。

| 范围 | 已验证的操作 | 实际候选及回执 |
| --- | --- | --- |
| 原对话任务与权限 | 查看正文执行步骤、收到审批、一次确认后在原任务继续。连续断线后只恢复一张审批卡。 | `b40102b5` Windows [正文](https://github.com/railwise-cn/railwise-ai/actions/runs/44955658679)及[视频审批](https://github.com/railwise-cn/railwise-ai/actions/runs/44955659333)，`bd64956f` Apple Silicon 断线重连及授权回执。 |
| 技能和附件 | 工作区切换保留草稿、PDF 和所选技能；技能失效出现处置提示；移除后恢复发送。 | `588802b3` Windows [技能与草稿](https://github.com/railwise-cn/railwise-ai/actions/runs/44982796447) |
| 浏览器、HTML、计划和附件入口 | BrowserSkill 实际读取受控网页，HTML 成果核验和预览，定时到期触发，文件选择、拖放、剪贴板导入。 | `2b38a741` Windows [实装回执](https://github.com/railwise-cn/railwise-ai/actions/runs/44980084592) |
| 安装和原地升级 | 正式 0.5.9 经私有 HTTPS 使用左下角和设置页分别升级，读回原数据；Apple Silicon 用正式 0.5.9 和 0.5.7 基线通过原地升级。 | `588802b3` Windows [两个升级入口](https://github.com/railwise-cn/railwise-ai/actions/runs/44982637887)，`bd64956f` Apple Silicon [同批 0.5.9 升级](https://github.com/railwise-cn/railwise-ai/actions/runs/44972874897)及 0.5.7 升级回执。 |
| 中文扫描资料、成片和离线表格 | 已配置本机 OCR 的扫描件恢复正文和页码，Video Shotcraft 生成可解码 MP4，离线表格完成公式、撤销、CSV 导出和保存冲突检查。 | `bd64956f` Windows [视频实装](https://github.com/railwise-cn/railwise-ai/actions/runs/44974253967)及 Windows、macOS 原生验收回执。 |
| 国内安装链路 | 托管 Windows 屏蔽上游后冷缓存安装 21 项锁定包，Playwright MCP 读取受控网页。Superpowers 和 Blender 子技能实际安装及调用，Docling 转换合成中文 CSV。 | `b40102b5` Windows [镜像与 Playwright](https://github.com/railwise-cn/railwise-ai/actions/runs/44956264804) · [子技能和 Docling](https://github.com/railwise-cn/railwise-ai/actions/runs/44956264939) |

## 待复核的用户环境

- 已登录大单网的真实订阅采集与定时成报，仍缺完整回执。
- 大陆普通网络下实体 Windows 的冷缓存安装及调用，仍缺实测。已有测试覆盖托管 Windows、经校验的内置包、睿威镜像及受控网络。
- 用户报告的 Mac 0.5.7 当次升级失败，仍缺当次日志。隔离更新源的升级记录覆盖可复现的安装和数据保留步骤，历史故障原因待确认。
