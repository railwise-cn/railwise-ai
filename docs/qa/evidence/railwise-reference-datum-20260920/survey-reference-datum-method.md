# 两历元指定参考集合基准比较纯核 v1

本批是独立一维纯计算模块和版本化合同。它用调用者事先指定的参考集合定义两期比较基准，保存共同平移、所有点的相对位移以及完整协方差传播。它不自动选择参考点，不判断物理稳定性，不提供显著性、拟稳自动筛选或工程签认，不修改正式坐标。不接 Runtime、数据库、IPC 或桌面。

## 调用者声明不能替代真实依据

请求提供两期各自原始点序列、坐标、完整**坐标协方差**、来源定位与 SHA-256；来源记录是否存在、哈希是否匹配真实字节仍为 `sourceRecordsVerified:false`。本纯核没有读取数据库或原始文件。`sourceSha256` 仅是声明字段，不是已完成不可变记录绑定的证据。

`covarianceBasis` 必须明确为绝对坐标协方差，不允许把相对权或既有自由水准试算的 `heightCofactor` 自动解释为协方差。若后续连接既有试算，必须先建立真实尺度与来源记录合同。本模块没有执行该转换。

两期必须显式声明独立，或提供完整跨期协方差 C12。C12 的行是第一期原生点序，列是第二期原生点序；点映射必须是两期完整双射。禁止在缺少相关模型时默认独立。声明本身仍为未验证。所选参考点可发生共同移动或个别移动，计算结果不会把它们认定为稳定。

## 原创线性代数推导

以共同映射后的点序表示 h1、h2、C1、C2、C12。差值 `d=h2-h1`。线性变换 `[-I,I]` 给出：

`D = Cov(d) = C1 + C2 - C12 - C12ᵀ`。

先检查完整联合块 `J=[[C1,C12],[C12ᵀ,C2]]`。仅 D 正定不能证明 J 有效，例如 C1=C2=I、C12=-2I 得 D=6I，但联合块有负特征值，本核拒绝。

R 表示选定参考子集。方法必须显式选择，不会自动切换：

- `gls-reference-mean`：参考子矩阵 Drr 必须数值正定且可解析。由最小化 `(d_r-1c)ᵀDrr⁻¹(d_r-1c)` 的一阶条件得到 `c=(1ᵀDrr⁻¹d_r)/(1ᵀDrr⁻¹1)`，参考权 `w_r=Drr⁻¹1/(1ᵀDrr⁻¹1)`。权可以为负，不截成非负；过度抵消或不可解析时停止。这个共同参考模型仍是声明，不证明点实际仅发生共同平移。
- `equal-reference-mean`：`w_r=1/r`。这是调用者指定的等权基准定义，不宣称精度最优或参考点稳定。它能在参考协方差奇异时照常定义基准；只有调用者明确选择此方法才执行，不作为 GLS 的失败后备。

将权嵌入全部 n 点，未选参考权为 0。令 `T=I-1wᵀ`，则 `c=wᵀd`、相对位移 `u=T d`。完整传播为：

`Var(c)=wᵀD w`；`Cov(u)=T D Tᵀ`；`Cov(u,c)=T D w`。

返回 `differenceCovariance`、`referenceShiftVariance`、`displacementCovariance` 和 `shiftDisplacementCovariance`，最后一个向量按映射点序表示 Cov(u_i,c)。因此能重建联合平移/位移协方差，而不是只给每点标准差。传播使用原声明矩阵，不将小负特征值剪成 0，不添加 jitter，不修改输入协方差。

锚定参考点差值 `a` 后计算 `c=a+sum(w_i*(d_i-a))`、`u_i=(d_i-a)-sum(w_j*(d_j-a))`，以减小巨大共同平移相消造成的舍入损失。均值与矩阵点乘使用补偿求和。返回权与 T 是浮点结果，附带约束残差和数值估计，不宣称严格符号恒等式。

## 数值边界与诚实含义

- 每期 2–32 个点，指定 2–32 个参考点；完整双射，不静默丢点。
- 坐标绝对值不超过 1e9；不支持非零次正规坐标或位移。单位只允许 m/mm，调用者必须同时正确换算所有坐标与协方差；本核不隐式换算。
- 正对角协方差在 `[1e-100,1e100]`，完整联合块的最大/最小正方差比不超过 1e12。零方差的整行必须严格为 0。
- 期内协方差必须严格对称；不自动平均相差的小数。
- 联合块先按对角平衡为相关矩阵，再作最多 64 轮循环 Jacobi。明显负相关特征值（估计值低于 -1e-10）拒绝；边界范围报告 `semidefinite-or-unresolved-within-numerical-tolerance`，**不是半正定数学证明，也不证明物理精度有效**。报告最小特征值估计、非对角残差、固定容差、是否在边界及 `matrixRepair:none`。与任何浮点 PSD 检查一样，零附近无法区分真零和微小负值，必须保留这一不确定性；此状态下只是传播声明矩阵的试算，不是确认它为有效随机模型。
- GLS 使用对角平衡 Cholesky、参考相关矩阵∞条件估计和后向误差检查；相关条件数≤1e10，权绝对和≤1e6。奇异/边界参考协方差明确返回 `reference-covariance-rank-or-conditioning`，不伪逆、不换参考、不降级为等权。
- 传播得到负方差、非有限值、次正规主要坐标结果或不满足数值基准约束时返回 `numeric-range-or-resolution`。即便只有微小负方差也不截零，可能保守拒绝真实但处在舍入边界的声明矩阵。
- `coordinateRoundoffEstimate` 与 `covarianceRoundoffEstimate` 是按维数、输入量级和权抵消程度计算的保守软件诊断，**不是认证误差界**，也不是工程允许误差或测量精度。大的共同原点、强相关、很小两期差协方差可能让估计远大于最终差值，调用者应保留该信息；本版无显著性判定。

两期各有自由基准约束时完整协方差可以奇异。合适的真子集 Drr 仍可能正定，因而可作 GLS；全参考子矩阵奇异时 GLS 停止，调用者显式选择等权可定义另一个基准。两种方法的含义和返回字段均不同，不能称“自动拟稳”。

## 独立证据与可重放命令

`survey-reference-datum-oracle.py` 为本次原创，固定 Python 3.12.7，标准库 Fraction 独立 Gauss-Jordan 精确解及矩阵乘法计算54个原始有理数模型，再以固定 mpmath 1.3.0 /120 位 lu_solve 与矩阵乘法计算实际 binary64 输入的另一组结果。生成器不导入产品实现。原始 JSON 保留精确分数和100位高精度数值。

案例包括：三点两期各单位协方差、d=[0,0,3]，两方法得到 c=1、u=[-1,-1,2]、Cov(u)=2(I-J/3)；相关参考产生合法负 GLS 权 [1.5,-.5]；四点自由基准 I-J/4 的子集 GLS 和全点等权；固定种子20260920的24个有理联合因子模型，各跑两种方法，覆盖非对称跨期块、完整联合随机模型和参考真子集。

测试另验证共同移动、两期共同原点、协方差正比例缩放、m/mm单位换算、原生点序与跨期两轴映射、反转历元、最大32点、GLS退化、非法联合相关、近半正定边界、次正规/极端尺度、来源/假设保留以及不可伪造的输出身份与方法字段。合成来源哈希只用于合同测试，不是现场项目证据。

```sh
python -m pip install mpmath==1.3.0
python docs/qa/evidence/railwise-reference-datum-20260920/survey-reference-datum-oracle.py
npm --prefix kun run test -- src/engineering/survey-reference-datum.test.ts
npm --prefix kun run typecheck
npx eslint kun/src/contracts/survey-reference-datum.ts kun/src/engineering/survey-reference-datum.ts kun/src/engineering/survey-reference-datum.test.ts
npm --prefix kun run build
```

本文件线性代数为原创推导，不把未获取全文的论文、规范条文或 AI 模拟评审登记为已核读权威来源。软件测试、数学推导、来源记录认证、现场适用性和授权真人签认是不同证据。

真实构建产物对照可重复执行：

```sh
node docs/qa/evidence/railwise-reference-datum-20260920/survey-reference-datum-node-probe.mjs "$PWD"
python docs/qa/evidence/railwise-reference-datum-20260920/survey-reference-datum-audit.py
```

实际 Node v26.8.2 输出已保存；54个模型、5048个标量比较的最大归一差异为 `3.108624468950438313186168670654296875e-15`。这是合成模型的软件数值验证，不能解释为工程精度或真实生产表现。

## 后续集成的具体边界

当前纯核不读取或保存真实记录。接入时需要像既有高级试算一样，绑定实际输入字节、来源材料字节、项目身份、不可变记录和严格重放；不能把这里的声明 SHA-256 当作已认证来源。GLS/equal 方法必须明确可见，不能在后端失败时由界面默默换方法。界面应保留 near-semidefinite 的未决分类、来源/尺度/相关模型未验证与数值估计，不把 `calculated` 渲染成精度验收或稳定点认证。

`survey-reference-datum-size-probe.mjs` 可从构建后的 checkout 重跑 32点/32参考、160码元中文长ID及完整跨期矩阵的运输样例。此次请求164307字节、完整返回261804字节、单次本地12.9毫秒。它用于接口容量设计，不是全域最大字节证明或生产SLA。后续 HTTP/body/record 限制和按完整声明点数计费仍需在实际保存/列表/导出路径验证，本批没有修改这些路径。

## 第二智能体独立审阅

完整原样审阅包保存在 `survey-reference-datum-independent-review/`，包含报告、独立生成器、108个模型与原始输出、32个边界输入/输出、精确审计和 portable runner。审阅者没有导入本作者的54例生成器，使用不同固定种子280620261、基于实际binary64的Fraction精确算术及120位mpmath独立交叉。8466标量的最大按运算尺度归一误差为 `2.220446049250313e-16`；32项边界全部通过，没有未决数值阻断。已逐项核验审阅源码和证据SHA-256，并在新临时目录重跑原样runner成功。

审阅特别保留了真实微小负特征值仍处于软件容差内的案例：此时 calculated 只是按原声明矩阵传播，必须连同 `semidefinite-or-unresolved-within-numerical-tolerance` 一起展示，不能称“协方差已验证”。它不是签署的专业审查，也没有验收未来Runtime/UI或真实仪器数据。
