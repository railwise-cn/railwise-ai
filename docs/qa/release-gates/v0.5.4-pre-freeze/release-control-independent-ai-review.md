# RailWise AI 0.5.4 发布控制独立 AI 工程审查

审查结论：**发布控制源码审查通过**。源码缺陷 0 项；文档发现的 1 项 P3 导航问题已由 root 修复并复核，未解决发现 0 项。此结论不构成最终安装包验收、签名公证结果、PowerPoint/WPS 互操作证明、真实专业签认或公开发布批准。

审查者：独立 AI 子代理 `release_source_audit`，以资深软件工程师视角检查缺陷、回归和验证空缺；并以产品使用语义核对文档。没有修改实现文件、提交、推送、派发工作流、创建标签或改变公开发布状态。适用技能：`/Users/wangjiawei/.agents/skills/code-review/SKILL.md`。

- 目录：`/private/tmp/railwise-release-0.5.4-20261101`
- 基础 HEAD：`db75a1fd2f48c6ba6878c81b67daec5191929362`
- 分支：`codex/release-0.5.4`
- 审查对象：未提交工作树中的 workflow/scripts delta、两个新增脚本、发布门禁文档、四份用户文档、CHANGELOG 和 0.5.4 发布说明。下方 SHA-256 固定本次审查内容；后续源码变更需重新审查相关部分。
- 已读取实现方报告：`/private/tmp/railwise-release-0.5.4-version-gate-report.json`。其中 13 个文件指纹与本次工作树逐项匹配。独立检查覆盖该报告之外的 release.yml 和新增内存测试等文件。

## 可操作发现

**[P3，已解决] 给 README 增加最新稳定版入口，避免继续突出 0.5.1。** `README.md:25` 的唯一醒目“正式版”入口仍指向 0.5.1；`README.en.md:17` 虽已改为历史发布背景，但缺少与之平级的最新稳定版入口。0.5.4 发布后读者容易误认为仍应下载 0.5.1。建议两份 README 增加 `https://github.com/railwise-cn/railwise-ai/releases/latest` 的“最新稳定版 / Latest stable”入口，并继续保留明确标注的 0.5.1 历史说明。无需提前声称 0.5.4 已通过最终包验收。此项不影响版本信任链或运行时安全。

解决复核：root 已将 `README.md:25` 改为“下载最新稳定版本”的 `/releases/latest` 动态入口，并将旧链接标注为 0.5.1 发布记录；`README.en.md:15` 已加入同一动态 latest 入口。复读最终内容并运行两份 README 的 `git diff --check` 通过。

没有把未知状态、历史限制或尚待执行的正式包验收写成代码缺陷。

## 信任链与回归检查

| 检查点 | 审查结果与依据 |
| --- | --- |
| 目标版本来源 | `scripts/frozen-release-version.mjs:6` 严格接受规范稳定版号、拒绝前导零/空白/预发布/超安全整数分量，并要求高于官方 0.5.2。`:20` 从校验器源码旁的 package.json 读取版本，未从被验证的报告或包反推期望值。 |
| workflow 输入绑定 | `.github/workflows/frozen-release-updater-acceptance.yml:59` 使用源码版本和 `GITHUB_SHA` 校验 reviewedBuild；JSON 通过环境变量解析，未进入 shell 插值。checkout 明确使用同一 SHA。 |
| runtime 二次绑定 | `scripts/run-frozen-release-updater-acceptance.mjs:435` 先要求受信任的 protected-main GitHub-hosted macOS 工作流；`:456` 绑定 build/source SHA；在下载前后均复验远端来源。所有下载校验、原生 harness 和报告校验均接收同一个独立 targetVersion。 |
| 错版本绕过 | 旧的隐式 0.5.3 默认值已从服务合同移除。fixture、feed、native report 和服务身份均显式收取目标版本；工作流和最终发布 verifier 的调用方完整更新。新增测试覆盖自洽但目标错误的 0.5.3 工件/报告，以及 native 为 0.5.4 而目标服务仍为 0.5.3 的组合。未发现剩余生产路径硬编码 0.5.3。 |
| 官方 0.5.2 baseline | BASELINE_PINS 与原 HEAD 逐字比较完全不变，arm64/x64 的名称、size、SHA-256、asset ID 保持；下载仍使用官方仓库 v0.5.2。最终发布 verifier 再次核对相同 pins、签名要求和严格 nonce。 |
| manifest 与公开身份 | 独立期望版本传入文件清单与下载 receipt 校验。清单绑定 artifact ID/digest、run/attempt、source SHA、所有文件 size/SHA-256；manifest 版本、ZIP 文件名与实际 SHA-512/size 一致。目标包仍校验正式 bundle ID/产品名/版本/stable updater URL、签名、公证及 Gatekeeper；安装后 ASAR 必须与冻结 ZIP 和 UI 审阅身份一致。 |
| 发布时证据绑定 | `scripts/verify-release-approval.mjs:174`、`:187`、`:194` 将标签/manifest 的版本传入服务、native 和远端工作流证据校验。报告不能通过彼此自洽来另选一个目标版本。实际 Actions 发布仍强制远端 provenance 和 immutable evidence archive 校验，未新增禁用开关。 |
| 构建 heap | release.yml 的 6144 MiB NODE_OPTIONS 只出现在 signed/unsigned macOS 构建和 Windows 构建三个步骤，未进入 workflow/job 环境、GITHUB_ENV 或应用配置。新测试执行实际 Node 参数，并检查所有 job/step 的作用域。 |
| CI 严格性 | 本轮未修改 quality.yml、required checks 或治理策略；release-gate 测试由现有 Quality job 执行，并新增导入 heap 测试。frozen updater workflow 权限仍为 contents/actions read，工作流 ref 和 source SHA 的原有严格要求保留。实际远端受保护分支状态和本次提交 CI 成功仍需在后续提交后确认。 |

## 文档行为检查

文档与当前源码一致：本地多标签 Markdown/MDX、富文本/源码/分栏、公式脚注 Mermaid 的可视化及源码对话框、搜索、属性/阶段、链接关系、快照和独立批注均有对应实现。AI 修改先审阅差异，手动动作在自动建议关闭后仍有显式入口；旧提案不覆盖已变化的正文。DOCX 对支持的公式产生 OMML，复杂公式走图像回退，文档没有把所有公式宣传为可编辑原生 Word 公式。

PPTX 文档已从旧的整页参考入口更正为专用编辑器的“编辑 / 参考 / 对比”；保持原稿、受保护对象和修订预检的描述，并保留复杂字体、动画和目标 PowerPoint/WPS 环境检查的边界，没有声称像素级保真。插件说明给出精选、本地推荐、搜索和功能用法；PPT Master 固定快照为 6.8.0。默认模型文案为 DeepSeek V4.1 Flash 的 `deepseek-flash`，同时保留旧 ID 和显式选择的兼容说明。历史 0.5.1 截图与验收事实仍标注对应历史版本，未当作最终 0.5.4 包证据；README 最新下载入口问题已解决，见 P3 记录。

本段为源码与文字语义核对，不是对最终安装包 UI、实际模型账户或第三方原生应用的现场验收。

## 独立验证

- `node --test scripts/frozen-release-updater-acceptance.test.mjs`：42 passed，0 failed。
- `node --test scripts/release-gate.test.mjs`：284 passed，0 failed。
- 11 个相关 MJS 脚本的 ESLint：通过。
- `git diff --check`：通过。
- 本地 Node：v26.12.0；正式 workflow 仍固定 Node 22.22.0，后续真实 CI 结果不能由本地测试替代。
- 第一次受限沙箱执行时两项本地 HTTP fixture 因 `listen EPERM 127.0.0.1` 失败；开启本地 loopback 执行后整套 42 项通过，没有修改测试或绕过断言。
- 独立测试日志：`/private/tmp/railwise-054-ai-review-frozen-tests.log`、`/private/tmp/railwise-054-ai-review-release-gate-tests.log`。

## 后续发布门禁

源码审查通过、文档 P3 已解决，可继续 PR 和受保护 CI。最终正式身份工件仍须独立安装，记录其版本、签名/公证、实拍截图、功能清单、无障碍发现、缺陷及独立最终包 AI review，并使用同一冻结源码、同一冻结公开身份 bytes 完成官方 0.5.2 → 0.5.4 的真实原生更新与历史资料回读。本报告与单元测试不替代这些结果；未观察到的结果没有被标记通过。

## 本次审查文件 SHA-256

```json
{
  ".github/workflows/frozen-release-updater-acceptance.yml": "f1b1169e66eeee1fef69e000ad5eae8dd0b79a3bdf3ddcad402a0754ecbfc1cd",
  ".github/workflows/release.yml": "6e9a8910948e8c807e29d57f923ebc44c704e0598bcb93516a99be4a34dfe8cd",
  "scripts/frozen-release-version.mjs": "69ee4952a2a2e8d02ced48e2da12039cff37578b9c95770a0d4bc97d1a5b3619",
  "scripts/frozen-release-updater-data.mjs": "f87bcec7597ec100e71156891bc3d3fa3d80dc6c9d896d5c7371c5b8dea50070",
  "scripts/frozen-release-updater-feed.mjs": "5ef3c0352f023b384f08146f2f60fce5338ba54b232d5be1d96fadd3b3a61c2f",
  "scripts/frozen-release-updater-service-contract.mjs": "bf37fd440fac01ba4a26a1d6adc030f11306b2edb267afcbf76612cf08a2d654",
  "scripts/run-frozen-release-updater-acceptance.mjs": "49a8b090bd139c987df90487265cb93588cd93377838166ce3b41590cdd8ee3a",
  "scripts/verify-frozen-updater-evidence.mjs": "5de30c8381cac8bf88a3bad948b1fc8dbbed2c546406787759ff3957b585211b",
  "scripts/verify-release-approval.mjs": "cf3aa2a1dee501450751c19f5ba14a96736c9cd1b58751c15322286e0b44a540",
  "scripts/frozen-release-updater-acceptance.test.mjs": "60397bea1b8f5d64c98cf54fbcce41cabdedaebefbcd7e5fcc2e0c9e71c505af",
  "scripts/verify-frozen-updater-evidence.test.mjs": "18510971c23799e79ed76a2c9798ad41545593555874f8461d60f055c1aa56d2",
  "scripts/release-gate.test.mjs": "e320fdebdaca6d21a9ca8df907867a2acda3095e4e205b1397d1464ec2afcccb",
  "scripts/release-build-memory.test.mjs": "54748c0e7bf6dd24380c2690429a9d6ef5a35e0ae7142be9a7633f6c1df7784b",
  "README.md": "9df2d4e2eb7ea26d55d80a6ec6395ae99dabfe28afe8bfa81a6e5aee2282c094",
  "README.en.md": "fea4e62a66695a9f64655244449f998a47a6f7dcb3afe67faa4171f56770634a",
  "docs/USER_GUIDE.zh-CN.md": "f538763340e01e06e0fffcc6e1569be5cba6332b42b34a09df5628ee1fc8af84",
  "docs/product-introduction.zh-CN.md": "46b2e50263a2e5801b151639dafb2f1050a53455469b9fc00cfe16643a2f38d5",
  "CHANGELOG.md": "03086981d2dd3db54781b89f26145a2e20541053a8a805b64ca61ec728730b7f",
  "release/release-v0.5.4.md": "17ffda4ac467085cb5b6b15c701d56005b2792a94e682b9b3aa9e7e8af7d9603",
  "docs/release/stable-release-gate.md": "9efa6d6f4d485c26fa210a540aa6a662cfbd646549662bce58c90ab55e7f3490",
  "docs/qa/release-gates/README.md": "300ddd7f8f0a280fd309f940ee6c93940c5a87cdcf1be3ffbe5febea6331b811"
}
```
