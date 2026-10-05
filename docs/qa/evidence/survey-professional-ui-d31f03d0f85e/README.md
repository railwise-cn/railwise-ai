# Survey 专业工作流最终候选验收

日期：2026-09-30。候选源码冻结为 `d31f03d0f85e91a6197ac0502aa35a41af1c1a57`，包版本 `0.5.1`，安装路径为 `/private/tmp/railwise-professional-candidate/installed/RailWise AI Candidate d31f03d0f85e.app`。候选使用独立应用身份、独立用户目录和隔离凭据，未连接真实模型。

## 已完成检查

- 中英文、明暗主题、`1440×900`、`1280×800`、`960×800` 的概览/处理/结果/交付共 48 张截图，`matrix.json` 的横溢、空白 SVG、无标签图标和 WorkWise 品牌检查均为零失败。
- 水准处理摘要只显示高程基准和 `m`，不再显示无关的 `LOCAL` / `rad`；选中页签、页面内容和 CSS 动画等待一致。
- 两个明确米制单位的合成期次实际导入、校核和平差后，`BM → P` 测段变化读回为 `-0.002000 m`；明确理由的初值事件追加成功，正常重启后历史完全一致。
- 专业结果表格的闭合、观测改正和点位结果区域均可横向滚动；AI 证据抽屉显示 `leveling-route` 精确引用，Tab 焦点保持在抽屉内，Escape 后返回原证据按钮。
- 交付页实际生成 DOCX、PDF、`evidence.xlsx`、`professional.xlsx` 和 `professional-review.json`。最终输出在 Writer / PDF 页面渲染 / Calc 中分别检查 5 / 6 / 9 页，`P=10.998 m`、高程改正 `-2 mm`、观测/闭合编号和空签认栏均通过回读；记录见 [最终成果阅读器复核](generated-output/reader-acceptance.md)。
- IPC 路径白名单回归 46/46；Survey 相关桌面定向测试 108 项通过；类型检查、生产构建、OpenSpec strict 和 `git diff --check` 通过。

## 证据文件

`matrix.json`、`zh-light-four-pages-final-contact-sheet.png`、`epoch-comparison-960x800.png`、`initial-value-record-960x800.png`、`initial-value-restored-after-restart.png`、`professional-tables-960x800.png`、`ai-evidence-drawer-960x800.png`、`period-records.json`、`restart-history.json` 和 `package-identity.json` 保留在本目录。上一轮 CSV 成果与长表分页复核见 [打包成果记录](../survey-professional-report-20260930/packaged-output/reader-acceptance.md)。

## 修复与限制

包内实际验收先发现 `projectId` 路径占位符遗漏，导致初值/期次被 IPC 拒绝；修复后的真实操作已通过。结果页高级抽屉的局部分区曾覆盖主页面，已分开状态并验证关闭后仍为结果页。旧候选 `823dfd7d` 只作为失败/修复基线，不引用其截图宣称最终包通过。

缺少坐标长度单位的两份期次输入被归档/阻断；后续用新文件明确 `unit=m` 导入，未覆盖旧原件或旧运行。重新使用已经校核的导入 idempotency key 曾被历史 replay 不匹配拒绝，验收改用独立测试 key 并保留旧记录。专业表格已验证滚动，期次抽屉表在当前宽度可完整容纳，未声称该表实际横滚。AI 只准备了精确证据草稿，没有发送真实模型请求；原生系统“另存为”对话框未在本次检查范围内。

OpenSpec 4.2 的安装、检查、截图均已完成，因尚待用户本人对该候选 UI/功能确认，复选框继续保持未完成；4.4 的厂商/专业确认亦保持未完成。

## 边界

这是隔离候选的源码和真实本机 UI 验收。候选为 ad-hoc deep strict signature，未使用 Apple 公证凭据，本增量未执行真实 updater round-trip。未取得当前授权 COSA / 测量云 / SUC 的许可对算或互操作验收，也没有替代专业人员对规范适用性、精度限差、签章和正式交付的确认。未执行公开发布、官网更新、tag、Release、stable feed 或版本变更。
