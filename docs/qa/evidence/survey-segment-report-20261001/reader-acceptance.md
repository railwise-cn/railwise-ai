# 两期水准测段比较成果验收

日期：2026-10-01。验证为合成两期水准网，比较记录由 `SurveySegmentComparisonV1` 冻结并投影到 DOCX、PDF、XLSX。

## 比较结果

- 测段：`BM-P`；成员：原测期 `fwd`，本期 `back`。
- 观测高差：原测 `1.003000 m`，本期按路径方向 `0.996000 m`，本期减原测 `-7.0000 mm`。
- 平差高差：原测 `1.001500 m`，本期 `0.997000 m`，本期减原测 `-4.5000 mm`。
- 报告同时保留两期运行 ID、观测期、结果哈希、投影哈希、源文件和原始记录定位。
- 规范符合性明确为“未评估”；差值只表示测段高差变化，不自动解释为测点绝对沉降。

## 格式阅读

原生 PDF 共 7 页，LibreOffice Writer 阅读 DOCX 输出 7 页，LibreOffice Calc 阅读 XLSX 输出 20 页。三者均回读到“测段观测高差比较”“测段平差高差比较”、`fwd`、`back`、`-7.0000`、`-4.5000` 和“本期减原测”。签认栏保持空白，XLSX 比较表保留冻结表头和数值单元格。

截图：[全页联系表](./reader-contact-sheet.png)、[PDF 第 2 页](./pdf-page-2.png)、[DOCX 第 3 页](./docx-page-3.png)、[XLSX 第 15 页](./xlsx-page-15.png)。机器可读回读及哈希见 [reader-validation.json](./reader-validation.json)。

测试：`survey-professional-report.test.ts` 6 项通过，覆盖旧报告无比较字段、两表差值、成员索引、哈希绑定、三格式一致性和空签名。`kun` typecheck 目前受既有 `engineering-segment-deliverable.test.ts:119` 的 `Database`/`Awaitable<void>` 类型错误阻塞，本次报告变更未触及该文件。

本记录是合成数据的报告投影和阅读器验收，不代表真实工程精度、规范审查、COSA 对算、SUC 互操作或专业人员签认。
