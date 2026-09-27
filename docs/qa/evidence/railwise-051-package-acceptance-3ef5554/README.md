# RAILWISE AI 0.5.1 本机候选包验收

- 源码：`3ef5554dbf76d0a6cde3839bd3bd9c37a8d6ce1f`
- 包版本：`0.5.1`
- 包：`WorkWise-Candidate-3ef5554dbf76-0.5.1-mac-arm64.zip`
- ZIP SHA-256：`417c250c5565daa22b010331a78d123b7138e7bbb0ce31092e10aa2ff1d882a6`
- 安装后 ASAR SHA-256：`60160e484802d2f8fd4608b6eef8fe14c214f698c6ef0ac7f6892e0209314484`
- Bundle ID：`com.wangjiawei508.workwise.candidate.head3ef5554dbf76`
- 本机安装目录：`/private/tmp/railwise-051-3ef5554/Applications/RAILWISE AI Candidate 3ef5554dbf76.app`

## 签名与更新

GitHub Actions 私有验收 [36219833698](https://github.com/railwise-cn/railwise-ai/actions/runs/36219833698) 通过：Developer ID 签名、公证票据、启用 Gatekeeper 的云端检查、真实 loopback HTTPS 下载、Squirrel 重启升级和隔离数据哨兵均通过；同源基线为 `0.0.0`，不等同于历史用户数据迁移。`codesign --verify --deep --strict`、`xcrun stapler validate` 和本机包哈希核对通过。本机 `spctl` 原状态为 security disabled，不能作为启用 Gatekeeper 证据。

## 功能和界面

同一安装包自身 Electron/Runtime 完成的合成审计通过，证据目录为本机临时路径 `/private/tmp/railwise-051-3ef5554/audit/service-001/`：确定性工程测量网络和平差、CSV 导入与分析、DOCX/PDF/XLSX 成果、质量整改四事件链、严格幂等与篡改拒绝、服务重启精确读回、原有业务行和文件字节不变均通过。隔离 GUI 种子 `/private/tmp/railwise-051-3ef5554/audit/gui-seed-001/` 也通过。

使用 Computer Use 实际启动了安装包并检查：

- 中文浅色首页：显示 `RAILWISE AI`、`编程 / 内业`、本地用量区和新版 RAILWISE 图标；首页不再使用深色英文截图。
- 深色 Survey 页面：显示 `RAILWISE Survey`、`工程测量内业`、任务卡、`项目配置 / 数据资产 / 质量检查 / 测量来源与预检` 四阶段入口及 Survey AI 区域。
- 设置页显示 DeepSeek 默认模型列表包含 `deepseek-flash`，并保留显式模型配置入口。

上述截图已在本次 Computer Use 验收界面实际显示；当前未把临时运行截图冒充为仓库静态截图。Windows Explorer 图标和完整键盘/窄窗矩阵仍需单独设备验收。

## 仍未闭合的发布门禁

真实模型对话未使用或复制任何 API Key；历史候选真实 GUI 请求曾因上游 `401 Authentication Fails (governor)` 失败，因此不能声称包内 AI 读回已通过。完整专业签认、生产指标认证和用户本人对精确安装包的确认也未由自动测试代替。

本记录是 0.5.1 候选验收，不创建 tag、不发布 GitHub Release、不更新 stable/frontier feed，也不更新官网正式下载元数据。
