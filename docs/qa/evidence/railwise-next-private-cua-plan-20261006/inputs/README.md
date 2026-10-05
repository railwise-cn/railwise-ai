# 冻结包验收输入（未执行）

这些文件专为隔离软件验收构造，均为合成资料，不能当现场工程、厂商实算对照或真人签认。原件 SHA-256 和大小见 `manifest.json`；独立预期见 `independent-expected.json`。

- `synthetic-monitoring.csv` / `synthetic-monitoring.xlsx`：同一组 6 行、2 个点、3 期、mm 单位。S01 从 0 到 3，本期变化 2；S02 从 0 到 -2，本期变化 -1。项目应声明符号约定，不从“沉降”自动推断现场方向。
- `synthetic-source-fixed-absolute.json`：固定 BM=10 m，P/Q 初值 10.1/10.2 m，5 条独立高差各有绝对先验 sigma。导入后必须经过真实预检/计算，才能进入来源绑定高级试算。独立 Fraction 法方程给出 P=10.100433333333333 m、Q=10.200033333333334 m，先验交叉协方差为 1.4222222222222223e-6 m²。
- `synthetic-source-fixed-relative-negative.json`：相同网、只有相对路线权；正式计算能力与绝对先验高级模型能力要区分，来源绑定高级模型必须明确拒绝。
- `synthetic-source-fixed-mixed-sigma-negative.json`：首条缺 sigma，其余有绝对 sigma；不得被当作完整绝对协方差。

独立预期由 Python 标准库 Fraction 直接构建设计矩阵、权和 2×2 逆矩阵得到，没有导入产品求解器；它只是这些固定输入的数值预期，不代替实际安装包运算、文件导出和 CUA 验收。
