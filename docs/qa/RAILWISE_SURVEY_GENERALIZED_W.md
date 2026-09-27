# 已知先验协方差的广义 w 只读诊断纯核

实现基线为 `a3072e25ebc33ee30702d5278c8144e3fbb625f7`，工作在独立分支 `codex/survey-generalized-w`。本增量只有版本合同、纯数值核、独立算例和测试；未接 Runtime、HTTP、桌面界面或持久化，未更改正式平差算法、观测数据、成果状态或公开版本。完整 Baarda、分布函数、多重比较、功效/MDB 和工程结果批准均不属于本次完成范围。

合同为 [survey-generalized-w.ts](../../kun/src/contracts/survey-generalized-w.ts)，入口为 [diagnoseGeneralizedW](../../kun/src/engineering/survey-generalized-w.ts)。算法标识固定为 `fixed-linear-known-covariance-generalized-w-1`。

## 计算模型与输入声明

采用固定线性模型 `y=A*x+epsilon`、备择方向 `E[y]=A*x+c*b`，残差必须为 **观测减平差值**：`v=y-A*xhat`。这与已有部分 WLS 原语使用的相反残差符号不同；本核独立构造该符号，没有直接套用旧结果的残差。

请求完整保存观测和参数 ID、参数与观测单位、A、y、完整 C、偏差方向及其 ID、协方差依据原文、检验家族 ID、alpha、双侧声明，并对 schema 规范化后的请求计算 SHA-256。alpha 只用于记录预声明，没有在当前算法中产生临界值、p 值、拒绝判定或多重性修正。

初版最多 64 个观测、16 个参数、64 个偏差方向。要求所有数值有限，维度完全匹配，ID 唯一，偏差方向非零。A 必须数值可解析且列满秩，观测数必须大于参数数。秩亏自由网、外加等式约束、隐式固定点、伪逆、岭项、非线性迭代均未实现；不会通过增加约束或小对角数补秩。全零 c 作为无意义请求拒绝，非零 c 落在模型列空间则返回不可探测。

C 必须显式声明为 **已知先验、绝对观测协方差**，不是残差协方差、相对协因数、路线长度权或同批数据估计出的后验尺度。矩阵需要对称正定并满足当前数值可解析条件。依据文本只是用户声明，不能证明真实随机模型；输出始终为 `assumptionsVerified=false`、`familyDeclarationVerified=false`。仅知道均值和协方差并不蕴含正态分布；将来使用标准正态分布仍需要另立分布假设合同。

## 公式、白化与投影

方法依据沿用既有 [高级方法来源登记](./evidence/railwise-advanced-methods-20260920/sources.json) 的 **AMIRI-2007**：A. Amiri-Simkooei 博士论文，纸页 17 / PDF 29，式 (2.39)。既有 PDF 指纹为 `4c4b6311f6da13844f559c48a57a62cd5467434b51d563805ae176a7a4ec9207`。本轮没有重新下载、重新核读全文或取得专业签认；这些文献不是中国工程规范或质量验收结论。

广义单方向统计量为：

```text
w(c) = cᵀ C⁻¹ v / sqrt(cᵀ C⁻¹ Cvv C⁻¹ c)
Cvv = C - A (Aᵀ C⁻¹ A)⁻¹ Aᵀ
```

实现不显式求逆 C，也不相减两个接近的协方差矩阵计算分母。令 `D=diag(sqrt(C_ii))`，对相关矩阵 `S=D⁻¹ C D⁻¹=L Lᵀ` 进行 Cholesky 分解，再构造 `B=L⁻¹D⁻¹A`、`z=L⁻¹D⁻¹y`。逐行尺度平衡保留完整相关性，并避免纯单位变换造成不必要的条件数放大。

白化直接复用既有 `choleskyDecompose` 和 `solveLowerTriangular`。B 的每列按二范数归一后，在此独立诊断核内采用列选主元的 Householder QR。该 QR 是软件实现选择，不是论文规定的具体算法，也没有替换正式 WLS 求解器。

将 `Qᵀz` 分为参数部分和残差尾部 `t`。对白化方向 `u=L⁻¹D⁻¹c` 作相同变换，取尾部 `u_tail`，则：

```text
w = (u_tail / ||u_tail||)ᵀ t
detectabilityRatio = ||u_tail|| / ||u||
Cov(v) = D L Q_tail Q_tailᵀ Lᵀ D
```

c 在白化前先除以其最大绝对元素，白化后再按范数归一；这些正比例缩放不改变 w 或可探测性。Cov(v) 由最后一个表达式的 Gram 矩阵计算，避免 `C-C_fit` 的消减。正定 C 下，c 位于 `col(A)` 等价于尾部为零。近于该空间而数值未分辨的情况不替换分母、不生成无穷大，也不伪称数学严格为零。

## 数值可解析边界

- 相关矩阵采用公共 Cholesky 原语的相对对称容差 `1e-12` 和相对主元下限 `1e-15`。容差内上下三角舍入差使用该原语的下三角；超出容差、非正定或主元无法解析均返回不可用。
- QR 在白化且列归一化后的矩阵上要求剩余列范数大于 `1e-10`。这属于数值秩规则，不是任意量纲下的固定绝对阈值，也不是对原始 A 的条件数保证。
- `detectabilityRatio <= 1e-10` 时，方向状态为 `not-detectable-or-numerically-unresolved`，w 为 null；真实列空间与有限精度下过近的方向不作不实区分。
- 显式 `y-A*xhat` 与正交投影残差的差异必须满足相对输入/拟合量范数的 `1e-10` 后向检查。该检查单独不足以支持标准化统计量，因此还执行下述统计误差预算。
- 计算 `kL=||L||∞ ||L⁻¹||∞`、`kR=||R||∞ ||R⁻¹||∞`，其中 R 来自列尺度归一和选主元后的设计矩阵。统计误差估计为 `64*n*eps*kL²*kR*||z|| / detectabilityRatio`；只有不超过 `1e-8*max(1,|w|)` 才输出该家族的数值结果。这是版本化的保守软件预算，**不是已证明的严格前向误差界、工程限差或置信区间**。它可能拒绝仍可由更高精度方法解决的模型。
- 巨大 `A*beta` 均值相对于很小先验标准差的动态范围，会使 QR 尾部舍入具有虚假统计显著性。预算因此相对白化 z 和 w 检查，不能仅以相对于原始大 y 的微小误差放行。
- 非有限中间量、非零 Gram 对角或残差能量下溢成零、任何非零 Cov(v) 元素或残差能量落入 subnormal 范围（绝对值小于 `2^-1022`），以及任何未达到上述预算的方向，令整个结果返回 `numeric-range-or-backward-error`，不保留貌似可用的部分家族分数。

本核没有“通过”字段。所有可解析结果仍明确：不改变观测，假设未核实，分布与多重比较未执行，规范符合性及真人签认未评定。输出中的条件估计指白化相关矩阵的 L 与归一化设计的 R，不能解读为原始坐标模型或整个工程的条件数。

## 独立证据与已执行验证

独立智能体以 Python 标准库 `Fraction` 做精确 GLS、协方差和方向二次型计算，以 70 位 `Decimal` 输出平方根与 w；该计算不导入产品代码、NumPy、SciPy 或共享数值生成器。脚本与原始输出已保留：

- [fraction_oracle.py](./evidence/railwise-generalized-w/fraction_oracle.py)
- [fraction_oracle_output.json](./evidence/railwise-generalized-w/fraction_oracle_output.json)
- [数值与边界测试](../../kun/src/engineering/survey-generalized-w.test.ts)

相关观测金标准：`A=ones(3,1)`，`y=[0,11,2]`，`C=[[4,1,0],[1,9,0],[0,0,1]]`。精确结果为：

```text
xhat = 103/46
v = [-103,403,-11]/46
Cvv = [[149,11,-35],[11,379,-35],[-35,-35,11]]/46
vᵀ C⁻¹ v = 517/46
w(e1,e2,e3) = [-19/sqrt(115),49/sqrt(230),-sqrt(11/46)]
```

前两个广义 w 与边缘 `v_i/sqrt(Cvv_ii)` 明显不同，防止把相关观测退化为已有逐项 z。四观测、两参数的第二解析模型得到 `x=[-686/611,1466/611]`、指定方向 w 约 `1.4226910512269755`，补充验证 QR 列顺序、尺度和相关矩阵传播。

测试对照了原始模型、同步行排序、参数列交换、故意漏排 c 的负对照、c 反号/正比例、两种一致的 m/mm 表示、混合行单位变换、单独 C 乘 9、c 加模型空间分量和 y 加模型空间分量。单独 C 乘 9 时 x 不变、w 除以 3；不能误报 w 不变。全部可解析模型同时比对参数、残差、完整 Cov(v)、残差能量和每个方向。

补充边界包括 c 尺度 `1e-150..1e150`、一致单位尺度 `1e-100..1e100`、参数列尺度 `1e-50/1e50`、零残差、非对称/不定/半正定 C、近秩亏、无冗余、重复 ID/错误维度/后验基准注入，以及巨大模型均值 `1e12/1e14/1e16` 与先验 C 比例 `1/1e-20/1e-32`。最后一组明确返回数值不可解析，不输出舍入放大的伪 w；Gram 对角与残差能量的下溢也返回不可用。

重放命令在仓库根目录执行：

```sh
python3 docs/qa/evidence/railwise-generalized-w/fraction_oracle.py
npm --prefix kun test -- src/engineering/survey-generalized-w.test.ts src/engineering/survey-adjustment-core.test.ts src/engineering/survey-statistical-diagnostics.test.ts
npm --prefix kun run typecheck
```

当前针对性验证为新增 42 项测试和已有 24 项数值回归，共 66 项通过；所选良态解析算例采用相对/绝对混合 `1e-11` 软件比较容差。转换后的极小协方差先还原单位后比较，避免以固定绝对误差让全零协方差假通过。此证据不等于精确候选包验收，也没有消除真实工程先验协方差与模型适用性所需的专业证据。

附加软件回归：根目录与 Runtime 类型检查、三个新增 TypeScript 文件的 ESLint、Runtime 编译和 `electron-vite build` 均通过。桌面全量测试为 318 个文件通过、2 个文件跳过，2606 项通过、2 项跳过。隔离工作区复用了主工作区的 `node_modules` 符号链接；首次默认配置有 3 项 PDF 预览测试因 Vite 禁止读取链接目标而失败。仅在仓库外临时配置增加这两个目录的 `server.fs.allow` 后，原失败文件及全量测试通过，未改产品、测试源码或仓库配置。没有运行可能重装共享依赖的根目录 `build:runtime` 脚本；编译使用 `npm --prefix kun run build` 和 `electron-vite build` 分步执行。

独立实现审查发现并已修复一个 subnormal 边界：两观测均值模型、`C=3*Number.MIN_VALUE*I` 时，逐项 Gram 乘积量化曾令输出 Cov(v) 不再半正定，尽管 w 本身接近解析值。现在保守拒绝非零 subnormal 协方差元素及残差能量，避免仅拒绝彻底下溢为零仍漏过严重相对误差；该解析负例已纳入回归。

独立审查者复测修复后的编译产物：`1/2/3/4/5/7/100/1e5/1e10 × Number.MIN_VALUE` 的双观测协方差边界全部明确返回不可用。另以固定种子 `20260920` 生成 96 个小整数正定协方差、满秩设计案例，采用不导入产品算法的 Fraction 精确 GLS 与 70 位 w 作为对照；95 项可解析结果的参数、残差、完整 Cov(v)、残差能量和 w 均一致，最大混合误差 `2.70894e-14`（比较阈值 `1e-11`）。剩余 1 项被已声明的保守统计误差预算拒绝，没有作为数学失败或工程不合格处理。该追加审查已归档为 [便携独立复核](./evidence/railwise-generalized-w/independent-review/README.md)，包含解析、96 个固定种子模型、9 个次正规反例与 18 个巨大均值边界，共 136 项。整合树实际重放 0 不符，Bun 执行最大混合误差为 2.0983e-14；与此前 Node 编译产物的末位差异保留，均在声明容差内。
