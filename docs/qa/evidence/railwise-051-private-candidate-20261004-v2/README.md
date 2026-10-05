# RailWise Survey private candidate v2 (2026-10-04)

This is a private development candidate rebuilt from the current working tree after the professional-surface language filter and the public M5 delivery regression were added. It is not a new public release. The public baseline remains `0.5.1`; any future public release of this work would require a separately approved `0.5.2` operation.

## Package identity

- App: `/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- Package version: `0.5.1` (development candidate)
- Architecture: macOS arm64
- DMG: `dist/WorkWise-0.5.1-mac-arm64.dmg`
- ZIP: `dist/WorkWise-0.5.1-mac-arm64.zip`
- ASAR SHA-256: `9b688f74969a1da4351cbe173d34eb77df739ea79d84b8344f11611542b222dd`
- DMG SHA-256: `42cc796d5313f512ddde49c314b3c719169b4b20b34974b95cdff0982bef9d05`
- ZIP SHA-256: `07bb2000bc95fb507cd0a0d58813db89ea40a976a1895cc7876bf3a72001dd16`
- Bundle identifier: `com.wangjiawei508.workgpt`
- Signature: ad-hoc; `codesign --verify --deep --strict` passed
- Notarization: not performed; no Apple notary credentials were present

## Source and regression checks

- `npm run build`: passed
- `npm run verify:brand-boundary`: passed (2,588 files)
- `npm run verify:build-freshness`: passed (1,130 production inputs)
- `npm run openspec:validate`: 12/12 passed
- `npm run typecheck`: passed after aligning the root test resolver to the repository's `kun` Zod 4.4.3 dependency
- `npm --prefix kun run typecheck`: passed
- Renderer professional-surface regression: 2 files, 89 tests passed
- M5 delivery plus format/P0 delivery regressions: 3 files, 138 tests passed
- ASAR verification: 13,363 files and 466 compiled files passed
- `git diff --check`: passed

## AI review and package gate

An independent AI review was performed from the combined engineering-survey, software-engineering and product-design perspective. The review is simulated expertise and is not a vendor certificate, SUC interoperability statement, professional signature or regulatory approval.

The source and deterministic tests cover professional source binding, adjustment semantics, reports and the M5 public-sample delivery chain. The exact candidate was subsequently selected with Computer Use using the isolated data root. A real COSA IN2 import, preflight, plane-control adjustment, result inspection, review-draft generation and DOCX/PDF/XLSX/JSON delivery path passed. English/Chinese and dark/light settings were also exercised. The full narrow-window, complete keyboard tab-order, isolated-source recovery and updater matrix remains open; the detailed current record is [CUA-20261004.md](CUA-20261004.md). Historical screenshots are not reused for this package.

No public release, tag, stable feed, website update or version change was performed.
