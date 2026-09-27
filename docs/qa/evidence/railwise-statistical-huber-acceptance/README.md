# 统计家族与 Huber 精确包验收输入

这里是下一精确包的验收材料，**不是已完成的 GUI 报告**。7d8e92b 包不含这两种试算。不得用纯核测试或 DOM 原生保存 mock 代替真实安装包检查。

- `huber-unique.json`：独立位置模型 [0,0,0,10]，固定尺度 1、k=1。解析解 1/3，目标函数 28/3；每次状态保留原观测和派生试算权，不提供高斯协方差。
- `huber-flat.json`：[0,0,10,10]、初值 4。整个 [1,9] 都是极小区间，目标 18；应初值即满足停止政策，唯一性未建立。
- `statistical-reversed.json`：完整四成员，正态双侧 3、t(df=1) 双侧 3、chi-square(df=2) 上尾 4，加一个缺失成员。统计项故意按反序输入。Bonferroni 分母必须保持 4，单项 alpha=.0125。概率独立以 erfc、Cauchy 及指数闭式计算；原声明保持反序，内核请求的 statistics 按 ID 排序。

GUI 应逐项检查模型选择/确认、结果解释、完整 df/尺度、原字节与归一模型、历史、重新核验、原生保存取消/成功、切换项目后的旧结果隔离、完整退出重启与篡改恢复。三例使用独立合成项目，依据写明仅用于软件数学验收。所有明暗/尺寸/键盘检查记录实际情况。

包中建完三例后，运行只读标准库脚本：

```sh
python3 docs/qa/evidence/railwise-statistical-huber-acceptance/inspect-packaged-trials.py \
  /ABSOLUTE/CANDIDATE/runtime/engineering/survey-advanced-trials.sqlite3 --project PROJECT_ID
```

它核对实际数据库原始 UTF-8/SQL 身份并独立计算上述特例。JS 规范化哈希和完整算法重放仍由 Runtime 验证；此脚本不认证模型适用性、源锚点或真人签署。

准备验证：`node development-smoke.mjs /ABSOLUTE/CHECKOUT` 在构建后的真实开发 Runtime 服务创建三例、关闭 SQLite，然后调用独立 Python。已取得三例通过的 `development-smoke.json`；它只证明输入和验收脚本可运行，不是打包 GUI 证据。
