# 指定参考集合两历元纯核独立数值审查

日期：2026-09-20。被审查树 `/private/tmp/railwise-statistical-family`；源码 `kun/src/contracts/survey-reference-datum.ts`、`kun/src/engineering/survey-reference-datum.ts`，编译后 Node ESM 入口 `kun/dist/engineering/survey-reference-datum.js`。本次未修改实现。

**结论：当前纯核限定合同下没有未解决数值阻断。108 个独立模型 / 8,466 个标量通过精确 Fraction 及 120 位 mpmath 比较，32 项独立边界判定通过。另实际重跑作者82个产品测试全部通过。** 结论不扩展到尚未实现的 Runtime/UI/真实来源绑定，也不是专业人员签署或物理稳定性确认。

## 独立性与模型

本目录生成器为第二审查智能体另行编写，随机seed `280620261`，没有导入产品生成器、求解函数或作者的54例golden。36个联合有理Gram模型分别执行GLS和显式等权，包含2–7点、异方差、非对称跨期块、参考真子集。前4组另做 m/mm（坐标×1000、全部协方差×10^6）、两期共同原点+10^8、第二历元整体+1000、两期不同原生点序与跨期双轴重排、mapping/referenceIds逆序。

增加独立解析异方差对角模型、相关参考产生负权模型。后者差协方差参考块为 `[[1,2],[2,5]]`，GLS权必须是 `[3/2,-1/2,0]`，不能截为非负；声明差 `[2,6,11]` 时参考平移为0、相对位移保留 `[2,6,11]`、平移方差1/2。显式等权另算，二者不互相替代。

Fraction oracle 以 `Fraction.from_float` 取**实际 binary64 输入**的精确值，通过独立 Gauss-Jordan 与有理矩阵乘法构造 `D=C1+C2-C12-C12ᵀ`、权、平移、全部相对位移、`T`、位移完整协方差和平移/位移互协方差。第二条路径用 mpmath1.3.0 的120位 lu_solve和矩阵乘法再核对关键传播量。Node probe只导入编译产品，与两个oracle分开。

## 实际数值结果

- 108/108 正常模型返回 calculated。
- 8,466 标量最大按运算尺度归一误差：`2.220446049250313e-16`。
- Fraction 与120位计算最大归一差异：`2.904443936136989e-120`。
- 已检查坐标实际误差 / 返回coordinateRoundoffEstimate最大：`0.00355884425652`。
- 已检查方差/位移协方差实际误差 / 返回covarianceRoundoffEstimate最大：`0.000255504251366`。

归一化按量纲分别使用原差值量级与 `max|D|*(1+sum|w|)^2`；不把 m→mm 后真实为零的互协方差附近纳米级舍入残差错误称为较大相对误差。软件估计仅是诊断而非认证误差界；此处通过的是这些合成模型，没有证明全域误差界。

## 边界与语义

32项另存 `boundaries.json` 和 `boundary-results.json`；其完整联合矩阵的最小特征值另用120位对称eigsy记录，方便区分真负值与浮点政策：

- C1=C2=I、C12=-2I：D=6I虽正定但完整联合块不合法，两方法均拒绝。
- 零协方差、秩一参考、自由基准 `I-J/4` 的全参考：GLS明确 `reference-covariance-rank-or-conditioning`，不伪逆、不默认等权。显式等权可以定义相应基准；自由基准真子集仍允许GLS。
- 近边界相关 `1±5e-11`：保留 `semidefinite-or-unresolved-within-numerical-tolerance`。负特征值例在选定参考下传播的各方差仍非负，可返回声明矩阵试算，但**不声称PSD已验证**；逐项确认原请求不变、`matrixRepair:none`、D保留原略大于2的非对角值，没有特征值剪裁或jitter。
- 跨期对角相关略大于1，即便联合特征值在模糊区，D传播出现负方差也明确停止，不截零。
- 参考相关条件约2×10^9允许；约2×10^11拒绝；独立校验上限分支。
- 任意非严格对称、负输入方差、零方差但非零行、方差低于1e-100、联合正方差比超过1e12、次正规输入坐标均拒绝。
- 缺少dependence不默认独立；缺少参考点不自动选择；单参考、非双射映射和cofactor冒充绝对协方差均拒绝。
- 最大32点/64维联合块GLS实际计算成功。
- 全部结果保留sourceRecordsVerified=false、formalCoordinatesModified=false、referencePhysicalStability=not-evaluated、caller-declared-no-automatic-selection，来源SHA字符串没有变成“已验真”。

## 限定建议

当前近PSD的 calculated 表示按声明矩阵传播，必须连同 covarianceCheck 的 unresolved classification和原矩阵一起保留。后续 Runtime/UI 不得将该结果显示成“协方差有效”或“稳定参考点已确认”。本合同不负责自动参考选取、显著性、二维/三维变换或从自由平差cofactor推定绝对精度；这些不能由当前测试结果推导。

## 重放

先在目标checkout完成 `npm --prefix kun run build`，需要 Node、正常产品依赖和 Python mpmath1.3.0：

```sh
REVIEW_PYTHON=/path/to/python-with-mpmath /path/to/evidence/replay.sh /absolute/checkout
```

runner生成全新临时证据目录，重放所有108+32例与精确数值比较，不改生产源或已有golden文件。当前已有环境可用 `/private/tmp/railwise-next-kernels-review/oracle-env/bin/python`。本次源码/编译文件SHA256在 `source-hashes.json`；计数和数值误差在 `audit-summary.json`。
