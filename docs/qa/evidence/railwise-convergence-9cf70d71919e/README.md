# 9cf70d7 Private Completion-Guard Baseline

**This is a private Runtime and historical-state test baseline, not the final acceptance candidate.** It verifies the signed-package completion guard and the display of an existing false-completed record. It does not include the subsequent explicit Resume UI or resume-failure recovery fixes. No public release, feed promotion, official download change, user acceptance, or real-project migration is established here.

Source: `9cf70d71919e997e815a9e55ec4264e01572979c`. Package: `0.5.0`. Bundle: `com.wangjiawei508.workwise.candidate.head9cf70d71919e`.

## Package and Updater

- [Private updater run 35496645847](https://github.com/wangjiawei508/WorkWise/actions/runs/35496645847) succeeded. The actual isolated `0.0.0 -> 0.5.0` HTTPS/Squirrel update preserved its synthetic user-data sentinel. The baseline uses the same source and does not represent migration from a historical public application.
- Signature and stapled notarization were verified in the cloud and locally. Cloud Gatekeeper was **assessments enabled**. Local `spctl --assess` returned zero, but local Gatekeeper status was **assessments disabled**; these are different claims.
- Evidence artifact `10600716979` was fully hashed against GitHub metadata. Application ZIP from target artifact `10600891727` was downloaded by HTTP ranges and fully hashed against the authenticated updater evidence. The outer target artifact was **not fully downloaded or rehashed**.
- Installed ASAR equals the cloud updater target. Embedded source provenance, version, bundle identifier and loopback-only updater metadata were checked. The candidate environment disables credential access and IM inbound/outbound, with updater provider `none`.
- The first local Python download attempt failed because its default certificate store lacked an issuer. The retry used system `/etc/ssl/cert.pem`, retaining TLS verification, and succeeded.

| Item | SHA-256 |
| --- | --- |
| Application ZIP | `6b18db96a217df357d96c38abe5a62b3df9dac2a18c55166616effe63b8e75ee` |
| Installed ASAR | `a42089f63f154c294243cc020e7ead866a5c73a69da0c74c336a3e2448f9642d` |
| Complete evidence artifact | `41a3ad39ef86b8db3ddf218b5bb8ad5c98908d7262f9139c5a1b644b5202b042` |

`package-summary.json`, `private-updater-summary.json`, `artifact-download-summary.json` and `installation-context.json` retain details and provenance. The private feed URL is removed. The updater's isolated test-channel label is not public frontier promotion. Large binaries and raw user configuration are excluded.

## Packaged Negative Probe

The exact signed application's Electron executable ran `verify-packaged-text-only.cjs` with `ELECTRON_RUN_AS_NODE=1` and expectation `reject`. This did not launch the GUI. Signature, ASAR, embedded source and version were verified before importing packaged Runtime modules.

The isolated synthetic model persisted seven fabricated completion replies. There were zero unexpected HTTP requests, zero tool calls, four null step receipts and zero adjustments. The TaskRun became `stalled`, the turn became `failed`, and the reason was specifically `engineering_plan_steps_incomplete`. Runtime execution evidence remained `complete: false`; finalResponse was null. Exit zero means the missing-receipt guard passed, not that a survey deliverable was produced. No real external model was used.

The original JSON and raw log are retained as `packaged-text-only-completion-probe-wCtOnp.json` and `packaged-text-only-completion-probe.log`. They are byte-identical with SHA-256 `1dfa903cbc8396db8028e0cdcc31170f10bd4daed17e6c6f81c6c64b9a789e2f`.

## Historical UI and Preservation

The parent operator copied only synthetic records from the earlier signed 9974 package's defect reproduction. `legacy-completion-copy.json` records the exact source files and copy-time hashes. This is distinct from the same-source updater sentinel check.

The native Chinese/light GUI displayed the old plan as **needs attention** and showed missing execution receipts with **0/4** verified steps. `gui/01-legacy-needs-attention.png` and its AX text show the plan state; `gui/02-legacy-zero-receipts.png` shows the zero-step footer. No regeneration button was clicked and no prompt was sent. The default workspace was restored to the isolated candidate default, recorded by `gui/03-default-restored.txt`. The operator reported normal app exit with no remaining candidate process before the independent audit.

`audit-legacy-preservation.mjs` opened closed databases with `mode=ro&immutable=1`. `legacy-preservation-audit.json` proves:

- All 15 original source files still match their copy-time SHA-256 values.
- All 14 copied candidate files remain byte-identical, including thread, messages and event history.
- All rows in 46 tables across nine copied SQLite databases are unchanged, including plans, approvals, project, network/source ledger, tasks, receipts and adjustments.
- The raw plan remains `started`, the old TaskRun and turn remain `completed`, and receipt/adjustment counts remain zero. The safer UI state is a derived projection, not a rewrite or automatic rerun.
- Before/after hashes prove the audit changed neither input tree and created no WAL/SHM files.

These screenshots cover this narrow historical-state behavior at one Chinese/light window size. They are not comprehensive theme/size acceptance or evidence for the later Resume UI.

## Quality and Archive Integrity

[Quality run 35496644961](https://github.com/wangjiawei508/WorkWise/actions/runs/35496644961) succeeded for the exact source. Desktop: 2,786 passed / 6 skipped. Runtime: 2,807 passed / 22 skipped. Windows: core security 128 passed, plugin security 104 passed, persistence subset 58 passed / 2 skipped.

`CloudQuality.log` preserves the original 1,491,887 bytes and whitespace. SHA-256: `b64ac2c2a039eec510ec05fb739c3bd354df0b764aef6331641a3e2dddcfc566`. Expected synthetic failures and skipped tests remain in the raw log. `CloudQuality-summary.json` identifies its explicit-repository download provenance.

`archive-manifest.json` records hashes for every copied original artifact. Text was scanned before copying for GitHub/API tokens, private keys, credential URLs and unmasked authorization strings; no high-confidence credential matches were found. Both screenshots were visually checked for exposed credentials. `archive-evidence.mjs` documents the collection procedure and intentionally refuses overwriting existing archive files.
