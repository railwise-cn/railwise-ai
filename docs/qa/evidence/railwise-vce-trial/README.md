# 受限线性分组方差分量试算 V1

此目录记录纯计算核和独立数值评测。它没有 HTTP、GUI、数据库写入、正式权替换或发布行为；不构成仪器能力证明、规范符合性结论或真实项目验收。

## 原始方法核对

Amiri-Simkooei, A. R. (2007), *Least-Squares Variance Component Estimation: Theory and GPS Applications*, TU Delft 博士论文。

- 原文：<https://repository.tudelft.nl/file/File_4e541723-5634-41e7-8d78-cb7ae7415568>
- 原 PDF：5,218,189 bytes；SHA-256 `4c4b6311f6da13844f559c48a57a62cd5467434b51d563805ae176a7a4ec9207`。
- PDF 第 66–68 页（印刷页 54–56）：Eq. (4.102)–(4.105)、(4.110)–(4.113) 和固定 Qk、更新分量的迭代说明。已提取并逐页渲染核对，确认 1/2 系数及残差方向。
- PDF 第 73 页（印刷页 61）：Example 4.8、Eq. (4.125)–(4.129)，已渲染核对；初始值会影响是否遇到负分量。
- PDF 第 49–50、74–75 页：投影协因数矩阵必须独立；互斥分组本身不能保证可辨识。例如 `A=[I;I]` 两组对应相同条件空间协因数。
- 原文承认迭代后不保证严格最小方差（PDF 68 页末）；本实现不输出方差分量协方差，也不把迭代结果宣称为普适最优估计。

未将原论文 PDF 再分发到仓库。这里引用的是方法论文，不是工程验收标准。

## 精确支持边界

`E[y]=A x`，固定、满列秩的线性 A；`C=sum(theta_g Qg)`，`Q0=0`。每条观测显式归属一个组，`Qg` 只在该组的对角线上有已知正数 `q_i`。独立观测、模型正确性、无粗差、来源真实性均由调用者提供，计算不能验证这些假设。

输入严格拒绝未知字段，不能夹带相关协方差、重叠分组、先验固定协方差或非线性模型。组名、参数名、观测名各自唯一；所有组须有观测。系数表示同一声明长度单位内的线性映射，`q_i` 无量纲，`theta_g` 单位为 m² 或 mm²；调用者必须一致地转换输入，系统不自动猜测单位或分组。`sourceAnchor` 是声明来源，不是来源鉴证。

支持 2–128 条观测、1–32 个参数、1–8 组；功能自由度必须为正。初始方差和每步候选方差限于 `[1e-18,1e18]`，相对方差限于 `[1e-8,1e8]`，观测绝对值不超过 `1e6`（声明单位）。迭代 1–100 次，逐分量相对停止阈值 `[1e-12,1e-4]`。这些是计算边界，不是生产验收指标。

## 实际计算与证据解释

取 `s=min_i C_ii`，归一化权 `W=s C^-1`，`R=W-W A(AᵀWA)^-1 AᵀW`，残差 `e=y-A xhat`：

```
N_gh = 1/2 sum_{i in g,j in h} q_i q_j R_ij²
l_g  = 1/2 sum_{i in g} q_i (W_ii e_i)²
theta_next = solve(N,l)
```

这是 Eq. (4.110)/(4.112) 的 `Q0=0` 情形，两边同时乘 `s²`；因此 trace 内的 N/l 不是未归一化的论文矩阵，**不可将这里的 N⁻¹ 当成方差分量协方差**。`covarianceScale=s` 和 `normalConvention` 保留此约定。

A 按列最大绝对值缩放；先减去 A 中的一个拟合向量以降低大基准值残差相消，不自动插入截距。共享矩阵核负责矩阵运算，缩放后才求逆。加权设计通过 Householder QR 构造残差空间 B，再用 `R=sqrt(W) B Bᵀ sqrt(W)`，避免直接相减两个近等投影矩阵。检查残差基正交性及与加权设计的正交性；还检查无量纲组掩码的投影 Gram，防止极端 q 比例把消减噪声放大成虚假的随机可辨识性。初始及加权功能法矩阵、无量纲组投影 Gram、随机法矩阵的无穷范数条件数须不超过 `1e8`，C 的对角比须不超过 `1e8`；逆矩阵回代误差须不超过 `1e-8`。检查残差的数值分辨率、输出参数重构残差及加权正交条件；非零残差的加权能量下溢或进入次正规数精度时明确报数值失败，不报零方差；不能支撑结果精度时停止。

每步保留当前方差、该方差的拟合值/残差、归一化 N/l、候选方差、条件数和相对变化。停止量为 `max_g |next-current| / max(|next|,|current|)`。非正候选立即停止，保留失败候选，不夹紧、不替换初值、不隐藏重试。超迭代次数和数值失败均不提供 `convergedVariances`。收敛后用最终接受方差重算 `finalFit`，避免报告上一步的拟合。

所有输出固定为 `trial-only`、`modelAssumptions=not-verified`、`engineeringDecision=not-evaluated`、`formalWeightsModified=false`。

## 独立评测与重放

`oracle.py` 不导入 TypeScript 或共享矩阵核。它以 NumPy SVD 求 A 的左零空间 B，转成 `t=Bᵀy`、`Qtg=BᵀQgB`，在条件空间使用 Eq. (4.39)/(4.41) 的迹和二次型，再迭代。Example 4.8 负例同时用 Python Fraction 直接按 Eq. (4.126) 求得 `[-37/25,42/5] mm²`。高精度 oracle 是数值参考，论文自身仅发表三位小数。

| 算例 | 结果 |
| --- | --- |
| 论文 Example 4.8，初始 `(1,1)` | 第一轮 `(-1.48,8.40)`，非正分量停止 |
| 同算例，初始 `(1,10)` | 13 轮收敛至 `(0.23485855696841812,5.183991736362312)` mm²；与论文 `(0.235,5.184)` 一致 |
| 单组常量模型 | `SSE/(m-n)=10/3` |
| `A=[I;I]` 两组 | 随机模型不可辨识，停止 |
| 三组、两个参数、非单位 q | 正向独立 oracle 及另一个非正边界例 |

运行（仓库根目录，Python 需 NumPy；记录版本见 JSON）：

```sh
python3 docs/qa/evidence/railwise-vce-trial/oracle.py
(cd kun && node_modules/.bin/vitest run src/engineering/survey-vce-trial.test.ts)
(cd kun && node_modules/.bin/tsc --noEmit -p tsconfig.json)
node_modules/.bin/eslint kun/src/contracts/survey-vce-trial.ts kun/src/engineering/survey-vce-trial.ts kun/src/engineering/survey-vce-trial.test.ts
```

回归还覆盖行/组/参数重排、参数比例变换、m/mm 单位变换、公共初始方差尺度、基准平移、零方差、设计欠秩和近欠秩、协方差动态范围、低于基准分辨率的方差信号、最大迭代、严格 DTO、输入不变性、N/l 回代与最终方差的拟合一致性。不存在借助 UI 截图或模拟专业身份宣称真实工程验收的做法。

## 独立边界审查归档

`independent-review/` 提供另一智能体独立编写的 Python Fraction 参考生成器、Bun 产品核调用器及紧凑结果。它不使用 NumPy oracle，覆盖 1,356 组单参数尺度/基准/不等 q 组合，以及 10,650 个具有严格不可见方差组的模型；修复后零数值不符、零错误可辨识结果。审查实际发现并推动修复了残差能量下溢和投影相减噪声放大两处缺陷，报告保留前后证据。收敛方差最大相对误差约 `1.18e-15`。这属于独立软件数值复核，不是真人签署或工程验收。

`independent-review/multi-group/` 另提供 Fraction 条件空间的 160 组首步对照、80 位 Decimal 的 32 组迭代对照，以及 4,306 组不可辨识变体重放。24 个收敛案例完整迭代及最终拟合最大混合误差约 `6.28e-15`；一个范围边界案例的软件保守停止早于高精度参考，明确保留失败状态及误差，不计为收敛。所有最小归档脚本已在归档目录实际重放；大型可再生输入缓存由 `.gitignore` 排除。
