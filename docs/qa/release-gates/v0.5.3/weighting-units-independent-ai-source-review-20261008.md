# 0.5.3 水准定权与精度单位：独立 AI 源码审查

2026-10-08，独立 AI 子代理 `profile_guard_review`。审查结合工程测量数值/成果语义、软件兼容与产品信息表达；这是 **AI review**，不是厂商互操作认证、真实专业签名、真人批准或最终安装包验收。

## 结论及绑定

在本次修订源码范围内，未发现尚未修复的阻断缺陷，可以继续源码 PR/CI、重新冻结和最终安装包验收。此次结论不授权跳过安装包界面、功能、签名/公证或真实 updater 往返质量门禁。

- 仓库：`/Users/wangjiawei/Documents/WorkWise`。
- 分支：`codex/survey-weighting-units-053`；基线：`d3f9158a6fd26cd40e4f0bd3dd4d92e4686d1f51`。
- 审查对象是未提交工作树增量，共 32 个修改/新增文件；不是冻结包，也不是旧构建 run `37749218440`。
- 文件清单见 `weighting-units-independent-ai-source-review-20261008.json`，排序清单 SHA-256：`ae606e6e14d728075cc35b18c87f654d8e52f8032ccab53d335acc1d12761a93`。合并或冻结时需核对此清单；产品源码改变应按影响范围复核。
- 本代理没有修改产品源码、版本、发布规则、标签、Release 或更新源；仅记录 QA 文档。

## 数值、专业语义及兼容性复核

1. 新算法 9 的水准相对定权采用 `P=L₀/L`、`L₀=1 m`；单位权中误差为 m，方差尺度为 m²，不解释为每千米精度或与无量纲 1 的方差比。独立可手算样例（路长 1 m/4 m、闭合 0.001 m）得到待定高程 10.9998 m、残差 −0.0002/−0.0008 m、方差尺度 2×10⁻⁷ m²及点位中误差 0.0004 m。
2. 全部绝对先验中误差定权保留无量纲尺度；m/mm 输入及 sigma 换算等值。先验 precision 标签没有被表述为已经独立标定。
3. 混合绝对/相对定权及部分缺失路长在新计算中阻断；所有路长缺省时保留明确的全观测等权记录。共享语义助手检查缺省 ID 为完整、唯一且实际存在的观测集合，不把不完整记录视为已核定。
4. 相对定权不生成 σ 筛查数值、阈值超限结论或 log10 相对 1 比值。无多余观测只保留解算高程，绝对点位精度、方差尺度及协方差不评定；有真实绝对先验时，无多余观测仍可保留先验点位中误差。
5. AI 两条真实读取路径的顶层尺度、最大点位精度和 precision pass 均以 null/未评定替代相对无冗余的名义占位数值。历史默认无量纲单位不作为核定证据。
6. 专业摘要、中文/英文界面、DOCX/PDF/XLSX 明确单位与定权口径；未评定数据保留为空或不可用。通用 XLSX 摘要增加定权/尺度/点位精度状态，不把 nominal 1、0 或缺省 sigma 单位输出为评定成果。专业报告的小非零数值采用科学计数法避免被四舍五入为 0。
7. 真实算法 8 的 SQLite 原始行及原件被恢复后，读回、新用途的确定性重算和逐表原行保全通过；没有给旧结果或专业摘要补入新定权字段。算法 6/7/8 分支与版本 8 GNSS 装饰路径保持兼容。真实旧快照含五张原始表、源 bytes 和计算结果，不含原专业投影 hash；因此不宣称独立比较过完整旧 professional projectionHash。

## 审查中关闭的问题

- AI 原先同时收到顶层 nominal 1/0 与嵌套未评定状态：已由共享助手覆盖顶层值为 null，并由真实 context/tool 测试验证。
- 等权 ID 初版仅检查存在，未检查完整集合：已检查完整唯一真实观测集合。
- 通用 XLSX 初版仍输出 nominal 1/0、历史默认单位及未检验粗差 false：已使用共享语义与空值/状态输出。
- 最后独立发现的结果摘要“粗差候选 0”误表达：已改为只统计 available 筛查；全部不可检验或历史无统计语义时显示未评定，部分可检验时明确已检查/未检查范围。相对有冗余与无冗余 DOM 断言均通过。

## 本代理实际执行的独立验证

使用现有 Electron 的 Node 模式（Node v24.18.0、模块 ABI 148）运行 SQLite 测试，未重装或重编译共享依赖。默认 shell Node ABI 147 与原生库不匹配；直接探测失败后切换匹配运行时，不将该 ABI 环境错误当作产品计算失败。

```sh
# kun 工作目录
ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ../node_modules/vitest/vitest.mjs run src/engineering/survey-weighting-units.test.ts src/engineering/survey-ai-adjustment-semantics.test.ts src/engineering/survey-professional-report.test.ts --maxWorkers=1 --reporter=verbose

# 仓库工作目录
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ./node_modules/vitest/vitest.mjs run src/renderer/src/components/engineering/SurveyAdjustmentPanel.dom.test.ts src/renderer/src/components/engineering/ProfessionalSurveyReview.dom.test.ts src/renderer/src/components/engineering/SurveyAdjustmentStatistics.dom.test.ts --maxWorkers=1 --reporter=dot

git diff --check
```

- 后端：3 文件、38 项通过，退出码 0，13.02 s。包含真实旧版本存储回放、相对/绝对 m/mm 定权、混合/缺路长阻断、无冗余、GSI 后验精度、两条真实 AI 读取路径及专业三格式导出。
- 前端：3 文件、98 项通过，退出码 0，3.23 s。包含中文/英文单位、完整/部分等权元数据、旧单位未核定、无冗余未评定及粗差摘要修正。既有 IN1 批量映射测试产生 React `act(...)` 警告；测试通过，但此报告不把该警告解释为已证明真实安装包无异步问题。
- `git diff --check` 退出码 0、无输出。
- 本报告只记本代理实际执行的 136 项；主代理的更广测试与另一个测试代理的 203 项不冒称为本代理执行。

## 尚须最终安装包验收

目标仍是 RailWise AI / RailWise Survey **0.5.3**，但此次没有安装或启动修订后的最终包，也没有包 SHA、签名/公证截图、CUA 操作证据或真实 updater 往返结果。因此源码审查通过仅解除本次定权/单位源码问题，不能替代最终包与发布前验收。旧 d3f9158 冻结产物及已取消工作流不能充当此修订的包验收证据。
