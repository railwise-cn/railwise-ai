# RailWise Survey 0.5.2 Independent AI Review

Date: 2026-10-05

Reviewer role: simulated senior engineering-survey practitioner, software engineer, and product designer (AI review).

This is an independent AI review of the installed local candidate. It is not a vendor interoperability certificate, a licensed surveyor's professional signature, a SUC comparison, a regulatory conformity assessment, or human approval.

## Package under review

- Application: `/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- Version: `0.5.2`
- Architecture: macOS arm64
- Bundle identifier: `com.wangjiawei508.workgpt`
- Launch mode: isolated candidate user-data directory, Computer Use inspection
- Code signature: ad-hoc; local deep strict verification passed
- Notarization: not present in the local candidate

## Inspection coverage

The candidate was opened and inspected through the native accessibility tree and screenshot surface. I checked:

- RailWise Survey branding and the four visible work areas: 概览, 处理, 结果, 交付.
- Overview actions: 查看结果 and 导出审查稿.
- Processing: upload/pre-check entry, source type, network type, known-control input, source recognition, point/observation counts, professional checks, and start calculation.
- Results: network/datum, source observations and corrections, independent closure status, residual statistics, precision/weakest item, adjusted point results, and professional review status.
- Delivery: review-draft generation, preview/export actions for DOCX, PDF, XLSX, and JSON, and the advanced source-record area.
- AI drawer entry from the Survey surface.
- Existing light-theme delivery screenshot and narrow-window evidence retained in this directory.

## Findings

### P0 / release blockers

None found in the installed local candidate UI. The four-area navigation is visible, the primary survey workflow is understandable, and no blank or development-only control was found in the inspected surfaces.

### P1 / release evidence and professional-use cautions

1. The seeded control-network sample shows `待确认` for the coordinate system and `未评估` for standards conformity, datum/height reference, independent closure, field-observation checks, and precision limits. This is correctly presented as pending professional review; it must not be represented as completed engineering acceptance.
2. The delivery page states that the restored historical review draft has not been re-reviewed. This is clear and appropriately prevents the historical file from being mistaken for a newly approved deliverable.
3. The local candidate is ad-hoc signed and not notarized. Public distribution requires the signed/notarized CI artifacts and updater round-trip evidence; this local package is not that evidence.

### P2 / polish observations

1. The result page is information-dense on a standard desktop viewport. The hierarchy remains scannable because the primary sections are named with survey terms, but a later pass could default-collapse the long observation table after the summary metrics.
2. The isolated sample includes a low-redundancy network (5 observations, 3 unknown parameters, 2 degrees of freedom). The UI exposes the degree of freedom and pending checks, which is correct; any release note or demonstration must avoid implying that this synthetic network proves field robustness.

## Internal/development terminology check

No visible `Typed Plan`, `TaskRun`, tool IDs, JSON execution payloads, context/source hashes, parser IDs, runtime protocol names, or developer commands were present in the inspected Survey work areas. The AI drawer entry is presented as `Survey AI`; its empty state only requests a survey question and does not expose implementation metadata. Professional result labels such as 平差残差、闭合检核、精度评定、规范合格评定 are appropriate engineering terminology.

## Acceptance conclusion

The 0.5.2 arm64 candidate passes this independent AI UI/workflow review with no P0 blocker. The package is suitable as a private release candidate from the inspected UI perspective. Public release still depends on the release workflow's signed/notarized artifacts, download/update metadata, and a real updater round-trip. External vendor files, formal SUC comparison, field-instrument interoperability, and human professional sign-off remain outside this AI review and are not claimed here.

