# RailWise Survey 0.5.3 runner blocker

Date: 2026-10-07. This is an operational evidence record, not a release approval.

## Candidate identity

- Branch: `codex/railwise-053-remediation`
- Source head: `ee224b69397910ff94e10dc8aa5f93637a40006c`
- Candidate version: `0.5.3`
- Public tag, GitHub Release, Stable/Frontier feed, and official download page: unchanged

## Runner results

The private macOS arm64 updater workflow was run against the candidate branch several times while diagnosing the external signing gate:

| Run | Result | API run interval (UTC) | Evidence |
| --- | --- | --- | --- |
| `37538074989` | cancelled | 2026-10-06 22:03:09–22:30:51 (27m42s) | Developer ID identity verified; no target package or updater report |
| `37541197543` | cancelled | 2026-10-06 22:32:11–22:51:28 (19m17s) | secure timestamp scan reached `186/186`; no completed notarization result |
| `37543633941` | cancelled | 2026-10-06 22:55:53–23:10:08 (14m15s) | secure timestamp scan reached `186/186`; no target package or updater report |
| `37545228293` | cancelled | 2026-10-06 23:12:15–23:26:37 (14m22s) | secure timestamp scan reached `186/186`; no target package or updater report |
| `37546773334` | failed | 2026-10-06 23:28:40–23:39:52 (11m12s) | secure timestamp scan passed `186/186`; `notarytool submit --wait` timed out after 300000 ms |

Intervals above are total workflow elapsed times from GitHub API `created_at`/`updated_at`, including setup and cleanup; they are not Apple processing times. Earlier 35-minute descriptions were inaccurate. The final failure establishes only that the combined upload/wait command did not return within five minutes. Upload, network, credentials and Apple processing remain unresolved because no submission ID was retained; it does not establish an Apple service outage.

All runs passed the repository checks before notarization: dependency installation, private transport isolation, Electron TLS pinning preflight, audited document sidecar, candidate source identity, and Developer ID signing initialization. The failed run produced only the TLS preflight artifact; it did not produce `private-updater.json`, `native-updater.json`, or `private-updater-target-arm64-*`.

## Release decision

The candidate is not release-ready. The missing notarization and native updater round-trip evidence cannot be replaced with the local ad-hoc package, a mocked updater, or the older successful run from a different source head. No `docs/qa/release-gates/v0.5.3.json` manifest, `v0.5.3` tag, public release, Stable feed update, or website update has been created.

The bounded command diagnostics are in [`scripts/mac-notarize.cjs`](../../../scripts/mac-notarize.cjs). The next investigation separates upload from processing, preserves the submission ID and status history, and retains failure diagnostics as private workflow artifacts. Only a successful signed/notarized target, real updater round-trip and complete inspection of that target can close the release gate.
