# GB/T 24356—2023 最小评分纯核独立审查（冻结版本）

本次独立审查基于已逐页核查的源文合同 `/private/tmp/railwise-quality-scoring-contract.md`。标准PDF SHA256：`96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`。当前被审查树 `/private/tmp/railwise-quality-scoring`。未编辑作者代码或主树；探针只在本目录和fresh tmp写入证据。

**冻结结论：无未解决评分纯核阻断。编译后的 Node ESM 在全新临时目录重放 6,638 个独立检查全部通过：70规则边界、1016公开profile层级结果、5455最终检查批等级、97公开状态/证据/精确数值边界。作者101个产品测试也已由本审查者实际重跑通过。**

最终运行时间：2026-09-20 08:10:45前后（Asia/Shanghai）。源模式与编译模式6471个profile/batch结果摘要SHA256相同：`15b84b7bfab34939a409643ed910828b8a2d42d623e8b74b6cf7fc9574dafafa`。源/编译文件哈希见source-hashes.json。

## 来源与独立性

72项原始Fraction oracle在生产实现前编写；本次其中70项直接适配纯规则，2项简化抽象层级例由全面的真实产品profile层级矩阵替代。生产公开接口不能以这些抽象例为理由允许任意产品权值。

新Python标准库Fraction生成器独立硬编码源文表43/45树：数据.5/点位.3/资料.2；数学精度.3/观测.4/计算.3；选点.5/埋石.5；整饰.3/完整性.7。枚举7叶所有127个非空scope，每个scope4组混合分数[60,75,90,100]，两个公开profile合计1016个结果。逐项核对最终精确分数、等级、元素得分、各层有效权和full/partial scope标记，能区分逐层归一和错误的全部叶一次归一。

批次oracle穷举N=1..30全部5455组E/G/Q，用Fraction比例条件计算优/良/合格；不调用产品公式。另有百万批量边界验证49.9999%不会被显示舍入升级为50%。

## 公开接口边界

97条独立探针覆盖：

- 七子元素逐个pending不能当作excluded；六个非数学叶59分各自否决高分兄弟且可以在另一个叶pending时仍给已知失败；七叶各自A均否决；失败无伪综合分。
- 明确partial scope可算本scope得分，完整性标记保留；全excluded没有评分；少一叶、重复叶、错误父节点、数学精度套扣分/其他叶套精度接口均拒绝；重排叶声明不改变结果。
- A/B/C/D任何未知不补0；已知扣分已足够<60时可失败并保留diagnosticScoreUpperBound；B9得原始-8分，不截零。调整t不支持；A否决独立但t<=0等结构数域无效优先拒绝。数学精度表44/46的BCD禁用，零计数也不伪造100分。
- 单项60有效；多项含60不可聚合；24位小数的略高于60可以聚合、略高于m0不给外推分、略高于0.3m0不得浮点舍入为100。24位小数权之和略高于1必须无效，不用float容差修正。
- 缺少m/A证据与已知A分别处理；负幅值等无效输入先拒绝。错标准hash/表号/单位类型/空证据引用/隐式float/指数/零分母/超长数串都拒绝。
- 样本精确算术平均、89.999…不升优；缺单位不可过，已有失败可否决；partial产品scope不能无标记升格为sample qualified成员；错误qualified分数先拒绝。
- 概查B3/B4、A未知与已知失败；最终检查前提未知、声明实际N与计数矛盾；验收的not-performed必须有明确依据，pending/missing/unknown不能借此通过；伪造/重大偏差优先否决，不输出优/良批等级。
- 原输入不变；每个结果均保留evidence/classification/priorQualification未验真、无正式成果修改、无删点、无真人签认。

## 已修正的审查点

审查初期发现内部finalBatch以E+G+Q=0当作空批拒绝，但公开接口允许实际声明N>0且分类计数尚缺失。向作者指出后，公开entry区分了两者：membership incomplete/unknown返回unavailable并保留声明N；已有priorBatchQualification=failed返回nonconforming；complete却计数总和不等于N仍是invalid。本次公开探针覆盖全部分支，修正已通过。

## 支持范围与限制

这是基于调用者声明检查记录的评分，来源真实性、分类真实性、委托方/此前批资格批准没有自动验真。数学精度仅声明m/m0幅值，不从残差自动生成；公式m>m0及多项等于60分支保守不可判定。第一版精度组要求同unit是明确的软件收窄，不是源文规定不同量纲项目永远不得各自标准化后评分。

计数录入与有限产品profile不是完整规范分类器；公开产品只支持平面控制“点”、高程控制“测段”的表43–46，不替代全章产品、抽样、现场检查或工程签署。所有权重和批前提计算需连同scope/证据状态显示。纯核测试不包含持久化、Runtime/IPC、GUI或打包发布。

## Portable replay

目标checkout先 `npm --prefix kun run build`，随后：

```sh
/path/to/evidence/replay.sh /absolute/built/checkout
```

只需Python标准库与Node及产品正常依赖。runner在全新临时目录生成Fraction profile oracle并对编译Node ESM运行所有探针，不更改生产源或已有golden。每轮输出文件包括70规则逐项结果、6471聚合计数及结果摘要hash、97公开案例完整请求/结果与trace。
