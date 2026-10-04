# 专业成果文件阅读器验收

验收日期：2026-09-30。样例为合成水准网，2 个点、45 条观测、44 条独立闭合检查；1985 国家高程基准为样例声明，不是经外部核实的工程基准。

## 结果

| 成果 | 阅读方式 | 页数 | 逐项回读 |
| --- | --- | ---: | --- |
| `synthetic-leveling-report.docx` | LibreOffice Writer 打开并输出 PDF | 14 | 45 个观测编号、44 个闭合检查编号完整 |
| `synthetic-leveling-report.pdf` | 原生 PDF 页面渲染与 PDF.js 文本回读 | 13 | 45 个观测编号、44 个闭合检查编号完整 |
| `synthetic-leveling-professional.xlsx` | LibreOffice Calc 打开并输出 PDF | 13 | 45 个观测编号、44 个闭合检查编号完整 |

全页联系表见 [reader-contact-sheet.png](./reader-contact-sheet.png)。逐页 PNG 与阅读器 PDF 位于本目录。

- 全页检查及末页、跨页观测表的全分辨率复查通过：未发现表格重叠、裁切、缺失中文或拆分数据行。
- 观测表和闭合表续页重复表头，页码/总页数显示正常。PDF 数值按实际文本宽度分配列宽，样例 10 位小数不折行。
- 高程/高差为 m，闭合差/限差/线性改正数/残差为 mm；水准基准说明不展示无关投影或角度单位。
- DOCX 签认栏为空白，PDF 签认栏保留空白填写线；各格式明确为待审查、未签认。
- 规范符合性和未配置的精度限差明确为“未评估”，未推定合格。原数值不由 AI 改写。
- XLSX 观测表共 46 行、闭合表共 45 行（含表头），保留数值单元格、显示精度、冻结表头和打印定义。

## 字体与复核

原 Noto Sans SC 可变字体默认 Thin (`wght=100`)，原生 PDF 阅读字重过细。PDF 已改为从原 OFL 字体派生的 Regular (`wght=400`) 静态实例。来源、生成命令和完整 SHA-256 记录在 `kun/assets/fonts/README.md`；既有 `assets/fonts/**/*` 打包规则涵盖字体及许可证。FontTools 仅用于构建转换，不是运行依赖。

LibreOffice 环境缺少系统 CJK 字体，本轮通过 `FONTCONFIG_FILE` 指向仓库字体完成阅读器渲染，没有安装系统字体。Writer/Calc 成果不嵌入字体，其他机器应提供 Noto Sans SC 或适合的中文替代字体。

代码验证：`npm run build --prefix kun` 通过；专业成果、测量交付、报告元数据和 PDF 的 4 个针对性测试文件共 9 项通过。

## 冻结文件

| 文件 | SHA-256 |
| --- | --- |
| DOCX | `d3194e807031c2776ff47df22a6c6fa1df4cad8646f3d954fc3fbf7ba6035c32` |
| PDF | `3822b74ec19649d7aacbb0eec5c90fbee1e6044773b9832d7aa20973110e086c` |
| XLSX | `46cf74bcec52984114552bc86ad660078d5f4f74ffbf1f84a81a54fece3a95b4` |
| 专业投影 JSON | `99378df7ab2558e37bf03fe8c52d43d935e90bbc85b86e6f77cd745f696e6d65` |

机器可读计数、阅读器页数及全部成果/阅读器输出的文件指纹见 [reader-validation.json](./reader-validation.json)。

## 验证边界

本记录是合成样例的真实文件阅读器和布局验收，不代表真实工程数据或历史用户数据迁移验收，不代表有授权 COSA 的数值对算、SUC 互操作性、测站原始读数规范符合性、专业人员签认、打包应用 UI 验收、Apple 公证或更新器往返验收。未执行版本、标签、Release、公开更新源或官网下载页的发布操作。
