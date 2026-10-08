# Isolated native updater acceptance — workflow 37316902321

This directory records the isolated Frontier-feed updater acceptance for RailWise AI 0.5.2 using the immutable public 0.5.1 installers as the baseline.

- Workflow: https://github.com/railwise-cn/railwise-ai/actions/runs/37316902321
- Result: `completed / success`
- Target version: 0.5.2
- Baseline version: 0.5.1
- Feed: isolated Frontier feed for this run; cleanup completed successfully after acceptance
- Acceptance gate job: `All native updater paths passed` — success
- Cleanup job: `Remove isolated updater feed` — success
- Feed metadata evidence: `feed/`
- Native updater evidence: `native-update/`
- Job logs: `acceptance-gate.log`, `cleanup.log`

## Native round-trip results

Each matrix path installed the pinned 0.5.1 package, detected 0.5.2 on the isolated feed, downloaded and installed the update, relaunched into 0.5.2, and confirmed user data preservation.

| Path | Evidence | Result |
| --- | --- | --- |
| macOS Apple Silicon | `native-update/macos-arm64/darwin-arm64.json` | passed |
| macOS Intel | `native-update/macos-intel/darwin-x64.json` | passed |
| Windows x64 | `native-update/windows-x64/win32-x64.json` | passed |

The acceptance gate also verified the production-safe metadata cache policy (ETag, Last-Modified, Range support) for the isolated feed before cleanup.

`run-summary.json` preserves the complete GitHub job status snapshot. All package builds, feed publication, three native update paths, acceptance gate, and cleanup jobs finished successfully.

After the cleanup job, direct HTTPS checks for the three isolated metadata paths returned HTTP 404 (`latest.json`, `latest-mac.yml`, and `latest.yml`), confirming that this acceptance feed was removed and did not remain publicly discoverable.
