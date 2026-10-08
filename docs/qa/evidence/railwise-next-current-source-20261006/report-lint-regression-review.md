# Independent AI regression and lint review

Review completed at 2026-10-05T18:32:01Z (2026-10-06 Asia/Shanghai) against the current uncommitted working tree on `codex/survey-reliability`.

This is AI source, numerical/reporting and product review. It is not licensed vendor interoperability evidence, an authentic professional signature, a human approval, installed-package acceptance, or release approval. No commit, version, tag, packaging or publication operation was performed by this reviewer.

## Root cause and repair

`kun/tests/survey-report-independent-review.test.ts` reproduced one failure: an existing professional topology source such as `record_0 / 第 6 行` did not have a structured `sourceRow`; after the JSON source-position presentation change, it was incorrectly rendered as `原始定位未记录`. The report now retains the explicitly recorded `第 N 行` anchor from legacy source text, while never inventing a row from display order. The report continues to preserve real file names, point names, XML/worksheet locators and numerical values.

The importer-owned locator `WorkWise JSON:network.observations[n]` remains rendered as `原始观测记录第 n+1 条` in ordinary exports. The internal evidence model is retained. The unreachable `sourceRecordId` branch in the new helper was removed.

The XML control-character filter in `kun/src/engineering/survey-design-export.ts` now uses code points with the same disallowed XML 1.0 ranges, removing `no-control-regex` without relaxing content validation. The draft collaboration/editor effects now depend on their actual scope fields; both `react-hooks/exhaustive-deps` warnings are resolved.

## Fresh verification

| Command | Result |
| --- | --- |
| `npm test -- --run tests/survey-report-independent-review.test.ts` in `kun` before repair | 1 passed, 1 failed; expected original filename and `第 6 行`, received `原始定位未记录` |
| `npm test -- --run tests/survey-report-independent-review.test.ts src/engineering/survey-professional-report.test.ts` in `kun` after cleanup | Exit 0; 2 files, 18 tests passed (2 independent source identity, 16 professional report) |
| `npm run typecheck` at root | Exit 0; renderer and Electron main type checks passed |
| `npm --prefix kun run typecheck` after cleanup | Exit 0 |
| `npm run lint -- --no-warn-ignored` after cleanup | Exit 0; no reported errors or warnings |

The scoped child reviewer `svg_export` reported the 16 professional report tests passed, Runtime type check passed, and 77 Survey test files / 1988 tests passed with 22 skipped. The parent independently re-ran the 18 report tests and type/lint checks above. The child did not re-generate persistent report artifacts in this turn; prior exported DOCX/PDF/XLSX and screenshots must not be represented as proving the current working-tree bytes.

## Scope and remaining acceptance

The source fixes are ready for the root agent's fresh full test/build pass. Real packaged UI, exact package identity, installed export flows, signed/notarized candidate and real updater round trip remain root-level acceptance work. This source review does not close those gates.
