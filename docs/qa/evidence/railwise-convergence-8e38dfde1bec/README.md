# 8e38dfd 修正版候选验收

2026-09-19，隔离安装源码 `8e38dfde1bec35433f06ff5f7d690554011a0ba5` 的 0.5.0 候选。Developer ID 严格/深层签名通过；无公证票据（stapler 65），Gatekeeper 已有 security-disabled override 不算公证通过。

真实 GSI、IN2 包内 Runtime 导入、校核、平差、三格式成果、draft manifest、文件哈希及独立参考对比全部通过。IN2 33 点 OU2 对照最大差 0.063415839 mm；GSI 独立 WLS 最大差约 0.020316 mm，旧 IN1 测段差异仍需专业复核。双真实 GUI 已完成：IN2 33 点/160 观测，GSI 27 点/28 观测（6 个显式控制高程），均经原生文件选择、校核、平差、三格式导出及草稿清单；两份清单共 6 份磁盘文件哈希匹配，见 gui-manifest-hashes.json。专业审查仍未完成。

独立 NumPy 对编译服务产生的 31 个未知点 XY 协方差做 eigendecomposition，椭圆半轴相对误差最大 1.776e-15、轴向差最大 1.111e-16，见 [记录](./ellipse-independent.json)。此项只独立验证椭圆分解，不是第二套网络平差。

后续 GUI 发现：同项目会话重选清空摘要但不触发 reload，模型重试失败的恢复提示仍为中文。后续源码分别保留同项目选择状态、仅翻译 Runtime 错误显示且保持存储原文；两个 DOM 回归在旧代码失败、修复后通过。后续修复不在本包中。
