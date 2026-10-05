# RailWise Survey 公开厂商资料与 AI 专业复核

日期：2026-10-04

这份记录汇总当前可核验的公开厂商资料、固定开放样例和仓库已有的只读工程配对证据。它用于工程软件的来源审查、格式边界和数值复核，不把公开网页、模型推理或合成数据称为厂商授权、SUC 认证或专业人员签章。

## 公开资料

已固定或持续可访问的来源包括：

- COSA `.in1/.in2/.NET/.ou1/.ou2`：COSA 操作说明、CosaSoft 产品页和武汉大学作者期刊索引，见 [`SURVEY_FORMAT_SOURCES.md`](../references/SURVEY_FORMAT_SOURCES.md)。
- Leica GSI/HeXML：Total Open Station、PynAdjust、OSGeoLabBp、GeoComPy 等公开格式说明和开放许可研究样例。
- Trimble JobXML：Trimble JobXML Schema 6.27 公开 XSD；仓库固定 JobXML 样例只用于元素和单位边界。
- Carlson RW5：Carlson SurvCE 官方格式页；仓库保留独立 RW5 golden/negative fixture。
- 南方 DAT/PA2005：南方测绘公开仪器手册和官方产品目录；由于不同机型可重排字段，未经列映射不进入平差。

来源清单、固定提交、许可证边界和不提升为 `adjustment-ready` 的条件均在 [`SURVEY_FORMAT_SOURCES.md`](../references/SURVEY_FORMAT_SOURCES.md) 与 [`WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md`](WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md) 中保留。

本轮公开页面访问状态、响应哈希和源码边界回归映射见[厂商资料访问记录](evidence/railwise-vendor-audit-20261004/README.md)。该记录只证明公开来源可复核，不改变外部授权或专业签认门禁。

## 已有工程证据

仓库已有的授权只读 COSA 配对记录包括：

- 5 组水准 `.in1/.ou1` 同源对照通过，最大显示高程差约 `4.8–5.0 μm`；2 组因输入/结果段数或测段差异阻断。
- 2 组 COSA `.in2` 平面控制网完成解析、确定性平差、精度摘要和 DOCX/PDF/XLSX 成果闭环。
- 历史 0.5.x 私有候选保存了输入哈希、映射哈希、点/观测数量、自由度、残差和结果文件哈希。

这些结果证明在明确映射、来源完整和同源参考存在时，软件能够完成可复算闭环；它们不能自动推广到未验证的厂商方言，也不能把 `precision.passed` 解释成规范符合或专业签认。

## AI 专业复核结论

以工程测量、数值平差、软件质量和产品设计的模拟高级工程师视角复核当前实现：

1. 来源链：原件哈希、解析器版本、记录锚点、映射和结果引用已形成可追溯链；来源变化会阻断旧成果复用。
2. 数值链：COSA IN1/IN2、GSI 和 M5 的已验证案例保留单位、闭合/附合、自由度、残差和精度口径；连续闭环按连通分量检查，避免误差抵消掩盖问题。
3. 交付链：DOCX/PDF/XLSX 和审查记录引用同一结果绑定，结果页优先展示专业指标，技术协议留在高级详情。
4. AI 增益：AI 能从资料识别、预检问题、来源定位、异常解释、结果问答和交付草稿中减少人工查找与重复录入；AI 不自动改观测、不绕过基准/单位确认、不把警告升级为通过。
5. 产品边界：当前公开资料和既有工程证据足以支撑“受控格式与公开样例的工程软件验证”，不足以支撑“厂商互操作认证”“SUC 兼容认证”或“法定专业签章”。

## 外部门禁状态

- 当前机器 `/Volumes/MOVESPEED` 仅能看到系统目录，未挂载可复核的 `.in1/.in2/.ou1/.ou2/.gsi/.dat` 工程文件；本轮没有伪造新的真实输入证据。
- 厂商授权书、正式 SUC 对算、真实角色专业签字和机构盖章不可能由模型生成。它们仍保持未完成，不能在 OpenSpec 中勾选完成。
- 当前候选的英文、明亮主题、窄窗口、隔离来源恢复、完整可访问性和 updater 往返仍是包验收缺口；历史候选截图不回填当前候选。

## 可执行后续

下一步只需把真实授权资料或公开许可样例放入隔离验收根，并为每一组保留来源许可、输入哈希、映射、独立参考和成果哈希；然后用当前源码重建目标为 0.5.2 的私有候选，完成 4.2 包矩阵。外部签认仍须由具有真实授权的厂商或专业角色完成。

## 本轮源码验证

- `SurveyTabularMappingForm` 已支持按表结构保存多个本地映射 profile，并在再次导入相同表头时选择复用；其保存内容不覆盖来源哈希、表 ID、确认状态和修订号，重新导入时由当前来源重新绑定。
- Survey 格式注册、原生格式 golden/negative、专业 fixture manifest 定向测试：3 个文件、206 项通过。
- Survey 质量工作流与专业报告定向回归在恢复 Node ABI 147 后通过：5 个文件、74 项测试；没有绕过环境门禁，也没有修改原生依赖版本。

机器可读记录见 [`railwise-public-vendor-review-20261004.json`](evidence/railwise-public-vendor-review-20261004.json)。
