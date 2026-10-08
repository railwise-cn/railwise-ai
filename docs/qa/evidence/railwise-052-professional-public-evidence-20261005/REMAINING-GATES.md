# 全部未勾选任务审计与可实施增量

2026-10-05；审查source `7bf3e6a129088232c35ae3d1320f87b7ba6cd735`。模拟工程测量、软件和产品高级工程师的 **AI 审查**。逐字原任务、source行及文件SHA-256见 [机器审计](open-task-audit.json)。本轮没有修改共享 tasks.md。

`engineering-delivery` 31项中，**21项主要是最终包验收，10项包含内部代码/混合生产范围**；`professional-workflow`另有2项。按主类只计一次，混合项明确拆开，不把实际缺功能统称等待厂商。

## 本轮可以关闭的子范围

- 16项来源访问回执、14项实际获取，失败/HTTP/TLS限制完整保留。公开资料支持流程/成果语义，不自动放开格式准入。
- 限定自由水准的独立Fraction-KKT数值、单位、排列、冗余/断网拒绝对照已通过；不关一般自由/拟稳或生产接线。
- 两份计划全部33条未勾选任务的具体scope、接线文件、最小可验收增量/依赖已梳理。
- 21项包验收在同一最终冻结包实际通过后可逐项关闭；本代理未安装/操作当前包，不提前勾选。licensed SUC、真实签認、全P1/P2仍不假报完成。

## 内部或混合生产范围：10项

“已有”是source/历史证据事实，不表示当前包已通过。最小增量分别验收，受限功能可先交付并保持明确能力界限。

| source行 | 优先级 | 已有与剩余scope | 最小可验收增量 | 接线文件 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| [engineering:9](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L9) | P1 | CSV/XLSX显式映射和profile已source，M5历史真实配对已有。剩余：COSA/GSI独立对照覆盖、GSI历史转换provenance、当前包准入验证。South无确认映射仍阻断。 | 拆分为表格mapping/profile往返、M5真实配对当前parser重跑及包链、COSA/GSI同源独立对照；没有参考的方言保留受限准入。 | `kun/src/engineering/survey-tabular-import.ts`<br>`kun/src/engineering/survey-format-registry.ts`<br>`kun/src/engineering/survey-converter.ts` | 合法原件/参考输出；已知点、单位和点角色语义 |
| [engineering:10](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L10) | P1 | 材料保全、首轮抽样、声明评分/整改复查已有；受信规则适用/撤销、质量全阶段/重抽、组织身份与认证签名/正式交付门禁仍有内部范围。 | 先做规则登记/撤销版本、质量材料逐条绑定和复查重抽，旧/错引用拒绝；另接可验证身份，不把caller声明升级为认证。 | `kun/src/engineering/survey-quality-workflow.ts`<br>`kun/src/engineering/survey-quality-scoring-rules.ts`<br>`kun/src/engineering/survey-quality-assessment.ts` | 组织角色策略；规范适用条件；可验证身份/证书 |
| [engineering:11](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L11) | P1 | 已有w/VCE/Huber、free-leveling/reference/static-append试算。缺准入正式网→固定模型/完整协方差受控生产接线和一般自由/拟稳范围。 | 从冻结准入网派生A/P/l、参数名、协方差与source references，独立数值对照；先限定模型/秩/单位，试算不静默回写正式权或观测。 | `kun/src/engineering/survey-service.ts`<br>`kun/src/engineering/survey-advanced-trials-workspace.ts`<br>`kun/src/engineering/survey-adjustment-core.ts` | 明确确定性/随机模型；完整协方差；秩与基准假设 |
| [engineering:12](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L12) | P2 | 通用Write/Design/Flow已存在；Survey精确成果引用、审批/导出/图表接线及编辑失效验证仍需产品级闭环。 | 冻结结果引用进入Write草稿/Design图；源变更或编辑生成新draft、旧验证失效；Flow只消费当前批准。 | `kun/src/engineering/survey-evidence-reader.ts`<br>`kun/src/engineering/engineering-plan-execution.ts`<br>`src/renderer/src/components/engineering/EngineeringManifestVerification.tsx` | 跨工作区契约；来源绑定；保留现有配置/数据 |
| [engineering:13](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L13) | P2 | MCP factory只进程内，缺真实OS宿主/transport/持久可撤销grants。GeoCOM实时适配/型号固件链、工程基准、DXF/点云/3D仍未齐；坐标核已有。 | 优先真实本地transport、可信宿主身份绑定、默认拒绝、每调用查持久grants，实际client测试重启/撤销/越权/畸形；其他空间/仪器能力分开验收。 | `kun/src/adapters/mcp/survey-context-server.ts`<br>`kun/src/adapters/mcp/survey-context-reader.ts`<br>`kun/src/engineering/survey-coordinate-transform.ts` | 可信宿主授权；明确基准转换参数；真实仪器仅影响设备claim |
| [engineering:14](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L14) | P2 | 大文件拆分、性能实测及首次启动/失败/中断真实分母采集仍需接线，不能将synthetic称生产指标。 | 先测真实文件规模的耗时/内存，再沿功能拆分；持久采集首次/重复/失败/取消事件、去重与分母。 | `kun/src/engineering/engineering-service.ts`<br>`src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx`<br>`src/renderer/src/components/engineering/engineering-usage.ts` | 稳定基线；真实任务事件/来源 |
| [engineering:111](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L111) | P1 | 全部advertised vendor/receiver的fixtures、负例、资源限制/provenance与两P0包实链尚无整项证明；registry名字不是接入。 | 逐entry能力矩阵与结构/资源负例；至少两P0 import→preflight→计算→三导出/审查记录和闭合精度对照；归档entry明确scope。 | `kun/src/engineering/survey-fixture-manifest.ts`<br>`kun/src/engineering/survey-format-registry.ts`<br>`kun/src/engineering/survey-format-coverage.test.ts` | 各家可再分发样例/规格；最终包；资源限制 |
| [engineering:124](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L124) | P1 | 汇总质量/规则/签名、advanced和第二批格式。局部核/声明链已source，整体生产范围仍有代码/参考和认证缺口。 | 按9/10/11逐子项关闭；规范版本适用/撤销、精确引用与生产采集接线分别验收，真实认证不捏造。 | `kun/src/engineering/survey-standard-registry.ts`<br>`kun/src/engineering/survey-quality-workflow.ts`<br>`kun/src/engineering/survey-advanced-trials-workspace.ts` | 规则/身份来源；独立数值/格式参考 |
| [engineering:125](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L125) | P2 | 仪器、工程坐标、DXF/点云/3D、outward MCP、binary转换和跨工作区仍有内部实现，不能统称等厂商。坐标核已含2D similarity/Helmert7/高程面/Gauss-Krüger。 | 按12/13拆增量；MCP先做可撤销只读transport；坐标核补基准确认工作流；DXF与仪器独立受限验收。 | `kun/src/adapters/mcp/survey-context-server.ts`<br>`kun/src/engineering/survey-coordinate-transform.ts`<br>`kun/src/engineering/survey-converter.ts` | 宿主授权/transport；规格/设备/许可仅相应claim |
| [engineering:126](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L126) | P2 | 真实traceable projects、首次结果/import/30分钟水准/复现/provenance/问答指标，尚缺生产采集接线及实际分母。 | 真实事件持久、首次/重复/失败/取消分母与结果绑定，运行有来源试点报告；synthetic仅benchmark。 | `src/renderer/src/components/engineering/engineering-usage.ts`<br>`kun/src/engineering/engineering-verification-audit.ts` | 实际任务记录；去重、保全与隐私 |

## 精确安装包主要验收：21项

当前AGENTS.md已将旧任务的human UI确认换成computer-use加独立AI验收，无需用户逐项人工验收；真实专业签認仍不得由AI冒充。

| source行 | 需实际验收行为 | 关闭证据 |
| --- | --- | --- |
| [engineering:6](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L6) | 冻结私有签名包：真实默认Flash/显式Pro、IN2/GSI、监测CSV/XLSX、三导出、重启、精确问题、审批、恢复、整改复查。 | 绑定包版本/哈希/签名公证、完整流程截图/录屏与三格式数值/审查记录；由当前其他代理验收。 |
| [engineering:7](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L7) | scope/offline/stale/cancel/retry/recovery，中英/明暗/窄窗/键盘。 | 逐状态触发/恢复、Tab顺序、焦点/live-region；同一冻结包。 |
| [engineering:21](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L21) | 真实默认模型中的原invalid draft读回→修复draft批准执行，保留原记录。 | 同private updater target字节实际触发失败/修复/批准/运行；原失败仍可恢复。 |
| [engineering:31](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L31) | 未经人工补prompt的GSI首次方案、失败续跑、恢复输出、版本/重启。 | 真实模型GSI完整处理、可控故障恢复、三导出/重启；保留原失败。 |
| [engineering:36](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L36) | 新未批准draft遮挡旧failed plan后，选择旧plan、typed resume、导航。 | 制造两记录，重启后恢复旧计划且两记录保留、不覆盖。 |
| [engineering:42](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L42) | 整改/复查全流程、source变化失效、重启、语言/主题/窄窗/键盘。 | 资料→问题→整改→复查；源变更拒绝旧引用；旧human UI由当前AGENTS的AI验收取代，真实签認不替代。 |
| [engineering:61](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L61) | 精确result question准备、explicit send/readback，stale/error/recovery。 | Q10–17类对象逐点/观测读回，来源/导航/回答专业语义一致，旧/坏引用拒绝。 |
| [engineering:78](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L78) | 工程线程隔离、AI-first/classic fallback，各loading/empty/partial/error/stale，表格全导出与矩阵。 | 工程/编程隔离；真实CSV/XLSX→预检→计算→DOCX/PDF/XLSX/审查记录；a11y/窄窗/明暗证据。 |
| [engineering:101](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L101) | typecheck/lint/full tests/build/strict OpenSpec及最终GUI/私有候选。 | 最终HEAD指定检查通过、绑定候选字节与private updater；旧0.5.0-rc字样是历史计划，不能靠改公开版本完成。 |
| [engineering:118](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L118) | 四阶段、持续会话、stage tools/localized summary/readiness动作已有source，需最终包验证。 | 四阶段连续任务、重启持续会话、缺件/过期动作准确，预览不可标reviewed。 |
| [engineering:119](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L119) | 普通问答、修改前后确认卡、typed execution approval、精确来源定位、离线手动。 | 实际UI拒绝/接受卡、显示影响，offline导入/预检/计算/导出及对象定位。 |
| [engineering:120](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L120) | 品牌集中和迁移已有source；最终菜单/设置/启动/关于/Dock/tray/候选品牌及asset。 | 全可见品牌RailWise AI/Survey；技术兼容标识保存；迁移矩阵无静默删除。 |
| [engineering:121](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L121) | Survey全中英、明暗、尺寸、键盘/a11y。 | 四页面、AI/高级drawer焦点进入/回trigger、Tab/live-region、44px命中；1280×800/1440×900/窄窗。 |
| [engineering:123](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L123) | 签名/公证、隔离安装、两P0 GUI/重启、真实private updater回环。 | 包版本/哈希/签名公证、真实source检查/下载/quit-install/target重启；mock和官网手动下载不替代；独立AI/CUA。 |
| [engineering:141](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L141) | ellipse单位/参数/解释及parser诊断的精确新包；不关全部advanced。 | 轴/角/协方差单位、初始/平差/后验界限、专业解析异常，独立AI解释复核。 |
| [engineering:159](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L159) | w/VCE试算的坏/旧记录、重启、明暗和键盘。 | 创建/native导出/读回，源变更/坏schema拒绝，trial不继承工程结论。 |
| [engineering:166](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L166) | 分布/Huber两kind新包的native导出/重启/坏记录/主题尺寸。 | 两kind独立展示/读回/拒绝矩阵，不能借w/VCE历史成功。 |
| [engineering:184](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L184) | static append stale baseline、完整参数/协方差/row、导出/重启/主题尺寸。 | 全表可读、大协方差滚动、基线变更拒绝、native同记录导出与重启。 |
| [engineering:192](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L192) | linkage全/不全coverage、源变化、native导出/重启/主题尺寸。 | 准确显示两coverage、源变更失效、导出/读回无认证升级；不关真实签认/生产批准。 |
| [engineering:208](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L208) | 规范exact/legacy/mismatch/auth/stale UI与独立审查。 | 正确映射、错引用拒绝、旧结果只读、授权/过期状态，catalog不提升现场合规。 |
| [engineering:247](../../../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md#L247) | completion guard、fbb后provider/model/effort/locale/terminal-refresh/resume组合。 | 真实模型无效完成拒绝/续跑、模型/推理/中英/终端刷新、原failed baseline保留。 |

## 专业修订计划：2项

| source行 | 剩余scope | 本轮证据/关闭条件 |
| --- | --- | --- |
| [professional:23](../../../../openspec/changes/survey-professional-workflow/tasks.md#L23) | 最终冻结包全主题/语言/尺寸/专业功能/a11y/恢复及独立AI。 | 真实安装包身份、矩阵截图/缺陷/清单；本代理资料/数值审查不代替CUA。 |
| [professional:25](../../../../openspec/changes/survey-professional-workflow/tasks.md#L25) | 当前licensed vendor/SUC准入协议与同源参考、真实角色签認仍缺；内部P1/P2软件范围也需分别完成。 | 本轮只完成14公开资料/限制回执、独立数值与31项清单；SUC archive-only、不伪造真实认证。 |

## 内部软件的执行顺序

1. 冻结包的21项真实行为和private updater回环；失败修复后重冻字节，旧包成功不能顶替。
2. 真实MCP宿主、transport和持久可撤销grants。factory明确由宿主提供identity、transport、lifecycle和grants；先找可信入口，不能信任tool参数/clientInfo/caller声明。
3. 准入网→固定模型/完整协方差受控接线，先限定模型/秩/单位和独立参考；trial保留不回写边界。
4. 质量规则版本/适用/撤销、重抽与组织角色、真实认证系统接口分开实现。身份未验证保留草稿并阻断正式签认。
5. 跨工作区精确引用/编辑失效、工程基准/DXF、性能和真实指标分别交付；GeoCOM型号固件链、许可转换、点云/3D独立扩展。

## 发布和外部事实的准确边界

普通软件改进不应虚构“取得全部厂商认证”的普遍前提；限制的是相应设备兼容、SUC平差、现场真实性/正式签認claim。AGENTS.md真实要求最终安装包、CUA、独立AI、真实private updater；失败/未完会阻止公开发布。

父任务确认公开0.5.2已存在而官网下载滞后；本目录不重发、不更改公开version/tag/feed/Release/官网，不将较新source当作已公开包。
