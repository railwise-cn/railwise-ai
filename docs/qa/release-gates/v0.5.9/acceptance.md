# RailWise AI 0.5.9 发布验收

验收采用受保护主分支提交 `389ee737a62cf4b889d5cb1958402e84911c5725` 的同一批安装包。安装包、更新文件和应用程序的摘要见[安装包回执](installed-package.json)。 [精确制品构建](https://github.com/railwise-cn/railwise-ai/actions/runs/44493773337) · [源代码质量检查](https://github.com/railwise-cn/railwise-ai/actions/runs/44493700586) · [本版更新说明](../../../../release/release-v0.5.9.md)

## 安装、启动和布局

| 平台 | 安装包大小（字节） | 安装检查 |
|---|---:|---|
| Windows x64 | 320,871,735 | 已从安装包读回 0.5.9，验证开始菜单和桌面快捷方式。安装器和应用程序的 Authenticode 状态均为 `NotSigned`。 |
| macOS Apple Silicon | 402,395,197 | 已从安装包读回 0.5.9 和 arm64，签名及公证票据验证通过。 |
| macOS Intel | 411,136,357 | 已从安装包读回 0.5.9 和 x86_64，签名及公证票据验证通过。 |

Windows 的英文浅色 100% 和中文深色 125% 启动检查均读到了「基于本地优先架构的智能协同工作台」和启动进度，版本行已去掉。中文深色图取自该次安装包冷启动。外层通用检查随后在技能目录路径断言处结束，截图和启动回执各自记录了通过结果。两种 Mac 安装包均验证了英文浅色和中文深色的启动界面。 [Windows 启动回执](https://github.com/railwise-cn/railwise-ai/actions/runs/44499648407) · [macOS 双架构验收](https://github.com/railwise-cn/railwise-ai/actions/runs/44506084478) · [软著启动截图](windows-startup-zh-dark.png)

同一源码的隔离生产界面在中文浅色、110% 缩放下检查了三个尺寸。960 × 640 使用两侧抽屉，1160 × 720 展开左栏，1460 × 840 同时显示左栏和 HTML 预览。菜单和面板检查通过。曾观察到预览刚改变尺寸时一次焦点移入预览，布局稳定后复测通过。 [界面回执](packaged-ui.json)

## 附件、技能和任务

- Windows 用 Explorer 文件格式粘贴约 40 MiB 的合成扫描 PDF、用选择器导入中文文字 PDF，并拖入后移除损坏的 PDF。两次只附 PDF 的发送经过本地验收模型检查。扫描原件保留并携带文字缺失说明，文字版携带实际提取结果。组合运行随后在隐私参数断言处失败。专门的技能和插件复测验证了参数脱敏及完整读取结果。 [附件阶段](https://github.com/railwise-cn/railwise-ai/actions/runs/44507640970) · [技能和插件复测](https://github.com/railwise-cn/railwise-ai/actions/runs/44509645877)
- 两种 Mac 安装包均实际接收 Finder 格式的文件粘贴。测试 PDF 显示「文字提取受限」，原件保留。英文和中文启动及这次粘贴使用隔离配置。 [Finder 粘贴](https://github.com/railwise-cn/railwise-ai/actions/runs/44506084478)
- 在 Windows 从「＋」分别选择 Video Shotcraft 技能和插件。两个回合都实际调用 `read_skill_resource`，KUN 留存的 24,312 字节结果与睿威镜像的 SHA-256 一致。本地验收模型读到了经过上下文压缩的 12,730 字节内容。草稿、计划模式、目标面板、能力有效期复核，以及执行详情折叠和重试恢复，覆盖在专项自动化测试中。 [功能回执](functional-checklist.json)
- 合成任务保存并核验 HTML，自动预览和手动打开正常。每日计划以北京时间 08:30、16:30 创建并读回。实钟到期验证生成了独立任务及成果，随后恢复每日计划。 [HTML 与计划回归](https://github.com/railwise-cn/railwise-ai/actions/runs/44502140362)

## 原地升级

Windows 两台隔离验收机分别用正式 0.5.8，从左下角升级按钮和设置页「重启安装」原地升级到同一份 0.5.9 安装包。已读回目标版本、原会话和设置中的原工作区路径，并核对用户配置目录中的独立验收标记。测试使用私有 HTTPS 更新源。 [Windows 回执](windows-updater.json) · [两入口原生升级](https://github.com/railwise-cn/railwise-ai/actions/runs/44500367698)

macOS Apple Silicon 使用固定摘要的官方 0.5.6 基线，经临时 HTTPS 源自动升级至 0.5.9。升级后的 ASAR 与本版 Apple Silicon 安装和启动验收一致。重启后通过历史工程数据和配置引用的读回检查，并通过签名、公证与 Gatekeeper 校验。 [macOS 原生升级](https://github.com/railwise-cn/railwise-ai/actions/runs/44516406751) · [升级验收摘要](updater-acceptance.json)
