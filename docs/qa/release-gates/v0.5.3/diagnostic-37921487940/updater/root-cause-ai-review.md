# Read-only updater failure review — run 37939882485

This is an AI root-cause review of failed acceptance evidence, not a successful updater report or release approval. No source, UI, user data, workflow dispatch, retry, or cancellation was performed by this investigation.

## Exact run and package

- Repository: railwise-cn/railwise-ai
- Workflow: .github/workflows/frozen-release-updater-acceptance.yml
- Run / attempt: 37939882485 / 1
- Job: 113851263330, Official 0.5.2 to exact frozen 0.5.3 native updater
- Frozen release: 37921487940 / 1
- Source: 6bcfe0db516eafbecfed546e7077088975cda804
- Target: RailWise AI 0.5.3, macOS arm64
- Target ZIP SHA256: f55b48b1eb9a90f30643191b2c24ef571b605e88e859e66e3432daa3e9e69e19
- Target ASAR SHA256: 2134c273af4b7e86e6f0243b0178fd1ffedeb120f260bca7094b5726b7474af7
- Run result: failure; machine report status: failed

## Original evidence preserved

Raw GitHub run/job JSON, run-log ZIP, extracted exact job and first-failing-step log bytes, and artifact metadata are retained in this directory. Direct job logs API request failed; the exact job log was extracted without modification from the original run-log ZIP, with member names and hashes in raw-api-receipt.json. Immutable failure artifact 11620971963 (frozen-updater-arm64-37939882485) was downloaded by the verified exact-ID helper. Full ZIP digest: sha256:63c516ce2f66ae135809ba36f3c90db3091ed16be5e57a7e100f80c1d36c5d79; archive size: 7174 bytes. The helper receipt is .artifact-11620971963-6usd4p7e/download-receipt.json.

The artifact contains only four original files, preserved byte for byte under retained-original-reports:

- frozen-updater.json, SHA256 a7b84acf976a9aaed85c6da99a45fabf6eac61dc1f2f7ed217a1ed3bdc506fdb
- seed-data.json, SHA256 5b765a2529066c207fa10d31c13a292b1360701bb27f1dc1099f692568fd9411
- target-services.json, SHA256 b2e11d64f6d92b10185017b16fba492d369c4e1ca0a47c5bd7d539d7f2ccfaa1
- cloudflared.redacted.log, SHA256 f2ca02327fcf49bc2b1537182692668cc21c696aacf716b061a3fa9fac934c02

No native-updater.json, harness log, verify-data.json, or verify-restart-data.json exists in the original artifact. Their absence is an actual execution boundary, not missing evidence to be invented. Machine error: `fetch failed Evidence retention: Required native updater report is missing.`.

## First actual failure and execution boundary

GitHub step 9, Run default-trust HTTPS download, Squirrel install and historical data readback, ran from 2026-10-09T13:52:36Z to 2026-10-09T13:54:30Z and failed. The signed/notarized official 0.5.2 baseline, frozen 0.5.3 target, exact target services, and synthetic data seed all completed before the failure. The original seed report says source-bound-compatibility-service with frozen source 6bcfe0db516eafbecfed546e7077088975cda804, baseline Electron 0.5.2 and packaged SQLite ABI; this closes the former referenceDeclaration seed error for this run but does not certify arbitrary 0.5.2 schema migration.

The tunnel log shows:

- 13:54:23Z: Requesting new quick Tunnel.
- 13:54:27Z: URL created; log explicitly says “it may take some time to be reachable”.
- 13:54:27Z: Initial protocol QUIC and local proxy setup.
- No “Registered tunnel connection” or successful HTTPS request is recorded before failure.
- Machine failure timestamp: 13:54:27.160Z.

The actual failed expression is the first fetch of the frozen manifest in scripts/run-frozen-release-updater-acceptance.mjs:367. Source line 187 returns from startTunnel as soon as any one URL is found, without waiting for an established tunnel connection or a successful request; lines 364–367 then immediately fetch the capability URL. The native updater harness is only created at line 370, after this check, and was never reached. Therefore Squirrel installation, target relaunch, and historical target/restart readbacks remain not executed in this run.

The “Required native updater report is missing” suffix is secondary evidence retention at line 395; it follows naturally because the harness was not started. “owned-resource-cleanup: failed” at line 415 reflects the overall failed report status; there is no `Cleanup:` exception appended, so it is not evidence of a separately failing cleanup operation.

## Classification and uncertainty

Classify as acceptance harness readiness handling exposed by temporary external HTTPS endpoint non-readiness, before product updater execution. It is not evidence of an installed 0.5.3 product defect. Existing raw evidence does not reveal the low-level Node fetch cause because the catch retains only error.message at line 392; DNS propagation, QUIC connection setup, or another early temporary transport failure cannot be distinguished. A permanent external service outage is not proven, nor is automatic success on a subsequent run.

## Least corrective change if the harness is repaired

Retain URL validation, default CA TLS, isolated capability feed, immutable target bytes, and manifest digest check. Replace the one-shot readiness fetch at lines 367–368 with a bounded readiness loop that waits for an established tunnel and verifies successful HTTPS retrieval of the exact frozen manifest before launching the native harness. Retry only explicitly transient connection/DNS/setup failures and temporary gateway responses; terminal URL, TLS, asset identity, or digest failures must continue to fail. Record sanitized attempt count and low-level error code/category without retaining the tunnel URL or capability. Add a focused readiness regression using a delayed-ready endpoint; do not substitute it for real native updater acceptance.

A code change is confined to the test harness on current evidence. Under the exact-source freeze requirement, changing the harness/source requires normal PR and strict CI, then a fresh freeze and real acceptance. Without changes, a rerun might happen to pass once the tunnel becomes reachable, but the race remains. No rerun or repair was executed in this task.
