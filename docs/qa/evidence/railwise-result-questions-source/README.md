# Exact Result Questions Source Evidence

Date: 2026-09-21. Worktree: `/private/tmp/railwise-survey-result-questions`. Base: `b193fc70d6363dc768e715087ca9c0d9975158c9`; branch: `codex/survey-result-questions`. Logs concern the uncommitted source increment, not a released or installed package.

The copied files are raw desktop and Runtime validation logs, desktop command/exit metadata, and the Runtime validation summary. The first desktop failure is retained: the external dependency symlink caused Vite to deny the PDF worker URL. The full rerun only added the worktree and shared dependency directory to Vite `server.fs.allow`; it excluded no tests and introduced no mocks.

No secret, provider configuration, database, field data, temporary test configuration or runner script is included. Local code/dependency paths and synthetic test names remain in the raw logs for reproducibility. `SHA256SUMS` identifies the included logs and command metadata.

`source-files-sha256.json` additionally identifies the 44 changed/new TypeScript source and test files at collection time. Its changed-source-set digest is `4750545d2e202ce726a85f971afc4a2d7c3349eb0999eabc4960f05fc180c399`; this is explicitly not a complete dependency or package fingerprint.

Results: Runtime 2929 passed / 22 skipped; desktop rerun 2850 passed / 2 skipped. Both Runtime and desktop typechecks/builds passed. ESLint passed with zero errors and one existing warning in `Workbench.tsx:1406`. Optional skips, first failure, build command substitution and remaining acceptance limits are described in [the acceptance record](../../RAILWISE_EXACT_RESULT_QUESTIONS_ACCEPTANCE.md).
