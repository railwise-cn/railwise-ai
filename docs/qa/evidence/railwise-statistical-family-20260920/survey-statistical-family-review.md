# Independent declared-statistical-family kernel review

The reviewed pure kernel evaluates caller-declared exact scalar statistics for normal/t two-sided and chi-square upper-tail references with a predeclared Bonferroni family. It does not authenticate model assumptions or predeclaration, propagate upstream statistic error, remove observations or grant engineering acceptance. The reviewer did not provide human professional signoff.

No unresolved blocker remained in the reviewed scope. A final packaging check found an extensionless contract import that Bun/Vitest could hide. The implementer changed it to `.js` and rebuilt; the independent reviewer then imported the compiled `kun/dist/engineering/survey-statistical-family.js` under Node 26.8.2 and evaluated the normal statistic 8 successfully (two-sided p=1.244192114854356e-15). This verifies the repaired ESM load for the new module, not full application integration.

## Independent reference and results

mpmath 1.3.0 computes tail references at 180 decimal digits and records 118 digits. Oracle input uses the exact supplied binary floating values. Normal references use erfc, Student references regularized incomplete beta, and chi-square references upper incomplete gamma; these are independent library algorithms, not copied TypeScript logic. Thirty-three analytical reference cases additionally check t(df=1) via 2 atan(1/|t|)/π, stable t(df=2) via 2/[sqrt(t²+2)(sqrt(t²+2)+|t|)], and chi-square(df=2) via exp(-x/2).

- 239 explicit tail cases plus 600 deterministic random cases: 705 calculated, 134 correctly refused because the true probability was below the declared 1e-300 floor. No zero probability was substituted. Maximum absolute log-probability error was 1.2462059719835392e-12; the initial floating relative-probability comparison was 1.2462253451417382e-12.
- 45 high-precision critical values across alpha/family-size extremes and representative degrees of freedom; 225 evaluations at predecessor/nearest/successor floats and separated sides. All three adjacent floats were boundary-unresolved; farther points were on their correct sides. Every true critical value was inside the reported software resolution interval; maximum scaled nominal critical discrepancy was 4.560759181427079e-13.
- A family mixing available, unavailable, undetectable and outside-domain members retains all four in the denominator. Missing members remain explicit unavailable entries in the 256-member threshold tests. No denominator is reduced because evaluation fails.
- Invalid alpha, noninteger degrees of freedom, post-observation declaration, negative chi-square and outside-domain magnitudes are separately probed.

The 2e-10 log comparison margin and returned intervals remain a software-resolution policy, not certified error bounds. Sampling the domain does not prove a global floating-error theorem. The explicit `statisticPrecision` contract restricts inputs to declared exact scalars; this module must not silently apply its comparisons to generalized-w estimates carrying unpropagated upstream uncertainty.

`requestSha256` hashes the schema-parsed request after sorting supplied statistics by member ID. It is not a hash of original submitted bytes. The declared family order and all members remain part of that normalized request.

## Replay and files

Use `survey-statistical-family-review-replay.sh CHECKOUT_ROOT`. It copies scripts to a fresh temporary output directory, generates the high-precision fixtures, invokes Bun against the requested checkout and audits the outputs. It prints the output directory. Python 3 with mpmath==1.3.0, Bun and normal checkout dependencies are required. Set `REVIEW_PYTHON` to an isolated Python interpreter if needed. No old temporary checkout path is required.

Scripts: `survey-statistical-family-review-oracle.py`, `survey-statistical-family-review-random-oracle.py`, `survey-statistical-family-review-critical-oracle.py`, `survey-statistical-family-review-probe.ts`, `survey-statistical-family-review-audit.py`. Fixtures: `survey-statistical-family-review-tail-cases.json` (239), `survey-statistical-family-review-random-cases.json` (600), `survey-statistical-family-review-critical-cases.json` (45). Outputs: `survey-statistical-family-review-probe-results.json`, `survey-statistical-family-review-summary.json`. `survey-statistical-family-review-source-hashes.json` identifies the reviewed snapshot. Archival filename prefixes are acceptable if script imports and fixture names are changed consistently and the archived replay is verified.

These probes do not cover Runtime persistence, renderer integration, packaged application behavior, field representativeness or human engineering approval.
