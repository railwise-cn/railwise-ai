# Survey confirmation IPC failure — AI diagnostic

The installed 0.5.3 package from freeze run `38000521987` cannot confirm Survey review-file export. After a normal single click on **Confirm and export**, the UI displays **Review records unavailable** and says the draft could not be checked or exported. This is a recorded package failure, not a completed acceptance or a release approval.

Package source is `33466f5a26a0e43ed5a234eed234979ea459f4b5`; installed `app.asar` SHA256 is `b8d356ce60d6c869ca2ce6d6dad133427e2a594b6e6e904976bfcd042e8f3b54`. The installed main-module SHA256 is `14503c50d6299c2121c290e216a9809bb974885a2f12fd847a05c6080118a29a`. A separate AI reviewer extracted and exercised the original packaged IPC/schema declarations without launching Electron, invoking IPC or sending an HTTP request. The two diagnostic reports and original screenshots/AX are preserved byte for byte and indexed in `evidence-receipts.json`.

## Actual UI and saved state

`before-one-confirm.jpg` shows the source-check step complete, the confirmation step waiting, and generation waiting for confirmation. `after-click-direct.jpg` and its separately captured AX contain the unavailable/error message. The normal click is recorded at `09:50:34.960Z` through `09:50:35.050Z` on 2026-10-10 in `action-trace.json`; the original directory label `0952` is not the action time. JPEG bytes retain their original `.jpg` format. Earlier files named `M2-confirm-export-failure` show the waiting UI, not the transient error, and are not presented here as screenshots of that error.

The root agent's preceding read-only GETs returned HTTP 200 for both the selected draft and flow run. The saved source-check node was `succeeded`; the approval node and run remained `waiting_approval`, with no decision persisted. `readback-report.json` remains the original report written before the root-cause investigation; its sentence saying the cause was under review records that earlier observation. No approval, rejection, cancellation, draft sealing or business-data mutation was performed by this source investigator or the separate packaged-schema reviewer.

## Confirmed cause

`FlowWorkspaceView` sends `POST /v1/flow-runs/decision` with the selected `runId`, node `approval` and decision `approve` or `reject`. The backend registers this POST route. The desktop handler first validates `runtimeRequestPayloadSchema` before calling the runtime transport.

The old predicate stops at the first matching path. Its earlier `GET /v1/flow-runs/{id}` also matches the literal word `decision`; the method mismatch returns false before the later registered POST route is considered. Running the unchanged packaged schema for the real run reproduces exactly `Invalid payload for runtime:request: runtime request path is not allowed` for both approval and rejection. The actual run-detail GET and an in-memory cancel POST control are accepted. These constructed decision/control payloads were never sent.

The source investigator independently inspected the actual ASAR's compiled route order and predicate. The IPC schema, endpoint declarations, Flow caller, desktop handler and backend-route file are byte-identical between the failed freeze source and pre-fix main `5496b214a296a454bf9c97fb0282259868f66ad9`, as recorded in `source-and-installed-receipts.json`. This confirms a deterministic IPC rejection rather than a missing review record or a claimed backend race.

## Narrow source correction and regression

The correction selects the first endpoint whose path **and method** match, then immediately returns that endpoint's query validation result. A method mismatch can reach the later registered action; a query failure cannot fall through to a more permissive match. No endpoint, method, public version, runtime approval rule or data store is added or changed.

Regression cases cover Survey approval/rejection with node `approval`, flow-run detail GET, the existing Flow `validate`, `publish`, `run` and `test-node` POST actions, and rejection of unregistered flow paths/methods. Before the correction, two regression tests failed with the same schema error and 47 passed. After the correction, 70 targeted tests passed; application tests passed 3,274 with two pre-existing skips; typecheck, relevant ESLint and the application/runtime build passed. The final schema run passed all 49 tests after the test fixture's node label was aligned with the actual GUI request. Commands, times, source hashes and original log receipts are in `source-checks.json`.

These are source diagnostics and regression checks. The old installed package remains failed; source checks and the local build do not establish acceptance of a future package. A new frozen package must exercise the actual GUI confirmation, generate and open the original review files, and complete the required same-package checks. This AI investigation is not a professional signature, vendor/SUC certification or human approval. The maintainer performs the separate source review before the normal PR and strict CI workflow.
