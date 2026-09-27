# 281 实际 GUI 检查器序列化修复

结论：`Manifest canonical hash` 是检查器对浮点 JSON 的跨语言序列化错误，未发现产品记录哈希错误。数据库和原成果均未写入。

原 `scoring_oracle.py:json_text` 明确假定“ASCII字段和整数JSON”，该条件适用于评分合同；`verify_records.py` 将同一函数用于工程清单。真实GUI生成的IN2清单包含平差浮点数，开发保全夹具没有覆盖这类数字。

本次首个字节差位于规范化文本偏移163：水平闭合量 `1.3726709029343796e-7` 被Python写为 `1.3726709029343796e-07`。其他潜在差异包括小数/指数切换、负零和UTF-16键排序。中文项目名不是本次根因。

| 核验 | SHA-256 |
| --- | --- |
| 数据库冻结的manifestHash | `e17adbea183f93b0afd8a2395e6d6706d7c03254e570f4018714339c9fe2c13d` |
| 旧Python排序JSON重编码 | `55cd0af2d3637f75577ecff204c1539c6eac62a5de6126362256b6aaaa2121e2` |
| 独立Node标准ECMAScript重编码 | `e17adbea183f93b0afd8a2395e6d6706d7c03254e570f4018714339c9fe2c13d` |

修复仅在检查器中新增 `ecmascript-json.mjs`，使用平台的标准 `JSON.stringify` 数字/字符串格式和明确的UTF-16键排序，对象递归规范化。Python仍独立计算SHA-256、读取只读数据库、核对记录绑定、事件头与历史前缀，并用原Fraction评分oracle独立重算；没有导入产品模块、调用业务API或弱化任何hash比较。检查器现在需要Python标准库与Node，不能再宣称纯Python运行。

保留 `verify_records.before-js-canonical.py` 和 `verifier-development-test.before-js-canonical.json`。父任务原失败stderr保持原样，不以成功输出覆盖。`canonical-diagnosis.json`保存独立比对细节，含本次合成工程浮点字段；仅在临时验收目录使用，不自动公开。

验证：

- `test-canonical.py` 六项通过：e-07/e-7、小数阈值1e-6与1e21、负零与整值浮点、中文/非BMP键序、递归对象序列、整数评分兼容、下一可表示浮点数修改导致不同哈希、非有限拒绝（按六个测试方法组织）。
- 原 `test-verifier.mjs` 六项再通过，包括三个案例、原导出、历史追加、修改基线拒绝和修改导出拒绝。仅写其自建临时开发夹具，未改真实GUI数据库。
- 父任务给定的真实281命令退出0，输出 `real-281-verification.json`：baselineUnchanged=true，独立核验3评分，三个必要案例齐全，实际原生导出1份与原记录完全一致。
- 保全事件共5。前三条评估保存于事件4，均currentSourceChanged=true；新建完整评估保存于事件5，currentSourceChanged=false。未以来源变化错误否认不可变历史的可核对性。

检查器结果仍标记 `guiExecutionVerified:false` 与 `professionalApproval:false`；真实GUI执行与截图由父任务留证，独立数据库核验不冒充人类专业签认。
