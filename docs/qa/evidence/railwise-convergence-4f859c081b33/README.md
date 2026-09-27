# 4f859c0 精确候选：自由试算与复验审计

2026-09-20，macOS arm64 隔离候选 `0.5.0`，源码 `4f859c081b33e6f0f9b8d16f9c046466ccb90e75`。这是具体候选的技术验收，不是总计划完成、真人专业签认或公开发布。

## 安装与真实更新

[私有工作流 35464149867](https://github.com/wangjiawei508/WorkWise/actions/runs/35464149867)成功；[原始更新报告](private-updater.json)记录签名、公证、启用 Gatekeeper 的 hosted runner、证书固定 HTTPS 下载、真实 Squirrel 安装/重启及用户数据哨兵保留。未改系统信任、生产应用和公开 feed。同源码 `0.0.0` 仅作隔离更新探针，不是旧用户数据迁移。

目标附件 `10590653155`，GitHub 附件摘要 `d1c3d1336409b542e8b4cf50fc6f819284fc4da8f28a5d4938a06188971e4409`。[本机安装记录](package.json)的 ASAR 为 `bd1afdce126d77809fa1f11800d3839b851f2c1219f5c20b2217a07f10aafb93`，与实际 updater 安装目标一致。Developer ID 与 stapler 校验通过。本机 `spctl --status` 为 `assessments disabled`、退出 1；初次本地脚本因此停止，随后修正为如实记录状态。没有开启/关闭本机安全设置，也没有将其写成启用 Gatekeeper 的验证。

## 实际 GUI 验收

| 项目 | 证据与结果 |
| --- | --- |
| 自由水准 | 原生文件选择器导入3点3高差合成JSON；未勾选明确释放约束时按钮禁用，勾选后通过Tab/Return实际运行 |
| 独立数值 | 高程 `[-37/30,-1/3,47/30] m`、三个观测减平差残差 `0.1 m`、秩2、自由度1、基准亏损1、后验方差因子0.03；SQLite独立脚本复核通过 |
| 保留原数据 | A仍为原固定点且高程0，网络观测和修订未被试算改写；没有为合成试算生成正式成果 |
| 原始记录 | 最后一条CA定位到 `workwise-json-observation-3`，字节偏移612/长度125，摘录与原高差一致 |
| 历史与重启 | 退出且确认进程结束后按同隔离环境重启；同一试算 `free_leveling_trial_e97a9ea9-97d7-4c34-9c11-a8928906c110` 恢复并重算校验通过 |
| 双语/主题 | 中文浅色常规1171×768、最大化1490×768；英文深色最大化与重启后常规布局。缩窄拖动没有改变尺寸，不记作窄窗口通过 |
| 真实IN2 | 33点、11测站、160观测，校核与algorithm-7平差、DOCX/PDF/XLSX、独立draft清单；五项实时复验与重启后复验通过 |
| 真实GSI | 显式输入6个控制高程并选择水准网，27点28观测；平差、三格式、draft清单；五项实时复验与重启后复验通过 |
| 篡改与恢复 | 临时向隔离IN2生成文件追加测试字节，GUI报告输出哈希失败；恢复备份原字节后通过。成功/失败均单独记录，原manifest及draft状态保留 |
| 独立文件检查 | [gui-integrity.json](gui-integrity.json)：六份成果SHA-256/尺寸均匹配；3项目、1试算、2draft清单，6次复验保留5成功1失败 |

截图索引和哈希见 [screenshots.json](screenshots.json)。真实原件、完整成果与截图仅存本机 `/private/tmp/railwise-survey-4f859c0/`，不上传仓库。

## 实际指标边界

[失败时快照](metrics-failed.json)得到记录时点覆盖率0/1、尝试成功率1/2，证明后续失败不会被旧成功掩盖。[结束快照](metrics-final.json)得到覆盖率2/2、尝试成功率5/6。快照脚本只验证存储绑定，不能代替当前重新读文件；本次另有上表GUI实际复验和磁盘字节检查。两个样本属于候选验收，不是代表性生产指标，专业批准、来源代表性及真实生产成功率仍未测量。

## 检查和已发现限制

[源码检查](local-checks.json)：桌面2558通过/2跳过、Runtime1765通过/3跳过，双端类型、build、strict OpenSpec通过；lint 0 error/1既有warning。[PR Quality](https://github.com/wangjiawei508/WorkWise/actions/runs/35464136038)、[push Quality](https://github.com/wangjiawei508/WorkWise/actions/runs/35464133779)成功。

实测关闭来源/读取历史后键盘焦点回HTML；独立源码审查还发现复核窄布局、读屏状态、中文错误、复验响应校验问题。这些修复以及随后质量证据工作区/抽样内核属于新一轮源码，均不在此包内，必须新包验证。此包未完成全量窄窗口/键盘/locale验收。模型密钥未配置，没有成功真实模型回合；未进行用户亲自界面确认、历史真实用户配置迁移或专业结果签认。总计划仍46/58，未进行公开发布或官网部署。
