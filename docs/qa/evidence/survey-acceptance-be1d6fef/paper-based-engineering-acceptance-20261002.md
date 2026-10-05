# RailWise Survey 论文对照工程验收

验收日期：2026-10-02（Asia/Shanghai）  
候选源码：`be1d6fef2e070a4996c14ec9413a331292e246f0`（文档初始候选；以下“当前源码增量”晚于该 ZIP）  
候选包：`WorkWise-Candidate-be1d6fef2e07-0.5.1-mac-arm64.zip`  
角色：工程测量算法与成果审查工程师（同时审查软件实现和产品边界）

说明：本报告针对该候选源码和当前工作区的审查结果。候选包生成后又完成了来源哈希绑定和历史控制点兼容修复；这两个修复已在当前工作区通过回归测试，但尚未进入上述 ZIP，必须在下一候选重打包后重新执行安装验收。

## 研究资料

本次先阅读两篇公开原始资料，再对照当前代码。来源登记、读取范围和 SHA-256 见 [`sources.json`](../railwise-advanced-methods-20260920/sources.json)。论文不是中国工程规范、COSA/SUC 互操作证明，也不是专业签章依据。

| 资料 | 核读重点 | 对本次验收的判据 |
| --- | --- | --- |
| W. Baarda (1968), *A Testing Procedure for Use in Geodetic Networks*, Netherlands Geodetic Commission, New Series 2(5)，[公开 PDF](https://ncgeo.nl/wp-content/uploads/2024/06/09Baarda.pdf) | 摘要和多重比较段落；数据探测需要零/备择假设、显著性、功效和多重性，相关观测不能直接套逐项标准化残差 | 统计诊断必须声明模型、先验协方差、检验方向和检验家族；不可观方向应返回未评估；检测不得自动改写原始观测 |
| Michael Lösler、Cornelia Eschelbach、Rüdiger Haas (2017), *Kongruenzanalyse auf der Basis originärer Beobachtungen*, ZfV 142(1):41–52，DOI [`10.12902/zfv-0147-2016`](https://doi.org/10.12902/zfv-0147-2016)，[公开 PDF](https://geodaesie.info/images/zfv/142-jahrgang-2017/downloads/zfv_2017_1_Loesler_Eschelbach_Haas.pdf) | 增广自由网方程、基准亏损 `g`、自由度 `r=n-u+g`、两期原始观测同类分析、参考点稳定性和不可辨识边界 | 必须区分数学基准与物理稳定性；整体平移、重排、边反向应保持可估量不变量；参考点不足时只能报告未评估 |

两篇资料的本地方法摘录和限制见 [`railwise-advanced-methods-20260920/README.md`](../railwise-advanced-methods-20260920/README.md#方法输入与验收边界)。论文中的 Delft/Onsala 表值没有完整原始观测和权模型，未被当成 RailWise 金标准。

## 对照结果

### 1. 自由网和基准处理：符合试验合同，未进入生产平差

`kun/src/engineering/survey-free-leveling.ts` 实现了一个明确标为 `trial-only` 的一维独立高差自由网试算：采用 `sum-height-corrections-zero` 内约束，显式检查连通性、正权、秩、条件数和正冗余；没有固定点、伪小对角线或隐式阻尼。输出同时记录 `rank`、`datumDefect=1`、自由度、完整高程/残差协因数、残差符号和数值诊断。对应测试覆盖解析三点网、整体平移、点/观测重排、边反向、单位变换、断网、零自由度和数值边界。

这与 Lösler 论文的“显式基准亏损、不能用正则化掩盖秩亏”要求一致，且 429 项定向测试通过。该能力仍是只读试验内核，输出明确为 `modelAssumptions=not-verified`、`engineeringDecision=not-evaluated`，没有替换 `SurveyService` 的正式平差结果，也没有自动拟稳点选择。因此只能判定为“数学试验能力已具备”，不能判定为“RailWise 已完成自由网/拟稳工程流程”。

当前正式 `SurveyProfessionalReviewV1` 已新增可选 `solver` 投影，报告 `rank`、参数数、代数 `datumDefect`、约束语义和基准状态；旧记录仍可读取。`datumDefect` 明确是参数数减秩的代数量，不等价于两期自由网的 `g`、物理稳定性或规范符合性。该增量通过专业 review/numerical 21 项及 UI DOM 12 项回归，但尚未进入 `be1d6fef` ZIP，仍需新候选包复验。

### 2. 两期变形和成果追溯：来源链较完整，方法范围更窄

当前监测记录链有以下可核验行为：

- `SurveyMonitoringRecords` 要求平差结果与项目、网络修订、原文件 SHA-256、来源锚点和当前算法版本一致；初始值事件和期次比较采用 append-only 表、事件哈希和幂等键。
- 期次比较要求两个不同且按时间排序的平差运行、相同基准元数据和已知控制点，并分别保存原始观测高差与平差高差的变化；连续摘要只接受相邻期次，不能跳期拼接。
- 结果和交付报告保留每个测段的期次、平差运行、观测编号和原始记录定位，旧结果不会被当前网络编辑后的元数据覆盖。
- 本轮复核还收紧了审查投影的绑定：网络快照哈希始终由当前快照重新计算，调用方传入的 `expectedInputHash` 只能额外校验，不能覆盖实际哈希；同时保留旧快照 `pointClass=known` 的控制点语义。对应来源错绑和兼容回归已通过。

这些设计满足 Lösler 判据中“保留两期来源和随机模型绑定、不能把当前编辑后的元数据贴到历史结果”的软件层要求，也满足产品追溯和可恢复要求。

尚未满足的部分是论文方法本身：当前 `compareSegments` 仍是已绑定平差结果之间的测段高差变化比较，尚未实现基于两期原始观测的自由网增广方程、参考点稳定性检验、共同移动/多点同等解释分析。当前已增加 `observationIdentifiability`：共同控制点不足、测段未连接控制点或两期原始随机模型不完整时明确返回 `unavailable`，并纳入新结果哈希；旧比较记录继续兼容。它防止错误宣称“绝对稳定”，但不等价于论文完整同类分析，`standardsConformity` 仍为 `not-evaluated`。

当前源码随后又增加了 `rawObservationCongruence` 试算投影。它只对已选测段的两期原始观测变化使用声明的 sigma/covariance 做描述性聚类，输出“整体平移候选”“共同变动候选”或“暂不可用”，并固定为 `trialOnly=true`、`engineeringDecision=not-evaluated`。缺少共同参考点、未连接控制点、原始随机模型或测段不一致时不输出数值结论；单位未知也会阻断试算。该投影已纳入 input hash、回放和中英文结果页，并有 11 项 Runtime 回归和 UI 回归。它仍不是论文要求的两期原始观测增广自由网方程、参考点稳定性检验或正式共同移动检验，不能关闭论文方法缺口。

### 3. Baarda / 广义 w：核心数值诊断已实现，工程判定明确后置

`kun/src/engineering/survey-generalized-w.ts` 使用显式的已知先验绝对观测协方差，经 Cholesky 白化和带列缩放的 QR 投影计算广义 w；它能识别模型列空间内不可探测方向，拒绝秩亏、非正定协方差和数值不可解析状态，并输出残差协方差、可探测性比和统计误差预算。测试包含相关协方差反例，证明结果不能退化成边缘 z 分数。

`kun/src/engineering/survey-statistical-family.ts` 另外实现了预声明成员、双侧分布、显著性水平和 Bonferroni 家族分母，缺失/不可探测/数值失败成员会留在完整家族中，不会静默删除。`survey-statistical-diagnostics.ts` 的外部学生化残差也要求完整残差协因数和正的删除后方差。

这些实现与 Baarda 的方法边界一致，且本轮为广义 w 与统计家族结果增加了可追溯的统计声明块：H0/H1 范围、目标功效、模型/协方差版本、检验家族来源与 alpha/校正、人工复核状态。历史或未提供完整声明的调用会得到 `status=not-evaluated`、`targetPower=null`，不会被伪装成正式功效证明；输出仍保持 `trial-only`、`assumptionsVerified=false`、`distributionEvaluation=not-performed`、`decision=not-evaluated` 和 `observationAction=none`。声明也在高级结果页的折叠详情中展示。正式工程运行仍缺最小可探测偏差验证、项目级审批/复测闭环和真实随机模型认证。

### 4. 成果文件和 UI 审查边界

专业成果已能生成 DOCX/PDF/XLSX/manifest，并把来源、平差运行、投影哈希和原始记录定位放入报告链；报告将观测高差、平差高差、改正数、闭合项、精度和多期变化分开呈现。相关专业成果测试和服务复核已通过。

但候选 `be1d6fef` 的精确打包应用仍无法启动：`open -n` 报 `kLSNoExecutableErr (-10827)`，直接执行在 AppKit/LaunchServices 初始化阶段 `SIGABRT`，Computer Use 连接返回 `-10005`。因此本报告不能把历史候选截图当作当前包的 GUI 验收，也不能把源码测试替代当前候选的安装、主题/窗口尺寸和真实附件导入检查。启动故障诊断见 [`launch-diagnostics-20261002.md`](./launch-diagnostics-20261002.md)。

作为独立 AI 产品/工程审查，Computer Use 读取了仍可启动的历史候选 `69842e5c5376`：界面已呈现 RailWise Survey、Overview/Process/Results/Deliver 四区、当前来源/状态/最近结果摘要、成果文件（DOCX/PDF/XLSX/JSON）以及 Advanced details/Citations 抽屉。该观察支持信息架构和成果组织的源码判断，但由于不是 `be1d6fef` 包，不能关闭当前候选的 GUI 门禁。

## 判定台账

| 能力 | 论文/工程判据 | 当前证据 | 判定 |
| --- | --- | --- | --- |
| 一维自由高程试算 | 显式基准约束、秩/基准亏损/自由度、协因数、不隐藏秩亏 | `survey-free-leveling.ts` 与对应测试 | **源码试验通过；非生产能力** |
| 固定基准平差与专业投影 | 来源、单位、闭合、残差、点位精度、结果哈希、秩/代数基准缺陷 | `survey-professional-review.ts`、专业数值和成果测试 | **源码通过；规范符合性未评估；新字段未进候选包** |
| 两期来源和结果追溯 | 期次、点/观测身份、哈希、基准一致性、相邻链、原始层可辨识性状态 | `survey-monitoring-records.ts` 及测试 | **源码通过；完整自由网同类分析未实现** |
| 原始观测一致性试算 | 两期原始观测、sigma/covariance 单位转换、不可辨识/不一致阻断、明确试算边界 | `SurveyRawObservationCongruenceV1`、`compareSegments`、Survey period UI 与 11 项回归 | **源码试算通过；不等价于论文完整同类分析** |
| 广义 w / 相关协方差 | 显式先验协方差、方向可探测性、秩亏拒绝 | `survey-generalized-w.ts` 及测试 | **只读试验通过；未作工程判定** |
| 多重比较 | 预声明家族、alpha、完整分母、不可用成员留存、H0/H1/模型/复核声明 | `survey-statistical-family.ts`、高级结果页及 333 项定向测试 | **数学计算和声明投影通过；功效验证及项目审批未完成** |
| COSA/SUC 对算 | 真实厂商文件、独立金标、转换器许可和候选包导入闭环 | 当前无真实厂商授权/金标/候选 GUI 闭环 | **未完成，影响 4.2/4.4** |
| 当前候选 GUI | 安装、启动、窗口/主题、真实附件导入和 updater round-trip | 当前主机 LaunchServices 阻断 | **未完成，影响 4.2** |

## 可执行后续项

1. **P0 发布门禁**：修复或更换当前 macOS 的 LaunchServices/打包启动环境后，重新安装 `be1d6fef` 候选，补做明暗主题、1280×800/1440×900/窄窗口、键盘、附件导入和 updater round-trip；不以历史候选截图替代。
2. **P1 专业成果**：在 `SurveyProfessionalReviewV1` 增加正式结果的 `rank`、数学基准亏损及其计算依据；把“固定基准结果”和“自由网试验结果”分开显示，避免用户把 `degreesOfFreedom` 当成基准稳定性证明。
3. **P1 两期分析**：实现两期原始观测层输入、参考点稳定性/可辨识性状态和整体平移/共同移动/多点同等解释负例；参考点不足时输出 `unavailable`，不得自动给出“绝对稳定”。
4. **P1 统计闭环**：已完成结果级声明投影和向后兼容读取；下一步是把声明从试验记录接入项目级检验计划、最小可探测偏差/目标功效验证、人工复核与复测闭环，维持当前“不删除原始观测”的约束。
5. **外部证据**：使用经授权的真实 COSA/SUC/测量云文件和独立金标，完成导入、预检、平差、成果和重启恢复；论文证据不能替代该门禁。

## 结论

从工程测量算法和软件审查角度，当前源码已经形成一套有明确边界的专业处理底座：固定基准平差、来源与成果追溯、只读自由水准试算、相关协方差广义 w 和多重比较计算均有确定性测试。当前不能将候选标记为“论文方法完整实现”或“专业工程成果已签认”，原因集中在三点：正式成果尚未完整报告自由网基准亏损，期次比较尚未实现原始观测层的参考点稳定性分析，且 `0.5.1` 精确候选仍未完成可启动的打包应用验收。OpenSpec 仍应保持 **17/19**，其中 4.2 和 4.4 不应因本次论文学习而关闭。
