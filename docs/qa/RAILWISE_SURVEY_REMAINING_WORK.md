# RailWise AI / Survey 总计划未完成清单

原审计日期：2026-09-20；进展更新：2026-09-24。原审计源码：`43689493ab586c8d65bae729cfd291f3c813f679`。依据为用户提供的《RailWise AI ｜ Survey 产品收敛与命名迁移总计划》、[OpenSpec 任务](../../openspec/changes/workwise-0-5-0-engineering-delivery/tasks.md)、源码与[执行台账](RAILWISE_SURVEY_CONVERGENCE_STATUS.md)。下表保留原审计任务编号；后续源码进展另列，不追溯改变旧包验收。审查身份为 AI 智能体，不是专业人员签章或用户验收。

2026-09-24：[声明整改链](RAILWISE_SURVEY_QUALITY_WORKFLOW.md)的持久化、Runtime/IPC/client 和双语人工界面已通过源码检查，自己的签名包验收未完成。`3f0dbf1` 旧候选已真实进入中文浅色 Survey 并显式发送两次，均因上游 401 鉴权失败，零模型工具调用；精确成果追问的真实读回仍未通过，详见[失败证据](evidence/railwise-result-questions-gui-20260924/README.md)。OpenSpec 当前 107 项、87 项完成、20 项未完成。

最近已验监测候选状态：`partial-not-release-approval`。[b193fc7监测复算包](evidence/railwise-monitoring-replay-package-b193fc7/README.md)已完成签名公证、隔离安装、私有真实updater、CSV/XLSX原件复算、历史缺源、失败恢复及重启独立审计；该限定验收不覆盖全矩阵与人审。复选项计数**不是总计划完成率**，也不是互不重叠的功能缺陷数。

2026-09-21 监测复算限定包验收已完成；随后 `353d407` 完成 Q10–Q17 精确成果追问源码、只读工具与桌面接线，Runtime 2929项、桌面2850项通过，新功能自己的包验收及真实模型读回仍待做。OpenSpec现为104项、85项完成、19项未完成。b193fc7不包含后加成果追问，旧4368949不包含监测复算。详见[复算合同](RAILWISE_MONITORING_REPLAY_ACCEPTANCE.md)及[成果追问验收](RAILWISE_EXACT_RESULT_QUESTIONS_ACCEPTANCE.md)。

## 已取得的资料与边界

- [GB/T 24356-2023 官方全文](evidence/railwise-standards-20260920/README.md)、[限定 TPS1200 GeoCOM 1.10 手册](evidence/railwise-field-interface-20260920/README.md)、[高级方法资料及独立数值基准](evidence/railwise-advanced-methods-20260920/README.md)已取得。剩余问题是适用性、具体设备/生产材料、软件接线及真实签认，不能再笼统写成完全缺少规范和协议资料。
- [官网及双语 README](evidence/railwise-website-20260920/README.md)已随 PR #29 上线中文浅色候选截图。后续界面改变须对应新包截图，网站上线不等于当前候选公开发布。
- 核心 P0、监测严格复算及Q10–Q17成果追问已有实现，后者仍需自己的包验收；完整 P1/P2与生产认证链仍有实际软件缺口，不能全部归为等待材料或用户确认。

## 18 个聚合项

编号是审计快照中复选项的顺序，行号仅定位当时任务文件；后续插入任务后须重新核对。类别：代码＝尚须实现；包验收＝冻结包实操；外部＝真实输入/设备/授权/独立材料；人审＝用户本人或真实专业角色确认。

| 任务号 / 行 | 剩余范围 | 分类与证据 |
| --- | --- | --- |
| 15 / 23，完整 Engineering 界面验收 | CSV/XLSX 新时间算法、完整历史趋势和中文报告已在4368949最终包完成三格式/清单/重启；线程隔离、空/错/过期状态、主题尺寸及键盘仍须全矩阵证据。7d4f454 的 XLSX/图表失败保留。 | 包验收。[最终监测归档](evidence/railwise-monitoring-final-4368949/README.md)。 |
| 29 / 46，完整验证集合 | 源码测试、类型、构建和 strict 已有通过记录；最终监测包 GUI 与独立绑定证据已补，完整跨功能组合仍待验收。 | 包验收。[执行台账最新节](RAILWISE_SURVEY_CONVERGENCE_STATUS.md)。 |
| 36 / 56，格式族与两 P0 实产验收 | IN2/GSI 已有选定同包完整链；GSI 历史转换版本/舍入/日志与专业复核仍缺。其余格式的逐项黄金/负例/授权/生产证据不能由两 P0 推及；inspection/detection/converter-boundary 不等于已有可用的具体适配或转换器。 | 代码＋包验收＋外部＋人审。[格式矩阵](WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md)、[GSI 补证](evidence/railwise-gsi-provenance-20260920/README.md)。 |
| 38 / 63，四阶段与就绪状态 | 四阶段、持续会话、摘要、准入动作、异步作用域已有实现；缺全失败/过期/离线、主题尺寸和最新包组合实操。 | 主要包验收。[导航与作用域证据](evidence/railwise-navigation-audit-followthrough/README.md)。 |
| 39 / 64，咨询/修改/审批/证据/离线 | 真实四工具链和限定修改确认已有包证据；最新完成守卫/恢复须最终包组合复验。完整关键结果追问还缺部分接线。 | 代码＋包验收。[UI 清单](RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md) Q10–Q17：原始控制点、期次比较、统计诊断、自由/高级试算、质检、规范依据、监测行缺专用追问。 |
| 40 / 65，显示品牌迁移 | 共用配置、品牌资源、兼容矩阵已有；Dock/托盘与最新包实看、用户确认仍缺。OpenSpec 旧命名文档已在 `2cc2f48` 同步现行品牌。 | 包验收＋人审。[品牌配置](../../src/shared/product-brand.json)、[迁移矩阵](../railwise-ai-migration-matrix.md)。 |
| 41 / 66，全中英文/主题/尺寸/a11y | 词典/诊断修复和选定包场景已有；完整动态错误、恢复、目录外组件及窗口矩阵未验完。新增实际残留须修复，但静态 JSX 候选数不是缺陷数。 | 包验收，后续代码修复由失败证据驱动。[UI 清单动态边界](RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)。 |
| 43 / 68，精确包总门禁 | 4368949最终包身份、签名公证、隔离安装、真实私有 updater 和限定监测链重启证据已完成；该包完整两 P0 链与跨功能恢复组合仍待验收。真实旧用户数据覆盖、用户本人和专业确认仍缺。 | 包验收＋外部＋人审。[私有更新流程](PRIVATE_SURVEY_UPDATER_ACCEPTANCE.md)。 |
| 44 / 69，完整 P1 | 规范受信执行、全质检阶段、实际缺陷材料、整改重抽、授权/签名/批准、监测严格重算、一般自由网/拟稳与高级试算生产接线、第二批格式等仍有代码缺口。 | 代码＋包验收＋外部＋人审。下节细分；[算法预审](RAILWISE_SURVEY_ALGORITHM_REVIEW.md)。 |
| 45 / 70，完整 P2 | GeoCOM 实时传输/设备适配、坐标工程扩展、DXF/点云/3D、MCP 宿主授权/传输、具体二进制转换器、Write/Design/Flow 证据接线未完成。外业/点云/长尾仍受 P0 包验收门禁约束。 | 代码＋外部＋包验收。[接口审查](RAILWISE_SURVEY_INTERFACE_REVIEW.md)。 |
| 46 / 71，生产指标 | 只读统计、持久导入/复验事件及采集合同已有；缺认证真实总体/首次业务开始/正式批准/全部字段来源及许可结论。采集合同不是签名认证服务。 | 外部＋人审，并有认证服务/全表面接线代码缺口。[指标口径](RAILWISE_SURVEY_PRODUCTION_METRICS.md)、[采集合同](RAILWISE_SURVEY_PRODUCTION_COLLECTION_CONTRACT.md)。 |
| 53 / 86，椭圆与诊断 | 核、双语显示、三格式及算法6兼容已有；精确包完整显示/单位/解释与专业确认仍缺。GNSS XY 不当 ENU，标准椭圆不当置信区域。 | 包验收＋人审。[设计的 XY 增量](../../openspec/changes/workwise-0-5-0-engineering-delivery/design.md)。 |
| 62 / 104，w/VCE 工作区 | 7d8e92b 已覆盖实际保存、破坏拒绝、重启及限定数值；完整主题/窗口/键盘、用户和专业确认仍缺。 | 包验收＋人审。[当前受限实现](RAILWISE_SURVEY_ALGORITHM_REVIEW.md)。 |
| 66 / 111，统计族/Huber | a606a86、6ff82c8 已有 GUI/独立核算/原生保存/重启；完整组合与人审未关闭。 | 包验收＋人审。[当前受限实现](RAILWISE_SURVEY_ALGORITHM_REVIEW.md)。 |
| 75 / 129，静态追加 | 6ff82c8 正常/旧基线/最大案例、导出、重启及128前缀复算已有；大参数、完整协方差及逐行展示的完整视觉覆盖仍缺。 | 主要包验收。[后端合同](RAILWISE_SURVEY_ADVANCED_TRIALS_BACKEND.md)。 |
| 78 / 137，质检关联 | 281dc87 已覆盖完整/缺失/否决/来源变更/导出/重启；全语言主题尺寸、原生最小尺寸与完整 a11y 未闭合。此项不完成 P1 签认。 | 主要包验收。[281 包证据](evidence/railwise-convergence-281dc8767250/README.md)。 |
| 84 / 153，规范依据目录 | 精确版本/来源/profile 绑定与独立审查已有；be0 包有限定当前/历史显示及 PDF 打开。后续页码拆分、错误/鉴权/过期状态须新包验证。 | 主要包验收。[规范依据增量](evidence/railwise-standard-basis-20260920/README.md)。 |
| 98 / 192，回执完成守卫 | 零工具阻止完成、原任务恢复、真实四回执已有；53213 旧等待文案失败已在7d4f454包实查修正。最新合并包 provider/model/effort/locale/恢复组合仍未闭合。 | 包验收。[7d4f454 包](evidence/railwise-convergence-7d4f454feecb/README.md)、[53213 历史](evidence/railwise-convergence-53213de739d0/README.md)。 |

## 明确的软件缺口

1. **规范与质量生产链。** [规范依据服务](../../kun/src/engineering/survey-standard-basis.ts)明确目录没有进入受信谓词集合；[质量工作区](../../kun/src/engineering/survey-quality-workspace.ts)仍输出 `evidence-retention-only`、`humanSignatureVerification=not-evaluated`。已有材料保全、首轮抽样、限定声明评分和关联评估；[声明整改链增量](RAILWISE_SURVEY_QUALITY_WORKFLOW.md)将检查、问题、整改与复查接入独立持久化服务和桌面，源码验证通过、包验收未完成。仍缺受信规则登记/适用性/撤销、真实缺陷分类及材料语义核验、完整组织阶段、整改后重新抽样、认证签名/批准和交付门禁。[交付服务](../../kun/src/engineering/engineering-service.ts)仍生成 `reviewStatus: draft`。
2. **高级方法生产接线。** 已有一维自由水准、固定线性广义 w、独立互斥组 VCE、固定外部尺度 Huber、预声明统计族、一维参考定义、固定模型静态追加和标准椭圆。仍缺一般自由网/拟稳稳定点决策、正式网随机模型到统计家族/权重的审计接线及适用范围内完整专业判读。静态追加不支持旧观测编辑/删除、参数/基准改变、相关/非线性/动态模型；总计划未逐一定义这些扩展，须明确承诺范围，不能把整个高级方法勾完，也不能无限扩大范围。依据：[方法合同](RAILWISE_SURVEY_ALGORITHM_REVIEW.md)。
3. **监测严格重算的剩余范围。** b193fc7 已通过自己的签名包限定验收，原4368949五项复验仍不含此功能。缺原件或不支持的历史算法明确未评估，不用重新导入覆盖旧成果；全状态/键盘矩阵、专业适用性与生产批准不由选定算例通过代替。见[实现及验收合同](RAILWISE_MONITORING_REPLAY_ACCEPTANCE.md)。
4. **结果到 AI 的包内实际读回。** [Q10–Q17 历史静态缺口](RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)已由 `353d407` 补齐对应源码入口及精确只读工具，记录身份/修订/摘要和行选择绑定已回归；仍缺新签名包中的实际发送、模型工具调用及正确回答证据。Q01–Q09 也须实际读回验证，不能把按钮数量当成功率。
5. **P2。** [Survey MCP factory](../../kun/src/adapters/mcp/survey-context-server.ts)仅有只读边界和进程内 SDK 协议测试，缺认证桌面宿主、可撤销项目授权持久化、真实传输及第三方互操作。GeoCOM 手册研究没有实现实时传输/命令适配；通用 Flow 和旧监测模板没有完整 Survey 证据接线；sandbox 边界也不等于已提供逐格式验证的具体转换器。范围见[接口审查](RAILWISE_SURVEY_INTERFACE_REVIEW.md)。

## 必须保持真实的外部证据

- 用户本人对精确安装包 UI/功能确认；项目作业、质管、委托角色的真实授权/签认；签名身份和撤销状态。可以开发验证机制、模拟审查合同，不能由 agent 自称这些角色。
- 具体仪器的型号/固件/接口许可、现场响应及数值对照；公开手册只覆盖其明确版本。
- 真实生产总体、首次业务开始、失败/中断完整分母、代表性样本及正式批准时间。候选样本和合成模型不能生成生产85%、30分钟或100%达标结论。
- GSI 历史转换软件构建、配置和执行日志；已有28站112读数、14路线中间值对应属于补证，不认证历史转换过程或舍入算法。
- 发行包、资料及第三方依赖/转换器的逐项许可结论；没有违规记录不能推出违规数为零。

## 下一步与文档边界

已冻结最终包的限定监测链及重启证据已绑定精确工件；继续该包两 P0 链与跨功能恢复组合实操，再把任务39、44、45、46等软件缺口拆成独立实现与验收边界，外业/点云/长尾遵循 P0 门禁。真实材料与人审先备齐可审成果和明确待确认项，不以模拟专家意见关闭生产或签认门禁。

OpenSpec 命名段落已在 `2cc2f48` 同步用户的新品牌基线。旧[规则内核说明](RAILWISE_SURVEY_STANDARD_RULES.md)和[质检接入审计](RAILWISE_SURVEY_QUALITY_INTEGRATION_AUDIT.md)保留原始结论，并在开头提供当前实现索引。历史“无服务/无评分”不能再当作整个产品现状，后加功能也不能倒填为旧包已经实现。本清单不修改历史勾选、原始成果、公开版本或发布状态。
# 2026-09-21 状态更新

私有候选 `3f0dbf1024577b5d28db1fe1570fe2e3173ae52a` 的签名安装、updater round-trip 和包内 26 项精确引用审计已经完成。该精确成果追问增量仍缺真实候选 GUI/模型读回（含截图、错误/离线/过期/恢复、主题/窄窗/键盘/a11y 和重启）及用户本人确认。公开发布、GitHub Release、stable feed 和官网正式下载更新仍受完整发布门禁约束。这里仅描述该候选增量，不代表总计划只剩 GUI；上文 P1/P2 软件缺口、真实生产资料和专业签认仍然未完成。不能用 headless 合成审计、旧包证据或代理意见替代这些门禁。
