# Survey 界面数值、证据追问与双语文本静态清单

本清单为 R11 软件资料，基准源码为 `267aadeafebeecdbbb3bc012f3844793d060990a`，包含本次 `common:surveyEpoch` 中英文缺失键修复。日期：2026-09-20。下列行号对应基准源码；词典修复不改变组件行号。`7d4f454feecb09028007ae9b436a318db6856201` 候选包不包含该后续文案修复，本清单也没有为任何候选包增加 GUI 验收结论。

2026-09-21 增量说明：`codex/survey-result-questions` 在 `b193fc7` 基线上已完成 Q10–Q17 的 typed 引用、只读读取工具及桌面接线。下面原审计表和静态计数保留为 `267aade` 历史快照；当前实现见“Q10–Q17 增量实现索引”和[精确结果追问源码验收](RAILWISE_EXACT_RESULT_QUESTIONS_ACCEPTANCE.md)。源码和 DOM 测试通过不代表真实模型读回或本增量签名包验收完成，生产指标仍不可由按钮数量推算。

这是源码可追溯的**字段族与界面表面清单**，不统计某个项目的行数，不生成生产百分比，不证明值级来源全覆盖、英文界面无中文残留或一键追问已经实际成功。[生产指标口径](./RAILWISE_SURVEY_PRODUCTION_METRICS.md)中的对应指标仍须保留 `not-measurable`，直到补齐冻结范围与真实操作证据。接口返回结果、前端显示结果、人工签认是不同证据。

## 范围与复核方法

只读脚本 [audit-survey-ui-evidence.mjs](../../scripts/audit-survey-ui-evidence.mjs) 使用 TypeScript AST 扫描 `src/renderer/src/components/engineering/` 当前目录下所有非测试 `.ts/.tsx`，不读取用户设置、凭据、工程数据库或外业文件，不请求网络，也不启动应用。

```sh
node scripts/audit-survey-ui-evidence.mjs --summary
node scripts/audit-survey-ui-evidence.mjs
```

完整 JSON 包含逐项 `path/line`、输入文件 SHA-256、当前 Git HEAD、字面调用、动态调用原表达式、词典候选字符串和非翻译 JSX 候选。脚本记录工作树实际字节，因此 HEAD 相同但未提交文件不同仍可区分。它不把目录外共用组件、Runtime 返回文案或任意表达式中的字符串自动认定为已经覆盖。

本次 `sourceSetSha256` 为 `17963f6ddfc498670b050b9ece810d6861f0eff2a12b21f95a1c62a8d59d4cb1`，计算方式是对脚本固定顺序的 `sourceFiles`（path/sha256 数组）执行 JSON.stringify 后取 SHA-256。复核时应同时匹配源集合摘要；后续源码变更需要重扫，不能沿用这里的数量。

数值来源分类：`R` 为 Runtime 计算或验证结果；`D` 为原始资料或调用者输入/声明（经 Runtime 保存也不自动变成计算值）；`F` 为前端计数、选择、格式化或布局变换；`M` 为版本、时间、文件大小、哈希等审计元数据。`R(D)` 特指 Runtime 对调用者声明的模型/检查资料进行计算，不表示模型假设、资料真实性或专业签认已验证。

## 数值字段清单

以下按字段路径/族列举，不按运行时数组元素重复计数；未显示的完整对象另列为审计 JSON。每项只声明可见来源，不把有限字段族称作全部导出文件的值级审计。

| ID / 可见表面 | 数值字段或表达式 | 来源、变换与限制 | 源码定位 |
| --- | --- | --- | --- |
| N01 工程摘要条 | 点数、测站数、观测数；选定闭合差；最大点位标准差 | 点数用 known/unknown ID 集合去重；测站优先 source.summary，缺失时由 station/from 去重；观测优先 source.summary，缺失时取数组长度，均为 D/F。闭合差/精度为 R；前端按网型择一显示，并不重算。 | [Workspace:597](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L597)、[summary:7](../../src/renderer/src/components/engineering/survey-summary.ts#L7)、[摘要显示:910](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L910) |
| N02 仪器文件预检/来源 | source.size、recordCount、summary 的 pointCount/stationCount/observationCount/recordCount/skippedRecordCount；detection.confidence；诊断阻断/警告数 | 文件/解析器 M/D；大小除 1024 并本地化；置信度乘 100 后 round 是 F，不是正确率；诊断数量由当前数组过滤。格式检测卡与已导入资料摘要不可合并成生产任务数。 | [Panel:749](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L749)、[检测摘要:796](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L796) |
| N03 源记录定位 | sourceRecord、byteOffset、rawOffset/rawLength、记录号；原文 snippet | M/D，定位到原始资料；显示原文内的数字不表示重新计算。 | [Panel:766](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L766)、[源锚点:773](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L773) |
| N04 观测/控制点输入 | observation.value；GNSS 时 vectorX/vectorY/vectorZ；sigma；GNSS 协方差“已提供/缺失”；point.height；已知点输入；revision | 观测及控制点 D，显示值为 F 格式化；协方差页面只判断长度是否为 9，不能当矩阵正定性验收。已知点、COSA 映射、单位/基准输入是调用者声明。 | [观测显示选择:153](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L153)、[输入:662](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L662)、[观测表:677](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L677)、[点表:679](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L679)、[COSA:39](../../src/renderer/src/components/engineering/CosaIn1MappingForm.tsx#L39) |
| N05 网络概览/拓扑 | known/unknown/observations 数组长度、points.length、blockers；图中 index+1、SVG x/y | 数量 F，不能混同 N01 去重口径。全部点有有限 X/Y 才分别按范围归一化，否则使用网格布局；边由真实观测端点 ID 连接。图像位置是 F 示意坐标，不能读取为工程坐标或比例尺。 | [Panel:317](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L317)、[统计:675](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L675)、[topology:52](../../src/renderer/src/components/engineering/survey-topology.ts#L52) |
| N06 平差摘要 | observationCount、unknownCount、redundancy、degreesOfFreedom、unitWeightStdDev、varianceFactor、precision.maxPointStdDev | R；degreesOfFreedom 缺失时显示 redundancy 是前端兼容选择。来源准入必须由服务 `sourceEligibility.eligible === true` 提供，旧结果不以本地猜测补齐。 | [Panel:325](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L325)、[统计:692](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L692) |
| N07 残差/闭合差/参数 | observations[].residual/standardizedResidual；closure.horizontal/angular/vertical/heightDifference/fx/fy/relativeClosure/baseline/baselineX/Y/Z；parameters[k] 及单位 | R；`abs(standardizedResidual)>3` 高亮是 F 展示规则。参数 key 除 orientation 映射外可原样显示；闭合差组合选择不产生新解。 | [Panel:694](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L694)、[闭合差:695](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L695) |
| N08 点位成果/误差椭圆 | point.x/y/latitude/longitude/height、correctionHeight/X/Y、standardError、xyErrorEllipse.semiMajor/semiMinor/orientationRad；outlierCount | R；改正值仅选 `correctionHeight ?? correctionX ?? correctionY`，不是三维改正模长；方向弧度乘 180/π、结果表小数位、筛选 `outlier || abs(standardizedResidual)>3` 计数为 F。 | [Panel:813](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L813)、[点位行:824](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L824) |
| N09 期次变形比较 | durationDays；points[].dX/dY/dH/settlement/horizontalDisplacement/spatialDisplacement/rates.spatialPerDay；pairs[].differentialSettlement/convergence/tilt/convergenceRatePerDay | R；点数、点对数、significant 过滤数为 F；沉降/收敛列的 `??` 是值选择。trend/significant 为 Runtime 输出，不由 UI 审查员确认。 | [Panel:706](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L706)、[变形表:707](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L707) |
| N10 统计诊断 | fullModelDegreesOfFreedom、degreesOfFreedom（删除模型）；observation residual、externallyStudentizedResidual、redundancy | R，绑定 project/network/run/result/inputHash/algorithmVersion/sourceSha256；模型假设未验证和 unavailable 分支必须保留。source locate 不是追问。 | [Diagnostics:97](../../src/renderer/src/components/engineering/SurveyStatisticalDiagnostics.tsx#L97)、[行表:114](../../src/renderer/src/components/engineering/SurveyStatisticalDiagnostics.tsx#L114) |
| N11 自由水准试算 | rank、degreesOfFreedom、datumDefect、posteriorVarianceFactorEstimate；点 referenceHeight/correction/height；观测 heightDifference/adjustedHeightDifference/residual/weight | 参考值与初始角色 D，Runtime 试算 R(D)，权重依据/缺省权重必须可见；零初值标识不能当真实高程；试算与正式生产解分开。历史 df/revision/time/hash 为 M。 | [Free:129](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx#L129)、[结果:139](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx#L139)、[观测:151](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx#L151) |
| N12 广义 W 试算 | rank/df/aprioriWeightedResidualSum；generalizedW/detectabilityRatio/statisticErrorEstimate；parameters、residuals、residualCovariance；whiteningConditionEstimate/designConditionEstimate | R(D)，输入参数单位和方向族由调用者声明；未解析方向不填零。此页不作粗差删除或工程显著性判定。 | [AdvancedResult:24](../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx#L24) |
| N13 方差分量试算 | 声明 initialVariance/maxIterations/relativeTolerance；convergedVariances、finalFit.parameters/residuals；iteration/relativeChange/currentVariances/candidateVariances；functionalNormalConditionInfinity/stochasticNormalConditionInfinity | 声明 D，结果 R(D)；非正分量和未收敛保留。候选分量不能冒充已接受最终方差。 | [Workspace:176](../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx#L176)、[VCE:40](../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx#L40) |
| N14 Huber 试算 | scale.value、loss.k、停止阈值/maxIterations；acceptedParameters；iteration/objective/normalizedScoreInfinity/scoreRoundoffEstimate/standardizedPredictionStep/relativeObjectiveChange；residuals/standardizedResiduals/robustMultipliers/derivedIrlsWeights | scale/停止条件 D；各迭代与接受参数 R(D)。权重降权不等于测量自动作废，唯一性条件由返回状态说明。 | [Huber:62](../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx#L62) |
| N15 预声明统计族 | denominator、alpha/memberAlpha；成员声明 statistic/df/priorStandardDeviation；pValue/adjustedPValue/criticalMagnitude/numericalResolutionInterval | statistic、分布与原始尺度 D；概率和临界区间 R(D)，denominator 不因 unavailable 成员而变成仅成功成员数；数值边界不可强制二分。 | [Family:89](../../src/renderer/src/components/engineering/SurveyAdvancedModelResult.tsx#L89) |
| N16 指定参考基准比较 | referenceShift/referenceShiftVariance；rawDifferences/referenceWeights/displacements/shiftDisplacementCovariance；differenceCovariance/displacementCovariance；coordinateRoundoffEstimate/covarianceRoundoffEstimate | R(D)；参考集合、两期映射与独立性/跨期协方差均为调用者声明；不认证参考点稳定性。 | [Reference:22](../../src/renderer/src/components/engineering/SurveyReferenceDatumResult.tsx#L22) |
| N17 静态追加试算 | 基础/追加/总观测数与revision；baseFit/updatedFit/batchCheck.referenceFit.parameters；aprioriParameterCovariance；SSE/df/posteriorVarianceFactorEstimate；各步 totalObservationCount/transformedResidual/accumulatedResidualNorm/rotationCosines/Sines；最大缩放差、容差；base/updated QR状态 | 模型/追加观测 D，计数 F；QR更新与批量对照 R(D)。这是静态声明追加，不是仪器实时连接或流式生产链路；完整 QR JSON 单列审计，不能把其中所有浮点数算作已逐项核对。 | [Static:20](../../src/renderer/src/components/engineering/SurveyStaticIncrementalResult.tsx#L20)、[结果:30](../../src/renderer/src/components/engineering/SurveyStaticIncrementalResult.tsx#L30) |
| N18 质量抽样 | population.unitCount、run.sampleSize；batchIndex+1、batchSize/sampleSize/nominalTableSampleSize；列表从 offset+1 开始编号，batchIndices+1 | 总体 D；样本选择和样本量 R(D)；显示序号/分页 F。Runtime 随机来源与总体冻结不能证明现场空间均匀、样本真实性或人员检查。 | [Sampling:74](../../src/renderer/src/components/engineering/SurveyQualitySamplingWorkspace.tsx#L74)、[总体:106](../../src/renderer/src/components/engineering/SurveyQualitySamplingWorkspace.tsx#L106)、[抽样结果:120](../../src/renderer/src/components/engineering/SurveyQualitySamplingWorkspace.tsx#L120) |
| N19 质量评分 | score/rawScore/fixedADeduction/diagnosticScoreUpperBound/excellentRate/excellentGoodRate；batch count；checked/pending/excluded 子项；原始/有效权重与逐节点结果 | R(D)，分数和权重保持 numerator/denominator 有理数文本，不能转 Number 后悄悄舍入。声明缺陷、等级与既有检验结论的真实性不由计算器认证。 | [ScoringResult:8](../../src/renderer/src/components/engineering/SurveyQualityScoringResult.tsx#L8)、[输入/审计:133](../../src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.tsx#L133) |
| N20 质量检查资料/评定关联 | 材料 sizeBytes；事件序列/数量；assessment.result.counts；每单位 score numerator/denominator；抽样单位数量 | 文件大小/事件 M；材料声明 D；关联与计数 R(D)/F。retentionCoverage、scoreCoverage 是状态枚举，不能冒充生产覆盖率百分比；reviewStatus 文本不等于可验证的人审签名。 | [Quality:90](../../src/renderer/src/components/engineering/SurveyQualityWorkspace.tsx#L90)、[事件:133](../../src/renderer/src/components/engineering/SurveyQualityWorkspace.tsx#L133)、[Assessment:62](../../src/renderer/src/components/engineering/SurveyQualityAssessmentWorkspace.tsx#L62) |
| N21 监测工作流兼容页 | currentValue/cumulativeChange/changeRate；normal/warning/alarm/control/unresolved 数量；阈值文本 | 数值分析 R，阈值 D，按 thresholdStatus 分组 F。Survey-only 总览有独立分支，不以监测零数量表示 Survey 校核通过。 | [Workspace:574](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L574)、[Survey分支:877](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L877)、[阈值:990](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L990)、[分析:1024](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1024) |
| N22 总览/数据/交付及导航计数 | datasets+networks、blocking/warning findings、观测数、manifests、outputs/warnings、文件 sizeBytes、项目/会话数量、计划完成步骤/总步骤 | 从接口数组/状态计算 F；size/hash/revision/time 为 M。formatBytes、日期和数字本地化不是成果重算；预览文件不等于批准交付。 | [Workspace:956](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L956)、[数据:995](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L995)、[复核:1058](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1058)、[Sidebar:142](../../src/renderer/src/components/engineering/EngineeringSidebarContent.tsx#L142)、[Plan:278](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx#L278) |
| N23 规范依据/复验 | 条款/表号、PDF页/印刷页、rule/profile/algorithm版本；checkedAt；各 check 的状态 | 官方来源定位与版本 M，checks 为 Runtime 验证 R；PDF页不是公式输入，复验状态也不表示人工签认。 | [StandardBasis:61](../../src/renderer/src/components/engineering/SurveyStandardBasis.tsx#L61)、[Verification:35](../../src/renderer/src/components/engineering/EngineeringManifestVerification.tsx#L35) |
| N24 原始/规范化/结果审计JSON | declarationJson、declaration、requestJson、result、replayEnvironment、各类摘要与历史版本 | 混合 D/R/M，不将整个 JSON 归为 Runtime 原创数字。示例按钮提供 synthetic seeds，不能混入真实外业来源；须逐路径区分 input 和 output。 | [Advanced示例:32](../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx#L32)、[审计:179](../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx#L179)、[Scoring审计:141](../../src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.tsx#L141) |
| N25 AI 计划/建议/证据回传 | step.parameters JSON、建议 before/patch JSON、expectedRevision、evidenceCards.length、card.summary 及会话正文中的任意数字 | 参数/建议是尚待执行或确认的声明，不能标为已计算成果；计数 F、修订 M。卡片摘要与 AI 文本中的数值仍须读回所引用的 Runtime 记录，不能仅凭出现在工程会话里判为 R。 | [Plan:347](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx#L347)、[卡片:363](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx#L363)、[建议:51](../../src/renderer/src/components/engineering/EngineeringProjectSuggestions.tsx#L51) |

数据链的复核入口：[基础平差服务](../../kun/src/engineering/survey-service.ts#L1468)产生标准平差结果；[高级试算客户端](../../src/renderer/src/agent/survey-advanced-trials-client.ts#L84)核对声明/结果绑定，[高级试算服务](../../kun/src/engineering/survey-advanced-trials-workspace.ts#L100)按 kind 执行并在读取时复算；[质量评分服务](../../kun/src/engineering/survey-quality-scoring-workspace.ts#L138)复算声明结果；[抽样内核](../../kun/src/engineering/survey-quality-sampling.ts#L64)计算抽样。前端读到 R 只说明服务合同来源，本清单没有独立重算每个显示值。

## 证据追问表面清单（历史基准）

以“表面类型 + 证据粒度”记录候选分母。没有按钮的结果表面照常列入，不为提高覆盖率排除；输入/审计资料另标边界。这里的“有专用入口”仅为静态接线证据，全部 GUI 操作结果均为**未测**。

| ID / 表面 | 源码中的动作与粒度 | 传递证据或缺口 | 定位 |
| --- | --- | --- | --- |
| Q01 文件解析诊断 | 前 20 条可见诊断各有追问；属于来源证据 | section=preflight，diagnosticCode/index、sourceRecord/byteOffset、sourceRecordId，外加当前网络/项目上下文；超过 20 条没有在此列表逐条显示 | [Panel:669](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L669)、[诊断按钮:763](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L763) |
| Q02 缺失资料规划 | 来源处置不允许计算时专用按钮；属于补资料动作 | section=preflight，当前网络上下文；不是独立结果行标识 | [Panel:675](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L675) |
| Q03 原始观测行 | 每行专用追问；属于输入证据 | observationId/sourceRecordId；继承当前 section=observations | [Panel:383](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L383)、[观测表:677](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L677) |
| Q04 平差总体精度 | 有专用追问 | metric=precision；不能自动认为所有统计量有独立字段级追问 | [Panel:693](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L693) |
| Q05 平差残差行 | 每行追问及原始记录定位为两个独立动作 | observationId/sourceRecordId + 当前 adjustmentId；继承当前 section=result；不附残差数值快照，须读回对应运行 | [Panel:694](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L694) |
| Q06 闭合差/参数面板 | 面板级追问 | metric=closure；不是每个 parameters[k] 独立入口 | [Panel:695](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L695) |
| Q07 点位成果表 | 每点专用追问 | section=result、pointId、metric=point-precision；点成果表共用底部区域，不等于原始点表具备按钮 | [Panel:714](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L714)、[点位按钮:824](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L824) |
| Q08 交付预览/最新清单文件行 | 每文件专用追问 | section=deliverables、runId、outputPath/outputSha256；预览没有 manifestId，最新清单文件带 manifestId | [Workspace:1029](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1029) |
| Q09 历史交付清单 | 清单级专用追问；文件子行仅定位锚点 | section=review、manifestId/runId/reviewStatus；该按钮不带所选 outputPath/hash | [Workspace:1058](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1058) |
| Q10 原始控制点/拓扑及网络摘要条 | 无该表面逐点/逐数字追问 | 通用“问智能体”只打开 AI，不等于显式选择当前字段证据；Q07 不能代替原始控制点入口 | [Panel:651](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L651)、[拓扑:679](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L679) |
| Q11 期次比较点行/点对行 | 无专用追问 | 现有 evidence 类型没有 deformationId/点对ID；当前平差证据不能自动代表所比较的两期 | [Panel:707](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L707)、[证据类型:5](../../src/renderer/src/components/engineering/engineering-conversation-drafts.ts#L5) |
| Q12 统计诊断 | 读取、导出、原始记录定位；无追问回调 | 不能把定位按钮记为提问成功 | [Diagnostics:80](../../src/renderer/src/components/engineering/SurveyStatisticalDiagnostics.tsx#L80)、[定位:119](../../src/renderer/src/components/engineering/SurveyStatisticalDiagnostics.tsx#L119) |
| Q13 自由水准试算 | 创建、历史恢复、定位；无专用追问 | 没有 trial 记录级追问接线，也没有此页独立导出按钮 | [Free:119](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx#L119)、[定位:151](../../src/renderer/src/components/engineering/SurveyFreeLevelingTrial.tsx#L151) |
| Q14 六类高级试算 | 广义W、VCE、Huber、统计族、参考基准、静态追加均无专用追问 | 可复验、导出、展开迭代/原始输入/审计；缺 trialId/kind/成员或迭代证据的提问接线 | [AdvancedWorkspace:169](../../src/renderer/src/components/engineering/SurveyAdvancedModelWorkspace.tsx#L169) |
| Q15 质量抽样/评分/检查资料/评定关联 | 无专用追问；保留、复验、导出、分页和材料定位属于别的动作 | plan/run/scoring/assessment/material 的记录级提问合同尚未接线 | [Sampling:120](../../src/renderer/src/components/engineering/SurveyQualitySamplingWorkspace.tsx#L120)、[Scoring:133](../../src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.tsx#L133)、[Quality:120](../../src/renderer/src/components/engineering/SurveyQualityWorkspace.tsx#L120)、[Assessment:62](../../src/renderer/src/components/engineering/SurveyQualityAssessmentWorkspace.tsx#L62) |
| Q16 严格复验检查项/规范依据 | 复验按钮、PDF外链；无逐检查/逐条款追问 | 链接官方PDF不等于上下文已注入 AI | [Verification:53](../../src/renderer/src/components/engineering/EngineeringManifestVerification.tsx#L53)、[StandardBasis:65](../../src/renderer/src/components/engineering/SurveyStandardBasis.tsx#L65) |
| Q17 监测分析及质量发现 | 原监测结果行、质量发现无专用证据追问 | 通用工程会话入口不能计为每行覆盖 | [Workspace:1001](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1001)、[分析:1024](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L1024) |
| Q18 AI 证据回传卡/计划步骤 | navigationButton 定位到工程证据；不是再提问按钮 | 源码有证据导航目标解析，不能把“从 AI 定位到结果”计作“从结果携带证据追问” | [Plan:351](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx#L351)、[卡片:363](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx#L363) |

共同链路：[askAboutEvidence](../../src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx#L370) 要求 workspace/network/onOpenAi，附 project/revision、network/revision、source SHA、parser id/version/sourceHash、当前 adjustmentId/algorithmVersion；交付使用 [askAboutDelivery](../../src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx#L853)。[prepareEngineeringQuestion](../../src/renderer/src/components/engineering/engineering-conversation-drafts.ts#L54)只设置工程作用域内的会话草稿与 evidenceContext，不立即发消息；已有非空输入保留。导航仅更新 viewContext，显式 evidenceContext 保留。

[EngineeringComposer.send](../../src/renderer/src/components/engineering/EngineeringComposer.tsx#L91) 优先 evidenceContext，将其 JSON 加到实际提示中，而 displayText 只展示问题正文；成功发送才按对象身份清除所发送的证据与附件，失败保留草稿。上下文只是引用，提示明确要求重新读取当前记录，不是执行批准。静态代码无法证明实际发送、当前线程匹配、服务读回、错误恢复与 AI 正确引用均已完成。

## Q10–Q17 增量实现索引

下表是 2026-09-21 未提交源码增量的实现状态，逐行替补上方历史 Q10–Q17 缺口；不覆盖历史记录。共同入口为 [EngineeringEvidenceQuestion](../../src/renderer/src/components/engineering/EngineeringEvidenceQuestion.tsx)，引用合同为 [SurveyEvidenceReferenceV1](../../kun/src/contracts/survey-evidence-reference.ts)，只读工具为 `survey_read_evidence`。所有引用绑定项目修订号和相应记录身份，点击仅准备草稿，必须显式发送后才能进入工具读取流程。

| ID | 当前源码接线与粒度 | 证据及限制 |
| --- | --- | --- |
| Q10 | 来源摘要、拓扑标题选择完整网络；控制点表逐行选择原始 known/unknown 点。 | 网络 ID/revision/source SHA + collection/index/id；重复点号按真实位置选择，不宣称每个拓扑像素或摘要数字均有入口。 |
| Q11 | 期次比较点行、点对行专用入口。 | comparisonId、两期 adjustmentId、inputHash/algorithmVersion + point/pair selector；项目或修订变更后旧结果隐藏。 |
| Q12 | 完整诊断及每个观测行。 | 网络绑定、adjustmentId、inputHash/calculationHash/diagnosticsVersion；定位和下载仍是独立动作。 |
| Q13 | 完整自由水准试算及输出点/观测行。 | trialId/recordHash、网络绑定及 `.output` 选择路径；本增量没有增加独立导出功能。 |
| Q14 | 六类完整试算记录，以及广义 W 方向、VCE/Huber 迭代、统计族成员、参考基准完整结果、静态追加步骤。 | trialId/recordHash + `.result` 路径/行身份；完整记录入口不表示所有矩阵单元格有独立按钮。 |
| Q15 | 抽样总体/运行/分页单位及样本；评分字段/trace；保留计划/成员/检查/事件；评定计划/结果/单位/材料。 | 各类 plan/run/record 哈希与实际 selector；分页使用绝对索引，声明真实性和专业复核仍未由工具认证。 |
| Q16 | 保存的旧复验 check、新监测复算 attempt、规范整体及 rule/profile locator。 | manifest/checkedAt 或 attemptId；规范版本、ruleDigest、来源和关联父记录；规范解析不等于标准符合性。 |
| Q17 | 数据集整体、质量发现行、分析结果行。 | dataset revision/source hash 或 analysis inputHash/algorithmVersion，配合 finding id 或 monitoringItem/point。 |

验证状态：完整 desktop 2850 项通过、2 跳过，Runtime 2929 项通过、22 跳过；类型检查、构建及 lint 无错误。首次 PDF 共享依赖目录拒绝的 3 项失败与仅放行依赖读取后的完整复验日志都保留在[源码验收证据](evidence/railwise-result-questions-source/README.md)。真实外部模型调用、准确回答引用、本增量独立签名安装包和用户验收均**未完成**。旧 Q01–Q09 的历史包证据也不自动覆盖新引用链。

## 双语文本的静态分母

扫描范围为 21 个生产 TSX 和 14 个本地 TS helper。字典扫描含 common、qualityScoring、qualityAssessment、standardBasis 四个 namespace；common 包含其他产品页，因此不能将其全部键数当工程页的可见分母。

| 可复核集合 | 本次实际数量 | 解释 |
| --- | --- | --- |
| 字面 `t('key')` 调用位置 | 1233 | 每个源码调用位置一次；同一 key 可重复，条件分支未证明到达 |
| 动态 `t(expression)` 调用位置 | 134 | 单独保留表达式；模板、映射、条件、运行时枚举均需展开验证 |
| 非直接调用、与当前 namespace 词典匹配的字符串候选位置 | 441 | 包含 map/数组里的候选 key，也可能是同名普通字符串；不表示全部实际翻译调用 |
| 字面调用与上述候选的唯一 namespace:key 并集 | 1338 | 有界静态候选集，不是 GUI 可见文本总数 |
| 上述集合缺中文/缺英文的键 | 0 / 0（修复后） | 修复前 `common:surveyEpoch` 两边共同缺失；仅做字典键对齐会漏掉此问题 |
| 上述集合英文值含 Han 字符的键 | 0 | 仅词典字面值字符检查；不含动态插值、错误、原文或目录外组件 |
| 非 `t` 的静态 JSX 文本/aria-label/title/placeholder/alt 候选 | 171 | 包括符号、单位、哈希标签与输入示例；不能把候选总数视为缺陷数 |
| 四个完整 namespace 的中/英文叶子数 | common 3407/3407；qualityScoring 153/153；qualityAssessment 92/92；standardBasis 28/28 | 只说明键集合对齐，不说明翻译正确、实际可达或动态键存在 |

扫描发现 `EngineeringWorkspaceView.tsx:995` 调用的 `surveyEpoch` 没有中英文值，本次补为“观测期次 / Observation epoch”。[i18n 初始化](../../src/renderer/src/i18n.ts#L15)还会覆盖品牌字段并注入 productName/runtimeName，不能仅凭 JSON 原始值确认最终渲染结果。

必须保留的文本边界：

| 类别 | 是否进入产品文案检查 | 核查依据 |
| --- | --- | --- |
| 标题、按钮、表头、空态、禁用原因、错误/恢复、aria-label、tooltip、分页/历史、下载结果提示 | 是；动态状态也要纳入 | 完整脚本 `literalCalls/dynamicCalls`。qualityScoring 的 metrics/states/reasons/grades/nodes，qualityAssessment 的 states/manifest/scope/outcome/material/profiles/stages/modes，standardBasis.errors 均有动态引用；跨 namespace `qualityScoring:reasons.*` 也须复查。 |
| Runtime 生成诊断、门禁理由、系统枚举、失败技术详情、系统能力/技能目录说明 | 是，不能因为来自服务就当用户原文排除 | [survey-diagnostic-text:24](../../src/renderer/src/components/engineering/survey-diagnostic-text.ts#L24)模板适配、嵌套诊断参数白名单与 [unknown fallback:84](../../src/renderer/src/components/engineering/survey-diagnostic-text.ts#L84)；未知文本保留原文，因此仍可能有中文。复验技术详情 [Verification:51](../../src/renderer/src/components/engineering/EngineeringManifestVerification.tsx#L51)直接展示错误；[Skills:29](../../src/renderer/src/components/engineering/EngineeringSkillsPanel.tsx#L29)直接展示 capability.label/reason 和 skill.name/reason，应检查服务输出。 |
| 工程名、点名、文件名、路径、用户输入、源记录原文、用户规范引用、modelBasisStatement、sourceAnchor、外部材料标题/locator、原始声明 JSON | 原始内容排除；其周围的产品标签不排除 | 要逐字段证明是原始/调用者内容；不得把整条含系统提示的字符串都排除。诊断模板非白名单参数按原始证据保留。 |
| AI 自由生成的解释、用户消息和附件摘录 | 单独内容来源，不视为静态 UI 词典覆盖 | 不以 AI 输出语言证明产品本地化；计划状态/等待理由等系统文案仍在产品范围。 |
| ASCII、GB18030、GNSS、SHA-256、m、B、cos/sin、字段名、单位、符号与数学变量 | 逐项标注保留理由 | `untranslatedJsxCandidates` 包含 `dX / dY / dH（m）`、`sourceRecordId：` 等全角符号；“无 Han 字符”不等于英文排版已经验收。 |
| 公用 FloatingComposer、聊天消息/计划/工具卡、模型选择器、文件对话框、设置以及目录外组件 | 本脚本未完整枚举；实际出现时仍需纳入英文可见状态分母 | [Composer:120](../../src/renderer/src/components/engineering/EngineeringComposer.tsx#L120)和 [AiCommandCenter](../../src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx)调用外部组件，不能用工程目录统计代替整个窗口。 |
| 规范依据的 rule/profile/locator 双语正文 | 产品说明，纳入；不由 common JSON 覆盖 | [StandardBasis:53](../../src/renderer/src/components/engineering/SurveyStandardBasis.tsx#L53)直接使用 Runtime 返回的 `[language]`，还需核验服务资料与失败分支。 |

静态脚本不解析任意数据流、任意 `t` 别名或目录外传入的 key；未找到显式 useTranslation 的 helper 暂按默认 common 记录。候选字符串不是可达性分析，171 个 JSX 候选也不包含所有 JSX 表达式内部组合出的字符串。以上边界是待补测项，不能从分母中悄悄删除。

## 从静态清单到操作证据

每次操作记录需绑定包版本/源码/ASAR、语言/主题/窗口尺寸、工程和网络/结果身份（对外只输出脱敏引用或摘要）、表面 ID、前置状态、实际按钮与发送后的证据 JSON。数值核验按 Nxx 记录 Runtime 原值、声明原值、前端变换及显示值；追问按 Qxx 分别记录缺按钮、禁用、准备草稿、发送、服务读回及回答引用，不能只截“已打开 AI”。

最少应覆盖已有草稿、导航后显式证据保留、不同项目/工作区、离线、过期 revision、源证据撤销、服务失败与恢复、长文本/空值/不可计算、历史恢复、窄窗口和中英文切换。尚无入口的结果表面应保持缺口状态，新增接线后再冻结新版本清单并实测。此项并不重写历史候选证据，也不替代用户对安装包的 UI 和功能确认。
