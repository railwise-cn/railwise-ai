# RailWise Survey 公开资料与 AI 专业复核矩阵

日期：2026-10-07（Asia/Shanghai）

本记录绑定当前工作树的源码审查，不绑定任何已发布安装包。复核身份是 AI 模拟的综合高级工程师（工程测量、软件质量和产品设计）；它不是持证测量人员签字、厂商授权、SUC 对算、法定规范认证或真实仪器联调。

## 公开资料复核

| 资料 | 可核对的工程事实 | RailWise 使用边界 | 证据状态 |
| --- | --- | --- | --- |
| COSA 操作/产品公开说明（`.in1/.in2/.NET/.ou1/.ou2`） | 输入、网络数据和成果文件属于成对的工程作业链；导入、校核、平差和成果复核必须保持来源关联 | 仅用于格式线索、受控解析和已记录的 COSA 样例；未知方言继续阻断 | `public-reference` |
| Leica GSI / HeXML 公开格式说明 | 字段、单位码和记录词义必须逐字段解释；GSI 文件格式不等于 GeoCOM 实时协议 | GSI 词法、单位转换和原始定位可回归；缺少独立基准时不能进入平差 | `public-reference` |
| Trimble JobXML Schema 6.27 | XML 结构和单位声明可用于元素级预检 | Schema 不能证明厂商软件结果一致；需要逐元素 golden 和独立数值对照 | `public-reference` |
| Carlson SurvCE RW5 格式页 | `OC.OP`、`TR/SS/BD/BR/FD/FR`、`LS.HI/HR`、`MO.UN` 等字段边界 | 未声明单位、角度参考或仪器高时只保留原记录，不猜测观测 | `public-reference` |
| 南方 NTS / PA2005 公开手册与目录 | 不同机型允许字段重排，机型手册不自动等于 DAT wire-format | 没有列映射、单位和样例对照时保持查看/归档状态 | `public-reference` |

来源 URL、访问时间和响应哈希见 [公开厂商资料访问记录](evidence/railwise-vendor-audit-20261004/README.md) 与 [格式来源清单](../references/SURVEY_FORMAT_SOURCES.md)。公开资料只证明资料事实可复核，不证明授权互操作。

2026-10-07 本机重新访问 Carlson、Trimble JobXML 6.27 和 COSA 公开页面，响应 SHA-256 分别为 `71484f68de3f7ddc3d6c61453026be7544fece81d0a0b7cbaf64b15319b9fead`、`30e65680df92fb5c69ae4b683dee76d31e8db20c8e83e12ddc8c711b71c9f031`、`bc50c4bbbceee96554b560e341a1ce4dfbc34100296fa70278d00d5646dcb935`，与既有访问记录一致。

## 论文与独立数值依据

当前方法审查采用以下公开研究材料，并在独立数值记录中保留输入、公式边界和结果哈希：

- Baarda, *A Testing Procedure for Use in Geodetic Networks*（1968）：数据探测必须声明假设、显著性、功效和多重检验，不能把固定阈值当作完整检验。
- Amiri-Simkooei, *Least-squares variance component estimation: Theory and GPS applications*（2007）：VCE 需要明确随机模型、可辨识性、非负约束和病态处理。
- Lösler、Eschelbach、Haas, *Kongruenzanalyse auf der Basis originärer Beobachtungen*（2017）：自由网基准亏损和跨期稳定性不能通过任意固定点掩盖。
- Huber, *Robust Estimation of a Location Parameter*（1964）：抗差估计需要明确尺度、损失函数、停止条件和最终协方差口径。

论文和 GNU Gama 独立计算边界见 [高级方法资料与验收合同](evidence/railwise-advanced-methods-20260920/README.md)。这些材料支持数值方法审查，不替代适用的中国工程规范或专业签章。

## 软件与专业复核结果

当前源码已由定向测试验证：专业诊断和 AI 回答会移除格式目录、解析器、工具调用、哈希、修订号、JSON 和模型信息；保留来源、观测、闭合差、精度、异常和处理建议。可追溯的历史 AI 回答审计记录为 5 个文件、262 项通过（见 `docs/qa/evidence/railwise-next-current-source-20261006/ai-response-audit-tests-20261006.txt`）；当前分支的新增回归仍需随最终冻结包重新执行。

复核重点：

1. 输入资料进入同一预检入口；平面控制网的平面坐标基准、单位、控制点、观测关系、闭合差和精度未确认时，计算保持阻断。平面网不适用的高程基准不被伪装成必填条件。
2. 平差结果区分已知点声明、待定点成果、初始坐标和最终平差值，不把初始坐标当作最终成果。
3. 结果和交付保留可定位的来源与证据，但普通界面不显示内部协议、代码或开发状态。
4. 警告只给专业处置动作；“需要处理”不能出现格式目录、解析对象、策略校验等实现词。
5. AI 可解释来源、指标和复核问题，但不能自动修改观测、绕过基准确认或把数值通过等同规范符合。

## 外部证据门禁

以下项目不能由模型生成，也不应在计划中勾选为已完成：

- 当前具体型号/固件的厂商授权互操作或 GeoCOM 实机回环；
- COSA、测量云或 SUC 的同源对算证明；
- 真实工程原始资料的真实性与现场条件证明；
- 具有可验证身份的测量专业人员签字、盖章和项目批准；
- 法定规范符合性认证。

这些项目统一标记为 `external-evidence-required`。在获得资料后，必须保存原件许可、输入哈希、软件/仪器版本、独立参考结果、差异说明和签认身份，再单独更新门禁；不得用合成样例、公开网页或 AI 意见替代。

## 当前候选绑定要求

本报告不宣称当前分支已经完成安装包验收。完成候选验收时，报告必须追加精确源码提交、包版本、Bundle ID、DMG/ZIP/ASAR 哈希、签名/公证、隔离安装路径、中文/英文和明暗主题截图、窄窗口与键盘/ARIA 检查、真实导入到三类成果文件读回以及同一候选的 updater 往返。旧安装包或其他分支的截图不得回填当前候选。
