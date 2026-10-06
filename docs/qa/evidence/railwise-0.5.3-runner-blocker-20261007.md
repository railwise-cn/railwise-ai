# RailWise Survey 0.5.3 runner blocker

Date: 2026-10-07. This is an operational evidence record, not a release approval.

## Candidate identity

- Branch: `codex/railwise-053-remediation`
- Source head: `ee224b69397910ff94e10dc8aa5f93637a40006c`
- Candidate version: `0.5.3`
- Public tag, GitHub Release, Stable/Frontier feed, and official download page: unchanged

## Runner results

The private macOS arm64 updater workflow was run against the candidate branch several times while diagnosing the external signing gate:

| Run | Result | Evidence |
| --- | --- | --- |
| `37538074989` | cancelled after approximately 27 minutes | Developer ID identity verified; secure timestamp scan reached the signing stage, then the operation was cancelled while the runner still waited for Apple tooling; no target package or updater report |
| `37541197543` | cancelled after approximately 35 minutes | secure timestamp scan reached `186/186`; the runner was still waiting for the Apple notarization response |
| `37543633941` | cancelled after approximately 35 minutes | secure timestamp scan reached `186/186`; no target package or updater report |
| `37545228293` | cancelled after approximately 35 minutes | secure timestamp scan reached `186/186`; no target package or updater report |
| `37546773334` | failed | secure timestamp scan passed `186/186`; `notarytool submit --wait` timed out after 300000 ms |

All runs passed the repository checks before notarization: dependency installation, private transport isolation, Electron TLS pinning preflight, audited document sidecar, candidate source identity, and Developer ID signing initialization. The failed run produced only the TLS preflight artifact; it did not produce `private-updater.json`, `native-updater.json`, or `private-updater-target-arm64-*`.

## Release decision

The candidate is not release-ready. The missing notarization and native updater round-trip evidence cannot be replaced with the local ad-hoc package, a mocked updater, or the older successful run from a different source head. No `docs/qa/release-gates/v0.5.3.json` manifest, `v0.5.3` tag, public release, Stable feed update, or website update has been created.

The source changes that made the gate diagnosable remain in [`scripts/mac-notarize.cjs`](../../../scripts/mac-notarize.cjs): each signed candidate is logged, per-command signature inspection is bounded, and the Apple notarization wait has a bounded timeout. A future attempt should rerun the private workflow from this exact head after Apple notarization service credentials/network are healthy, then install and inspect the resulting target package before any public release operation.

