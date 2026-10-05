# RailWise Survey 当前 33 条未关闭计划矩阵

日期：2026-10-06；源码检查点 `2c7bf48be4bffa03d8000ddab9179292a51e2c24`。本报告是模拟工程测量、软件与产品高级工程师的 **AI 审查**。没有修改共享任务勾选，也没有替代真实专业签认。

**结论：计划没有全部完成；官方 0.5.2 包验收不通过。** 31 条工程交付和 2 条专业计划中，21 条工程条目主要是精确包验收，10 条有真实内部或混合生产范围；专业计划还含 1 条包验收和 1 条外部事实/生产范围。此快照关闭完整任务 0 条。

较新源码实现与官方安装包分别记录。不能把包验收全说成等待用户/厂商，也不能把本轮源码回归成功说成已发布或已通过最终包。

## 已固定的官方包失败基线

官方包 version 0.5.2 / tag source `ea763458567ccf069067a165d812f561e9af6b62`，ASAR SHA-256 `ce33ebb88d156a129c599ab8ec8d08094014d3d578c2704fe564b2fa9d8fb3bb`。签名/公证通过，但 CUA 发现专业报告和交付外露内部内容、AI 混淆残差与独立闭合、计算阻断文案矛盾、坐标改正误称位移以及孤立分页标题。

真实 IN2/GSI 导入→平差→三导出已保存，GSI 闭合/高程独立 Fraction 对照通过。完整48屏、键盘/恢复/质量/高级/CSV/XLSX/updater没有覆盖；实际响应模型 ID 未在保存 metadata 中证明。详见 [失败清单](../railwise-public-052-cua-20261005/README.md)。

## 真实软件/混合生产范围：10 条

| 原任务 | 当前已完成的受限范围 | 仍待完成或验证 |
| --- | --- | --- |
| engineering:9 · P1 | 已有显式表格映射/profile、M5历史配对；官方IN2/GSI各一条实际导入/计算/三导出已跑，GSI独立闭合/高程对照通过。 | COSA/GSI更多方言独立同源参考、GSI历史转换provenance、M5当前候选链及最终包矩阵仍缺；South无确认映射不放开。 |
| engineering:10 · P1 | 现有材料绑定/声明评分/整改工作流；本轮精确规范版本/撤销替代、连续复查抽样由实现代理进行，尚未完成最终汇总或候选验收。 | 完整规则适用/撤销、分类缺陷与材料、连续整改/重抽/评分轮引用、角色认证签认链需分别验收；真实签认不能由AI冒充。 |
| engineering:11 · P1 | 本轮已接限定准入固定基准独立高差网→冻结A/P/l、参数、完整先验协方差→w/VCE/Huber/static试算；恢复/保存/导出重验来源。来源模型/高级/MCP/报告10文件121项、来源高级UI/Panel/IPC3文件133项通过，两侧typecheck及4组件ESLint exit0。证据：survey-source-trials-20261006。 | 当前包验收仍缺；相对路线权、混合/缺失sigma、相关观测、非线性平面网均明确拒绝；一般自由/拟稳网不能宣称生产接线完成。 |
| engineering:12 · P2 | 通用Write/Design/Flow保留；没有本轮跨工作区精确引用闭环证据。 | Survey冻结结果→Write/Design/Flow及编辑新draft/失效、审批/导出的完整产品闭环仍待完成。 |
| engineering:13 · P2 | 本轮已接真实Node loopback TCP和SDK initialize/tools/list/call，持久可撤销grant、客户端token hash、零默认授权、读前后核验；targeted22项/runtime65项及kun build通过。 | 当前冻结包/OS宿主验收仍缺；仅元数据摘要读取，不提升为任意工程数据访问；GeoCOM真实型号/固件链、工程基准工作流、DXF/点云/3D未齐。 |
| engineering:14 · P2 | 已有部分usage事件及历史合成基准；没有本轮真实生产分母或完整拆分完成证据。 | 按已实现功能拆分大文件、先实测性能、首次/重复/失败/取消/中断去重持久事件和实际分母待完成。 |
| engineering:111 · P1 | 官方IN2/GSI实际两P0样例端到端及六份native文件已保存；GSI闭合高程独立对照通过。 | 全advertised格式家族fixtures/负例/资源界限及更多方言provenance不能由两样例代替；官方包P0失败，新的精确候选须复验。 |
| engineering:124 · P1 | P1规范/质量/高级试算的多个受限增量已有source；本轮来源绑定高级試算和规则/重抽正在补齐。 | 聚合范围不能整项关闭；按9/10/11分别验收，second-batch格式和认证签认未全部完成。 |
| engineering:125 · P2 | 坐标数学核和MCP受限真实transport增量已存在，通用协作保持兼容。 | GeoCOM、工程基准、DXF/点云/3D、licensed binary conversion、跨工作区闭环分别完成；真实仪器/许可事实只限制相应claim。 |
| engineering:126 · P2 | 本轮官方包IN2/GSI是实际应用操作，但来源为公开合成样例；不是工程生产KPI。 | 真实traceable project试点及首次结果/import/30分钟水准/复现/问答率的持久事件、真实分母和来源待完成。 |

本轮实现代理报告的来源绑定高级试算已通过限定模型和负例回归，证据已归档 [来源试算回归](../survey-source-trials-20261006/README.md)；相关/非线性网不支持该试算适配，不删除原专业计算。MCP是真实loopback SDK transport并受持久grant约束，仅元数据摘要；当前安装包接线尚未验收。质量规则/连续复查抽样仍在实现，最终回归与证据到齐后更新。

## 精确包行为验收：21 条工程条目

| 原任务 | 该条需验收的实际行为 | 当前状态 |
| --- | --- | --- |
| engineering:6 | 冻结私有签名包：真实默认Flash/显式Pro、IN2/GSI、监测CSV/XLSX、三导出、重启、精确问题、审批、恢复、整改复查。 | 尚未关闭；官方基线：F1/F2/F3/F4/F5。新冻结包需该项指定功能与恢复证据。 |
| engineering:7 | scope/offline/stale/cancel/retry/recovery，中英/明暗/窄窗/键盘。 | 尚未关闭；官方基线：F4。新冻结包需该项指定功能与恢复证据。 |
| engineering:21 | 真实默认模型中的原invalid draft读回→修复draft批准执行，保留原记录。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:31 | 未经人工补prompt的GSI首次方案、失败续跑、恢复输出、版本/重启。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:36 | 新未批准draft遮挡旧failed plan后，选择旧plan、typed resume、导航。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:42 | 整改/复查全流程、source变化失效、重启、语言/主题/窄窗/键盘。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:61 | 精确result question准备、explicit send/readback，stale/error/recovery。 | 尚未关闭；官方基线：F3。新冻结包需该项指定功能与恢复证据。 |
| engineering:78 | 工程线程隔离、AI-first/classic fallback，各loading/empty/partial/error/stale，表格全导出与矩阵。 | 尚未关闭；官方基线：F1/F4。新冻结包需该项指定功能与恢复证据。 |
| engineering:101 | typecheck/lint/full tests/build/strict OpenSpec及最终GUI/私有候选。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:118 | 四阶段、持续会话、stage tools/localized summary/readiness动作已有source，需最终包验证。 | 尚未关闭；官方基线：F1/F4。新冻结包需该项指定功能与恢复证据。 |
| engineering:119 | 普通问答、修改前后确认卡、typed execution approval、精确来源定位、离线手动。 | 尚未关闭；官方基线：F3。新冻结包需该项指定功能与恢复证据。 |
| engineering:120 | 品牌集中和迁移已有source；最终菜单/设置/启动/关于/Dock/tray/候选品牌及asset。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:121 | Survey全中英、明暗、尺寸、键盘/a11y。 | 尚未关闭；官方基线：F6。新冻结包需该项指定功能与恢复证据。 |
| engineering:123 | 签名/公证、隔离安装、两P0 GUI/重启、真实private updater回环。 | 尚未关闭；官方基线：F1/F2/F3/F4。新冻结包需该项指定功能与恢复证据。 |
| engineering:141 | ellipse单位/参数/解释及parser诊断的精确新包；不关全部advanced。 | 尚未关闭；官方基线：F3。新冻结包需该项指定功能与恢复证据。 |
| engineering:159 | w/VCE试算的坏/旧记录、重启、明暗和键盘。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:166 | 分布/Huber两kind新包的native导出/重启/坏记录/主题尺寸。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:184 | static append stale baseline、完整参数/协方差/row、导出/重启/主题尺寸。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:192 | linkage全/不全coverage、源变化、native导出/重启/主题尺寸。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:208 | 规范exact/legacy/mismatch/auth/stale UI与独立审查。 | 尚未关闭；官方基线：未完整覆盖。新冻结包需该项指定功能与恢复证据。 |
| engineering:247 | completion guard、fbb后provider/model/effort/locale/terminal-refresh/resume组合。 | 尚未关闭；官方基线：F3。新冻结包需该项指定功能与恢复证据。 |

## 专业修订计划：2 条

| 原任务 | 当前证据 | 关闭前仍需 |
| --- | --- | --- |
| professional:23 | 官方0.5.2精确包完成中文明亮IN2/GSI各一条导入→计算→三导出和专业问答；总体不通过，仅部分行为基线，不覆盖该整项。 | 修复后冻结同一私有目标字节，完成该任务指定的功能/状态/矩阵、CUA和独立AI；涉及updater须真实往返。 |
| professional:25 | 16来源访问/14获取回执与限定自由水准Fraction-KKT对照已完成；真实厂商wire/同源SUC参考、现场仪器或人类签认没有取得。 | 继续查找合法公开/厂商资料、完成内部P1/P2接线；SUC仍archive-only。AI不得制造真实身份、证书、现场数据或签字。 |

## 下一步按证据关闭

1. 完成当前 source 修复和针对性回归，固定一份私有签名/公证候选与哈希。
2. 在同一精确目标包完成48屏、四条导入链、三导出、真实问答/审批、恢复、质量/高级、键盘无障碍与重启；发现失败则修复并重新冻结。
3. 对该目标包完成真实 private updater 往返和独立高级工程师 AI 审查。
4. 按本矩阵继续完成内部跨工作区、空间/设备、格式、性能/真实指标子范围；真实厂商互操作、现场真实性和人类签认不得虚构。

公开0.5.2已于2026-10-05发布。此审计不覆盖同版本重发，不更改公开版本/tag/Release/feed/官网。后续修复的公开版本与行动由协调代理核对授权。

逐字原任务、行号、当前文件SHA-256及逐条状态见 [task-status.json](task-status.json)。状态快照明确保留并行实现仍在进行的范围，不当作永久的未接线事实。
