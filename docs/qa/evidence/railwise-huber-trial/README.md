# 固定外部尺度 Huber IRLS 只读试算 V1

本记录对应新增纯函数 `runSurveyHuberTrial`，不替换现有平差器、广义 w 诊断或 VCE，不接入正式成果权重，不修改或剔除观测。本阶段没有桌面 UI、IPC、数据库、打包或发布变更。

## 模型和输入责任

调用方声明 `y = A x + e` 为固定线性、满列秩且观测独立的模型，并显式提供每个观测的来源锚点、唯一标识、参数标识/单位、初值、固定外部尺度 `s` 的依据和相对标准差 `r_i`。这些声明不等于经过验证；`sigma_i = s r_i`。不接受相关协方差或白化输入，不估计尺度，不支持约束或秩亏模型。调用方需自行核对 `A x` 和 `y` 的物理量纲。

输入最多 128 条观测、16 个参数，要求 n > p；尺度为 [1e-12,1e12]，相对标准差为 [1e-8,1e8]，k 为 [1e-6,1e6]。观测、系数和初值须有限且绝对值不超过 1e150。未知字段、非有限数、维数/单位不一致和重复身份均拒绝。

定义 `u_i = (y_i - A_i x)/sigma_i`，最小化 `F(x) = sum rho_k(u_i)`，其中 `rho_k(u)=u²/2`（|u|≤k），否则为 `k(|u|-k/2)`。IRLS 乘子 `m_i = min(1,k/|u_i|)`，在 u=0 时为 1；派生试算权重为 `m_i/sigma_i²`，字段命名 `derivedIrlsWeights`，不是精度估计或正式权重。

## 算法与可审计停止条件

标准化设计 `A_i/sigma_i` 按列二范数缩放得到 B。每步用 `sqrt(m_i/max(m))` 对 B 和 `y_i/sigma_i` 加权，并通过带列选主元的 Householder QR 解绝对参数；避免采用“大初值 + 反向巨大修正”的消减方式。QR 是基线提交 `7d8e92b461b6697cf782d197c05c392b6d62de03` 中 generalized-w 私有实现的孤立改编，未修改共享求解器。

秩阈值为列标准化之后的 1e-10，R 的无穷范数条件数估计上限为 1e8。原始设计及每一次 IRLS 设计均检查。阈值是软件数值政策，不是工程规范限差。

记录初始状态和每一个成功求得的候选状态，含参数、拟合值、残差、标准化残差、乘子、派生试算权重、目标函数、QR 条件数估计和停止指标。停止采用无量纲列标准化 score：`Bᵀ psi(u)/k`。除初值已满足 score 条件的情况外，必须同时满足：

- score 无穷范数 + score 舍入估计 ≤ 声明的 score 容差；
- score 舍入估计 ≤ 0.1 × 声明的 score 容差；
- `max |(A_i/sigma_i)(x_new-x_old)|` ≤ 声明的预测步长容差；
- `|F_new-F_old|/max(1,F_old,F_new)` ≤ 声明的相对目标变化容差。

每项容差必须在 [1e-12,1e-4]，最多 200 次迭代。巨大且与参数无关的常量损失可能使相对目标变化舍入为零，但无法绕过 score 和步长条件。`stationary` 仅表示本声明模型下满足这套浮点停止政策，不表示精确最小值或工程验收。

舍入估计采用 `64(p+1) eps (|y_i|+sum|A_ij x_j|)/sigma_i` 估计残差计算影响，传播至截断 score 和目标函数；只有整个残差误差区间都位于同一饱和尾部时才把该项 score 变化估为零。求和另加与 n、eps 成比例的预算。这些是保守的软件估计，未经区间算术证明，**不是认证误差界**。

以下情况不输出接受参数：输入非法、秩/条件数不满足、算术溢出或不可解析范围、目标增量超过软件舍入预算、未满足 score 的零步长、以及迭代耗尽。非零模型乘积落入 subnormal 范围、非零残差标准化为零、非零损失/乘子/派生权重低于最小正规数时均拒绝。极大坐标原点可能产生数值边界或迭代耗尽；不会将其接受为解。失败保留此前有限状态，便于追踪。

## 唯一性与结论边界

Huber 目标是凸函数，但满列秩不保证唯一极小值。例如 y=[0,0,10,10]、A=1、sigma=k=1 的极小值区间为 [1,9]，目标值为 18。V1 只检查严格内点满足 `k-|u_i| > 8 × residualError_i + 1e-10 k` 时的子设计秩/条件数；严格内点子设计满秩是唯一性的数学充分条件，但浮点阈值检查不是形式认证，因此始终 `uniqueMinimizerCertified:false`。

未满足该充分条件时输出 `not-established`，不能反向断言非唯一。例如 y=[0,2] 的唯一解 x=1 恰在两个折点处。高杠杆反例 A=[1,1,100]、y=[0,0,100] 的解接近 1，说明残差 Huber 试算不保证抵抗高杠杆点。

始终不提供参数协方差或高斯 WLS 精度，最终 IRLS 正规矩阵的逆不能冒充稳健估计协方差。始终声明：尺度/模型假设未核验、正式权重未修改、无观测处理动作、工程判定/规范符合性/人工签署未评估。该内核未完成相关误差、尺度估计、影响函数推断或稳健精度估计。

## 来源及阅读范围

损失函数来源：Peter J. Huber, *Robust Estimation of a Location Parameter*, Annals of Mathematical Statistics 35(1),73–101 (1964), DOI [10.1214/aoms/1177703732](https://doi.org/10.1214/aoms/1177703732)。此前调研已阅读 [Project Euclid 发布者摘要](https://projecteuclid.org/journals/annals-of-mathematical-statistics/volume-35/issue-1/Robust-Estimation-of-a-Location-Parameter/10.1214/aoms/1177703732.full) 中的污染模型和分段损失公式，登记见相邻 `railwise-advanced-methods-20260920/sources.json` 的 HUBER-1964。

本次没有新增网页读取；29 页论文全文未阅读，没有留存不可变原网页及其哈希。固定线性回归 IRLS、数值守卫和停止政策是本软件明确限定的实现扩展，不宣称由该摘要完整证明。本记录不是中国测量规范条文、外部专家签字或真实项目精度认证。

## 独立真值与回放

`huber_fraction_oracle.py` 由独立复核任务提供，枚举残差的负尾部/内点/正尾部分区，使用 Python Fraction 有理数消元得到候选点并严格验证零 score；它不使用 IRLS、不导入产品代码。`huber-exact-cases.json` 保存 12 个解析案例，包括位置异常值、不同 sigma/scale、直线多异常值、平坦区间、二维平坦矩形、高杠杆、精确及邻近折点。

枚举器只用满秩内点分区求出候选；找到多个不同的精确极小点可以证明非唯一，仅找到一个候选不能证明唯一。产品测试因此不从候选数量单独推出唯一性。

在仓库根目录回放：

```sh
python3 docs/qa/evidence/railwise-huber-trial/huber_fraction_oracle.py
npm --prefix kun test -- src/engineering/survey-huber-trial.test.ts src/engineering/survey-generalized-w.test.ts src/engineering/survey-vce-trial.test.ts
npm --prefix kun run typecheck
npm --prefix kun run build
node_modules/.bin/eslint kun/src/contracts/survey-huber-trial.ts kun/src/engineering/survey-huber-trial.ts kun/src/engineering/survey-huber-trial-qr.ts kun/src/engineering/survey-huber-trial.test.ts
```

实际验证：新增 61 条测试通过，与 generalized-w、VCE 合计 148 条回归通过；runtime typecheck、runtime build 和新增文件 ESLint 全部通过。测试覆盖不同初值、长度单位、参数列置换/极端缩放、观测置换/带符号非均匀缩放、强相关设计、溢出/下溢、巨大坐标原点、巨大常量损失、迭代耗尽、请求不变性与状态合同。


独立复核追加 `huber_random_oracle.py` 的 48 个固定随机种子（20260920）案例，与 12 个解析案例合计 60 个；归档 Bun 探针仅将临时 worktree 默认路径改为调用时仓库根目录，数值计算保持独立，另增加 suspect/unexpected 非空时非零退出的回放守卫。60 个案例全部满足停止政策，最大相对目标差 2.25968e-16，最大参数缩放差 4.43541e-10。56 个变换/尺度端点案例得到 46 个 stationary、4 个 iteration-limit、6 个 numerical-boundary；没有错误接受。高杠杆例加 10 的偏移因 score 预算 6.25346e-11 超过 0.1 × 1e-10 而保守拒绝，其余未接受案例涉及巨大原点；并不声称所有合理输入都能达到声明精度。

独立 180 位精度复核以实际输入的双精度数和输出参数作为精确起点，重新计算残差、score、目标函数。60 个接受点最大真实 score 为 4.76848e-11；最大 score 计算差 2.223e-15，均在对应软件预算内，目标差亦均在预算内。上述实测覆盖是本批案例证据，不能证明舍入预算对所有输入都是数学上界。

追加回放命令（Bun 运行于仓库根目录；高精度复核需 Python mpmath==1.3.0）：

```sh
python3 docs/qa/evidence/railwise-huber-trial/huber_random_oracle.py
bun docs/qa/evidence/railwise-huber-trial/huber_probe.ts
bun docs/qa/evidence/railwise-huber-trial/huber_transform_probe.ts
python3 -m venv /tmp/railwise-huber-oracle-env
/tmp/railwise-huber-oracle-env/bin/python -m pip install mpmath==1.3.0
/tmp/railwise-huber-oracle-env/bin/python docs/qa/evidence/railwise-huber-trial/huber_audit.py
```
