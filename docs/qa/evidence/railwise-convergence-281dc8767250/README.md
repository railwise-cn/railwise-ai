# 281dc87 声明检查关联评估精确包验收

本记录仅覆盖源码 `281dc87672509de147357efc3aabbeae0eb4dbcb` 的 macOS arm64 隔离 `0.5.0` 候选，整体状态为 **partial**。本包 GUI 实际创建合成控制网成果、保全记录、首轮样本、单位评分和关联评估；独立只读检查另行核对实际保存的记录。它不代表完整规范质检、真实工程验收、人员签认或公开发布。

后续 V4.1 自动路由修复 `dd919f5` 和抽样工作区边界文案修复 `7aa944f` 不在本包。截图中的旧抽样说明按原样保存；模型设置截图显示未配置 API Key，不构成真实模型调用成功证据。

## 精确包与真实更新

- Bundle ID：`com.wangjiawei508.workwise.candidate.head281dc8767250`。
- ASAR SHA-256：`55daa373c28d3bf1ff2b6d98a9af403da7e405c54df500a4bfcaddc09f1ac807`。
- 应用 ZIP SHA-256：`0c1849958d5492ef641560bb9168cd245a3354f62ca8940676f717d38d12d83f`。

`private-updater.json` 与脱敏的 `native-updater.redacted.json` 记录真实私有 HTTPS 下载、原生安装、目标重启、哨兵保留六阶段。本机安装使用相同应用 ZIP，ASAR 与实际更新后的目标一致。`frontier` 仅为私有隔离探针通道，未提升公开 feed；同源码 `0.0.0 → 0.5.0` 不等于历史旧用户迁移。应用 ZIP 由外层 artifact 的 HTTP Range 提取，未重算完整外层 artifact 摘要。

本机 `codesign --verify --deep --strict`、`stapler validate` 通过；`spctl --assess` 退出 0，但本机系统 assessments disabled。启用 Gatekeeper 状态的检查来自 cloud updater，未改变系统信任。`package.json` 中 `guiAcceptance: not-tested` 为 GUI 操作前的安装快照，保留原字节，后续结论由本报告承接。

## 实际合成链路

GUI 在单一合成项目 `project_9c8894f5-7683-4b0e-a634-466ffca1dbe0` 导入 IN2，完成校核、平差与 DOCX/PDF/XLSX，生成 `draft` 清单。示例为 4 点、5 观测、3 未知参数、2 自由度，不是本包双真实 P0 验收。原清单和三份文件的哈希、大小，以及项目行、清单行、成果复验审计基线由独立检查器确认未变。

四项保全检查覆盖成果包字节和三份输出；随后冻结两个明确声明的单位 `LINK-01`、`LINK-02`，执行最终内业首轮全数。单位定义为合成声明，不从点数或文件数推断总体。三个单位评分记录为两个 `9141/100` 完整声明评分与一个否决案例。材料关联均显式选择已有 `output-1` 保全要求，不声称真实材料完整或检查真实性。

同一冻结关联计划 `assessment_plan_26588896-1113-4803-89f8-17625e428c1e` 产生以下四条评估：

| 记录 | 实际状态 | 保全事件数 |
| --- | --- | ---: |
| `assessment_07daf090-925b-4093-a010-d012477dac4f` | 两项评分缺失；材料关联齐全，单位结果不完整 | 4 |
| `assessment_310839d6-3b44-45a4-8f99-5f44e0d815ed` | 两项完整单位结果；声明关联齐全，不批准工程交付 | 4 |
| `assessment_6e4da1bc-bc03-48b3-a9b7-b8817a0e4ee1` | 一项否决、一项缺失；否决与覆盖分开显示 | 4 |
| `assessment_dd5a9602-8de7-46e0-8800-626ac283ca88` | 追加正常保全事件后，在同计划创建的新完整评估 | 5 |

第 5 项正常保全事件使前三条旧评估显示来源已变；原记录保留，旧结论不会继续冒充当前结果。新完整评估绑定新 head。37 另实测将 LINK-02 评分错误选择给 LINK-01，保存被关联合同拒绝；38 随后恢复健康的当前完整记录。来源变化和错单位引用不是字节损坏；本轮没有执行损坏来源 GUI 注入，不沿用其他候选的损坏案例作为本包通过证据。

## 原生导出与重启

GUI 实际打开 Save As 并取消，随后 `test ! -e` 默认导出路径返回 0；再次打开后保存 `assessment-complete.json`。保存文件为 8,213 字节，SHA-256 `70ea6e3845de2d6ce26210cea6635be612aef4e3c5cab6629a621d7b74d232a6`；独立检查器核对它与原保存评估完全一致。取消与保存由 10–13 的原生对话框、AX 和 `gui-operation-notes.json` 操作记录共同证明，不能仅由文件存在反推 GUI 操作。

完整退出后重启，原先缺项、完整、否决三条评估按原 ID 逐条恢复，见 15–19。两次应用退出均为 0；最终进程搜索没有候选进程。后续正常来源追加在此次重启之后执行，不把第 4 条评估冒称已完成相同重启检查。旧 CUA helper 曾意外打开旧 6ff 隔离候选，操作者立即关闭且未改项目；后续使用单独的 281 handle，事件在操作记录中保留。

## 独立核验及首次失败

`assessment-verification.json` 核对 baselineUnchanged、3 评分、4 评估和 1 个原生导出。检查器使用 SQLite `mode=ro`/`query_only`、独立 Fraction 评分与原文/存储/依赖摘要，不导入产品计算器或执行写入接口；多个数据库为独立只读快照，不声称跨库原子性。

首次失败 `Manifest canonical hash` 保留在 `assessment-verification-initial.stderr.json`；首次 stdout 原本为空，也原样保留。原因是清单中的 `1.3726709029343796e-7` 被 Python 写成 `1.3726709029343796e-07`。修复仅增加独立 ECMAScript 标准序列化辅助，继续由 Python 计算哈希、读库和评分，没有放宽哈希或改写产品数据。`independent-checker/CANONICALIZATION-FIX.md`、诊断、旧检查器、修正版和 6 项序列化自测、6 项开发夹具检查结果同时保存。

独立检查器的 `guiExecutionVerified: false` 表示脚本不能认证 GUI 操作，不表示本轮没有执行 GUI；实际操作由截图、AX 与操作者记录支持。开发夹具自测不等于安装包操作。`test-verifier.mjs` 保留原开发环境的 fixture import，仅作原始测试来源，不能在缺少该开发构建时宣称可直接移植运行；只读 `verify_records.py`、`scoring_oracle.py` 与 `ecmascript-json.mjs` 可在具备 Python/Node 和授权数据路径时使用。

## 界面范围与剩余项

已查看中文浅色常规/宽布局、中文深色宽布局、英文浅色/深色宽布局。22、23 确实为上下堆叠的紧凑布局，图像为 1163×764 像素；26 虽文件名含 `compact`，图像实际为 1490×768 且仍是宽布局，不能计作英文紧凑验收。常规图 1171×768，宽图 1490×768；这些都是图像像素，未测原生 bounds/CSS viewport，不声称精确最小窗口通过。

32、33、34 为本包中文浅色、合成数据的成果、平差和模型设置实拍，可作为精确来源素材；归档不证明官网已经上线。35、36 记录从重新核验依次 Tab 至导出及下一历史条目的可见焦点，属于有限键盘检查。英文界面保留中文项目名和原始合成声明是用户数据保真；中文应用的原生保存对话框仍有英文 `Save generated file` 和 `JSON file`，没有据此宣称全量 locale 通过。最后恢复中文浅色健康关联结果后退出。

仍缺完整状态/全键盘/a11y、所有语言主题尺寸组合、损坏来源 GUI、真实模型/官方搜索、真实旧用户迁移、专业解释及用户本人确认。两个合成单位不是代表性生产样本；关联齐全、技术字节保全或独立算术一致均不授予规范符合性、签章或发布批准。

## 归档边界

截图、AX、baseline 和诊断仅含本轮合成资料。原始 updater feed URL 已完整隐藏；`private-updater.json` 扫描凭据后按原字节保留。不归档原始日志、配置、数据库、真实工程输入或私有凭据。GSI 历史来源补充只在相邻 `railwise-gsi-provenance-20260920/README.md` 保存可公开摘要，不混作本包实测。

复制文件保持原字节，包括原 AX 中的空白与历史状态。`manifest-hashes.json` 覆盖本目录除自身外的所有文件；`archive-verification.json` 说明复制、脱敏和隐私检查范围。
