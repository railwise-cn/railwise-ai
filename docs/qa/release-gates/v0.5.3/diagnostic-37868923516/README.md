# Failed 0.5.3 freeze diagnostic archive

This directory preserves failed and incomplete acceptance evidence for the
installed **0.5.3** candidate from source
`68ab3cb39c76f44f22f0c22f3504ac82c232d023`, release workflow run
[`37868923516`](https://github.com/railwise-cn/railwise-ai/actions/runs/37868923516),
attempt 1. It is **not a passing package acceptance report, a published release,
or permission to publish**. All observed results belong only to those old frozen
bytes. The same version number on a later package does not transfer these results.

The parent agent operated the installed application using computer use. A
separate AI investigator reviewed the captured evidence and root causes. These
are AI/software acceptance observations, not vendor/SUC interoperability proof,
a licensed professional signature, or real human approval.

## Package identity and archive integrity

- Installed diagnostic application: `/Applications/RailWise AI.app`.
- Bundle identifier: `com.wangjiawei508.workgpt`.
- arm64 DMG SHA-256:
  `36df77e9226205fa4cfdcd629b5a8a709eeeb58ed78577bfc397c762cef16222`.
- Installed ASAR SHA-256:
  `01f74eb38998a1978821bd82680e1b1a9cc9fe8d8accc83a807029f839171057`.
- The original [package/preflight summary](preflight-package-and-defects.json)
  was captured early in the diagnostic run. Its `not-executed` fields describe
  that capture time. Subsequent partial computer-use observations and the failed
  updater report below are preserved separately; the summary was not rewritten.
- [Native window observation](000-native-window.json) records an observed
  1280 × 840 logical window. Original screenshots are 2560 × 1680 pixels.
  This is not coverage for 1280 × 800, 1440 × 900 or narrow windows.
- The eight original screenshot names retain their `.png` extension, but the
  captured bytes are JPEG-encoded. Image decoding and dimensions were checked
  using the actual media format; neither the bytes nor the names were changed.
- Screenshots, AX text, package metadata and updater originals retain their
  source bytes. [SHA256SUMS.txt](SHA256SUMS.txt) and
  [inventory.json](inventory.json) bind every archived file except the inventory
  files themselves. No screenshot was resized, redacted or relabeled.
- Original AX records contain trailing spaces in list markers and separators.
  They are preserved deliberately: whitespace warnings in those original files
  are not corrected by changing captured evidence. Authored Markdown/JSON and
  archive metadata are checked separately for whitespace errors.
- Only this explicit diagnostic allow-list was copied. Profile snapshots,
  settings, credentials, account configuration, real user projects and the
  personal system Login Items list are excluded. Host paths in original reports
  are retained where needed to identify the package and failing service import.

## Observed product sequence

Each numbered capture links to the original screenshot and full accessibility
text. All captures use English and dark theme; an English UI may contain
macOS-provided Chinese accessibility metadata.

| Capture | Evidence and interpretation |
| --- | --- |
| 000 | [PNG](000-empty-en-dark.png) / [AX](000-empty-en-dark.ax.txt): empty Survey task view. This is a diagnostic starting state, not a completed visual matrix. |
| 001 | [PNG](001-new-task-preparing.png) / [AX](001-new-task-preparing.ax.txt): the first new task stayed in conversation preparation and Send remained disabled. |
| 002 | [PNG](002-explicit-continue-restored.png) / [AX](002-explicit-continue-restored.ax.txt): explicitly reopening the conversation restored the composer; Escape closed the drawer and focus returned to its trigger. This recovery did not repair the new-task race. |
| 003 | [PNG](003-second-task-preparing.png) / [AX](003-second-task-preparing.ax.txt): a second new task reproduced conversation preparation failure. |
| 004 | [PNG](004-gsi-missing-bm-blocked.png) / [AX](004-gsi-missing-bm-blocked.ax.txt): the source network retained the declared synthetic height datum. Reference draft fields were already empty. Missing benchmark/topology conditions legitimately blocked calculation. |
| 005 | [PNG](005-gsi-reimport-lost-datum.png) / [AX](005-gsi-reimport-lost-datum.ax.txt): after entering `BM,100.000` and reselecting the same original GSI file, the new network lost its height declaration and correctly blocked calculation. |
| 006 | [PNG](006-gsi-datum-repair.png) / [AX](006-gsi-datum-repair.ax.txt): explicit reference repair focused Height datum, accepted the synthetic declaration and restored readiness. This capture precedes the actual calculation; subsequent diagnostic results are visible in 007. It does not prove the original reimport defect fixed. |
| 007 | [PNG](007-gsi-ai-no-live-response.png) / [AX](007-gsi-ai-no-live-response.ax.txt): the application contains a **complete live AI answer** and numerical results about P1. The capture label `no-live-response` is retained for original-file identity and is **not an observed lack of response**. The answer has professional semantic and wording defects described below. |

The synthetic leveling calculation yielded P1 = 100.5998 m, a 0.4 mm observed
loop closure and a 0.2 mm posterior point error. The record had four observations,
three unknowns and one degree of freedom. Those descriptive synthetic results
do not certify a tolerance pass, standards conformity or field accuracy.

## AI answer findings and source repairs

The [independent AI professional-answer audit](professional-answer-audit-20261009.txt)
records two substantive boundaries:

1. Point role `unknown` means a point to be determined, not an unclassified
   observation. The displayed answer incorrectly treated P1 as unclassified and
   contained repeated cleanup text such as “Observation Observation role” and
   “other other findings”.
2. Relative route-length weighting lacks absolute prior precision for the default
   sigma-like screen. It does not categorically prohibit every posterior
   diagnostic. The separate deleted-observation t diagnostic has deterministic
   assumptions and redundancy gates; with one degree of freedom it is unavailable
   in this sample.

The original answer and audit remain unchanged. The audit is retained as a raw
`.txt` log so historical internal component names do not become authored product
copy; its private source record and exact digest are bound in the inventory.
Source remediation is tracked
separately, and no CI result or repaired-source test closes this old package's
acceptance. The conversation and reimport investigation is documented in the
[remediation report](../../v0.5.3-ai-review/survey-reimport-and-conversation-remediation-20261009.md).

## Immutable native updater failure

The real updater acceptance run
[`37882814359`](https://github.com/railwise-cn/railwise-ai/actions/runs/37882814359),
attempt 1, failed for the same frozen source. The original machine report says
that the target application exited with `Cannot find module` while the data
helper attempted to import an absent source-tree engineering service. The
required native updater report is missing; no successful update round trip or
data preservation acceptance can be inferred.

- Original GitHub artifact ID: `11594984034`.
- Artifact name: `frozen-updater-arm64-37882814359`.
- Size: 2561 bytes.
- API digest and retained [ZIP](updater/failure-evidence.zip) SHA-256:
  `79b0982d89a7a501e9f163633b3f999fa5054a19fbc557c0856ca3e1130a2ed8`.
- [Original machine report](updater/retained-original-reports/frozen-updater.json)
  SHA-256: `2f2805aef2d8f2df42e9857f6e8774c4e4b305979f572c67809a8f4bbc529b57`.
  The ZIP contains only this report, byte-identical to the extracted file.
- [Original artifact API response](updater/artifacts.raw.json),
  [download selection](updater/download-selection.json) and
  [bounded failure summary](updater/failed-bounded-summary.json) preserve the run,
  source and digest association. The machine report records no production,
  trust-policy, official-feed or public-release change.

## Bounded restoration result

The normal-profile guard journal was read only to confirm `restored`, original
verification at 04:50:17 UTC and final verification at 04:54:21 UTC on 2026-10-09.
The [bounded restoration record](normal-profile-restoration-bounded.json) archives
only these results. Root computer-use captures, read back independently for the
RailWise scope, showed no RailWise entry under Open at Login before or after, and
RailWise background activity **on** before and after. The complete personal app
list and profile journal remain private.

The [original local package restoration report](local-original-app-restore.json)
records that the official 0.5.2 package was restored to `/Applications` after
strict signature verification, with ASAR
`94a815ad4eb084b652a066838b2ade64ea5959059dd7c32c650c6a8e63ec3030`.
The blocked 0.5.3 package remains preserved privately; the restored original
package was not launched during this restoration. These are restoration
observations, not acceptance or release approval.

## New freeze and unresolved gates

The scope of this archive ends at the old source/run/package identity above.
There is no new passing package in this directory. After protected-main repairs,
freeze a new candidate and record its exact source, run/attempt, artifact IDs,
digests, installed package and ASAR. Any new failure needs a separate archive;
never overwrite this evidence or reuse an old “pass”.

Required checks for the new frozen bytes remain: first and later task creation;
same-source GSI benchmark repair without erasing the reference draft; professional
AI answer semantics; four work views and the complete language/theme/window and
accessibility matrix; source import and blocker recovery; exported deliverable
read-back; real native updater round trip; and normal-profile restoration.
Successful source tests and recovery actions in this archive do not replace those
checks or authorize public release, feed promotion or website publication.
