# 指定参考基准 Runtime/UI 集成独立审查

日期：2026-09-20。审查主树 `/Users/wangjiawei/Documents/WorkWise`、基线 a606a86 后 reference-datum 集成变更。**20项独立探针全部通过；没有发现未解决集成阻断。** 未修改主树源码，所有探针和报告写独立临时目录。

## 实際覆盖

`client-service.test.ts` 11项：

- generalized-w、vce、huber、statistical-family、reference-datum 五种真实 SQLite service记录，原始UTF-8请求带外层空白、中文、emoji及多行声明；renderer在无全局Buffer环境恢复与export校验通过。reference独有pointCount/referenceCount且observationCount/parameterCount为0；旧kind不新增这两个字段。
- 参考summary缺pointCount、referenceCount>pointCount、非0观测/参数、混入familyMemberCount均拒绝；旧vce混入参考计数亦拒绝。重复JSON键仍在预检被拒绝。
- 自造的近半正定略负特征值、GLS奇异参考子块和合法负GLS权模型，分别保存并恢复unresolved矩阵政策、unavailable拒绝、带负权calculated结果；没有省略失败结果，也没有自动切换等权。
- 自造最大32点、32参考、完整跨期协方差模型实际创建十条，关闭并重开SQLite后十条历史逐条重放成功。整页191/240单位，后续两个21单位单读通过，再次读因额度不足拒绝。32×32协方差完整，单记录低于4MiB。
- 改写持久记录位移并重新计算resultHash、recordHash、storageHash，保持其他合同与元数据一致，仍在service实际重算对比时拒绝integrity。不是只靠旧哈希不一致来拦截。

`gui.test.ts` 9项：

- 中英两语各自从真实service恢复最大32点模型，无Buffer；显示32行点位及mapping、完整差值与位移协方差各1024数值单元；显示显式跨期交叉协方差、caller-declared来源与稳定性限制，没有缺翻译key/undefined/NaN/Infinity。
- 近PSD例仍显示“半正定或数值容差内未分辨，未证明数学PSD、未修补特征值”，不显示数值正定通过；奇异例保持GLS方法并停止，不渲染计算表或改为等权；合法负权使用完整String显示且未截为0。
- Unicode参考记录导出先请求/export重新检查，mock原生save桥收到的UTF-8 base64精确等于完整已重算JSON加换行。项目切换后迟到export不会调用原生save；workspace/revision/runtime改变后的迟到restore不污染新会话。

这些有限模型来自本审查者自编fixtures，与此前独立纯核Fraction/mpmath检查相互补充。纯核数学正确性结论见 `railwise-reference-independent-review`，本次没有以集成测试替代数值oracle。

## 代码只读核查

kind分支贯穿版本化summary/detail合同、service model计费/evaluate/parseRequest、IPC预检、shared导出、renderer预检与request/hash绑定、workspace方法选择/示例/历史/结果。SQLite结构与append-only约束沿用既有实现；reference新summary明确0网络观测/参数、独立点数/参考数，旧四kind条件保留。reference request没有统计族额外排序规则，client按真实schema声明和内核SHA绑定正确。

界面使用完整double字符串输出参考权、平移与协方差；nearPSD文案没有把算法calculated变成有效随机模型或物理稳定性认证。纯核source在本轮集成中未修改，哈希与此前独立纯核审查一致。

## 限制

GUI使用happy-dom，原生另存为桥为mock；验证桥接载荷和响应隔离，不代替真实系统对话框、已签名安装包的明暗主题/窗口尺寸验收。service使用真实SQLite和真实求解器；独立本轮不重跑完整HTTP server套件，主实现任务提供其HTTP/IPC测试证据。来源SHA与依赖关系仍是声明，未读取外业真实资料、验真或真人签认。

最后实际运行：Vitest4.1.7，2026-09-20 08:15:27 Asia/Shanghai，2文件20测试通过，约2.94秒。各源与探针hash见source-hashes.json，计数见summary.json。

## 重放

```sh
/path/to/evidence/replay.sh /absolute/checkout
```

目标checkout需正常Vitest/React/happy-dom/better-sqlite3依赖。入口通过REVIEW_REPO定位源码，无硬编码目标checkout；临时SQLite在测试中创建并清理。不会编辑生产代码。此目录可原样归档后再次执行。
