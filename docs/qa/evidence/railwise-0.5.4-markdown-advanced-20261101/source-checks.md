# Advanced Markdown source checks

Date: 2026-11-01. Product version remains 0.5.4. These checks precede the signed private candidate freeze; they are not package acceptance or publication approval.

## Final checks

- `npm test -- --testTimeout=15000`: **389 files / 3,748 tests passed; 2 files / 2 tests skipped** (35.76 seconds), after the final renderer corrections.
- `npm run typecheck`: passed for renderer/shared/preload and main.
- `npm run build`: passed for bundled runtime, main, preload and renderer.
- Changed TypeScript and packaging-script ESLint: passed.
- Root tracked-source `git diff --check`: passed. The frozen all-file checkpoint also preserves the scoped raw-AX-capture trailing spaces and preexisting PPTX EOF blank lines documented in `private-signed/whitespace-exceptions.md`.
- `node --test scripts/dependency-artifact-policy.test.cjs scripts/verify-packaged-markdown-rendering.test.cjs`: **4 passed**, including real-ASAR assets and deliberate missing-font rejection.
- `npm run verify:document-licenses`: passed. KaTeX 0.16.46, Mermaid 11.16.1 and markdown-it-footnote 4.0.0 are exact MIT dependency pins with bundled notices.
- Export owner final suite: **63 passed**. UI/shared owner suite: **49 passed**. Preview queue and IPC contract/registration suite: **45 passed**. These overlap with the full test count and are not additive.

## Environment and regression fixes

The first full run encountered the existing Electron-vs-Node native SQLite ABI mismatch and sandbox loopback restrictions. Rebuilding the local native dependency against the installed Node headers and running the loopback tests with the required permission resolved those environment failures. This did not change a lockfile version or skip tests.

The complete run exposed two additional regressions: isolated packaging fixtures lacked the newly introduced dependency-artifact policy module; trusted local Skill entry links compared canonical target paths with noncanonical roots on macOS (`/var` versus `/private/var`). The fixture now includes the module, ASAR loading is lazy for policy-only configuration reads, and both sides of the trusted-root comparison use real paths. Regression assertions retain rejection of outside-root links.

A subsequent full run had one large bundled-Skill copy exceed the default five-second test timeout. The final full run used a 15-second per-test ceiling with all assertions retained; every active test passed. No production timeout or behavior was relaxed.

## Independent review and real execution

The independent AI source review identified DOCX formula fidelity issues before freeze. No-rule fractions now emit Office Math `noBar`; unsupported compound operators, one-sided fences, noncenter arrays, explicit color/spacing and custom fraction rules use a locally rendered image fallback. Regression tests inspect actual DOCX XML.

Actual computer-use inspection found interspersed footnotes grouped at the first definition and an advanced syntax dialog whose preview opened at the document beginning. The corrected renderer assigns each named note to its own source gap, keeps inline-note tail visuals out of serialization, focuses the edited block within a full-context parse, repeats preview-pane-only scrolling after async image/diagram layout, and uses opaque work surfaces. The independent follow-up review and targeted run passed **8 files / 62 tests**; final signed-package visual inspection remains required.

The first private CI run exposed npm10's rejection of missing optional peer lock records for the existing PPTX dependency graph. The minimal lock repair adds 24 MIT canvas 1.1.0 optional/platform records, changes no existing package record or package.json version, and passes Node 22/npm 10 clean-directory `npm ci --dry-run --ignore-scripts --offline`. Full signed native packaging remains the validation of those target-specific binaries.

`source-export-smoke/` preserves actual Electron-generated HTML, PDF, DOCX, Mermaid SVG/PNG, formula fallback image, hashes and semantic readback. This is real source-level rendering evidence; installed-package acceptance is recorded separately.

`live-model-service-readback.json` records successful real DeepSeek v4 Pro requests through the production Write builder/service using the existing configured credential in memory. Source files and production settings were unchanged. This is service integration evidence and does not substitute for the pending final signed-package GUI review.

## Candidate boundary

Final source SHA, signature identity, notarization receipt, exact ASAR, installed screenshots, real model GUI review and actual private Squirrel updater round trip are bound by the subsequent package acceptance record. No public version, tag, release, stable/frontier feed or download-page operation is authorized by these checks.
