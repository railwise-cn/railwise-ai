# 6c3f5f691a32 安装包复验

2026-09-19；源码 `6c3f5f691a327928c24086f58d99daf722341e9e`，私有隔离候选，包内版本 0.5.0。包 SHA-256、项目修订、计划状态及成果哈希见 [acceptance.json](./acceptance.json)。此次源码之后新增的解析诊断译文不在本包内。

## 安装与 Runtime

- DMG 安装至 `/private/tmp/railwise-survey-6c3f5f6/Applications/`，独立 bundle ID、用户数据和工作区，未覆盖正式应用。
- Developer ID `codesign --verify --deep --strict` 通过。`stapler validate` 返回 65，无公证票据。Gatekeeper 返回 0 的原因为 `Unnotarized Developer ID / override=security disabled`，不能作为公证成功。
- 安装包内 Runtime 完成真实 GSI/IN2 导入、校核、平差、DOCX/PDF/XLSX 与待审查清单链路；两份独立数值参考比较通过。日志及真实工程资料仅留本地候选 evidence 目录。
- 上述真实格式检查由安装包 Runtime 执行，不能算作两条真实格式 GUI 验收。

## 本包 GUI 实测

- 英文日期输入显示 YYYY-MM-DD；2026-02-30 保存被拒绝，未改任务名称；合法闰日 2024-02-29 与结束日期 2024-03-01 成功持久化。
- GUI 创建“审批卡验收（合成数据）”并通过原生选取器导入仓库合成 IN2。退出后本地夹具使用安装包服务添加明确标记的修改建议和四步计划；`fixtureOnly=true`，`modelCalled=false`。
- GUI 确认改名后，侧栏、会话所属项目、任务选择器、摘要与 AI 标题同步为“审批卡已确认（合成数据）”，修订由 2 变为 3。历史会话标题原样保留。
- 审批旧修订计划时被拒绝，状态 stale；重新生成保留四个操作并绑定项目修订 3。英文会话显示完整英文系统回执，中文用户目标原样保留。
- 窄窗口质量校核后，Tab 将焦点移至“运行平差”，Space 成功执行，显示分析与精度。仅这一条键盘路径通过，不代表完整键盘/a11y 验收。
- GUI 生成 DOCX/PDF/XLSX 预览和 draft manifest；三份清单输出磁盘 SHA-256 与持久化清单一致。页面没有声称已批准交付。
- 英文深色常规窗口 1171×768；英文深色与中文浅色窄窗口 1090×768 已实际触发上下分栏；中文浅色最大化 1490×768 已查看。尺寸指 CUA 返回截图的像素尺寸。
- 重启后进入 Survey 能恢复合成任务、来源及审批夹具。启动主入口仍为 Code；未将此记录成自动恢复 Survey。

## 截图

所有图片均为本包实拍的合成资料，不含真实工程观测。

- [无效日期拒绝](./gui-invalid-date.jpg)
- [英文审批及改名](./gui-review-en-dark.jpg)
- [英文窄窗口](./gui-review-en-narrow.jpg)
- [中文浅色窄窗口](./gui-review-zh-narrow.jpg)
- [窄窗口键盘平差结果](./gui-keyboard-adjustment-zh-narrow.jpg)
- [中文浅色最大化成果审查](./gui-delivery-zh-maximized.jpg)

真实模型成功回合、双真实格式 GUI、全状态/键盘/a11y、Dock/托盘、真实旧用户资料、公证、私有 HTTPS updater 往返以及用户与专业确认仍未完成。设置页明确显示当前隔离候选未配置 API key。用户没有签认这些截图。
