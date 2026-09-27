# 53213de 签名候选：同任务恢复与回执验收

源提交 `53213de739d0b1f3f173f883dcdac21cdc4fdfc9`，版本 `0.5.0`。状态为 **partial-not-release-approval**：真实工程工具链、数值核对及重启持久化通过；完成后仍显示过期待处理提示，当前包 UI 验收失败。后续 `7d4f454feecb09028007ae9b436a318db6856201` 修复不在本包内。

## 包与更新

[包摘要](./package-summary.json)核对本机与云端同一 ZIP/ASAR、签名及 stapled 公证。[私有 updater](./private-updater-summary.json)在 [run 35498678787](https://github.com/wangjiawei508/WorkWise/actions/runs/35498678787) 完成同源 `0.0.0 -> 0.5.0` 下载、安装、目标重启和合成数据哨兵保留。云端 Gatekeeper 启用，本机原状态 disabled。未修改公开版本、安装包或 feed；同源基线不代表旧用户迁移。

ZIP SHA-256：`08b10e861ae15cac22a1e2bf724ff1a435f4cb17633bf8ebc7aac9196d134db7`。ASAR SHA-256：`529a0f1364d4e4546eb8058d5dc7e4a0ffccc7cbe41ef95011fc8929f548a774`。内层应用 ZIP 全量哈希已核对，外层 artifact 未本机重算，包摘要明确区分。

## 两个执行场景

所有 GUI 测量数据均来自仓库合成 `golden-plane-control-e2e.in2`。待审批计划由限定包内辅助脚本准备，未声称模型生成。GUI 确认四步骤、三个写入/导出勾选及 `custom-provider-3 / deepseek-flash / off`，实际线上请求的 thinking 为 disabled；不是模型内部版本或 V4.1 身份证明。

| 场景 | 实际结果 | 证据 |
| --- | --- | --- |
| 首轮纯文字负例 | 7 条固定完成回复，0 工具、4 空回执、0 平差/导出；原 Task stalled，Turn 因缺回执 failed | [继续前快照](./before-resume-zero-receipts-53213.json) |
| 首轮真实继续 | 同 Task 第 8 次尝试遇官方 HTTP 503，Task/Turn failed；无工具副作用。保留失败，不改预算或删历史 | [失败快照](./failed-real-resume-53213.json)、[完整中继报告](./relay-report-d6fabac586b96a85.json) |
| 显式重新规划 | GUI 创建新计划，重新勾选审批；第二场景新 Task 的 7 次纯文字同样被守卫阻止。全线程累计 14 条固定回复 | [第二轮继续前快照](./second-before-resume-zero-receipts-53213.json) |
| 第二轮真实继续 | 沿第二场景原 Task 执行 4 工具/4 成功回执，5 次真实聊天全部 HTTP 200，另 2 次模型列表 HTTP 200 | [严格审计](./strict-before-restart-audit-53213.json)、[成功中继](./relay-report-43151fd88b293414.json) |
| 正常退出重启 | 同计划、Task、成功与失败 Turn、任务事件、回执、结果及三份文件哈希全部不变；GUI 恢复 26 条消息 | [重启对照](./strict-after-restart-audit-53213.json)、[场景关联](./scenario-lineage-before-restart-53213.json) |

第二场景计划 `eplan_86ed3cb7-07c6-46c4-a503-4cae5150ccd3`，原 Task `task_05adc31c-0268-4cf7-80b5-7c9b5733faee`，模拟 Turn `turn_80tnsgof`，成功 Turn `turn_hcl2310o`。首轮 Task `task_a3258fff-f184-49a0-bb97-9ce06e1d1360` 仍明确 failed，不用第二轮新 Task 冒充首轮成功。

普通 GUI `2+3` 尝试被旧 typed 中继的工具目录限制本地拒绝 7 次，未送上游，不计为产品错误或咨询成功。后来 CLI 最小健康检查先因历史限定被本地拒绝，修正辅助检查后只转发固定算术问题，收到 `5`；[两份健康记录](./consultation-healthcheck-1789894523837.json)和[成功健康记录](./consultation-healthcheck-1789894568710.json)保留全部结果。该受限 CLI 检查不等于完整 GUI 咨询验收。

## 独立核对

严格审计核对包身份、原 Task/plan 绑定、provider/model/effort、四工具批准参数及前序绑定、独立回执、完整确定性结果和三文件。DOCX/XLSX ZIP CRC/XML 通过，PDF 2 页，XLSX 15 表；[三份合成成果](./synthetic-deliverables/)原字节保存。原始 plan 状态为 started，回执派生完成为 true，Task/Turn completed；未形成正式 manifest 或专业签认。

[独立 NumPy 最小二乘 oracle](./oracle/)不调用产品解析器或平差核，先声明 D.MMSS、X 北/Y 东、定向未知数及两种独立权模型，再比较实际结果。5 观测、3 未知数、秩 3、自由度 2 精确一致；RSS 坐标最大差 `9.95e-14 m`，加法距离权最大差 `5.77e-9 m`，均在预声明 `2e-6 m` 门限内；角残差门限 `2e-8 rad`，另做几何残差重建。[比较结果](./independent-oracle-comparison-53213.json)通过，不声称精度/协方差等价或真实专业验收。

SQLite 只打开 DB/WAL 的一致副本；读取前后源字节核对通过。四步回执表本身没有 Turn ID，归属由失败轮零工具、成功轮调用/结果及精确参数共同佐证。中继停止报告要求 tokenRemoved=true、无 cleanupError，并以 lstat 核实会话 token 路径不存在；不读取 token 内容。GUI 清空临时 key、恢复官方端点由操作记录支持，审计器不读取设置。原始上游响应流未存档，不声称逐字回放网络响应。

## 界面缺陷与后续源码

[中文浅色合成截图和 AX](./gui/)记录导入、审批、两次停滞、503、完成自动刷新、残差原行定位与重启；九张截图逐张检查。当前包完成后底部仍显示过期 `waitingReason` 对应“需要处理”，[该缺陷保持 FAIL](./after-restart-known-ui-defect-53213.json)。图片只证明所拍状态，不代替全语言/主题/尺寸/键盘矩阵或用户确认。

`7d4f454` 的 [4 文件修复与验证](./post-package-fix/)在完成时清除当前 Task 过期提示，界面仅显示与当前 Task/线程绑定的失败或等待原因，保留旧记录和失败历史。独立只读审查未发现确定回归；桌面 2818 通过/2 跳过、Runtime 2821 通过/22 跳过、构建和 strict OpenSpec 11/11 通过，lint 0 error/1 既有 warning，两侧类型检查在前阶段通过。需要新签名包实测，不能回填本包为修复成功。

P0 双真实格式的[重启前摘要](./p0-before-public-summary.json)与[重启后摘要](./p0-afterrestart-public-summary.json)均通过所选证据检查：同八个 project/network/adjustment/manifest ID、输入/算法及六份成果的 hash/size/type 不变，draft 保持；每网络均有两次 start/finish 绑定的复验通过，未完成数为 0。主任务代理实际观察正常退出、进程消失、同包重启，并于本地 17:23:42（GSI）和 17:24:20（IN2）分别看到五项通过；私有 AX 只留本机，审计脚本本身不冒称能够证明 GUI 操作或重启。

IN2 与独立 OU2 解析比较 33 点，公开舍入/精度门限均零 mismatch；GSI 同源独立平差 21 未知点与包内最大差 `1.71e-10 mm`，但历史 IN1 转换的 14 条路线仍有 7 条高差超出半打印单位，来源差异尚未解决。[来源与对比摘要](./p0-summary-provenance.json)记录两份原摘要哈希和对比规则，本目录不含真实源文件、坐标、私有明细或私人路径，不称完整 P0、历史转换或专业验收通过。

## 归档方法

[source-artifacts.json](./source-artifacts.json)记录源哈希、归档哈希及个人路径替换；[archive-manifest.json](./archive-manifest.json)覆盖所有归档文件，清单不包含自身。`archive-evidence.mjs` 仅取明确白名单，文本扫描凭据/私有 feed，二进制截图逐张查看，成果解包或转文本后扫描。首次归档发现预设 `pdftotext` 路径不存在，未造成源文件修改；改为已安装 Poppler 路径后完成。原本地证据不改写。

完成文档与证据整理后，显式运行 `node verify-archive.mjs --write-manifest` 生成基准，再单独运行 `node verify-archive.mjs` 只读核对既有条目集合、大小和 SHA-256。默认验证不会重写清单；文件被改、增添或遗漏均拒绝。`verify-archive.test.mjs` 在独立临时目录验证篡改与新增条目被拒绝，同时清单原字节不变。

`helpers/*.source.txt` 和 `oracle/*.source.txt` 是执行/自检脚本快照，后缀防止将审计夹具作为产品代码自动执行；重放须恢复原后缀并重新绑定明确候选路径。部分个人仓库/运行时路径替换为占位符，源摘要可追溯。oracle README 是比较最终包前的方法记录，实际本包比较以本目录结果为准。当前 helper 快照含后来收紧的 consultation-only 模式，旧场景以报告中脚本哈希和当时执行记录为准，不冒称全部历史工具字节相同。

完整 UI、普通咨询、真实用户迁移、专业签认和生产 KPI 门禁仍开放。此归档没有公开发布授权或发布动作。
