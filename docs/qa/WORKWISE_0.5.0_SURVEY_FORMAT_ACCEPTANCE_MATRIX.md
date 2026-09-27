# WorkWise 0.5.0 测量源格式验收矩阵

状态索引更新至源码 `281dc87672509de147357efc3aabbeae0eb4dbcb`（2026-09-20）；Task 36 未完成。下方 26 行保留 2026-09-10 的格式/测试基线，后续实机状态以“截至 281dc87 的当前状态索引”为准；不把历史包证据改写为新包验收。

## 截至 281dc87 的当前状态索引

最新已归档的同包真实 P0 GUI 证据是 [6ff82c8 精确候选](./evidence/railwise-convergence-6ff82c8c2746/README.md)，不是 912e4d30b065。其 [最终 GUI 索引](./evidence/railwise-convergence-6ff82c8c2746/gui-acceptance.json) 与 [P0 聚合核验](./evidence/railwise-convergence-6ff82c8c2746/p0-summary.json) 绑定源码 `6ff82c8c27466ee42f2604b053397fd132d5a0a7`、ASAR `ba7edf57c3afe50473a633700a96898c773a4ab42b255eb42c9da91e2e3ebe4d` 和算法 `workwise-survey-adjustment-7`。

| 记录 | 当前已有证据 | 仍未证明 |
| --- | --- | --- |
| `FMT-COSA-IN2` | `PACKAGED_GUI_SELECTED_WORKFLOW`：本包实际 GUI 导入、预检、平差、三格式成果及草稿清单；33 点/160 观测/174 锚点/87 自由度。独立原 OU2 比较 33 点，印刷舍入和精度包络各 0 不匹配；最大平面差 `0.06341583922171747 mm`，最大组合归一化差 `0.08899925199598996 sigma`（比较包络为 1 sigma）。 | 不是全部 IN2 方言或历史左右线样本的通过证明；完整主题/窗口/键盘覆盖、专业签认及个人确认未闭合。 |
| `FMT-LEICA-GSI` | `PACKAGED_GUI_SELECTED_WORKFLOW`：同包实际 GUI 导入、显式控制高程、预检、平差、三格式成果及草稿清单；27 点/28 观测/156 锚点/7 自由度。独立参考 IN1 比较 7 未知端点和 6 控制点，最大高程差 `0.02031550931747006 mm`；从原 GSI 重建同源 21 未知点解，与包结果最大差 `1.7053025658242404e-10 mm`。 | 只覆盖所用 GSI8 WI41 样本，不推广为所有 GSI8/GSI16。参考 14 路线中 7 条高差超半个印刷单位，`heightConversionProvenance=unresolved`；数值精度包络通过不能替代来源复核。 |
| `FMT-COSA-OU2` | `READ_ONLY_REFERENCE_COMPARED`：已在上述 IN2 样本完成独立只读比较；“真实 IN2 尚未执行 OU2 比较”不再是当前状态。 | 始终只读参考、`archive-only`，没有成为平差输入，也未做 OU2 独立导入 GUI 验收。 |
| 其余 23 条记录 | 保留下方历史行的已证范围；本次没有为它们追加新实机证据。 | IN1、M5、South DAT、私有转换器和 GNSS 等均不因两份 P0 样本升级。 |

两份本包草稿共有六个实际 DOCX/PDF/XLSX 文件，哈希/长度与保全源字节、原始锚点及观测关联均核对；退出并重启后两清单再做五项复验，持久记录共 4 次成功，每次 5 项通过。它们不是 20 个独立生产样本，也不是审批后的正式交付。

本包中文浅色/英文深色、常规与近最小截图已有证据，但 `963×641` 是图片像素，未独立确认原生窗口下限；完整 locale/状态/a11y 未完成。签名、公证与真实私有 HTTPS updater 往返见同包索引，均不授予公开发布批准。281 的安装包及其新增关联评估不能沿用 6ff 的 GUI 结论。当前仍没有任何格式行达到下述 `ACCEPTED` 总门禁。

## 目的与边界

本矩阵把测量格式的“有界识别/解析”与“真实工程可验收”分开记录。它是
`workwise-0-5-0-engineering-delivery` 中专业测量源格式任务的可审计
验收清单，不扩大任何格式的运行时权限，也不替代专业人员的成果复核。

格式支持不以厂商授权转换器为前提。私有二进制格式需要的是用户本地提供、
版本和哈希固定、无网络执行且可审计的转换链；真实工程验收需要可授权使用的
输入、独立数值参考和候选包内的实际操作证据。两者均不能由格式扩展名、
合成 fixture 或公开研究样本替代。

## 字段与判定规则

### Evidence class

| 值 | 含义 | 不表示 |
| --- | --- | --- |
| `semantic-parser` | 有界解析器生成带单位、原始记录锚点和负向测试的结构化点位/观测。 | 厂商互操作或生产验收。 |
| `read-only-comparison` | 严格读取已有成果表，仅用于与 WorkWise 成果比较。 | 该结果文件可作为平差输入。 |
| `inspection` | 有界提取结构、来源或物理锚点，不生成基线观测。 | GNSS 后处理、基线解算或调整来源。 |
| `detection-only` | 只识别内容特征或扩展名，安全保留/阻断原件。 | 厂商字节语义已经被解析。 |
| `converter-boundary` | 只接受本地用户提供、白名单、哈希固定、无网络的已审计转换器；安装包不含厂商二进制。 | 已有可用的厂商转换器或转换后的生产验收。 |

### Task 36 acceptance gate

某一行只能标记为 `ACCEPTED`，当且仅当下列记录均存在且相互可复算：

1. 该行的正向/黄金和负向/资源上限证据均已指向具体测试或不可变证据。
2. 有可授权使用的真实或脱敏工程输入、来源哈希、单位/基准/映射声明，以及独立数值参考；参考比较覆盖闭合量和精度，而不只是“成功解析”。
3. 使用同一候选应用包完成导入、预检、确定性平差、DOCX/PDF/XLSX/manifest，且保留候选包版本、ASAR 哈希、实际 GUI 操作和界面截图。
4. 对 GNSS，输入已先形成固定基准且具完整协方差的基线向量；对私有二进制格式，转换器来源、版本、哈希、参数和网络隔离记录完整。

`adjustment-ready`、`archive-only`、`gnss-processing-required` 和
`converter-required` 是当前 Runtime 安全处置，不是 Task 36 验收状态。
`detection-only`、`inspection`、`read-only-comparison`、`archive-only`、
`gnss-processing-required`、`converter-required` 均不得被解读为“厂商互操作”或
“可直接平差验收”。截至本矩阵日期，**没有任何格式行达到 `ACCEPTED`**。

### Candidate status values

| 值 | 含义 |
| --- | --- |
| `NO_PACKAGED_GUI` | 没有该格式的打包候选 GUI 操作验收。 |
| `PACKAGED_RUNTIME_NOT_GUI` | 候选自带 Electron/Runtime 已完成受控闭环，但没有可见 GUI 验收。 |
| `PACKAGED_RUNTIME_OU2_PENDING` | 已有候选 Runtime 闭环，但缺少独立 OU2 坐标/精度比较，且没有 GUI 验收。 |
| `PARSER_OR_INSPECTION_ONLY` | 只有合成/公开研究/安全边界证据，没有真实候选验收。 |
| `CONVERTER_NOT_RUN` | 转换器边界及其安全测试存在，但没有真实、已审计的用户转换器运行。 |
| `PACKAGED_GUI_SELECTED_WORKFLOW` | 精确包中选定样本的真实 GUI 成果链和重启复验已留证；不等于全格式、全界面状态或专业验收完成。 |
| `READ_ONLY_REFERENCE_COMPARED` | 已对指定输入/成果完成独立只读参考比较；不生成可平差来源，不代表参考格式单独 GUI 验收。 |

## 2026-09-10 格式与测试基线

测试路径和证据路径是本表的机器定位键。`当前 Runtime 处置`必须与
`kun/src/engineering/survey-format-catalog.ts` 和
`kun/src/engineering/survey-format-registry.ts` 一致；候选状态只引用候选包证据，
不将源码测试提升为 GUI 通过。下表“当前”是该历史基线的时点；IN2/GSI/OU2 的后续状态由上方索引承接，历史测试数未在本次重跑。表内只写 basename 的测试文件均解析到
`kun/src/engineering/<basename>`。

| Record ID / 格式族（Runtime ID） | Evidence class | Fixture / source type | 当前 Runtime 处置 | 正向 / golden coverage | Negative coverage | Resource-limit coverage | Task 36 candidate status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FMT-COSA-IN1` COSA `.in1` (`cosa-in1`) | `semantic-parser` | synthetic golden/negative；用户有权处理的真实工程候选摘要 | 显式保存的已知点/测段列映射和 `m/km` 单位声明有效时可为 `adjustment-ready`；否则 `archive-only` | `kun/src/engineering/survey-cosa-in1.test.ts`；`kun/src/engineering/survey-professional-fixture-manifest.test.ts`；三组 synthetic golden；当前候选包真实左线样本 `290/116`（观测/点），同源 OU1 `116` 点 `mismatches=0` | 无分隔符、列数错误、距离错误、无效映射及配对成果不一致 | `survey-cosa-in1.test.ts` 覆盖 8 MiB、100,000 行和 16 KiB/行；`survey-format-registry.test.ts` 覆盖共享来源/展开/点数上限 | `PACKAGED_RUNTIME_NOT_GUI`；唯一候选包内已完成闭环，未取得 GUI 截图/交互验收 |
| `FMT-COSA-IN2` COSA `.in2` (`cosa-in2`) | `semantic-parser` | synthetic golden/negative；用户有权处理的真实工程候选摘要 | 严格结构、记录锚点、单位、基准、拓扑、闭合和精度门禁通过后可为 `adjustment-ready`；否则 `archive-only` | `kun/src/engineering/survey-cosa-in2.test.ts`；`survey-format-registry.test.ts`；catalog 中 3 个 synthetic golden；当前候选包真实 `s7g47-s8g09` 配对 `160/33`（观测/点），OU2 `33` 点 `mismatches=0` | 错误头、缺后视归零、非法点名、DMS 分秒越界和策略门禁失败 | `survey-cosa-in2.test.ts` 覆盖来源字节、行数、行字节、记录和观测上限；registry 覆盖集成后的 limit diagnostic | `PACKAGED_RUNTIME_NOT_GUI`；唯一候选包内已完成 OU2 比较，最大组合归一化差 `0.088999 sigma <= 1`，未取得 GUI 截图/交互验收 |
| `FMT-COSA-NET` COSA `.NET` (`cosa-net`) | `semantic-parser` | inline synthetic grammar | `archive-only`；隔离拓扑核心尚未接入调用方坐标和来源文件组 | `kun/src/engineering/survey-cosa-net.test.ts` 覆盖逆时针/顺时针三角形、不可变 UTF-8 锚点 | 重复点、字段缺失、坐标缺失、共线和非 ASCII | 仅有 registry 共享来源限制；隔离 `.NET` core 没有格式专用维度/行长回归 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-COSA-OU1` COSA `.ou1` (`cosa-ou1`) | `read-only-comparison` | inline synthetic report；真实 IN1/OU1 摘要 | 附件来源始终 `archive-only`；只读成果比较，不生成平差来源 | `kun/src/engineering/survey-cosa-ou1.test.ts` 覆盖标签表、打印精度、点集、同源测段；候选见 `left-in1.json`、`right-in1.json` | 数值/舍入、点集、映射、源测段数量或值不一致 | parser 已实现字符/行/点和比较维度上限，但 `survey-cosa-ou1.test.ts` 尚无专用资源上限用例 | `NO_PACKAGED_GUI`；仅作为 IN1 参考比较 |
| `FMT-COSA-OU2` COSA `.ou2` (`cosa-ou2`) | `read-only-comparison` | inline synthetic report | 附件来源始终 `archive-only`；只读坐标/精度比较，不生成平差来源 | `kun/src/engineering/survey-cosa-ou2.test.ts` 覆盖固定点、成果点、X/Y 打印分辨率和一倍标准差比较 | 固定点变化、超精度、缺精度、点集不一致和格式错误 | `survey-cosa-ou2.test.ts` 覆盖 16,385 字符超长行；parser 另有 8 MiB、100,000 行、10,000 点/比较维度门禁 | `NO_PACKAGED_GUI`；真实 IN2 尚未执行 OU2 比较 |
| `FMT-SOUTH-DAT` 南方 DAT / PA2005 (`south-dat`) | `semantic-parser` | synthetic explicit-mapping envelope；一手资料仅作格式边界 | `archive-only`；没有权威 DAT 列序时禁止猜测 | `survey-professional-fixture-manifest.test.ts`；`survey-native-format-golden.test.ts`；`docs/references/SURVEY_FORMAT_SOURCES.md` | `south-dat-negative.dat`；未知 DAT 不降级为通用 delimited parser | `survey-format-registry.test.ts` 共享来源、文本行、锚点和点数上限 | `PARSER_OR_INSPECTION_ONLY`；缺经批准列映射和真实参考 |
| `FMT-LEICA-GSI` Leica GSI8/GSI16 (`leica-gsi8`, `leica-gsi16`) | `semantic-parser` | synthetic golden/negative；固定公开研究样本；授权真实 GSI/IN1/已知高程 | WI41 水准完整语义可进入策略门禁后的 `adjustment-ready`；缺初始化或 blocking diagnostic 为 `archive-only` | `survey-leica-gsi-leveling.test.ts` 与 `survey-historical-source-gates.test.ts` 覆盖相邻 WI83 累计高程差、非零初始高程、闭合返回边及旧语义禁用；候选 `912e4d30b065` 实测 28 观测/27 点并完成交付 | 缺 WI11/WI83 初始化、缺目标、重复最终字段、非法单位、非递增累计距离阻断；历史网络/成果保留只读 | registry 共享来源和 100,000 原始记录锚点上限 | `NO_PACKAGED_GUI`；已具包内 Runtime 与独立 NumPy 数值证据，最大高程差 0.020316 mm；既有 IN1 转换的 7 段打印差异仍需复核 |
| `FMT-LEICA-HEXML` Leica HeXML (`leica-hexml`) | `semantic-parser` | synthetic golden/negative | `archive-only`；元素级语义、物理偏移和单位互操作未验收 | `survey-professional-fixture-manifest.test.ts`；`survey-native-format-golden.test.ts` 的观测和物理行锚点 | `leica-hexml-negative.hexml`；阻断不完整/不可信元素 | `survey-format-registry.test.ts` 覆盖 XML entity、嵌套深度、来源和点数上限 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-LEICA-DBX-MDB` Leica DBX/MDB (`leica-dbx`, `leica-mdb`) | `converter-boundary` | synthetic opaque probe；synthetic converter harness | `converter-required` | `survey-format-coverage.test.ts` 识别并保留原件；`survey-converter.test.ts` 验证转换后双哈希和正常 parser gate | 无白名单无 fallback；可执行文件哈希变化、输出格式不符均阻断 | manifest 声明 timeout/max output，协议输出限 1 MiB；尚无 timeout/超大输出负向测试 | `CONVERTER_NOT_RUN`；无真实用户转换器运行 |
| `FMT-TRIMBLE-JOBXML` Trimble JobXML/JXL (`trimble-jobxml`) | `semantic-parser` | synthetic golden/negative；固定公开研究样本 | `archive-only` | `survey-professional-fixture-manifest.test.ts`；`survey-native-format-golden.test.ts`；`survey-public-fixtures.test.ts` | `trimble-jobxml-negative.jxl`；不完整 XML 阻断 | `survey-format-registry.test.ts` 覆盖 XML entity、嵌套深度、来源和点数上限 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-TRIMBLE-M5` Trimble/Zeiss M5 (`trimble-m5`) | `semantic-parser` | synthetic golden/negative；固定公开研究样本；真实 M5/BM1/OU1 配对 | 有效语义解析可进入 `adjustment-ready`；仍需已知点、拓扑、闭合与精度策略校验 | `survey-native-format-golden.test.ts`；`survey-professional-fixture-manifest.test.ts`；`survey-format-registry.test.ts` 覆盖 aBFFB 与高置信内容优先于 `.dat` 后缀；`evidence/real-m5-production-2026-09-10/` 记录 148 观测、78 点、74 个 OU1 参考点匹配 | `trimble-m5-negative.m5`、`trimble-m5-dat-negative.dat`；扩展冲突保留诊断；仪器 Z 不作为已知高程基准 | `survey-format-registry.test.ts` 共享来源/文本/锚点上限 | `NO_PACKAGED_GUI`；已有隔离 Runtime 成果闭环，M5 属计划第二批，不等于 South DAT，也不替代 P0 验收 |
| `FMT-TRIMBLE-OPAQUE` Trimble T00/T01/T02/T04/JOB (`trimble-t00`, `trimble-t01`, `trimble-t02`, `trimble-t04`, `trimble-job`) | `converter-boundary` | synthetic opaque probe；synthetic converter harness | `converter-required` | `survey-format-coverage.test.ts` 覆盖全部 ID；`survey-converter.test.ts` 验证 T02 转换和原件/产物双哈希 | 无 adapter 时保持原件；哈希、输出格式、无 fallback 门禁 | manifest timeout/max output 与 1 MiB 协议限额存在；缺 timeout/超大输出专用负向回归 | `CONVERTER_NOT_RUN` |
| `FMT-TDS-CARLSON` TDS RAW / Carlson RW5 (`tds-raw`, `carlson-rw5`) | `semantic-parser` | synthetic golden/negative | `archive-only` | `survey-professional-fixture-manifest.test.ts`；`survey-rw5-inspection.test.ts` 覆盖测站、后视、正倒镜、`LS` 状态和单位 | 两个 negative fixture；重复 token、几何拒绝和行锚点 | `survey-format-registry.test.ts` 共享来源/文本上限及 100,000 锚点上限 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-SOKKIA-SDR` Sokkia SDR20/SDR33 (`sokkia-sdr`) | `semantic-parser` | synthetic golden/negative | `archive-only` | `survey-professional-fixture-manifest.test.ts`；`survey-native-format-golden.test.ts` 的 SDR20/33 定长记录 | 两个 negative fixture；歧义定长方言阻断 | `survey-format-registry.test.ts` 共享来源/文本/锚点上限 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-LANDXML` LandXML (`landxml`) | `semantic-parser` | synthetic golden/negative；固定公开研究样本 | `archive-only`；Units 声明保留，未把未验证值误标为 `m/deg` | `survey-professional-fixture-manifest.test.ts`；`survey-native-format-golden.test.ts`；`survey-public-fixtures.test.ts` | `landxml-negative.xml`；未验证单位、元素和几何阻断 | `survey-format-registry.test.ts` 覆盖 XML entity、嵌套深度、来源和点数上限 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-FIELD-CONTROLLER` Topcon GTS7/FC5、Nikon RAW (`topcon-gts7`, `topcon-fc5`, `nikon-raw`) | `detection-only` | synthetic content probes | `archive-only` | `survey-format-coverage.test.ts` 覆盖内容/扩展识别和原件保留 | 同测试断言零观测和 `missing_geometry` 阻断 | `survey-format-registry.test.ts` 共享 64 MiB 来源与 8 KiB 探测窗口；无格式语义维度可测 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-SPECTRA-SURVEY-PRO` Spectra Survey Pro (`spectra-survey-pro`) | `converter-boundary` | synthetic opaque probe；synthetic converter harness | `converter-required` | `survey-format-coverage.test.ts` 的 `.survey/.spj/.job` 处置；`survey-converter.test.ts` 保留原件 | 白名单、可执行哈希、输出格式和无 fallback 门禁 | manifest timeout/max output 与协议限额存在；缺 timeout/超大输出专用负向回归 | `CONVERTER_NOT_RUN` |
| `FMT-SURVEYCLOUD-SUC` 测量云 SUC (`survey-cloud-suc`) | `inspection` | synthetic structure tests；用户授权 NAS 只读元数据摘要 | `archive-only` | `survey-format-registry.test.ts` 的结构签名、非语义字段和来源锚点；`SURVEY_FORMAT_SOURCES.md` 记录 26 期、598 文件 | 结构冲突、`missing_geometry`；始终零点位/零观测 | registry 覆盖来源/行/锚点及 preserved raw-field entry/byte cap | `PARSER_OR_INSPECTION_ONLY`；规格、单位、基准和字段语义未验收 |
| `FMT-GNSS-RINEX` RINEX observation 2/3/4、navigation、meteorological、clock (`rinex-observation`, `rinex-navigation`, `rinex-meteorological`, `rinex-clock`) | `inspection` | synthetic probes；固定公开研究原件 | `gnss-processing-required` | `survey-gnss-format-manifest.test.ts`；`survey-gnss-source-evidence.test.ts` 的物理行锚点；`survey-rtklib-fixtures.test.ts` | 缺 `END OF HEADER` 阻断；始终零基线观测 | `survey-gnss-source-evidence.test.ts` 覆盖长行与记录锚点上限；registry 覆盖来源/展开限制 | `PARSER_OR_INSPECTION_ONLY`；不是基线平差输入 |
| `FMT-GNSS-HATANAKA` Hatanaka/CRINEX (`hatanaka-rinex`) | `converter-boundary` | synthetic probe；固定公开研究原件 | `converter-required`；展开后仍需 GNSS 后处理 | `survey-gnss-format-manifest.test.ts`；`survey-public-fixtures.test.ts` | `survey-format-registry.test.ts` 要求本地审计解压器，零观测 | registry 共享来源/展开限制；转换器 timeout/output 仍缺专用负向回归 | `CONVERTER_NOT_RUN` |
| `FMT-GNSS-SINEX-NMEA` SINEX、NMEA (`sinex`, `nmea-0183`) | `inspection` | synthetic probes；固定公开 SINEX 研究原件 | `gnss-processing-required` | `survey-gnss-format-manifest.test.ts`；`survey-gnss-source-evidence.test.ts` 对 SINEX estimate、NMEA 行锚点的限定读取 | 重复/不完整 SINEX 分量；NMEA 无协方差阻断 | `survey-gnss-source-evidence.test.ts` 覆盖长行/记录上限；registry 共享来源/点数限制 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-GNSS-RTCM-AUX` RTCM2/RTCM3、SP3/IONEX/ANTEX (`rtcm2`, `rtcm3`, `sp3`, `ionex`, `antex`) | `inspection` | synthetic probes；固定公开研究原件 | `gnss-processing-required` | `survey-gnss-format-manifest.test.ts`；`survey-public-fixtures.test.ts`；`survey-rtklib-fixtures.test.ts` | 截断 RTCM、帧不完整和无基线声明；始终零观测 | registry 覆盖来源、文本和 100,000 锚点上限；RTCM parser 保持有界扫描 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-GNSS-RECEIVERS` UBX、OEM、SBF、BINEX、JPS、TPS、STH、ZHD、HCN、CNB (`ublox-ubx`, `novatel-oem`, `septentrio-sbf`, `binex`, `javad-jps`, `topcon-tps`, `south-sth`, `hitarget-zhd`, `chcnav-hcn`, `comnav-cnb`) | `inspection` | 10 类 synthetic probes；UBX/OEM/JPS 固定公开研究原件 | `gnss-processing-required` | `survey-gnss-format-manifest.test.ts`；`survey-gnss-source-evidence.test.ts`；`survey-rtklib-fixtures.test.ts` | 不透明流不猜测记录边界；保留单个原件锚点并阻断 | registry 覆盖 64 MiB 来源及 100,000 锚点；四类有帧语法的格式为有界扫描 | `PARSER_OR_INSPECTION_ONLY` |
| `FMT-WORKWISE-JSON` frozen WorkWise JSON (`workwise-json`) | `semantic-parser` | inline synthetic frozen-schema inputs | 无阻断且单位合同完整时 `adjustment-ready`；否则 `archive-only` | `survey-format-registry.test.ts` 覆盖冻结 schema、单位和原始字节锚点 | 重复 key、单位缺失和 solver identity 冲突 | 同测试覆盖数组、合计点位、总记录及 preserved raw-field 上限 | `NO_PACKAGED_GUI`；它不是厂商格式验收替代品 |
| `FMT-OPEN-TABLES` CSV/delimited/XLSX (`delimited-text`, `xlsx`) | `detection-only` | inline synthetic CSV；synthetic OOXML ZIP | `archive-only`，待 F-FMT-10 保存映射和单位/角度确认 | `survey-format-registry.test.ts` 的原件/OOXML 识别和映射政策 | 未保存映射、单位和角度格式即阻断；伪 OOXML 阻断 | 同测试覆盖 ZIP/OOXML 展开大小、压缩比和 gzip bomb | `NO_PACKAGED_GUI` |
| `FMT-UNKNOWN` 未识别来源 (`unknown`) | `detection-only` | arbitrary synthetic bytes/text | `archive-only` | `survey-format-registry.test.ts` 验证未知 JSON、二进制和冲突来源不继承受理状态 | 不允许 generic fallback 生成观测 | registry 覆盖 64 MiB 来源和 8 KiB 固定探测窗口 | `PARSER_OR_INSPECTION_ONLY`；不是 advertised vendor family |

矩阵共有 26 条记录，逐项引用 `SurveyFormatIdV1` 的 53 个 ID（含开放格式和
`unknown` 安全边界）。共享门禁由 `SURVEY_FORMAT_LIMITS` 暴露并由
`survey-format-registry.test.ts` 覆盖：8 KiB 固定探测、64 MiB 原件、128 MiB 展开、
200 倍压缩比、32 个普通归档成员、2,048 个 OOXML 成员、200,000 文本行、
100,000 来源锚点/观测、10,000 点、8 MiB 原始字段、XML 64 层/500,000 标签。
矩阵中的格式专用限制是共享门禁之外的增量证据；写明“缺”的项目不能由共享
门禁自动视为已覆盖。

## 候选包实证索引

最新归档实机证据见上方 6ff 索引。`docs/qa/evidence/survey-candidate-912e4d30b065/README.md` 是较早的包内 Runtime 证据，当时尚无完整 GUI；GSI 参考转换来源至 6ff 仍未闭合。以下同样是历史 COSA 候选证据：

- `docs/qa/evidence/survey-candidate-f09e74ebcbc5/README.md`
- `docs/qa/evidence/survey-candidate-f09e74ebcbc5/left-in1.json`
- `docs/qa/evidence/survey-candidate-f09e74ebcbc5/right-in1.json`
- `docs/qa/evidence/survey-candidate-f09e74ebcbc5/left-in2.json`
- `docs/qa/evidence/survey-candidate-f09e74ebcbc5/right-in2.json`
- `docs/qa/WORKWISE_0.5.0_ENGINEERING_CANDIDATE_EVIDENCE.md`

这些记录证明隔离 Runtime（以及历史候选自带 Runtime）中的真实 COSA 源格式处理和成果文件闭环。它们明确标注
`packaged-runtime-not-gui-acceptance`：未替代窗口级连续会话、文件选择、主题、窄窗口、键盘可达性、
实际截图或更新器往返。

## 仍需关闭的验收缺口

1. 当前候选已有另一份真实 COSA IN2/OU2（160 观测、33 点）同源坐标与精度比较，严格打印精度和精度范围均 0 不匹配；历史左右线两份 IN2 不因此自动获得同源比较通过。
2. 6ff 已完成选定 IN2/GSI 的同包可见 GUI 导入、预检、平差、DOCX/PDF/XLSX/manifest 和重启复验；后续精确包、完整深浅主题/语言/支持尺寸/键盘状态覆盖及用户本人确认仍待闭合。GSI 的 7/14 历史高差转换来源继续待复核。
3. 对其余有 native parser 的格式收集可授权使用的真实或脱敏输入及独立数值参考；synthetic/public fixtures 继续只作为解析安全证据。
4. 对 South DAT 获得经批准的列映射契约；对 COSA `.NET` 完成来源文件组和调用方坐标接入；继续将 OU1/OU2 限制为只读比较，不作为调整输入。当前已有第二个独立 COSA `.in2/.ou2` 工程配对，但它仍属于同一 COSA 格式族，不替代第二厂商格式。
5. 对 DBX/MDB、Trimble T00/T01/T02/T04/JOB 和 Survey Pro，使用实际用户提供的、允许格式的本地转换器，保留可执行文件哈希、许可证/来源、参数、无网络证明、原件哈希和转换输出哈希。
6. 对所有 GNSS 输入先完成受审计的后处理，得到固定基准、完整协方差的基线向量后，再执行 GNSS 平差验收；原始接收机流和开放交换文件本身不满足此条件。
7. 补齐目前机器证据明确暴露的专用回归：COSA `.NET` 的行长/维度上限、OU1 的字符/行/点/比较维度上限，以及 converter executor 的 timeout/超大输出失败；将 T00、T01、T04、JOB、DBX、MDB、Survey Pro 分别跑过转换 harness，而不是只以 T02 代表整个集合。

## 2026-09-10 历史机器复核

- 合同覆盖脚本：`SurveyFormatIdV1` 共 53 个 ID，矩阵缺失 `0`；矩阵 26 条记录，
  每条均为固定 8 列。
- 聚焦格式回归：17 个测试文件，`498 passed / 1 skipped`。跳过项只是默认运行中
  受环境变量控制的 macOS sandbox integration，不是失败。
- 单独执行 `npm run test:survey-converter-sandbox`：1 个测试文件，`16 passed`；
  其中 `/usr/bin/sandbox-exec` 下的无网络本地 copy adapter 实际运行通过。该结果只证明
  executor 基础设施，不证明任何厂商转换器可用。
- `git diff --check -- docs/qa/WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md`：通过。

截至 281dc87，本次文档核对复算了 6ff 归档目录的 60 个文件哈希，并逐项核对上方数字与 `p0-summary.json` / `gui-acceptance.json`；没有重跑输入或改写任何原始证据。指标分母与候选/生产边界见[生产指标口径](./RAILWISE_SURVEY_PRODUCTION_METRICS.md)。在上述缺口关闭前，Task 36 和完整打包 GUI 验收任务均保持未完成，且不得以本矩阵作为公开发布、稳定渠道提升或厂商互操作声明的依据。
