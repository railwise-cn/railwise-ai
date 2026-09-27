# Runtime Validation

- Date: 2026-09-21
- Worktree: `/private/tmp/railwise-survey-result-questions`
- Branch: `codex/survey-result-questions`
- Base HEAD: `b193fc70d6363dc768e715087ca9c0d9975158c9`
- Scope: uncommitted Q10-Q17 typed result-question Runtime changes in the isolated feature worktree.
- Node: `v26.8.2`
- npm: `11.19.1`
- Vitest: `4.1.8`
- Dependencies: existing original-repository `node_modules` symlinks. No installation or native rebuild performed.

## Commands And Results

All commands ran with cwd `/private/tmp/railwise-survey-result-questions/kun` and shell pipefail enabled.

```sh
set -o pipefail
npm test -- --reporter=default 2>&1 | tee /private/tmp/railwise-result-questions-validation/runtime-tests.log
```

Exit 0. 192 test files passed; 2 test files skipped. 2,929 tests passed; 22 tests skipped; 0 failed. Duration: 24.90 seconds.

```sh
set -o pipefail
npm run build 2>&1 | tee /private/tmp/railwise-result-questions-validation/runtime-build.log
```

Exit 0. Executes `tsc -p tsconfig.build.json`.

```sh
set -o pipefail
npm run typecheck 2>&1 | tee /private/tmp/railwise-result-questions-validation/runtime-typecheck.log
```

Exit 0. Executes `tsc --noEmit -p tsconfig.json`.

## Existing Optional Skips

- 20 tests in `src/engineering/survey-converter.test.ts`: real macOS process-boundary cases gated by `WORKWISE_TEST_MACOS_SURVEY_SANDBOX=1`; this opt-in variable was not supplied.
- 1 test in `src/engineering/survey-leica-gsi-real-source.test.ts`: requires `WORKWISE_TEST_GSI_SOURCE`.
- 1 test in `src/engineering/survey-leica-gsi-known-evidence.test.ts`: requires `WORKWISE_TEST_GSI_SOURCE`.

These skips are not recorded as successful real-instrument or sandbox acceptance. No source changes were necessary after this full validation.

## Log SHA-256

```text
71af7044773b54eeb42bc3d71be0ee11535db2c2467b84396f655c0d28cad6b1  runtime-tests.log
94237238a28e727e1459298d2a242a6f37658af0e574e26bffc4315208e93221  runtime-build.log
ab88ecae7431e42c873a6f9f73f86603bb96042ae5a0bd6236f92877aa8dfb1b  runtime-typecheck.log
```

No commit, push, public version edit, native rebuild, or original-worktree change was performed. This validation is not release approval or packaged UI acceptance.
