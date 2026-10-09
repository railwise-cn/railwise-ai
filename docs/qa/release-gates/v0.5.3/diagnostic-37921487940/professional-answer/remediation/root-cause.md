# Professional assistant presentation: root cause and source fix

Status: source fix complete; replacement packaged application acceptance is not executed by this diagnostic.

## Actual installed-package defect

The reviewed package was RailWise AI 0.5.3 from private freeze run 37921487940, source `6bcfe0db516eafbecfed546e7077088975cda804`. The installed ASAR SHA-256 was `2134c273af4b7e86e6f0243b0178fd1ffedeb120f260bca7094b5726b7474af7`.

The real official DeepSeek response in the synthetic task was read before restoration of normal user data. The preserved raw response says `This is the true pre-adjustment check.` and `no observation files or adjustment records are registered yet`. The rendered installed interface instead displayed `Yes` for `true` and `s` for `adjustment records`. Lowercase station compounds were also capitalized. This is a renderer defect, not an alteration present in the model's raw response.

The actual computer-use capture is at `../../cua/captures/new-task-actual-professional-answer/screenshot.jpg` from this diagnostic directory, with the corresponding AX/capture records. The parent agent owns those original installed-package records and their archival. The exact local absolute directory is `/private/tmp/railwise-053-tools/new-freeze-37921487940/cua/captures/new-task-actual-professional-answer`.

## Root cause

`engineering-professional-text.ts` translated every occurrence of true/false/null/undefined across the response. These are legitimate words in survey prose such as true closure, false alarm and null hypothesis. A separate expression removed `network record` or `adjustment record` without requiring revision metadata, leaving the plural suffix. Global station and known/unknown enum replacement also changed natural datum declarations, point identities and source filenames.

Independent source readback reproduced the associated identity errors: a Point/X table's `known`, `unknown` and `station` point names were renamed; `known.csv` and `unknown.in2` changed in Chinese mode. The first source patch's removal of global scalar translation also exposed incomplete field/value handling for `varianceFactorEstimated=false`, `statisticalSummary=null` and the internal readOnly table row. These are source diagnostic findings, not additional installed-package scenarios claimed as complete.

## Fix

Only `src/renderer/src/components/engineering/engineering-professional-text.ts` and its existing test file were edited by this agent.

- State translation is restricted to whole scalar values in recognized professional field/value rows. Variance-factor estimation and missing statistical-summary limitations retain their professional meaning. Internal readOnly rows are removed as complete rows.
- Point-role values are converted only in explicit pointClass, recordType, rawFields.recordType and known field contexts. Chinese legacy bare known/unknown requires an explicit following point noun; known-point/unknown-point remains a point enum. Ordinary unresolved datum declarations do not infer a point role.
- Global known/unknown/station rewrites were removed. Natural English prose, point names and the captured source filenames remain intact.
- Only numbered network/adjustment revision metadata is removed. Ordinary record/records and dataset/datasets remain intact.
- The stored original assistant response and user question text were not changed. Internal protocol filtering and professional numerical limitations remain covered by existing regression tests.

## Validation

Before the additional independent findings were fixed, all 8 new bilingual regression cases failed, reproducing datum-prose, point-name, scalar-table and internal-row errors. After the final fix, professional text, plan transcript and AI command center DOM suites passed 169/169 tests; web TypeScript, targeted ESLint and git diff --check passed. The logs are `validation-vitest.log`, `validation-typecheck-web.log`, `validation-eslint.log` and `validation-diff-check.log`.

The exact captured raw model response was passed through both the frozen original source and the final patched source using Vite SSR. `render-comparison.json` records the hashes and all three before-error/after-preservation checks. This is source diagnosis and does not replace computer-use inspection of a rebuilt package.

## Remaining boundary

The parent agent must merge through the required PR/CI path and freeze a new candidate. Run 37921487940 is a failed package and cannot supply final package acceptance. A persistent Preparing defect was not established: in the original startup diagnostic, the second newly created task accepted input and sent a message. No speculative startup or prompt rewrite was made. Normal user data has been restored by the parent and this agent will not read it again.
