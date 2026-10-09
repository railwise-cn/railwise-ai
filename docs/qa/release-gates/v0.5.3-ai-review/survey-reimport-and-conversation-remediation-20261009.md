# Survey conversation and GSI reimport remediation

Date: 2026-10-09. This is an AI investigation and source regression report. It
does not certify vendor interoperability, professional signoff, or final package
acceptance. The diagnostic package remains blocked from publication.

## Diagnostic package and observed failures

- Installed version: 0.5.3, `/Applications/RailWise AI.app`.
- Candidate workflow run: `37868923516`, attempt 1.
- Frozen source: `68ab3cb39c76f44f22f0c22f3504ac82c232d023`.
- Artifact SHA-256: `36df77e9226205fa4cfdcd629b5a8a709eeeb58ed78577bfc397c762cef16222`.
- Installed ASAR SHA-256: `01f74eb38998a1978821bd82680e1b1a9cc9fe8d8accc83a807029f839171057`.
- The parent agent operated computer use. This investigator did not operate the
  installed UI, modify business databases, or read credentials.

The parent is archiving the diagnostic screenshot and accessibility evidence in
`docs/qa/release-gates/v0.5.3/diagnostic-37868923516/`. The entries below identify
the observed original package, not a package rebuilt with these fixes.

| Evidence | Observed behavior |
| --- | --- |
| `001-new-task-preparing.png` / `.ax.txt` | Creating the first Survey task left the AI drawer preparing its conversation with Send disabled. |
| `003-second-task-preparing.png` / `.ax.txt` | A second new Survey task reproduced the same failure. |
| `002-explicit-continue-restored.png` / `.ax.txt` | Explicitly reopening the conversation restored the composer. |
| `004-gsi-missing-bm-blocked.png` / `.ax.txt` | The initial GSI import retained the supplied height datum, but the reference input boxes had become empty. The missing benchmark was legitimately blocked. |
| `005-gsi-reimport-lost-datum.png` / `.ax.txt` | Entering `BM,100.000` and selecting the identical GSI file created a new network with an unconfirmed height datum. |
| `006-gsi-datum-repair.png` / `.ax.txt` | Explicit reference repair focused Height datum; filling it and reimporting the retained source restored readiness. The subsequent diagnostic computation returned P1 = 100.5998 m, 0.4 mm closure and 0.2 mm posterior error. This recovery does not prove the original reimport defect fixed. |

## Conversation root cause and fix

`refreshThreads` read the active conversation and prepared a remote listing,
then awaited Write workspace settings before applying that listing. During the
await, a newly created Survey conversation could become active. The old listing
did not contain it, so the resumed refresh cleared the new selection and aborted
its event subscription. A subsequent listing could recover the sidebar item but
did not restore the selection.

The settings await now precedes reading the active selection and constructing
the preserved listing. There is no asynchronous suspension between those steps
and applying the selection. The existing filtering and workspace mapping remain
covered by regression tests.

The regression uses the actual navigation and thread-creation actions, a deferred
settings read and provider boundary stubs. It covers both first and later Survey
tasks, checks the immediate state after the stale refresh and a later ordinary
refresh, and verifies that the active subscription survives. The original code
failed with activeThreadId `null`; the fixed code passes. Separate cases retain
internal code-thread filtering and canonical Write workspace mapping.

## Reference root cause and fix

The Panel synchronized its local coordinate and height inputs together whenever
the project revision changed. Source declarations belong to the imported network;
import did not copy them into project defaults. A routine project refresh thus
replaced the local declarations with the still-empty project defaults. Manual
reimport sent the now-empty fields and lost the user's explicit height datum.

Read-only inspection of the acceptance database confirmed that the relevant
project was at revision 2 with no coordinate or height defaults, its first network
contained `SYNTHETIC-LOCAL-GRID` / `SYNTHETIC-BENCHMARK`, and its second network
contained unconfirmed references. The Panel key uses workspace and project ID,
so this was an effect reset, not a remount.

The two reference synchronization effects now follow their respective project
declaration and task scope. An unrelated revision preserves the draft; a genuine
coordinate-default change updates only that field, and a height-default change
updates only height. A project or workspace change resets both to the new task's
defaults. Manually changing the datum still applies to a new import, and earlier
network records remain unchanged. No reference is inferred or synthesized, and
the calculation gate for undeclared network references is retained.

Five new DOM regression cases cover the original import -> project revision
refresh -> add benchmark -> same-source reimport sequence, individual default
changes, separate project/workspace changes and an explicit new datum. Before
the fix, the original sequence failed because both inputs were empty; a coordinate
default change also wrongly erased the height draft. After the fix, both cases
and scope/new-datum cases pass.

## Verification

- Conversation actions, thread actions, sidebar visibility and Write registry:
  4 files, 33 tests passed.
- Survey Panel, reference DOM and import identity regressions: 4 files,
  98 tests passed.
- `npm run typecheck`: passed.
- ESLint on all four changed source/test files: passed.
- `git diff --check`: passed.
- Complete renderer suite: 357 files passed, 2 skipped; 3249 tests passed,
  2 skipped. The first run hit 3 unrelated PDF preview failures because Vite
  rejected a worker URL from the shared dependency symlink. A temporary test
  config allowed only the isolated worktree and its shared dependency directory;
  rerunning the unchanged complete suite passed. This environment override was
  not added to repository configuration. Logs are retained privately at
  `/private/tmp/railwise-survey-blocker-regressions-20261009.log` and
  `/private/tmp/railwise-survey-blocker-regressions-20261009-permitted.log`.

| File | SHA-256 of reviewed implementation |
| --- | --- |
| `src/renderer/src/store/chat-store-navigation-actions.ts` | `ec03fa477d8e18900ead909598be18691426f128dc0db95da2ab086283f712e6` |
| `src/renderer/src/store/chat-store-navigation-actions.test.ts` | `5c6d581315327f6ab00902be912a76ba4c5c1cdc56426913e15834457e0303b3` |
| `src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx` | `c98b1314cacecaf1f2bb6462fe86ab4d8b2b976a3367480820b10024508340ff` |
| `src/renderer/src/components/engineering/SurveyAdjustmentPanel.reference-dom.test.ts` | `f7b38cfe931f05ab7065644ac727654342c68125355368e77d7214d3b6ead623` |

## Remaining gate

The source fixes require independent review and required PR CI. After merging,
the final package must be frozen again from the new source and inspected by
computer use. Reproduce both new-task sequences and the GSI benchmark-repair
reimport without manually restoring erased references, then complete the broader
language/theme/window, AI professional-response, export/read-back, native updater
and original-profile restoration acceptance. Existing diagnostic screenshots and
successful unit tests do not authorize publication.
