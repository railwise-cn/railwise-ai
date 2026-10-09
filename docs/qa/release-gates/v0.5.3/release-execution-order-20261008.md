# RailWise AI 0.5.3 发布执行顺序

本文件是发布操作准备记录，不是通过的验收记录。尚未填写最终标签提交、安装包哈希、updater 结果或最终验收结论，不创建公开标签，不替代真实验收清单。

## 授权与治理

用户已经明确授权发布 0.5.3，并授权恢复单维护者模式。当前维护者可以在严格 CI 通过后审核、合并，在最终安装包验收通过后执行已获授权的发布，不需要第二 GitHub 维护者、CODEOWNER 人工审批或 production reviewer。独立高级工程师模式 AI 审查仍是内部质量门禁；它不是厂商互操作认证、真实专业签名或真人审批。

2026-10-08 的只读 GitHub API 回读显示：

- 当前 CLI 用户为 `railwise-cn`，仓库 `railwise-cn/railwise-ai` 的维护、管理与推送权限有效。
- `main` 保留 PR 合并，要求三项严格 GitHub Actions 检查：`OpenSpec, brand, lint, type, test, build`、`Windows path, spawn, persistence`、`Electron production smoke`；required approvals 为 0，管理员强制遵守，禁止 force push 和删除。
- `Protect release tags` 规则为 active，覆盖 `refs/tags/v*`，保护创建、更新、删除与非快进；当前指定维护者是该规则的授权例外。
- `production-release` 无 required reviewer，`can_admins_bypass=false`，部署策略仅允许 `v*` 标签。

## 冻结来源与验收前提

**2026-10-09 增量状态：** 水准定权单位修订、updater 历史资料兼容夹具和处理方案历史文案已通过 PR 合入 `main`。随后从 `1aae1717926de575220cb01e2289613f3c34c639` 启动的冻结 `37861714441` 已取消：独立源码审查发现归档成果追问仍把内部记录编号写入用户草稿。PR #49 正在补齐该文案、能力信息中英文呈现，以及验收保护脚本的安装源/用户目录符号链接边界。修订检查和复审完成后，必须从新的受保护 `main` 重新冻结。以下旧冻结状态保留为历史记录，不能当作当前包或通过证据。

**2026-10-08 状态更新：旧冻结已取消，等待源码 PR 和重新冻结。** 独立数值审查发现水准相对定权的单位权尺度、平方因子及专业说明存在口径缺口；对应产品修订尚待通过源码 PR 合入受保护 `main`。新冻结 source HEAD、run ID 和最终安装包均未记录，不能把准备材料或合成检查记作安装包验收。

下列信息仅保留为已取消的历史冻结，不是当前可发布来源：

- 历史 source HEAD：`d3f9158a6fd26cd40e4f0bd3dd4d92e4686d1f51`。
- 历史 freeze run：`37749218440`，由 `release.yml` 私有 dispatch，现已取消。
- 输入：`candidate_only=true`、`prepare_public_artifacts=true`、`publish_release=false`、`skip_stability=false`。

源码修订经 PR/严格 CI 合入后，必须从新的受保护 `main` 精确 source HEAD 重新私有 dispatch，并记录真实新 run。旧 run 的安装包和其他产物不能用于最终验收或公开发布。必须从新 run 的真实完成结果确认完整两小时稳定性、macOS/Windows 构建、三客户端校验和最终 macOS 校验。记录新 run 的实际 attempt、两份 unexpired immutable artifact ID/digest、原始 receipt 与全部八个文件的真实尺寸和哈希，不借用同名其他构建。

本目录的 [用户资料保护说明](normal-profile-protection.md)、[合成自检](normal-profile-protection-selftest.json)、[独立 AI 工具审查](normal-profile-protection-independent-review.md) 与 [独立数值基准](independent-numerical-expectations-20261008.md) 仅为执行准备。尚未对新冻结安装包实际激活正常用户资料验收环境，也未完成其功能、界面、成果读回或 updater 验收。

发布前必须完成同一冻结包的签名、公证、安装版本与 ASAR 核对、computer-use 48 视图矩阵、专业导入/预检/计算/交付及导出读回、恢复和可访问性检查、独立高级工程师模式 AI 审查，以及官方 pinned 0.5.2 到同一冻结 0.5.3 的真实 native updater 下载/安装/重启/历史资料读回。任何必需项目失败或不完整都阻断发布。

updater 在受保护 `main` 仍为冻结 source HEAD 时 dispatch，保留其不可变 artifact 内原始 `frozen-updater.json` 和 `native-updater.json` 字节，不重新排版。该 run 与 freeze run 分别记录。UI 安装、目标 ZIP、更新后安装的 ASAR 必须一致。

## 最终应用发布

1. 所有真实验收通过后，创建 `docs/qa/release-gates/v0.5.3.json`，引用已提交的截图、功能清单、CUA 报告、AI 复审及原始 updater 报告。审核 manifest 的每项结果与实际证据一致。
2. 通过 PR 和严格 CI 将验收证据合入 `main`。冻结来源至最终标签之间的所有提交、所有 merge parent diff 只能修改 `docs/qa/`；其他源码、版本、构建、依赖、workflow、配置或网站变化都要求重新冻结。后续还原也不能免除该要求。
3. 确认远程尚无公开 `v0.5.3` Release，标签尚未存在；记录实际最终验收 main SHA。用该精确提交创建标签，运行完整发布校验，然后推送该标签。不得强推、移动或覆盖现有标签。

以下 SHA 占位值必须替换为实际观察到的最终验收 merge SHA；它不是冻结 source HEAD。

```bash
ACCEPTANCE_MAIN_SHA='<actual-final-qa-main-sha>'
git tag -a v0.5.3 "$ACCEPTANCE_MAIN_SHA" -m 'RailWise AI 0.5.3'

HTTPS_PROXY=http://127.0.0.1:9567 node scripts/verify-release-approval.mjs \
  --tag=v0.5.3 --ref-type=tag --source-head="$ACCEPTANCE_MAIN_SHA" \
  --confirmation=PUBLISH-STABLE-v0.5.3 \
  --evidence=docs/qa/release-gates/v0.5.3.json --verify-source

git push origin refs/tags/v0.5.3
```

4. 从 `v0.5.3` dispatch 以下发布输入。`release.yml` 没有 tag-push 自动发布触发器；公开发布必须明确 dispatch，`candidate_only` 默认 true，因此必须显式设为 false。

```bash
HTTPS_PROXY=http://127.0.0.1:9567 gh workflow run release.yml \
  --repo railwise-cn/railwise-ai --ref v0.5.3 \
  -f publish_release=true \
  -f candidate_only=false \
  -f prepare_public_artifacts=false \
  -f skip_stability=false \
  -f release_confirmation=PUBLISH-STABLE-v0.5.3 \
  -f release_evidence=docs/qa/release-gates/v0.5.3.json
```

该模式跳过应用、sidecar 与稳定性重跑，直接消费 manifest 中的两份不可变 artifact。它不会重新构建应用。发布工作流按以下顺序运行：

1. 校验标签中的已提交验收清单、真实 GitHub 来源、冻结与 updater 不可变证据。
2. 按准确 artifact ID 下载，再校验原始 receipt、八份文件尺寸与 SHA-256。
3. 准备三份用户安装包名称，校验发布凭据，拒绝修改已经公开的同标签 Release。
4. 上传并验证 R2 immutable 版本目录；部署并验证官网 immutable 下载版本目录。此时不改变 latest 指针。
5. 创建或更新 GitHub draft，只上传 Apple Silicon DMG、Intel DMG、Windows EXE；实际重新下载并逐字节比较三份安装包。
6. 保存 R2 和官网 Stable/兼容 latest 共十二份 metadata 的真实旧值，校验旧版本 archive 和当前指针一致。
7. 提升 R2、官网 Stable 和兼容 `workwise/latest` 指针；验证公开 HTTPS 更新元数据与下载文件。
8. 最后公开 GitHub Release；保存私有 transaction evidence。

GitHub 安装包只是重命名副本，字节必须与冻结文件一致。更新 ZIP、blockmap 和 YAML 由下载渠道提供，不新增到 GitHub 的三安装包列表。全部渠道参数保持显式 `stable`；本次 workflow 不提升 `frontier`。直接运行 `publish-r2.mjs` 的默认渠道为 `frontier`，不得省略渠道或用它绕过事务流程。

## 官网产品页必须后置

`release.yml` 只更新官网的下载版本目录和 latest 指针，不部署 `/products/workwise/` 产品页面。2026-10-08 审计时，`website/data/workwise-product.json` 仍记录正式 0.5.2；这不是 0.5.3 官网部署完成的证据。

产品页使用单独 `deploy-workwise-product-page.yml`。其 full/deploy 门禁要求：

- JSON 的 version 为 0.5.3，release URL 指向 `railwise-cn/railwise-ai` 的 `v0.5.3`。
- `releaseCommit` 与实际 `v0.5.3` 标签提交一致。
- GitHub Release 已公开且不是 prerelease，官方 Stable latest 实际为 0.5.3。
- 三安装包名称、immutable URL 和 SHA-256 真实有效。

因此不能把 `website/` 改动放到冻结来源与应用标签之间，否则应用发布证据门禁会拒绝。正确顺序是在应用发布后，按实际发布时间、标签提交、安装包字节与真实截图更新官网资料，经单独 PR/CI 合入 `main`。此官网变更不重建已经验收的应用，也不移动 `v0.5.3`。

`WEBSITE_MAIN_SHA` 是该官网 PR 合入后的真实 main SHA；环境只允许 tag 部署，因此 dispatch ref 为 `v0.5.3`，内容来源通过 input 单独指定。

```bash
WEBSITE_MAIN_SHA='<actual-website-main-sha>'
HTTPS_PROXY=http://127.0.0.1:9567 gh workflow run deploy-workwise-product-page.yml \
  --repo railwise-cn/railwise-ai --ref v0.5.3 \
  -f version=0.5.3 \
  -f confirmation=DEPLOY-WORKWISE-PRODUCT-PAGE-v0.5.3 \
  -f mode=full \
  -f operation=deploy \
  -f source_sha="$WEBSITE_MAIN_SHA"
```

该工作流使用受保护 main 的部署工具，并检查精确内容 SHA 是 main 的祖先。它保存服务器备份，再验证公开页面、公开 manifest 和三个 immutable 安装包；公开验证失败时尝试恢复本次页面变更。

## 观察与失败处理

记录两次 dispatch 的真实 run ID、source/tag SHA、最终公开 Release 与渠道元数据。核对 Github Release 三个安装包、Stable latest、兼容 latest 与产品页面版本一致，并对实际下载字节核验哈希。不要把绿色 Actions 状态代替安装包验收或用户授权。

发布失败时先读取 `official-promotion-transaction-<run>-<attempt>`，辨明哪些阶段已经发生。只有本次尝试已进入 started 且 GitHub 权威状态仍为 draft/absent，工作流才尝试恢复自己改变的旧指针；其他发布占用或状态未知时拒绝覆盖。已公开同标签 Release 会被拒绝修改，不盲目重跑或手动覆盖。

## 原生窗口尺寸观察

旁边的 `observe-window.swift` 只接收精确 PID，读取 CoreGraphics 已有窗口信息、真实 bounds 和显示比例并输出 JSON。它不调整窗口、不点击、不激活应用、不请求权限、不修改任何 UI，也不使用 AppleScript。窗口调整、主题/语言变更、截图与功能操作由 computer-use 工具完成。

```bash
swift docs/qa/release-gates/v0.5.3/observe-window.swift ACTUAL_REVIEWED_APP_PID
```

屏幕读取授权不足时标题可能不可用；JSON 会保留 null，不猜测标题。没有目标 PID 的窗口时返回明确错误，不能使用其他应用窗口代替真实尺寸证据。

本机工具可用性检查：Python 3 未安装 `Quartz`/`AppKit` 模块；`/usr/bin/swift` 可用。`swiftc -typecheck` 无诊断，使用已观察到的 Finder PID 2279 完成一次只读试运行，输出主显示逻辑尺寸 1920×1080、像素尺寸 3840×2160、scale 2，以及该进程的窗口 id/title/bounds。不存在的 PID 999999 返回退出码 1 和明确无窗口错误。这只是观察工具验证，不是 RailWise 安装包尺寸或 UI 验收证据；最终审查时必须改用真实已安装冻结包进程 PID。
