# RailWise AI

[简体中文](./README.md) | English

> Engineering survey processing and coding collaboration.

RailWise AI is a local-first desktop platform. Its candidate interface has Code and Survey as the primary workspaces. RailWise Survey connects original observations, deterministic adjustment, precision evidence and reviewable deliverables. Write, Design, Flow, plugins and schedules remain supporting tools.

**Version boundary:** the naming migration, four-stage Survey interface and subsequent professional features are undergoing isolated candidate acceptance. This documentation does not replace the public 0.5.0 installers or change their update channel. The repository is now `railwise-cn/railwise-ai`; WorkWise package, storage and update identifiers remain compatible; see the [migration matrix](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/railwise-ai-migration-matrix.md).

- Product page: [www.railwise.cn/products/workwise](https://www.railwise.cn/products/workwise/)
- Direct mirror downloads: [Download and installation](https://www.railwise.cn/products/workwise/#download)
- Documentation: [kb.railwise.cn/products/workwise](https://kb.railwise.cn/products/workwise/)
- Public releases: [GitHub Releases](https://github.com/railwise-cn/railwise-ai/releases)

## Current release

The current stable release is **[v0.5.0](https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.0)**. It adds the engineering survey workbench, unified plugin market, verifiable installation, Codex plugin compatibility, cross-platform glass window chrome, and structured attachment vision handling. Installed 0.4.2 clients can update in the application. Public releases have three user-facing installers:

| Platform | Installer | Download |
| --- | --- | --- |
| macOS Apple Silicon | `WorkWise-<version>-mac-Apple-Silicon.dmg` | [Release assets](https://github.com/railwise-cn/railwise-ai/releases) |
| macOS Intel | `WorkWise-<version>-mac-Intel.dmg` | [Release assets](https://github.com/railwise-cn/railwise-ai/releases) |
| Windows x64 | `WorkWise-<version>-win-x64.exe` | [Release assets](https://github.com/railwise-cn/railwise-ai/releases) |

GitHub Releases remains the public release log and manual installer source. Signed updater metadata and platform update artifacts are published through the official `railwise.cn` Stable channel. There is currently no Linux client, portable edition, or activation-code flow.

## RailWise Survey

**Original files → Content detection and preflight → Network and datum confirmation → Deterministic adjustment → Precision review → Deliverables → Human review.**

| Production stage | Current candidate capabilities |
| --- | --- |
| Import and preflight | Content detection, source hashes, diagnostics, original-record anchors and explicit file dispositions |
| Network and adjustment | Confirm network type, control points, units and datum before validated local computation |
| Analysis and precision | Closure, residuals, point precision, XY standard error ellipses and original-record navigation |
| Deliverables and review | DOCX, PDF, XLSX and linked manifests, with fresh source/output reads and strict replay of supported results |

AI conversation continues across stages. Calculations, project changes and exports show concrete parameters for confirmation; AI explanations do not replace deterministic computation. File generation, integrity verification and human approval remain separate states. Candidate deliverables are still review drafts.

COSA IN1/IN2 and Leica GSI leveling inputs must pass the applicable unit, datum and topology checks. Column mappings require explicit confirmation. OU1/OU2 currently remain archival review material, not an accepted automatic comparison workflow. Some formats, including RW5, support inspection or archiving only; receiver observations and RTKLIB-related sources require post-processing and cannot directly substitute for baseline-adjustment inputs. See the [current format matrix](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/qa/WORKWISE_0.5.0_SURVEY_FORMAT_ACCEPTANCE_MATRIX.md).

Candidate workspaces include free leveling, generalized w, grouped VCE, fixed external-scale Huber, statistical families, explicit-reference two-epoch comparison and static independent-observation additions. They retain model declarations, history and strict replay without automatically deleting observations, changing formal weights or declaring reference points stable.

Quality workspaces provide material retention, complete first-round sampling, limited declared-record scoring and linked assessments for up to eight sample units. Missing evidence and vetoes remain separate; these features do not authenticate evidence, resampling, professional signatures or full standards conformity. See the [implementation and acceptance ledger](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/qa/RAILWISE_SURVEY_CONVERGENCE_STATUS.md) and [advanced-trial contracts](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/qa/RAILWISE_SURVEY_ADVANCED_TRIALS_BACKEND.md). These candidate capabilities are not all part of the published 0.5.0 release.

## Candidate interface

All three images are actual Chinese light-theme captures from installed candidate `281dc87`, using a synthetic planar network with four points, one station and five observations. The [screenshot manifest](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/website/products/screenshots/workwise/candidate-screenshots.json) records their provenance and hashes.

![RailWise Survey candidate adjustment results in Chinese light mode](./website/products/screenshots/workwise/04-survey-candidate-zh-light.jpg)

![RailWise Survey candidate deliverables in Chinese light mode](./website/products/screenshots/workwise/05-survey-candidate-delivery.jpg)

![RailWise AI candidate model settings in Chinese light mode](./website/products/screenshots/workwise/06-candidate-model-settings.jpg)

This package completed signing, notarization, a real private updater round trip and limited linked-quality GUI checks. Its [exact-package report](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/qa/evidence/railwise-convergence-281dc8767250/README.md) remains partial: full interface coverage, packaged AI workflows, professional review and personal user confirmation are outstanding. Subsequent source fixes are not implicitly included in this package.

## DeepSeek V4.1

The default model is DeepSeek V4.1-Flash, using the official ID `deepseek-flash`; existing explicit model selections remain unchanged. Candidate `281dc87` includes this default, while later automatic-routing and fallback fixes belong to subsequent source changes.

On September 20, 2026, real official-service calls through the product adapter passed conversation, JSON output, declared function-name/argument return and synthetic-image recognition checks. The function check did not execute a tool. These checks do not replace acceptance of the complete packaged AI conversation, approval, tool and vision workflows.

The official V4.1 Responses API ignores built-in `web_search`. HTTP 200 does not establish a successful search; use separately configured browser or MCP search tools. See the [real-service evidence and correction](https://github.com/railwise-cn/railwise-ai/blob/e7de9df7c664a4924ea1668e69f821efd0a9bab1/docs/qa/evidence/railwise-v41-live-20260920/README.md).

The model catalog configures a 1M-token context and up to 384K output, with reasoning, tool-call, compression, cache-usage, JSON and Responses adapter paths. Actual access, limits and billing depend on the service and account. Provider vision capability determines structured `text`/`image` messages; text-only providers use the configured loopback visual-evidence analyzer. Failures remain explicit rather than inserting image Base64 into the model prompt. [Official model documentation](https://api-docs.deepseek.com/updates) remains the source for provider capabilities.

## Why RailWise AI

AI should do more than answer a one-off prompt. Real work needs project material, files, sessions, methods, and delivery standards to persist together.

1. **Persistent context**: local workspaces, conversations, and documents stay organized around the same task.
2. **Writing through delivery**: Markdown writing, preview, rich-text copying, and Word / PDF delivery live in one workflow.
3. **Reusable experience**: repeatable methods, templates, and standards can become Skills instead of one-off prompts.
4. **Bounded extensibility**: MCP and plugins add tools and data sources only after their purpose and permissions are understood.

## Core capabilities

### Code workbench

Collaborate around local projects and source material: understand, modify, test, build, review, and deliver. Sessions, plans, todos, goals, and permission settings support longer task chains without replacing human judgment.

### Write workbench

Use a complete document workflow for Markdown and text work:

- Edit, preview, and organize Markdown and text content.
- Copy rich text and deliver through HTML, PDF, DOC, and DOCX paths.
- Use Skills such as AI Word, humanized writing, and PPT Master to improve structure, expression, and review.
- Keep a human review step for facts, images, tables, layout, and formal delivery.
- Attach PDF and Office tender sources directly in Write, then start the bundled Tender Master workflow without switching to Code.

Read more: [Write and document export](https://kb.railwise.cn/products/workwise/write-export/).

For the exact WorkWise adapter scope and data boundaries, see the [DeepSeek Harness integration note](./docs/DEEPSEEK_HARNESS.zh-CN.md) (Chinese).

### Document attachments and retrieval

Attach PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, PNG, JPEG, or WebP files directly to a conversation. Files are streamed into application-managed storage, validated, parsed locally, split into indexed sections, and retrieved only when needed. Long documents are not inserted wholesale into the initial model context; retrieval results preserve page, worksheet, or slide provenance.

Document content is always treated as untrusted reference material. It cannot override system instructions or grant tool permission. Encrypted, damaged, disguised, or oversized files are rejected with an explicit reason. MarkItDown is bundled for local parsing, while MinerU remains an optional local high-accuracy component for difficult scanned PDFs.

The DeepSeek Harness integration describes the application's own Runtime adapters and evidence paths; it does not mean the upstream Harness repository or every upstream capability is bundled into the client.

### Design workbench

Create multi-page structured canvases with text, shapes, images, layers, groups, undo/redo,
document-scoped Agent conversations, visible selection targets, and revision-safe canvas commands.
PPTX import uses a readable-first full-slide reference that can be selected and annotated; source
text, charts, and animations are not misrepresented as individually editable objects. Export the
active design to PNG or SVG, insert it into Write, or deliver a validated PPTX through PPT Master.

### Flow Preview

Build executable workflows by connecting typed trigger, Agent, retrieval, tool, control, approval, and output nodes. The three-column workbench brings node configuration, mock and single-node tests, publish validation, run history, recovery, and approval resumption into one page. Published flows can be invoked by Agents, schedules, or signed webhooks.

Flow is visible by default and labeled Preview. Nodes that require an unconfigured model, external account, or companion CLI show the missing capability, and flows with unresolved dependencies cannot be published. Restricted code execution and webhook signing, replay protection, and rate limits keep execution within explicit boundaries.

### Skills and MCP

Skills are WorkWise reusable assets for high-frequency methods, writing rules, templates, and domain processes. The MCP and plugin market provides source, purpose, and installation-state context before additional tools are connected.

Read more: [Skills and templates](https://kb.railwise.cn/products/workwise/templates/).

### Local first

Workspaces, sessions, and settings are centered on the local machine. Model calls use API keys or compatible services that you are authorized to use. Handle sensitive material, access permissions, and local cleanup according to your organization’s rules.

Read more: [Local data and security](https://kb.railwise.cn/products/workwise/security-data/).

## Capability status

| Status | Scope |
| --- | --- |
| Available now | Code, Write, Design, DeepSeek Harness structured attachment handling, reliable task runs, Agents, MCP V2, general document attachments, indexed retrieval, validated document delivery, and in-app updates |
| Isolated candidate | RailWise AI naming, four-stage Survey and subsequent advanced/quality workspaces; accepted by exact package, without replacing 0.5.0 downloads |
| Preview | Flow canvas, typed nodes, mock and single-node tests, publish validation, run history, approval, and failure recovery |
| Optional | Local MinerU parsing, online Skill updates, mobile connection, and companion command-line tools |
| Direction | More multimodal generation nodes, industry nodes, and enterprise integrations |

Preview and directional items are not described as stable released features.

## Quick start

1. Download the installer that matches your device and install it.
2. Configure DeepSeek, Agnes AI, or another OpenAI-compatible service in Settings.
3. Choose a local project or source-material directory as a workspace.
4. Use the released version's Code, Write or engineering survey entry, or attach business files to a conversation. The new Code/Survey navigation and four-stage layout are candidate previews, not required menus in 0.5.0.
5. Open Flow Preview when automation is useful, then review content, images, tables, and layout before formal delivery.

- [Quick start](https://kb.railwise.cn/products/workwise/quickstart/)
- [Installation guide](https://kb.railwise.cn/products/workwise/install-guide/)
- [FAQ](https://kb.railwise.cn/products/workwise/faq/)

### Installation notes

- **macOS**: When macOS shows a first-open security prompt, verify the installer source first. You can allow the app in System Settings > Privacy & Security; the installation guide includes a fallback `xattr` path when needed.
- **Windows**: When Defender or SmartScreen appears, verify the source, file name, and version before continuing under your organization’s security policy.
- **Model services**: API-key availability, quotas, model access, and billing are controlled by the provider and your account.

### In-app updates

WorkWise 0.5.0 checks the official `railwise.cn` Stable channel at startup and every 24 hours. The blue update icon first downloads in the background; after completion it changes to **Restart and update**. Before restarting, WorkWise saves edits and reports active Agent, Flow, and scheduled runs. The platform updater then replaces and relaunches the application without opening a browser or requiring another drag-and-drop installation.

Version 0.3.2 and earlier did not include the trusted production update channel, so those users need one final manual installation of 0.3.3. Subsequent stable releases can update in the application.

## Development

```bash
git clone https://github.com/railwise-cn/railwise-ai.git
cd railwise-ai
npm install
npm run dev
```

Common quality checks:

```bash
npm run openspec:validate
npm run verify:brand-boundary
npm run typecheck
npm run lint
npm run test
npm run build
```

The local agent is provided by WorkWise Agent Runtime through a stable HTTP/SSE boundary with the desktop application.

## Release policy

- Public GitHub Releases expose the macOS Apple Silicon DMG, macOS Intel DMG,
  and Windows x64 EXE. ZIP, blockmap, signed update metadata, and checksums are
  published through the official `railwise.cn` update channel.
- Intermediate build artifacts are not published, and unverified roadmap items are not presented as released capabilities.
- [GitHub Releases](https://github.com/railwise-cn/railwise-ai/releases) is the public release log. Stable promotion requires the exact version's release approval after packaged acceptance, including signing, notarization and a real updater round trip; passing CI alone is not approval.
- The historical 0.2.5 public behavior baseline is tracked in the [public behavior gap table](docs/PUBLIC_BEHAVIOR_GAP_0.2.5.zh-CN.md).

## Feedback

Please report issues or ideas through [GitHub Issues](https://github.com/railwise-cn/railwise-ai/issues). Include where possible:

- WorkWise version, operating system, and chip architecture.
- Reproducible steps, screenshots, or error logs.
- A minimal Markdown example for document-export issues.
- The source, trigger, and error message for Skills or MCP issues.

## License

[MIT](./LICENSE)
