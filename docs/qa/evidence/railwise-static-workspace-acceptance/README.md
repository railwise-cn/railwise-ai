# 静态追加精确包验收准备

使用邻目录 `railwise-static-workspace` 的 sample、stale-base、maximum 三份声明，分别保存到同一独立合成项目。sample 基线 [0,2,4] 的解2/SSE8/先验方差1/3；追加8、-1后解13/5、SSE256/5、先验方差1/5，后验因子64/5仅为诊断。旧指纹配修改后的基线必须不可用；最大输入为256观测/16参数/128追加。

`inspect-packaged-trials.py DATABASE --project ID` 以只读SQLite读取真实记录，独立标准库Fraction构建并求逆有理数正规方程，对照基线、追加、独立批处理全部参数/协方差/残差及每个前缀SSE；同时核原始UTF-8摘要和SQL身份。没有导入产品计算代码，不声称重建所有JS canonical hash或验证真实来源。所有三份已知声明均须存在。

`development-smoke.mjs CHECKOUT` 在实际compiled service创建三例并调用Python；三例/130个追加前缀检查通过，结果在development-smoke.json。这是准备验证，**不是已执行打包GUI**。实机需另外检查确认、计数、单位、完整表、原生导出、历史/重启、损坏/过期拒绝及主题窗口键盘。
