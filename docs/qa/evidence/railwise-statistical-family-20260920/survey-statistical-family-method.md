# 预声明统计家族纯核 v1

本批仅新增 `survey-statistical-family` 合同、纯计算函数、原始数值夹具和验证证据；不接 Runtime/API/桌面，不修改既有广义 w、外部学生化 t 或正式平差结果，不包含功效/MDB、自动粗差剔除、完整 Baarda 程序或工程签认。

## 声明与适用范围

输入显式固定家族 ID、完整有序成员、每个成员的分布/尾型/依据定位、家族 alpha，以及 `bonferroni`。声明必须为 `caller-declared-before-observing-statistics`；输出仍为 `familyPredeclaration: not-verified`，软件无法证明家族真正事先确定。

本版只接受调用者声明的精确标量统计量。`statisticPrecision: caller-declared-exact-scalar-inputs-no-upstream-error-propagation` 是必填合同字段。它不传播已有 w 试算的 `statisticErrorEstimate`，不允许直接把本模块的尾函数数值分辨率当作上游统计量误差界；未建立误差传播合同前不自动连接已有诊断结果。所有分布假设仍为 `not-verified`。

- 正态双侧：`w` 已按已知先验尺度标准化；必须声明先验标准差与单位。调用者传入的 `w` 已标准化，本核不会再次除以标准差，也不验证它如何计算。相关观测的 w 必须来自正确的协方差模型，不能用单个边缘 z 冒充。
- 外部学生化 t 双侧：统计量必须为外部学生化，并显式给出整数自由度。不能把内部学生化量或同批后验尺度标准化量直接当正态。
- 卡方上尾：统计量为正确模型下除以已知先验方差的全局二次型，显式给出自由度、先验标准差与单位。只实现上尾，不作方差偏小的双尾判定。

既不验证高斯性、独立性/相关结构、尺度来源、秩/自由度推导，也不以这些声明代替真实数据证据。

## 数学定义与校正

`normal: p = erfc(|w|/sqrt(2)) = Q(1/2,w²/2)`。

`student-t: p = I_{ν/(ν+t²)}(ν/2,1/2)`。

`chi-square: p = Q(ν/2,x/2)`。

其中 Q 为正规化上不完全 gamma，I 为正规化不完全 beta。NIST/DLMF 来源、获取日期和 SHA-256 见 `survey-statistical-family-sources.json`；短公式 TeX 已保存。NIST 的舍入临界值表没有用于高精度断言。

`m = 全部预声明成员数`，`memberAlpha = alpha/m`，`adjustedP = min(1,m*p)`。缺失、unavailable、undetectable、域失败和数值失败均保留在 `m` 中。未提供统计量的成员返回 `unavailable/not-supplied`。重复 ID、家族外 ID、错误尾型、错误版本或缺失声明使整个请求无效，不默默缩小家族。

`requestSha256` 对 schema 解析后的请求按 memberId 排序 statistics 后 JSON 序列化求 SHA-256；它是规范化语义请求哈希，不是原始提交字节哈希。声明成员顺序保留并参与哈希。它只提供重放标识，不提供签名认证。原始输入对象不被修改。

Bonferroni 的条件式家族错误率保证来自 union bound：若完整家族事先固定且每个边缘 p 值在其零假设下有效，则无须各检验相互独立，错误拒绝任意真零假设的概率不超过 alpha。本软件没有验证前提，故输出只陈述 p 与校正阈值的数值关系，不给出“成果合格”“粗差证实”或自动观测操作。

## 数值方法与有界域

| 项目 | v1 固定范围 |
|---|---|
| 家族成员数 | 1–256，包括未计算成员 |
| 家族 alpha | 1e-12–0.5 |
| t/卡方自由度 | 整数 1–1000 |
| 正态统计量 | `abs(w) <= 35` |
| t 统计量 | `abs(t) <= 1e16` |
| 卡方统计量 | `0 <= x <= 1e6` |
| 可输出 p | 1e-300–1；更小的正尾概率返回明确数值失败 |
| gamma/beta 最大迭代 | 4096；不收敛返回 `iteration-limit` |
| 临界值二分 | 扩张上界后最多 160 步，始终在上述域内 |

采用 g=7 的九系数 Lanczos log-gamma 数值展开。下不完全 gamma 在 `x<a+1` 使用正项级数，正规化上尾以 `log1p`/`expm1` 求稳定补数；另一分支直接计算上 gamma 连分式。DLMF 8.9.2 的偶收缩给出 `b_n=x+1-a+2n`、`a_n=n(a-n)`；modified Lentz 防止中间分母下溢。beta 连分式使用 DLMF 8.17.22–23 系数，按互补恒等式选择分支。

t 分布独立计算 `log(x)`、`log(1-x)`，避免极小 t 时 `x` 舍入为 1 丢失补数。极小上尾不通过 `1-CDF` 相减获得。数值域之外、超出迭代预算、非有限中间值、无法包围临界值均有明确状态。低于 1e-300 不返回 `p=0`，也不返回阈值判定。

临界值由指定尾概率的对数方程求根。`logComparisonMargin=2e-10` 是通过独立样例检验的软件比较分辨率政策，**不是数学上已证明的误差界**。当 `abs(logP-log(memberAlpha))<=2e-10` 时返回 `boundary-unresolved`；其他情况只输出 `p-below-adjusted-alpha` 或 `p-above-adjusted-alpha`。`numericalResolutionInterval` 来自目标 `logAlpha ± margin` 的数值求根区间，包含二分端点分辨率；它也不是严格认证的真根包围区间。独立高精度样例中的真根位于该区间只能作为实测证据，不能升级为全域证明。

## 可重复验证

`survey-statistical-family-oracle.py` 不导入产品代码，以固定 `mpmath==1.3.0`、Python 3.12.7、120 位精度调用 erfc/betainc/gammainc，并独立高精度二分临界值。原始 JSON 保留 100 位十进制结果。尾概率以输入 binary64 的精确值计算；临界值使用实际 binary64 的 `alpha/m`，避免将理想十进制和实际浮点输入混淆。

156 个原始尾点覆盖正负、零、极小 t、正态 8/26/35、自由度 1/2/3/10/30/100/999/1000、gamma 切换点两侧、极小尾概率明确失败。36 个临界值覆盖 normal/t/chi、alpha=.05/.5/1e-12、m=1/4/256，独立真根、边界状态、两侧判定均验证。Cauchy(df1)、t(df2) 的稳定闭式及 chi(df2) 的指数闭式另外核对。合同负例覆盖缺失/重复/家族外、NaN/Infinity、域限制、错误尺度/学生化/尾型、分母篡改、未知决策字段等。

重跑命令（依赖安装在隔离 Python venv，非产品依赖）：

```sh
python -m pip install -r docs/qa/evidence/railwise-statistical-family-20260920/survey-statistical-family-oracle-requirements.txt
python docs/qa/evidence/railwise-statistical-family-20260920/survey-statistical-family-oracle.py > /tmp/survey-statistical-family-oracle-regenerated.json
npm --prefix kun run test -- src/engineering/survey-statistical-family.test.ts
npm --prefix kun run typecheck
npx eslint kun/src/contracts/survey-statistical-family.ts kun/src/engineering/survey-statistical-family.ts kun/src/engineering/survey-statistical-family.test.ts
```

JSON fixture 与生成器为本次原创合成数学材料，不是现场观测，不代表仪器连接验收、生产收益指标或授权专业人员签认。独立审阅结果与最终命令摘要另见同目录验证记录。

## 独立审阅归档与构建检查

独立审阅者另编写了 180 位 mpmath oracle：239 个固定尾点（含 33 个额外闭式对照）、固定种子 `20260921` 的 600 个随机域点，以及 45 个临界值、225 个近邻 ULP/远侧判定。结果为 705 个有效概率计算和 134 个真实概率低于支持域的明确失败；最大绝对 log-p 误差 `1.2462059719835392e-12`，样例真临界值均位于软件分辨率区间。归档文件统一加 `survey-statistical-family-review-` 前缀，Python 模块导入改为按文件加载，公式与随机种子未改；三个生成器重跑后夹具字节与原始 SHA-256 完全一致。

重放独立交叉审阅：在上面的固定 mpmath 环境中依次运行 `survey-statistical-family-review-oracle.py`、`survey-statistical-family-review-random-oracle.py`、`survey-statistical-family-review-critical-oracle.py`；从仓库根目录运行 `bun docs/qa/evidence/railwise-statistical-family-20260920/survey-statistical-family-review-probe.ts "$PWD"`，再运行 `survey-statistical-family-review-audit.py`。Bun 只用于加载 TypeScript 探测脚本，不是数值 oracle。

独立审阅指出生产合同 import 缺少 `.js` 会在 tsc 后的 Node ESM 加载失败，虽 Bun/Vitest 可通过；已补后缀并通过真实 `kun build` 和 Node 对构建产物的 256 成员计算。最终 231 项新核测试与 66 项相邻诊断回归全部通过，全量 kun typecheck、目标 ESLint、kun build 通过。完整结果见 `survey-statistical-family-validation.json`、测试日志与独立审阅摘要；没有据此声称桌面或正式发布已完成。
