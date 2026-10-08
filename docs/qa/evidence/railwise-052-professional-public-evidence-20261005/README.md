# RailWise Survey 0.5.2 后续：公开厂商资料与独立 AI 专业复核

审查日期：2026-10-05。审查源：`7bf3e6a129088232c35ae3d1320f87b7ba6cd735`，另以具体源码 SHA-256 绑定独立算例。审查角色：模拟工程测量实践、软件质量与产品设计的高级工程师，**属于 AI 审查**。

本轮完成官方资料核对、完整未勾选项分类和独立有理数计算对照。没有运行竞品商业软件或实际仪器，没有获取真实身份签认，也没有自行验收当前安装包。最终包界面与 updater 由本任务的其他审查者单独记录；本目录不能替代该证据。

协调任务已确认 0.5.2 存在公开发布而官网下载页滞后。本目录不重新发布 0.5.2，不更改公开文件或宣称较新修正已经进入既有公开包；源码中的 `version=0.5.2` 也不能单独证明某个安装包的身份或验收状态。

## 本轮新增成果

- [厂商流程与成果对照](PROFESSIONAL-COMPARISON.md)：把官方处理步骤、原始/归算/平差量、复测表和专业交付栏目映射到当前产品。
- [全部未勾选任务分类](REMAINING-GATES.md)：`engineering-delivery` 的 31 条、`professional-workflow` 的 2 条，区分安装包验收、实际代码范围和外部事实。
- [机器可读任务审计](open-task-audit.json)：逐项保留原任务文案、源行、分类、缺口和关闭证据；不修改原 tasks.md。
- [官网独立审查](WEBSITE-REVIEW.md)：公开 0.5.2 的版本/摘要/能力边界、部署验证修正与截图/文案发现。
- [来源访问回执](source-receipts.json)：16 项来源、14 项本轮成功获取；2 项失败保留。只提交链接、哈希与自撰审查，不复制网站内容或 PDF。
- [独立算例脚本](independent-leveling-check.py)与[结果](independent-leveling-result.json)：独立 Fraction KKT 参考，不调用产品矩阵算法计算期望值；当前 TypeScript 仅在临时目录转译后读回。

## 实际读取的来源

| 来源 | 实际范围 | 证据结论与限制 |
| --- | --- | --- |
| [测量云 SUC 导出](http://help.celiangyun.com/knowledge/outputsuc) | 官方产品团队，2019-10-02；本轮浏览器正文与 HTTP 字节回执 | 可单个/批量导出原始观测 SUC；无 wire-format、字段/单位/基准或完整同任务参考输出，不能放开平差准入。 |
| [测量云水准设置](http://help.celiangyun.com/knowledge/levelset) | 转点、测段合并、文件格式、点名对照；官方旧教程 | 支持处理步骤研究，不认证当前竞品版本。 |
| [测量云水准平差与成果](http://help.celiangyun.com/knowledge/1555553650) | 官方正文；HO/IN1/OU1、示意图、控制点成果和检测成果 | 原始/当期成果与往期检测不可混写。 |
| [测量云导线流程](http://help.celiangyun.com/knowledge/tsprocess23) | 官方 2023-09-04；项目、APP 外业、参数、已知点、单/多期、坐标变化、手簿与检查 | 工程主线是资料—参数/基准—解算—检查—成套成果。 |
| [测量云高差之差](http://help.celiangyun.com/knowledge/cdgczc) | 官方 2019-09-29；原测高差、测段生成、参数、Excel 表 | 高差之差是测段复测量，不等同平差高程变化或坐标改正。 |
| [测量云沉降分析](http://help.celiangyun.com/knowledge/leveldataimport) | 官方 2019-11-12；原始处理/成果导入两路径，任意期初值与重设累计接续 | 监测时间与单位语义需要显式管理。 |
| [Trimble DiNi 导入](https://help.fieldsystems.trimble.com/tbc/4652.htm) | 官方 HTML；明确 `.dat` 为 M5、转点编号范围 | 扩展名不能单独区分 Trimble M5 和 South DAT；点号角色需要确认。 |
| [Trimble digital-level 流程](https://help.fieldsystems.trimble.com/tbc/12082.htm) | 官方 HTML；standard errors、import/properties、Level Editor、plan/spreadsheet | 先验精度、允许平差/固定成果的区别应可见。 |
| [Trimble Level Editor](https://help.fieldsystems.trimble.com/tbc/5589.htm) | 官方 HTML；raw/adjusted、misclosure/correction、双程每公里/每站误差、原始读数和损坏路线 | 量的含义及缺量/异常需完整保留；有两个独立误差分量时按平方和开方组合。 |
| [Trimble Level Report](https://help.fieldsystems.trimble.com/tbc/12481.htm) | 官方 HTML；raw observations/reduced observations/reduced coordinates、对象超链接 | 复核链应回到对应观测对象，不能只输出汇总数。 |
| [Trimble JobXML XSD 6.27](https://ww2.trimble.com/schema/JobXML/6_2/JobXMLSchema-6.27.xsd) | 官方 XML 成功获取；本轮用于确定可追溯规格，不宣称全模式逐项验证 | XSD 可支持结构研究；不证明某个 field file 的基准/协方差或可直接平差。 |
| [Carlson SurvCE RW5](https://update.carlsonsw.com/manuals/SurvCE/online/source/FileFormat.html) | 官方格式页面成功获取；既有格式登记与 synthetic 测试对照 | 格式事实不等同真实设备往返或所有方言。 |
| [COSA 经销商页](https://www.survey3d.com/changguicehui/changgui-kesha.html) | 经销商产品说明成功获取；非本轮验证的最新厂商正式手册 | 可对照功能/成果组织；不能标为官方授权互操作。 |
| [Leica SurveyOffice 手册](https://downloads.leica-geosystems.com/files/archived-files/surveyoffice_manual.pdf) | 官方存档；PDF 1999-08，13 页；实际提取阅读第 4、6、9–11 页 | 第 4 页型号串口参数，第 6 页 GSI8/16、WI41–49/WI71–79 编码；第 10 页数据交换。旧存档不能充当当前完整 GSI 数值格式规范。 |
| [Leica-authored GSI 手册，NRAO 托管](https://naic.nrao.edu/arecibo/phil/hardware/theodolites/gsi_online_for_leica_tps.pdf) | Python 首次证书链失败；curl 默认 TLS 验证显示证书过期 | 本轮未读取 PDF；不绕过证书验证，不将其内容作为本轮新增核验。 |
| [South NTS-591R10 手册](https://pm.southsurvey.com/static/uploads/downfiles/20250911/591R10%E6%B5%8B%E9%87%8F%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%93%8D%E4%BD%9C%E6%89%8B%E5%86%8C-1757582889.pdf) | Python 首次证书链失败；curl 默认 TLS 超时 | 本轮未取得字节，不伪报读取；既有手册事实仅引用历史记录。South 禁止未经许可复制的边界继续保持。 |

测量云链接使用明文 HTTP；下载哈希只能固定本轮响应字节，不能证明 TLS 认证或厂商签章。Trimble 等 HTTPS 重试使用 curl 默认 TLS 验证，未使用 `-k`。初次 Python 信任链失败与重试成功均保留，不能隐去失败记录。

## 数值复核

新算例为 4 点、6 个独立高差观测，采用零和高程改正约束、明确的先验方差和权；参考算法为独立有理数 KKT 消元。秩 3、基准亏损 1、自由度 3。精确检查满足改正和为零、加权残差正交、冗余度和为 3。

产品结果与参考最大高程/观测量差 `2.22e-16 m`，完整协因数差不超过 `1.39e-17`；m/mm 换算的高程差 `2.07e-17 m`，点/观测排列变化差 `1.22e-19 m`。无冗余和断网分别拒绝为对应原因。

这项证明限定的 `free-leveling-trial-1` 内核及其数值含义，不证明一般自由网/拟稳生产接线、不证明现场精度、不认证已知点真实性。当前源码仍返回 `trial-only`、`modelAssumptions=not-verified` 和 `engineeringDecision=not-evaluated`，审查保留这些边界。

## 既有真实证据的使用方式

历史 COSA IN1/OU1 的 5 组同源对照、2 组拒绝，真实 M5 配对与 IN2/OU2 数值证据仍可作为输入与算法的限定基线；来源、哈希和偏差见 [格式来源清单](../../../references/SURVEY_FORMAT_SOURCES.md)及[历史 M5 证据](../real-m5-production-2026-09-10/README.md)。它们没有被复制成“本轮新外业”或“新包已经通过”。

PynAdjust/OSGeo/GeoComPy 的开放样例支持教学/转换/词法回归，不独立证明 field provenance。Medjil Boya 原始媒体没有得到独立数据授权，本轮未下载或使用。没有联系厂商或其他人发送消息，没有代写签名。
