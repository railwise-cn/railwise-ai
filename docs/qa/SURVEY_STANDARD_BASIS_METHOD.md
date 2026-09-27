# GB/T 24356-2023 只读依据目录

本目录关联现有抽样及限定评分执行器与已有规范研究证据，帮助调用方定位条款、表号、印刷页和 PDF 页。它不是标准符合性证明、人工专业签认或项目适用性批准，不将任何目录项加入 `SurveyStandardRegistry` 的独立受信规则集合。

## 范围与来源

目录版本 `gbt24356-2023-trial-basis-1`，规则版本固定为字符串 `1`：

| 规则 ID 后缀（共同前缀 `gbt24356-2023.`） | 执行器 | profile |
| --- | --- | --- |
| `sampling.census` | `quality-sampling-hmac-sha256-fy-1` | `census` |
| `sampling.table-1-simple-random` | 同上 | `table-1-simple-random` |
| `scoring.accuracy` / `scoring.deduction` / `scoring.unit` | `gbt24356-declared-exact-quality-scoring-1` | `planar-control-point` 或 `height-control-section` |
| `scoring.overview` / `scoring.sample` / `scoring.final-batch` / `scoring.acceptance-batch` | 同上 | 同上 |

采样目录 profile 版本 `survey-quality-sampling-request-v1` 表示现有 V1 输入合同，不代表对旧记录新增了 profile 字段或做出新的适用性结论。评分 profile 版本沿用 `gbt24356-2023-control-declared-counts-1`。名称、摘要、定位说明和边界提供 `zh`、`en`，不是运行时模型翻译。

目录保留官方公开 PDF、发布页及国家标准元数据 URL。PDF 绑定 SHA-256 `96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`、27,976,440 字节、129 页；正文 PDF 页为印刷页加 3。条款定位来自已保留的 [规范研究](evidence/railwise-standards-20260920/README.md)、[机器来源清单](evidence/railwise-standards-20260920/sources.json) 和 [评分实现合同](evidence/railwise-quality-scoring/implementation-contract.md)，后两者的确切文件哈希也写入目录。运行时不联网下载全文、不捆绑扫描 PDF、不推断再分发许可，来源链接也不能替代文件摘要核验。

逐页核查补充见 [独立页面观察与精确映射](evidence/railwise-standard-basis-20260920/page-review.json)，其摘要也绑定到目录。该记录来自实际打开扫描页并读取页脚、条款及表标题，不以“印刷页加3”自洽测试代替内容核查。已保留 PNG 的摘要供本地证据核对；扫描图不提交到公开仓库。

| 定位对象 | 印刷页 | PDF实际页 | 链接含义 |
| --- | --- | --- | --- |
| 平面控制表43 | 58 | 61 | 权重表，profile 首个链接 |
| 平面控制表44及续表 | 59–60 | 62–63 | 错漏分类表 |
| 7.5.1引导 | 57 | 60 | 页底条款引导，上部是表42续表，不是表43所在页 |
| 高程控制表45 | 61 | 64 | 权重表，profile 首个链接 |
| 高程控制表46及续表 | 62–63 | 65–66 | 错漏分类表 |
| 7.5.2引导 | 61 | 64 | 与表45同页 |

原研究的 PDF 60–63 / 64–66 是整节核查区间，不能把区间首页称为所有表格的直接页。本次将 profile 分为权重、错漏、条款引导三个定位，优先打开实际权重表；原来源文件及评分 trace 不改写。9 条规则的正文页亦已逐项复核：两个抽样规则为 PDF 6、8、8–9；数学精度完整式(3)为 PDF 9（移除不必要的第10页）；扣分为9–10；单位分层为9–11；概查为9；样本及两类批判定均为11。此前精确候选包中的第60页链接记录为区间引导，修正后的源码需在后续候选包另行验证，不能追溯冒称旧包已直达表43。

## Runtime API

两个接口都复用现有 Runtime Bearer 认证，认证先于查询解析；所有响应 `Cache-Control: no-store`。接口不读写项目数据库、不执行评分/抽样、不改成果文件，也不迁移旧记录。

1. `GET /v1/engineering/standard-basis`：不接受查询参数。返回 `schemaVersion`、`catalogVersion`、`catalogDigest` 和 `rules: [{rule, ruleDigest}]`。
2. `GET /v1/engineering/standard-basis/:ruleId/:ruleVersion`：必须且只能传一次 `standardCode`、`standardVersion`、`sourceSha256`、`algorithmVersion`、`profileId`、`profileVersion`。返回精确 reference、entry 和所选 profile，`status=resolved-basis-only`。

缺字段、未知参数、重复参数或格式错误返回 400；未知规则/规则版本（包括 `latest`）返回 404；标准版本、来源摘要、算法、profile 或 profile 版本不符返回 409，附具体 `standard_basis_*` 原因。没有自动选择最新、相近 profile、其他版规范或猜测未知条款的后备路径。只登记上述九个操作，4.3.4 检测点恰好 20、调整 t、全表自动错漏分类、分层比例抽样以及其他成果类型没有可执行依据项。

## 摘要与历史记录

`ruleDigest` 为 `SHA256(UTF8(JSON.stringify(SurveyStandardBasisRuleV1.parse(rule))))`。严格合同解析固定字段次序，数组保持目录顺序；不是任意对象直接 JSON 序列化，也不是排序键 canonical JSON。`catalogDigest` 为 `SHA256(UTF8(JSON.stringify(rules.map(entry => entry.ruleDigest))))`。返回值每次从内部冻结 JSON 重新解析，调用方修改结果不会改变后续目录。

已有抽样或评分记录不含目录 ruleId/ruleVersion 的，客户端可以读取目录，以记录中已有 schema、算法、source、operation 和 scoring profile 完全匹配唯一项，再用完整 reference 请求明细。零匹配或多匹配必须拒绝，且应标注为“按历史记录身份关联的目录说明”，不能伪称这些字段原本存在，不能回填旧记录或重算旧分数。今后目录或解释调整应追加明确的新版本并保留旧版本，不静默覆盖 V1。

全部项明确 `reviewIdentity=agent-reviewed-not-professional-signoff`，`standardConformity`、`humanSignatureVerification`、`projectApplicability` 均为 `not-evaluated`。Bearer 只认证 Runtime 调用，不认证规范结论、证据真实性或人员资格。条款引用也不会把原评分结果的 `standardConformity=not-authenticated` 改成通过。

## 验证与待接边界

测试覆盖 16 个精确 rule/profile 绑定、拒绝每种身份不符、目录摘要及修改隔离、来源文件哈希和页码、现有计算结果不变，以及实际 Runtime router 的认证、重复/未知查询、错误分类和无写路由。相关抽样、评分及旧 Registry 回归单独运行；类型检查和编译不替代专业复核或安装包验收。

Runtime 与桌面接入已整合。抽样和评分结果提供按需展开的双语依据说明、精确身份核对与受控官方 PDF 页链接；离线、身份改变、收起和迟到请求不能保留过期显示。旧记录不回填目录字段，也不改变得分或结果摘要。精确签名包 GUI 检查与用户确认仍需分别记录。

独立扫描复核发现旧评分 trace 将式(6)标为 `6.2.5/formula-6/table-3`。官方 PDF 第10页（印刷7）底部的 `6.2.4.5` 引出单位评分，式(6)延续至第11页（印刷8），之后 `6.2.5` 才是等级与表3。本次新目录补齐 `6.2.4.5` 并直接说明此历史标签偏差；旧算法与历史记录保持原字节，不将条款注释修正混作数值算法变更。目录尚未进入任何已验收安装包，该修正属于初始 V1 的开发审核。
