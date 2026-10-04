# d31f03d0f85e 最终成果阅读器复核

生成批次：`d31f03d0f85e`。原始目录为 `/private/tmp/railwise-professional-candidate/home/.workwise/default_workspace/.workwise/deliverables/project_bb5aa9ca-b7de-4d2f-8800-e59b799924ec/run_2e8ace7d-cb36-4b5e-ab0a-fe009f747ecc/`。5 个原始输出已复制到本目录，复制前后逐字节一致。

这是限定复核，报告代码与上一份已完成阅读器验收的成果包逐文件无变化，因此沿用相同的版式规则；本轮针对最新生成数据检查关键数值和操作记录。

| 文件 | 阅读器 | 页数 | 结果 |
| --- | --- | ---: | --- |
| `report.docx` | LibreOffice Writer 实际打开并输出 PDF | 5 | 中文、单位、表格和空签署栏可读 |
| `report.pdf` | PDF.js 文本回读与页面渲染 | 6 | PDF 内嵌 Regular 中文字体，分页和数值可读 |
| `professional.xlsx` | LibreOffice Calc 实际打开并输出 PDF | 9 | 工作表、数值单元格、冻结表头和打印区可读 |

关键数值在 JSON、原生 PDF、DOCX 阅读器 PDF 和 XLSX 阅读器 PDF 中均通过回读：

- 点 `P` 高程：`10.998000 m`；高程改正数：`-2.0000 mm`。
- 观测编号：`fwd`、`back`；观测值/平差值分别为 `0.9980000000`、`-0.9980000000 m`。
- 闭合记录 `leveling-route` 存在；闭合限差未配置，状态保持“未评估”。
- 源文件 `period-valid-2.json` 已绑定、完整性已校验；缺失原始定位为 0。
- 编制、复核、批准的姓名/日期/签名均为空；成果状态为待审查草稿、未签认。
- 单位和显示规则保持：高程/观测为 m，改正数/残差为 mm；数字保留原始精度，界面按成果规则显示。

关键页截图：[PDF 第 2 页](./pdf-page-2.png)、[DOCX 签署页](./docx-reader-page-3.png)、[XLSX 观测表](./xlsx-reader-page-7.png)；全页联系表见 [reader-contact-sheet.png](./reader-contact-sheet.png)。机器可读计数和文件哈希见 [reader-validation.json](./reader-validation.json)。

本次复核使用仓库 Noto Sans SC 配置完成 LibreOffice 渲染，不安装系统字体。该记录只证明本次打包输出的文件可读和关键数据完整，不代表真实工程规范审查、COSA 对算、SUC 互操作、专业人员签认、厂商验收、Apple 公证或更新器往返验收，也没有执行公开发布。
