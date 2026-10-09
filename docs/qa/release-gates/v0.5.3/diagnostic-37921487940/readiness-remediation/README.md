# Updater readiness remediation evidence

This private directory records source regression and one temporary external transport smoke. It is not native updater, installed-package, UI, historical-migration or release acceptance. No GitHub workflow dispatch, public feed edit, persistent upload, application launch or normal user profile operation was performed by this driver.

## Source checks and independent review

- Frozen base/source before remediation: 6bcfe0db516eafbecfed546e7077088975cda804.
- Reviewed source copies, SHA256 pins and exact diff: source-review-receipt.json and source-diff.patch.
- Focused updater boundary tests: 36 passed, 0 failed.
- Release-related artifact/provenance/gate tests: 431 passed, 0 failed.
- Release delivery regression: 21 passed.
- Focused ESLint and git diff --check: passed with empty output.
- Original result bytes and hashes: checks-receipt.json plus the five raw logs.
- Independent AI source review: independent-source-review.md; no remaining actionable defects. This is source review, not external professional signoff or package acceptance.

## Single transport-only smoke: FAILED and retained

The official cloudflared 2026.10.0 arm64 archive was downloaded once over default TLS from the official GitHub release and verified against the source-pinned size 19809074 and SHA256 a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70. No unknown binary or privilege change was introduced. The binary used an explicit private empty configuration and private unused origin-certificate path; inherited authentication variables were removed.

Inputs were the already-downloaded frozen release run 37921487940 / attempt 1, source 6bcfe0db516eafbecfed546e7077088975cda804, arm64 ZIP and latest-mac.yml. Both inputs were size/SHA256 checked against reviewed-build-combined.json before starting the temporary capability feed. The exact current reviewed connection/readiness helpers were used, with default CA TLS, manual/no-follow redirects and exact manifest size/hash binding. The driver started one owned account-less Cloudflare Quick Tunnel and a local temporary feed; it never started Electron or native updater.

- Tunnel connected after 7532 ms (poll 16).
- The Mac's direct default-TLS Node manifest probes returned DNS ENOTFOUND on every attempt.
- The helper stopped at its explicit 60-attempt cap after 60703 ms of manifest readiness, within its 120-second global maximum.
- Total smoke elapsed 68636 ms; final status transport-only-failed, failure Frozen updater readiness failed (manifest-deadline).
- Owned tunnel process 9103 stopped; temporary feed closed. Original temporary URL-bearing working log was replaced with the source redaction function's retained log and removed. No temporary endpoint/capability remains in the retained report/events/log.
- No additional smoke or retry was launched. Failure is retained. The test demonstrates a real connected tunnel and bounded classified DNS failure on this host; it does not prove external HTTPS manifest retrieval or native updater completion. No passing result is substituted.

Original machine report: transport-smoke/transport-only.report.json. Event log and redacted tunnel log are alongside it. The pinned binary/archive receipt is transport-smoke/pinned-binary-receipt.json. The live transport limitation is this Mac's DNS resolution for the temporary endpoint; it does not establish the GitHub-hosted runner's DNS behavior. A fresh real hosted updater run remains required after normal source integration and freeze.
