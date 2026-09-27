# 声明模型高级试算后端

## 范围

`generalized-w`、`vce`、`huber`、`statistical-family`、`reference-datum` 与 `static-incremental` 纯核通过独立 project-scoped 实验记录服务开放，不修改既有纯核，不依赖正式网形、正式相对权或平差结果写入接口。服务只接受用户显式提交的完整模型 JSON 和模型依据原文。广义 w 的绝对先验 C 必须由完整声明提供；不会将正式相对权、后验单位权方差或其他结果暗自转成已知绝对 C。

每条记录固定为 `trial-only`、`modelAssumptions=not-verified`、`engineeringDecision=not-evaluated`、`formalResultsModified=false`、`declarationTrust=caller-declared-not-authenticated`、`checkpointTrust=local-records-only`。成功保存可以包含纯核明确的非正分量、不可辨识或未收敛结果；保存成功不是计算通过或工程验收。

## 接口

全部接口位于 `/v1/engineering/projects/:projectId/advanced-trials`，先校验既有 Runtime Bearer 认证，再读取服务、query、body。所有响应 `Cache-Control: no-store`。

| 方法/后缀 | 请求 | 响应 |
| --- | --- | --- |
| POST 根路径 | `kind, acknowledged:true, expectedProjectRevision, idempotencyKey, declarationJson, modelBasisStatement` | 201，`SurveyAdvancedTrialSummaryV1`，不包含模型/结果大字段 |
| GET 根路径 | 可选单个十进制 `limit` 1–10、`offset` 0–128 | `SurveyAdvancedTrialListV1`，`trials/unavailable/nextOffset` |
| GET `/:trialId` | 无 query/body | `SurveyAdvancedTrialRecordV1`，完整原文、归一化模型与纯核结果 |
| POST `/:trialId/reverify` | 精确空对象 `{}` | 当前重算后的 `SurveyAdvancedTrialVerificationV1`，不写新记录 |
| GET `/:trialId/export` | 无 query/body | 与详情相同的完整 JSON；`attachment; filename="survey-advanced-trial.json"` |

未知或重复 query、非规范十进制分页、未知请求字段、缺少确认、非法 UTF-8、孤立代理项、重复或转义等价 JSON 键、超过 32 层嵌套均拒绝。请求不允许设置摘要、结果、验收决定、专业身份或正式权。

`declarationJson` 是对应纯核 V1 输入的完整 JSON 文本；`modelBasisStatement` 是整体模型依据声明（广义 w 内部的 `covariance.basisStatement` 仍需独立提供）。Huber 要求固定外部尺度、独立观测、固定满列秩线性模型及显式停止政策；不输出高斯参数协方差或唯一性认证。统计家族要求预先声明完整成员、自由度/先验尺度及精确标量输入，不能自动将带误差的广义 w 值转为精确检验输入。缺失、不可检测、数值失败成员保留在 Bonferroni 分母中。临界区间是软件分辨政策，不是认证误差界。

统计结果的 `request.statistics` 按成员 ID 排序，保存的声明仍保持其归一化输入顺序；前端复验使用该明确规则，不改原声明字节。统计摘要使用 `familyMemberCount`，观测数/参数数为 0；旧类型摘要不新增该字段。输入 schema 可以规范化部分 VCE 标识符；原文与规范化模型分别保存并分别计算摘要，不以重新序列化模型替代原文字节。

认证失败 401，未知项目/跨项目或未知记录 404，输入错误 400，过期/完整性/重放环境错误 409，体积或总配额 413，计算或写入速率超限 429（`Retry-After: 60`）。错误代码前缀 `advanced_trials_`，不会返回数据库原文、路径或内部异常。未知算法版本不进入计算，作为完整性不支持项保守不可用。

## 指定参考集合的两历元比较

`reference-datum` 是 2–32 个一维对应点的完整协方差比较，调用方显式声明两期坐标、双射点号映射、参考集合与独立/跨期协方差关系；可选 GLS 或等权参考定义。摘要独有 `pointCount/referenceCount`，观测数/参数数保持 0，旧四种摘要禁止新增这两个字段。原声明不排序或替换源摘要。

界面保留所选方法、时期与依赖关系、参考点、原坐标差、参考权、位移、平移方差、平移–位移协方差，以及完整坐标差和位移协方差。单位与差分方向明确显示。近半正定结果保留未分辨说明，GLS 奇异只返回不可用，不回退等权。来源摘要仍为声明，物理稳定性、显著性与工程结论未判定。纯核源码不因接入改变。

## 静态独立观测追加

`static-incremental` 只接受固定满列秩、正多余观测基线及固定参数集，显式声明独立零均值误差和已知绝对先验方差。旧基线至少比参数数多1条、至多255条，新追加1–128条，总计至多256条/16参数；其他旧类型不放宽其128观测限制。摘要显示基线/追加/总观测数。基线指纹绑定模型和修订，但不认证真实仪器或跨请求现存状态。

逐行 Givens 平方根更新保留固定基线列尺度、旋转、累计残差能量和状态摘要；最终用独立从头 Householder 批处理核对参数、SSE及完整先验协方差。后验方差因子只作诊断，不能乘入已知先验协方差。旧观测编辑/删除、参数/基准改变、相关和动态随机模型不支持。最大合法十项页191工作单位，后续两次detail可用而第三次正确限流；完整记录818,649 bytes的真实容量例见[接入说明](./evidence/railwise-static-workspace/README.md)，不构成生产SLA。

## 持久化与绑定

数据库是 Runtime 工程数据目录下独立的 `survey-advanced-trials.sqlite3`，WAL、5 秒忙等待。`advanced_trials` 对 UPDATE、DELETE、INSERT OR REPLACE 重用 ID/幂等键均有 append-only trigger；创建用 IMMEDIATE 事务并有 `(project_id,idempotency_key)` 唯一约束。两个服务实例/进程竞争同键由 SQLite 串行化，不会生成第二条记录。

表中保存完整 `data_json`，以及实际收到的 HTTP `request_bytes` 与模型声明 `declaration_bytes` BLOB。JSON 中同时保留对应 `requestJson`、`declarationJson`、依据文本、规范化模型、计算结果、创建时项目快照和执行环境。

- `requestSha256`：实际收到的整个 HTTP UTF-8 body（包括原始空白/键序/转义写法），不是重新 JSON.stringify 的请求。
- `declarationSha256`、`modelBasisSha256`：两份声明文本的精确 UTF-8 字节。
- `modelHash`：schema-normalized 模型的 canonical JSON。
- `resultHash`：完整纯核结果的 canonical JSON。
- `projectBindingHash`：`{id,revision,workspace}` 快照 canonical JSON；workspace 使用工程服务返回的原样绝对路径，不在试算服务中重新 resolve。
- `replayEnvironmentHash`：Node、V8、platform、arch、可选 Bun 版本环境对象的 canonical JSON。
- `recordHash`：完整记录去掉唯一 `recordHash` 字段后的 canonical JSON。
- SQL `storage_hash`：除自身外全部 SQL 列的 canonical JSON；其中两个 BLOB 分别以 `request_bytes_sha256` 和 `declaration_bytes_sha256` 替代，`data_json` 仍作为精确字符串参与。

Canonical 规则：数组保持顺序；对象键用 JavaScript `Object.keys().sort()`（UTF-16 序）排序，省略 undefined；键与标量使用 JSON.stringify，数值必须 finite。hash 均 SHA-256。

相同键的重试先重新验证既有记录、当前项目修订和工作目录，再要求整个原始请求字节完全相同；仅空白或依据文本变化也返回 conflict。改变模型必须使用新幂等键和明确提交。历史记录不会自动迁移、覆盖或删除。

## 读取与恢复

详情、导出、重验以及列表中的每条摘要均在数据库只读事务中验证：SQL/JSON ID、project、kind、revision、binding、幂等键、时间及摘要一致；BLOB 与原文和实际字节数相等；从原 HTTP 请求重新严格解析模型与确认字段；规范化模型与模型 hash 一致；项目 revision/workspace 快照仍匹配；执行环境兼容；最后调用指定纯核，完整 canonical 结果必须严格相同，不使用数值容差掩盖结果更改。

不同 JavaScript 引擎可能有正常末位浮点差异。环境指纹变化时报告 `replay-environment`，保留旧记录并停止重放，不把这种情形解释为恶意篡改，也不会重写输出。当前契约不宣称跨引擎浮点 JSON 完全相同。

坏项、过期项、环境不兼容项分别出现在 `unavailable`，占用原分页槽位而不遮蔽其他有效项。无法解析的 SQL ID 使用稳定 `unavailable-slot-{SQLite rowid}` 占位，仅用于显示损坏槽位，不能用于恢复详情。持久化的大 BLOB/TEXT 在 SQL SELECT 阶段先按字节数约束，避免解析超大损坏内容。

这些未加外部签名的本地摘要不是独立保管或专业签章；拥有数据库全部写权限者可以整体伪造新的自洽模型记录。服务检测内部不一致和计算不一致，不证明模型真实性。

## 资源边界

- HTTP body 512 KiB，包含所有空白与转义文本；读取最多 20 秒。
- 模型声明 256 KiB、依据文本 16 KiB，均按真实 UTF-8 字节计数。
- 完整记录 4 MiB；每项目最多 128 条、总 `data_json + request_bytes + declaration_bytes` 64 MiB（坏项也计入）。
- 每项目持久化最多 8 个新记录/60 秒；重启服务不会清掉此写入计数。
- 每进程、每项目 240 工作单位/分钟。create 基础 10、详情/重验/导出基础 5、列表基础 1 加实际每条记录 3（空页不按请求上限收费）；每次实际计算另扣模型额度：VCE `max(1,ceil(n²*maxIterations/81920))`，广义 w `max(1,ceil(n²*(p+directions)/65536))`，Huber `max(1,ceil(n*p²*maxIterations/327680))`，统计家族 `max(1,ceil(memberCount/16))`，两历元参考 `max(1,ceil((2*pointCount)³/16384))`。
- 内存速率桶最多 512 个活跃项目，过一分钟清理；列表遇速率限制整体返回 429，不把额度不足误标成记录损坏。

最大维度真实 HTTP 验证：广义 w 64 观测/16 参数/64 偏差方向导出 121,066 bytes；VCE 128 观测/32 参数/8 组、100 轮上限的确定性输入实际迭代 55 轮，导出 333,063 bytes。两者均走真实 create/detail/export 和严格重算，未以伪结果验证响应上限。最大 VCE 的完整创建、写后复算及导出复算合计约 5 秒（开发机测试），不是生产性能保证。

Huber 最大合成实例真实保留 201 状态、完整记录 2,924,991 bytes；统计家族 256 成员记录 482,097 bytes。十条历史页经独立 SQLite 重开/严格重算验证，分别计费 231/191，均在 240 工作单位内。界面仅展开当前 Huber 状态的观测表，统计成员显示自由度、声明先验尺度与完整双精度临界区间。详见[独立接入审查](./evidence/railwise-advanced-two-kernels/independent-review/REVIEW.md)。32 点完整跨期协方差参考记录及十条历史页也经真实 SQLite 重开/重算核对，最大页费用 191。以上容量例不是生产 SLA。

## 后端验证

```sh
kun/node_modules/.bin/vitest run --root kun src/engineering/survey-advanced-trials-workspace.test.ts tests/survey-advanced-trials-workspace-http.test.ts tests/runtime-advanced-trials-wiring.test.ts
kun/node_modules/.bin/tsc --noEmit -p kun/tsconfig.json
```

覆盖精确 UTF-8 原文、规范化区别、重复键/代理项/嵌套、认证顺序、分页、坏项隔离、大小和配额、重启、同键同/异载荷、多服务实例、SQL 修改/删除/替换触发器、逐列篡改、仅 BLOB 篡改、重签全部无密钥 hash 后的结果篡改、环境变化、项目修订/目录/跨项目隔离，以及真实 factory 的认证和关闭重开。纯核原有测试和相邻 sampling/factory 回归也执行。

前端界面、打包应用和人工验收属于另行核验范围，此文档只记录后端行为。
