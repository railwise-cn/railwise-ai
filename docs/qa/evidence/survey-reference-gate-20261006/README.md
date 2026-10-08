# Survey reference declaration regression — 2026-10-06

This is a source-level AI review and regression record. It is not an installed-package UI acceptance, vendor interoperability certificate, professional signature, or release approval.

## Scope and findings

- Calculation now requires the reference dimensions actually used by the survey model: a coordinate reference for plane calculations; a height datum for leveling, GNSS and applicable vertical/3D calculations.
- Import and precheck remain available when a reference is missing. New computation is blocked with a professional repair action; retained historical results remain readable.
- An explicit import declaration is retained separately from original source bytes and participates in import identity. A conflicting declaration is rejected.
- The first full Survey run found 10 existing cases that imported reference-free fixtures and expected a new successful calculation. Those fixtures now explicitly declare their synthetic/local test references. No original fixture bytes, numerical expectations, source hashes or independent numerical references were changed.
- Safe SVG export is imported by `SurveyCollaborationService` from `survey-design-export.ts`.

## Fresh checks

| Check | Command | Result |
| --- | --- | --- |
| Runtime Survey regression | `kun/node_modules/.bin/vitest run survey --reporter=dot --maxWorkers=4` from `kun/` | Exit 0; 96 files passed, 2 skipped; 2079 tests passed, 22 skipped |
| Reference UI and identity | `node_modules/.bin/vitest run src/renderer/src/components/engineering/SurveyAdjustmentPanel.reference-dom.test.ts src/renderer/src/components/engineering/survey-import-reference-identity.test.ts --reporter=dot` | Exit 0; 2 files / 10 tests passed |
| Survey interface and professional copy | Five files listed in `desktop-survey-tests.txt` | Exit 0; 5 files / 201 tests passed |
| Runtime types | `kun/node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` from `kun/` | Exit 0 |
| Web types | `node_modules/.bin/tsc --noEmit -p tsconfig.web.json --pretty false` | Exit 0 |
| Whitespace | `git diff --check` | Exit 0 |

The Survey logs retain skip counts; skipped tests are not claimed as verified. The desktop run reports existing React `act` warnings, with no test failures.

## Remaining package acceptance

The final 0.5.2 package must still be frozen, installed and inspected across supported locale/theme/window sizes, independently reviewed in AI senior-engineer mode, checked for code signature/notarization, and exercised through a real updater round trip before public publication. Source tests above do not replace that gate.
