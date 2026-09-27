# 官方扫描 PDF 的真实渲染合同验证

2026-09-20。使用已取得的 GB/T 24356-2023 官方扫描 PDF，实际运行 Poppler，并将真实 RGB8 输出送入 `SurveyStandardRegistry` 的扫描来源路径。结果见 [renderer-contract-result.json](renderer-contract-result.json)，复现脚本见 [verify-scanned-pdf.mjs](verify-scanned-pdf.mjs)。本验证只证明文件、渲染和转录证据的字节及绑定关系；未注册生产规则，没有作规范符合性判断或真人签认。

## 实际输入与操作

- PDF 来源和全文摘要沿用 [sources.json](sources.json) 的贵州省自然资源厅公开附件；27,976,440 字节、129 页，SHA-256 `96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`。
- 选取已目视核读的第 4.2.1 条，印刷页 3 / PDF 页 6。使用 Poppler `26.05.0`，72 DPI，产生 `1587 × 2240` 的 RGB8 全页。区域采用左上原点像素框 `x=160, y=790, width=1270, height=100`，另经本机渲染图像核对其覆盖该条两行正文。
- 全页像素摘要为 `4725a88bdb2c38eec0f6e04f732c946d05e6cc00db44221f5cb80a95c43fb3ee`；区域逐行 RGB8 摘要为 `3034baf3078f7bfc245296d5e745e568e460f2e32e1d8927d1503f0d4f1e71ec`。摘要针对紧密排列的原始 RGB8，不是 PNG/PPM 容器。
- 转录使用显式输入的 UTF-8 文件，末尾包含 LF，共 202 字节。转录及复核主体均为 `agent`；复核记录明确限定为来源绑定测试。文件内容、实际 PDF 和渲染图均留在本机，不入仓。
- 测试注册的唯一规则为 `TEST-ONLY-SOURCE-BINDING`，断言是人为构造的零值标记，不是第 4.2.1 条的执行规则。用于通过信任入口的集合只存在于本次测试进程，不能视为独立人员审核集合。结果保持 `standardConformity: not-evaluated`、`humanSignatureVerification: not-evaluated`。

## 结果及负例

| 检查 | 结果 |
| --- | --- |
| 实际 PDF 字节、全页、区域、转录及复核材料绑定 | 通过；注册器实际调用 Poppler 重新渲染 |
| 缺少独立全文摘要集合 | 拒绝：`source-not-independently-trusted` |
| 缺少精确规则审核摘要 | 拒绝：`exact-rule-not-reviewed` |
| 换页或换转录，复用旧规则审核摘要 | 拒绝：`exact-rule-not-reviewed` |
| 改转录并重算测试规则摘要，但保留旧转录摘要 | 拒绝：`scan-transcription-hash-mismatch` |
| 改区域摘要并重算测试规则摘要 | 拒绝：`scan-region-hash-mismatch` |
| 同页请求 1200 DPI，预计超过像素预算 | `pdfinfo` 预检后拒绝，未启动 `pdftoppm` |
| 原始 PDF 输入哈希 | 运行后保持不变 |

扫描来源预算为 PDF 64 MiB、复核材料 1 MiB、页面 1600 万像素 / RGB8 4800 万字节。源码在复制前检查输入长度，schema 在渲染前检查页面总像素，适配器用 `pdfinfo` 在实际光栅化前核对页面尺寸，并为 `pdfinfo` 的尺寸打印量化预留边缘余量；子进程具有 30 秒超时及输出预算。59 项规范/质检单测另覆盖不用巨量分配的超限与非法长度拒绝、旧规则摘要兼容等边界。

## 复现

需要支持 `node:module.registerHooks` 和 TypeScript 类型剥离的 Node（本次 `v26.8.2`），以及 PATH 中同版本 `pdfinfo` / `pdftoppm`。脚本从仓库源码导入合同和注册器，不要求构建产物；只映射这一对已知本地 TypeScript 模块。输入路径须显式提供，PDF 预期摘要还要与来源清单一致。

```sh
node docs/qa/evidence/railwise-standards-20260920/verify-scanned-pdf.mjs \
  --pdf "$STANDARD_PDF" \
  --expected-pdf-sha256 96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487 \
  --transcription "$CLAUSE_TRANSCRIPTION_UTF8" \
  --pdf-page 6 --printed-page 3 --clause 4.2.1 \
  --region 160,790,1270,100 --dpi 72
```

调用者应自行核对转录内容对应所选区域；脚本不做 OCR、语义审核或真人身份验证。转录文本不包含在复现脚本或结果中。版本、渲染参数或输入转录发生变化时，需要重新核对并保留新结果，不能复用旧的页图/规则审核摘要。本地复核材料中的时间为测试记录日期，不是人员实际签字时间。

临时目录在脚本退出时清理；原始输入只读。仓库保存脚本、结论、页码、尺寸、摘要及拒绝原因，不保存全文、条款转录或图像。本次适配器是隔离验证工具，尚未接入生产 Runtime 持久化、GUI、正式规范注册或交付批准流程。
