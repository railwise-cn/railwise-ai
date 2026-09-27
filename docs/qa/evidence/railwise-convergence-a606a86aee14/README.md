# a606a86 统计检验族与 Huber 实机验收

本记录只覆盖 `a606a86aee144c1c12b4221bde4112e4df9312dd` 的 arm64 隔离 0.5.0 候选，整体 **partial**。不覆盖后续两历元参考、质量评分、静态追加工作区或 V4.1 官方搜索修复。没有公开发布，也没有用户本人/专业确认。

[私有构建与真实 updater](https://github.com/wangjiawei508/WorkWise/actions/runs/35477710134)成功。已从同一附件 HTTP Range 提取应用 ZIP（未重算完整外层附件摘要），其 SHA-256 与 updater 目标严格一致，随后 ditto 安装。本机 ASAR 与云端实际更新后 ASAR 一致，codesign 和 stapler 通过；本机 Gatekeeper 原本 disabled，未改变它，启用状态的检查来自 hosted macOS runner。同源 0.0.0→0.5.0 探针不等于旧用户迁移。

Computer Use 实际创建三条合成声明，核对固定尺度 Huber 的 1/3 解、平坦极小区间的初值 4/目标 18/未认证唯一性，以及四成员完整检验族的分母 4、成员 alpha 0.0125、正态/t/卡方自由度/尺度和完整临界区间。独立 stdlib/Fraction Python 读取真实包数据库复算三例通过，输入/原始 UTF-8/SQL 身份一致。

空输入及未确认时保存按钮禁用，勾选后 Tab/Return 保存成功；原生 macOS 保存面板取消不声称导出，实际保存的 Unicode 文件与数据库记录结构完全相同。完整退出和重启保留三条原 ID。UPDATE 首先被 append-only trigger 拒绝；仅为隔离合成损坏注入，在同一事务内短暂移除 UPDATE trigger 并恢复，再追加一个声明空白字节。真实 GUI 重验拒绝，坏历史标记不可恢复，正常 Huber 历史仍可恢复。最终原字节及 trigger 完整恢复，记录重验再次通过。

中文浅色和英文深色已查看并留图，窗口缩放动作已执行，但没有独立量得精确最小尺寸。发现统计族表格过度换行，源码另作最小列宽修复，须下一精确包确认。完整状态、无障碍与真人确认尚未闭合。验收结束恢复中文浅色。图片全部为合成软件验收数据，不冒充工程成果或官网正式版本。

文件索引：`package.json`、`private-updater.json`、`native-updater.redacted.json`、`zip-download.json`、`gui-acceptance.json`、`independent-gui-numerics.json`、`native-export.json`、`tamper-plan.json` 与编号 AX/截图。原始未脱敏云端 updater 报告和完整启动日志只留本机。
