# Candidate 0.5.2 baseline findings

Date: 2026-10-06  
Review type: AI simulated senior engineering-survey/software/product review using native CUA evidence.  
Status: **baseline only; not a release approval and not a passing acceptance**.

## Exact bytes reviewed

- Package: `/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- Version: `0.5.2`
- Bundle identifier: `com.wangjiawei508.workgpt`
- ASAR SHA-256: `cc022580212df636ce04c90f997c829ab77145d069192b26722e8affe4ca54e8`
- Code signature: `codesign --verify --deep --strict` exit `0`; adhoc arm64 signature, no Team ID
- Gatekeeper assessment: `spctl --assess --type execute` exit `0`
- CUA evidence: `candidate-052-processing-baseline-20261006-02.png/.ax.json`, `candidate-052-delivery-baseline-20261006-01.png/.ax.json`

The package was inspected as an unpromoted candidate. It is not the public release approval for 0.5.2, and no updater round-trip or notarization ticket was established for these bytes.

## Findings

### F4: processing status contradicts the unresolved professional prerequisite

On the processing view, the same task displays:

- `基准与单位：待确认 · 待确认`
- `是否可计算：可计算`
- `资料已通过当前计算条件校验。`
- `需要处理：资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。`

This is contradictory for a professional workflow. A coordinate system and vertical datum that are still `待确认` must be represented as an explicit unresolved prerequisite. The UI should either block calculation with the complete reason and a direct repair action, or show a narrowly scoped status such as “数值结构检查通过，专业基准待确认”; it must not combine `可计算` and “资料已通过” with an unresolved basis declaration.

The `needs attention` copy is now professional in wording, but it does not identify the missing declared reference as a blocking item. The repair path must name the exact field(s), preserve the original record, and update the status after confirmation.

### F1: ordinary delivery surface exposes internal review artifact

The delivery baseline exposes `professional-review.json` in the ordinary output list. This is an internal audit artifact and must be available only from the advanced traceability area. The ordinary delivery page should present the professional review status, source references and warnings in user-facing terms, while keeping the raw JSON behind advanced details.

### F2: exported reports expose implementation details

The public 0.5.2 baseline reports parser names, internal identifiers, hashes, catalog identifiers and internal enum values in PDF/DOCX. Those details belong in the advanced traceability record. Ordinary deliverables should contain measurement conclusions, units, source locators, warnings and review status without implementation protocol fields.

### F3: residual norm is labelled as a pre-adjustment closure check

The AI/result wording calls the post-adjustment residual norm a pre-adjustment closure check. These are different quantities. The result must state whether an independent pre-adjustment closure check was performed; residual norm must remain labelled as a post-adjustment residual statistic.

### F5: coordinate correction is described as displacement and missing elevation correction is rendered as zero

The result language describes a coordinate adjustment as displacement and renders an unavailable elevation correction as `0`. The UI/report must use “坐标改正数” (or the corresponding English term) and represent unavailable elevation correction as not evaluated/not available, never as a measured zero.

### F6: GSI PDF pagination separates a closure heading from its table

The GSI PDF baseline leaves a closure heading isolated from the table it introduces. Keep the heading with at least the first table row, or move the whole section to the next page.

## Acceptance boundary

This baseline does not close any of the 21 package-acceptance tasks or professional workflow task 4.2. Source tests, source reviews and this CUA baseline are evidence for repair planning only. A changed package must be frozen under a new exact identity and re-tested from a clean isolated install; old screenshots and hashes cannot be inherited as passing evidence.

