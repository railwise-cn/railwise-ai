# RailWise AI 0.5.8 候选包验收

以下结果对应受保护主分支提交 `bd0e81af6bae82454b5f3c79423532f8cfe0f21f`。安装包与更新文件的原始 SHA-256、大小和应用身份记录在 [安装包回执](installed-package.json)。 [私有安装包构建](https://github.com/railwise-cn/railwise-ai/actions/runs/44315356926) · [源代码质量检查](https://github.com/railwise-cn/railwise-ai/actions/runs/44315252981)

[完整更新说明](../../../../release/release-v0.5.8.md)

## 三种安装包与离线表格

| 安装包 | 大小（字节） | 表格首次打开 |
|---|---:|---:|
| `RailWise-AI-0.5.8-win-x64.exe` | 320,835,129 | 1.171 秒 |
| `RailWise-AI-0.5.8-mac-arm64.dmg` | 402,354,432 | 3.083 秒 |
| `RailWise-AI-0.5.8-mac-x64.dmg` | 411,164,396 | 2.544 秒 |

三个安装包均用中文界面，在渲染器断网条件下创建表格、导入中文 CSV、保存并重开双工作表、只读预览 Excel，并复核 Excel 原件摘要。首次打开计时取各验收机单次实测。 [Windows 表格](https://github.com/railwise-cn/railwise-ai/actions/runs/44318992550) · [macOS 双架构表格](https://github.com/railwise-cn/railwise-ai/actions/runs/44324683396)

macOS 两种架构均核对了签名和公证票据。Windows 安装器和应用程序的 Authenticode 状态均为 `NotSigned`。 [Windows 安装、身份与清理](https://github.com/railwise-cn/railwise-ai/actions/runs/44318714127)

## 会话、网页与计划

- 中文深色 Windows 界面验证了首次首页版本提示和关闭后重载的持久状态。在 1024 × 728 和 960 × 672 的视口验证智能体、模型菜单与窄窗导航。 [首页与会话](https://github.com/railwise-cn/railwise-ai/actions/runs/44318714127) · [菜单与导航](https://github.com/railwise-cn/railwise-ai/actions/runs/44318639996)
- 普通会话运行实际 KUN，模型输出由本地协议夹具提供。工具错误的详情默认折叠。切断本机事件流后按游标续传，断线前和期间的文本各出现一次。停止原回合后，同一会话的下一轮正常完成。 [断线、停止与继续](https://github.com/railwise-cn/railwise-ai/actions/runs/44318714127)
- 使用安装包中的 BrowserSkill 操作受控公开查询页，读取正文并核对六项字段，保存 HTML，验证自动预览和手动打开。普通任务及采集任务均读回北京时间 08:30、16:30 启动的计划，并验证独立到期任务与成果。 [BrowserSkill、来源和计划](https://github.com/railwise-cn/railwise-ai/actions/runs/44318639996) · [普通任务和成果](https://github.com/railwise-cn/railwise-ai/actions/runs/44318651410)

## 市场安装与成片

- 睿威官网的原生市场锁定 21 项 × 3 种平台。全部锁定的分发文件摘要与经验证的官网镜像字节一致。Windows x64 冷用户目录验证全部 21 项，测试网络通过 DNS 阻断 GitHub、npm、PyPI 等 15 个上游域名。 [Windows 全量冷安装](https://github.com/railwise-cn/railwise-ai/actions/runs/44318842386)
- 实际启动已安装的 Docling 并发现 19 个工具。Playwright MCP 访问受控网页并读回页面内容。 [Docling 和 Playwright](https://github.com/railwise-cn/railwise-ai/actions/runs/44318844145)
- 普通会话使用斜杠菜单选择 Video Shotcraft，读取安装的技能资源，经明确批准后运行私有非商业合成素材验收。使用单独配置的 Remotion 渲染并登记 H.264 MP4，另用锁定版本的 FFmpeg 做完整解码验证。 [Video Shotcraft 成片](https://github.com/railwise-cn/railwise-ai/actions/runs/44318848495)
- 在当前 Mac 上关闭代理并用直连 HTTPS 下载了 Windows x64 的全部 51 个锁定文件，核对 362,292,684 字节及 SHA-256。Cloudflare 网络定位为中国。国内普通网络上的实体 Windows 实装仍待独立复核。 [功能回执](functional-checklist.json)

## 旧版升级与数据读回

- Windows 0.5.7 测试复现了原版重启安装失败。用最终 0.5.8 安装器直接覆盖原位置后，已保存会话与应用配置仍可读取。在私有测试源上从 0.5.8 点击左下角升级到测试用 0.5.9，确认实际重启和数据保全。 [Windows 更新链路](https://github.com/railwise-cn/railwise-ai/actions/runs/44318842982)
- macOS Apple Silicon 使用已固定摘要的官方 0.5.6 作基线，自动升级到精确的 0.5.8。核对安装后应用 ASAR 与同架构离线表格验收一致，重新打开历史数据并校验配置。升级目标的签名、公证及 Gatekeeper 校验均通过。 [macOS 原生升级和数据读回](https://github.com/railwise-cn/railwise-ai/actions/runs/44328989342)
- 首次 macOS 验收在建立私有更新源时收到 Cloudflare Quick Tunnel HTTP 429。复测沿用同一安装包和更新文件。 [首次验收日志](https://github.com/railwise-cn/railwise-ai/actions/runs/44326685717)
