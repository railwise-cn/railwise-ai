# Survey 专业资料与指标证据

日期：2026-09-19。这里记录本轮可复核的公开来源、候选样本统计和实现边界，不把模拟预审、候选夹具或在线预览访问当作生产验收。

本文保留2026-09-19历史研究范围及原指标，不作为当前功能状态。后续截至281dc87的事件/分母说明见[生产指标口径](../../RAILWISE_SURVEY_PRODUCTION_METRICS.md)，真实IN2/GSI GUI与OU2比较见[格式验收当前索引](../../WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md)。

## GB/T 24356-2023

- 官方信息页：[国家标准平台](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=2874EFAC7523FB293E6AF2E4068CEB02&refer=outter)
- 标准号：GB/T 24356-2023；中文名《测绘成果质量检查与验收》；英文名 `Specifications for quality inspection and acceptance of surveying and mapping products`。
- 官方状态为“现行”；发布日期和实施日期均为 2023-05-23；CCS A75；ICS 07.040；主管/归口部门为自然资源部（测绘地理）；发布单位为国家市场监督管理总局、国家标准化管理委员会。
- 官方在线预览入口已通过 Computer Use 打开，页面显示 129 页，并核对了封面和目录区域。下载入口要求验证码，本轮没有绕过验证码、没有提交验证码、没有保存全文副本。
- 当前软件只保存规范版本/条款元数据和来源引用，没有把本页元数据扩展成检查限值，也没有声称已完成 GB/T 24356 条文逐条实现。质量检查链仍是未完成项。

## 统计与高级调整资料

- NIST EDA outlier guidance：<https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm>。检索日期 2026-09-19。来源区分标记、容纳和正式识别，并提醒 masking/swamping；不支持自动删除观测。
- NIST t reference：<https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm>。仅作为 t 分布临界值背景资料，不证明 Baarda、自由网、方差分量或抗差估计已经完成。
- 新增的 `apriori-residual-z-1` 诊断只接受同一模型产生的先验残差协方差 `Cov(v)`，输出有符号 z 与绝对值，校验维度、有限性、对称性、半正定性、秩和冗余；另增加独立观测固定线性 WLS 的外部学生化诊断核，以六次独立删点重拟合验证删除方差和自由度。两者不内置临界值、自动删除或规范判定；均未改写 `algorithm-7` 或接入生产服务/UI。16 项定向测试通过。

## 候选指标

见 [`candidate-metrics.json`](./candidate-metrics.json)。数据来自停止后的 d249035 隔离候选副本，两个项目、两个网络、两个清单均为 `draft`。在 2026-09-01 至 2026-10-01 UTC 半开区间内，网络导入到每个项目首个合格草稿的中位时间为 111.788 秒，样本数为 2，范围为 83.48 至 140.096 秒。

这不是生产指标：候选记录不包含被拒绝的首次导入分母，没有可验证的人审批准或数字签名，未做严格重放，未完成标准条款核验，也没有中等水准网定义。因此导入成功率、可追溯生产项目数、30 分钟目标、可复现率、规范可追溯率、数字混入、许可违规和中英文残留均明确为 `not-measurable`，没有填造数值。

## 外业与 MCP 边界

`RAILWISE_SURVEY_INTERFACE_REVIEW.md` 记录了 GeoCOM、GSI、GNSS 和对外 MCP 的来源与待核实项。当前新增的 `survey_context_read` 仅通过 MCP SDK 的内存传输测试，默认无身份即拒绝，宿主负责身份、项目授权、传输生命周期和撤权；没有监听端口、复用 Runtime Bearer、修改用户 MCP 配置或控制仪器。真实第三方客户端、具体仪器/固件和现场联调仍未完成。

## 当前工作树验证

- Runtime 全量 1642 项通过、3 项跳过；统计诊断和 MCP 分别 16、18 项包含在全量中。
- 桌面首次全量在并行构建时有两个 Agent Pack 文件复制用例超过 5 秒，保留失败记录；单独重跑 2511 项通过、2 项跳过，包括新增项目基准摘要回归。
- 指标脚本 14 项测试通过；当前候选数据库的只读重测与保存 JSON 一致。
- 双端类型检查、生产构建、OpenSpec strict 11/11 通过；lint 0 error、1 条既有 Workbench Hook warning。
- 官网 source 验证及三张截图 SHA-256 验证通过。本地没有 PHP 命令且仓库只含官网覆盖文件，未宣称完成完整官网渲染或线上部署。
- 当前工作树包含独立诊断/MCP 适配和摘要修复；94f1550 安装包不含这些新增代码，包证据按独立提交记录。
