# RailWise Survey 0.5.2 package acceptance

Date: 2026-10-05

This record covers the exact local arm64 package built from commit `41f7078c5b621423b968af8799dfcd9ec84f10b7`.

## Package identity

- App: `/Users/wangjiawei/Documents/WorkWise/dist/mac-arm64/RailWise AI.app`
- Version: `0.5.2`
- Architecture: macOS arm64
- Bundle identifier: `com.wangjiawei508.workgpt`
- ASAR SHA-256: `aa705cb8574f78714a21720c3fbf59668b810a642a1617d222cfaebacd0cbf20`
- ZIP SHA-256: `b9fee39144ad49741a40a9baa726041fa39b24de232b76ed1af910c7b7a4107d`
- DMG SHA-256: `b8c71962331c9817f5794eccea18e946849d07955355af728596f5f1c9683685`
- Signature: ad-hoc deep strict verification passed; no Developer ID identity was available locally.
- Notarization: not performed locally because Apple notary credentials were unavailable.

## Computer Use inspection

The exact package was launched with an isolated user-data directory and inspected with Computer Use. The accessibility tree exposed RailWise Survey, the four work views, current source/status/result summary, delivery review-draft controls, DOCX/PDF/XLSX/JSON artifacts, AI drawer entry and settings controls. The delivery surface screenshot is [01-delivery-arm64-light.png](01-delivery-arm64-light.png); the follow-up capture is [03-process.png](03-process.png). A 960x800 narrow-window capture is [04-narrow-960x800.png](04-narrow-960x800.png); content remains readable and scrollable, while the full keyboard/focus matrix is still a release-runner gate.

The visible surface contained professional survey terms and actions. It did not expose parser IDs, tool IDs, hashes, JSON execution plans or runtime protocol details. Existing retained COSA IN2 data restored a result and review-draft delivery without data loss.

## Local checks

- `npm test`: 3,109 passed, 2 skipped.
- `npm run typecheck`: passed.
- `npm --prefix kun run typecheck`: passed.
- `npm run openspec:validate`: 12/12 passed.
- `npm run verify:brand-boundary`: passed.
- `npm run verify:document-licenses`: passed.
- `codesign --verify --deep --strict`: passed for the local app bundle.

## Release boundary

This local package is evidence for source and packaged UI behavior. It is not a notarized public package, a vendor interoperability certificate, a SUC comparison, a professional signature or regulatory acceptance. The signed/notarized multi-platform artifacts and real updater round-trip remain CI release gates.
