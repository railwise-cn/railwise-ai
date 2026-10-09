# RailWise 0.5.3 独立 AI 源码审查 · 2026-10-09

结论：在以下精确源码范围内，未发现阻止修复合入的实际缺陷。可继续受保护 PR 检查和合并，然后从新的 main 重新冻结。此结论不是安装包验收通过，也不是发布批准。

## 身份与范围

本报告为独立 AI 源码审查，结合工程测量业务、软件质量和产品设计视角；不代表真人审批、专业签认、规范认证或 COSA/厂商/SUC 互操作认证。未操作应用 UI，未读取真实 preferences/凭据，未修改仓库、创建标签或发布。

- 显式审查工作目录：`/Users/wangjiawei/Documents/WorkWise`。
- 工作树 HEAD：`a19b84c3a67f33fd5ce74d96dd2323f57449b9a1`；PR #49 已提交的两项 QA 修复为 `036ddc1ca1da6869c05b515aee220978ff635108` 和 `ec067a4f35a1aa582fa2f052581cac7b438ce71e`。
- 比较基准 origin/main：`1aae1717926de575220cb01e2289613f3c34c639`。
- 审查范围：PR #49 的两项原始 QA 提交与本轮全部 11 个有差异文件。审查中实现者已将最终字节提交为 `3951bd14` 和 `a19b84c3`；当前工作区干净。文件哈希将审查绑定到实际内容，避免把先前未提交状态与当前提交混淆。
- 完整 `git diff origin/main --` SHA-256：`85d5070d31e2e7226a3b513c79bc9a45295b4ba53e8a254cbe960cd96a1e040c`。
- 精确文件清单：`/private/tmp/railwise-053-tools/current-source-review-files-20261009.json`。后续任何字节变化均超出本次复审范围。

## 具体结论

1. **安装来源与用户资料的链接策略已分开。** `normal-profile-protection.mjs:119` 起，安装目录、Info.plist、ASAR、pack 根目录、manifest 和 audit 都检查直接路径及所有祖先链接；`fingerprint(ctx.packSource, false)` 拒绝整个包资源树中的嵌套链接。资产源检查位于第 152 行。链接式身份文件不能靠普通用户资料指纹路径获得放行。
2. **用户嵌套链接只保留，不遍历目标。** 第 47–74 行使用 `lstat` / `readlink` 为链接记录类型、模式、uid/gid 和目标原文后立即返回；不通过 `stat` 或文件流读取链接目标。用户直接保护目标及祖先仍在第 178、182、184、307 行拒绝链接。快照 copy 的内容对比和恢复验证保留这种区分。独立自检实际覆盖外部、失效、自循环和相对循环链接，以及受保护 Skill 目录内的外部链接；外部目标独立变化不会改变用户目录指纹，恢复后目标文本和外部字节保持预期。
3. **凭据读取不会沿 settings 链接越界。** 第 327–330 行对私有快照中的 settings 先执行严格 regular-file/ancestor 检查，再读取字节；调用在第 350 行，先于 journal 变为 activating 和任何原资料移动。独立自检确认链接式 settings 的复用请求被拒绝、状态保持 snapshotted、原链接及外部文件未改动；普通文件的合成 DeepSeek 复用仍通过。
4. **自检记录与实现一致，但范围明确限于合成测试。** 本机独立重跑 23 项全部通过，记录的 testedScriptSha256 与当前脚本完全一致。README、保护说明和 JSON 仍把真实资料恢复、真实 defaults-domain 往返与最终包功能/视觉验收列为未执行，未把这些合成测试当作真实包验收。
5. **plist 兼容修复合理，未夸大独立证据。** 第 258 行使用本机 `/usr/bin/plutil` XML1 输出做前后哈希，避免 JSON 无法表达 data/date。文档把此限定为同主机序列化比较，不保证原始文件字节或跨平台 canonicalization。原实现者记录的 `ef981369…` 原始夹具未保留，本审查没有声称复现该值；另建四份独立合成输入（XML/binary × 正反字典插入顺序），包含 Unicode、data、date、非整数 real 和嵌套字典。四次真实 plutil 转换均为 `2b2c6299c1bed53c69feb267eac1df009929e5c92dc52a081277d09288e24506`，解析值全部保留。该 probe 不读取或导入真实 preferences，结果见 `/private/tmp/railwise-053-tools/current-source-review-plist-probe-20261009.json`。
6. **归档追问不再把记录编号放入用户草稿。** `EngineeringWorkspaceView.tsx:1323` 的 label 改为本地化“审查稿”，精确 manifestId/runId/reviewStatus 仍留在非可见的 evidenceContext。中英 DOM 测试验证草稿文本不含编号、证据绑定未转为活动网、点击没有直接网络请求；追溯能力保留。
7. **能力目录使用专业中英文呈现。** `EngineeringSkillsPanel.tsx:9` 起的五个 ID 映射与当前服务端返回一致；三个已知不可用原因使用本地化专业说明。未知技术失败内容不会直接转发到专业工作区；限制说明保留已知点 BM_01、平面控制网和 COSA 格式等专业条件，避免把点号中的下划线误当内部 ID。错误状态存 boolean，语言切换不会留下上一语言的错误文案。
8. **取消冻结的文件说明属实。** 只读 GitHub API 返回 `37861714441` 为 completed/cancelled、head 为 `1aae1717926de575220cb01e2289613f3c34c639`。README/执行顺序明确要求新来源重新冻结，旧截图和更新报告不得为新包放行。

## 独立执行的验证

- `node --check docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs`：通过。
- `node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs self-test`：23 个检查通过；私有合成会话 `/private/var/folders/t8/1bkjpgdx5zbd2ynlyzpqd7zw0000gn/T/railwise-profile-guard-selftest-MmHTC9/home/Library/Application Support/RailWise Acceptance/synthetic-session`。
- SkillsPanel DOM、WorkspaceView DOM、本地化 parity：3 文件、79 项通过。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- Survey UI 静态 inventory：选中键缺失 en/zh 为 0/0，英文 Han 键为空；这不是运行时/GUI 覆盖率。原始 inventory 在 `/private/tmp/railwise-053-tools/current-source-review-static-inventory-20261009.json`。
- 独立真实 plutil 合成转换：4/4 相等且值保留；未验证真实 defaults export/import 往返。

## 继续交付的边界

没有新增源码阻塞。修复仍需通过 PR 必需 CI 后合入，最终包必须从新的受保护 main 冻结，并重新完成安装、签名/公证、四工作视图及语言/主题/窗口/a11y/恢复矩阵、真实 AI 专业回答、成果导出读回、真实 native updater 往返，以及用户原资料 restore/verify。当前没有可由此报告替代的最终包通过证据。

## 审查文件字节

| 文件（相对审查根目录） | SHA-256 |
| --- | --- |
| `docs/qa/release-gates/v0.5.3/README.md` | `6a1a12c3ca30be237bffd3783707f9aa34120e572282311149c0cb857914551a` |
| `docs/qa/release-gates/v0.5.3/normal-profile-protection-selftest.json` | `1a20e1fa785d64b97ea3501b7dce92db0b955e0ee425351b891bcdf7d7f5a2cb` |
| `docs/qa/release-gates/v0.5.3/normal-profile-protection.md` | `c93bbf3c6d7b1e7dc8bdc315c66288ab05bf9c0e080a6ea33cc31cf76a2e6dd4` |
| `docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs` | `994be48b6edb18e9ee0ed1f4b855a779bf3de26b47a11a20aa1dd6e0e2f9fb74` |
| `docs/qa/release-gates/v0.5.3/release-execution-order-20261008.md` | `fec443dd4b7e2c6d3e8c606fd77580dfec67c87729d19df863df17dce4e9f6ae` |
| `src/renderer/src/components/engineering/EngineeringSkillsPanel.dom.test.ts` | `9160676140bc53ad3a6142bc4353c054a9e4bfda4402327f3080d2911cbda13e` |
| `src/renderer/src/components/engineering/EngineeringSkillsPanel.tsx` | `8c2d5e032679dd94fc9b0a205be007a6b2e7eae6a511a92339abf1cdaf721897` |
| `src/renderer/src/components/engineering/EngineeringWorkspaceView.dom.test.ts` | `9042f89a11acc59d943b5c7abd8097b0b78756424cc0428ebcb25c527c501af4` |
| `src/renderer/src/components/engineering/EngineeringWorkspaceView.tsx` | `66e7ba4f234415ce306dd099ec6da1b05f8c05491a1c6d63abd28b82824832f8` |
| `src/renderer/src/locales/en/common.json` | `a34cfc42c953b333fe6af79ba1e613c4a4b2f7cc958a31198ac64dd9eda23186` |
| `src/renderer/src/locales/zh/common.json` | `e0b659c81a898038c90277004e2060171ba76cd8fa6b7847165ca0b68e58013a` |
