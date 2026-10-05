# 打包应用成果文件验收

日期：2026-09-30。已将打包候选应用生成的 5 个完整输出复制到本目录，并逐字节与原始输出比对一致；未修改生产源码或成果文件内容。

原始目录：`/private/tmp/railwise-professional-candidate/home/.workwise/default_workspace/.workwise/deliverables/project_bb5aa9ca-b7de-4d2f-8800-e59b799924ec/run_145f3736-b484-492d-b320-fb2db9f696d0/`。

样例来源为 `professional.csv` 合成水准观测，2 个点、2 条观测、1 条独立闭合检查。源文件完整性为已校验，SHA-256 为 `444a71b823936b80ee45ce6ee15bcc28ffef8482b641f56e45d24459c59a22d9`；高程基准 `PROJECT-BM` 为测试项目声明。

## 阅读器检查

| 文件 | 检查方式 | 页数 | 结果 |
| --- | --- | ---: | --- |
| `report.docx` | LibreOffice Writer 实际打开并输出 PDF | 5 | 中文、数值、单位、分页、空签署栏正常 |
| `report.pdf` | 原生 PDF 页面渲染及 PDF.js 回读 | 5 | Regular 字体已嵌入，数值不折行，签署栏为填写线 |
| `professional.xlsx` | LibreOffice Calc 实际打开并输出 PDF | 9 | 9 个专业工作表可读，数值单元格/表头/打印定义正常 |

全页截图见 [reader-contact-sheet.png](./reader-contact-sheet.png)。关键页可见 [PDF 第 2 页](./pdf-page-2.png)、[DOCX 签署页](./docx-reader-page-3.png)、[XLSX 观测表](./xlsx-reader-page-7.png)。

三个阅读器输出均逐项回读到 `tabular-2`、`tabular-3`、`leveling-route`。高程 `100.000000` / `101.000500` m、观测/平差值 10 位小数、改正数/残差 `-0.5000` mm 与冻结专业投影一致。XLSX 原数值保留完整精度；显示舍入规则在成果中说明，极小方差因子的 6 位显示为 `0.000000`，完整数值仍在技术附件、XLSX 数值单元格及 JSON 中保留。

全页联系表和关键页全分辨率检查未发现中文缺字、表格重叠、数值裁切或拆行。DOCX 的 3 个角色姓名/日期/签名格共 9 格为空白，PDF 仅保留空填写线；XLSX 明确“未签认”。闭合限差、精度限差、外业检核及规范符合性均明确“未评估”，未自动推定合格。

LibreOffice 渲染使用 `FONTCONFIG_FILE` 指向仓库 Noto Sans SC 字体，没有安装系统字体。DOCX/XLSX 不嵌入字体，其他机器需提供合适的中文字体；原生 PDF 使用打包内 Regular 字体，不依赖系统字体。

## 文件指纹

| 原始输出 | SHA-256 |
| --- | --- |
| `report.docx` | `8fd47963c2425aeaaca360deefd5ad1245c1641f2e0abe4de5008c2438da337c` |
| `report.pdf` | `e849530cc7e8da18bb4730c1289e293754b8124b8f16d4d311e5e2ba3646bff1` |
| `professional.xlsx` | `8024968889e40f6cad4d708ff9024079ce349aa2a4d460c9e2fd11295c820cb9` |
| `evidence.xlsx` | `f4694f1ebbe26c055a29701b0739325877d99ac76c92f2565ce6d7162260de6e` |
| `professional-review.json` | `211d6a78467aa785daf910521c846066ec727b31e8d1f2e116013aaee3c50356` |

机器可读的来源、回读结果、阅读器输出指纹和截图顺序见 [reader-validation.json](./reader-validation.json)。`evidence.xlsx` 完整保存并校验复制一致，本轮重点布局验收覆盖 DOCX、PDF 和专业 XLSX。

## 范围

本记录证明候选打包应用本次生成文件的可读性和记录完整性。它不代表厂商验收、有授权 COSA 的对算、SUC 互操作、真实工程项目精度/规范审查或专业人员签认，也不代替打包应用全流程 UI 验收、Apple 公证或更新器往返验收。没有执行公开发布。
