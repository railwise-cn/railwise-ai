# RailWise AI 0.5.3 functional checklist

Status: **passed for the user-authorized reduced core scope, with disclosed findings**.

Exact package: RailWise AI 0.5.3, freeze run 38100786001 attempt 1, source `3256f4842503e002f094952934b82f2d1d445a0f`, arm64 DMG SHA256 `6b12d991bee1853f93ab13e37aee8cf9759ea17642252bf7e11fa11ea0b37c6e`, installed/frozen/updater ASAR SHA256 `2e18a357464957c304a7a7aeb040071845a9b0ddfc190257518604c55b739797`.

| Actual current-package scope | Result and retained evidence |
|---|---|
| Package and source identity | Passed: immutable combined build receipt and selected-field installed readback under `package/`. |
| Signature/notarization | Passed: actual strict/deep codesign and stapled-ticket diagnostics. Gatekeeper assessments locally disabled; enabled-policy enforcement is not claimed. |
| Two-hour stability | Passed: exact actual 7200 seconds, 01:08:58Z–03:08:58Z on 2026-10-11; `freeze/two-hour-stability-readback.original.json`. |
| IN2 import/reference negative | Passed: native Add files import; initial missing-reference block; GUI-declared reference and reimport to ready state. Operator observation retained in `cua-evidence/in2/README.md` and `cua-observed-state.txt`; the early summary is explicitly transcription, not claimed raw AX. |
| Actual calculation and numerical results | Passed: actual Start calculation produced 4 points/5 observations, rank 3/3, dof 2. `cua-evidence/in2/calculation-result.*`; 129 original-record/source-row comparisons and 8 independent analytical GUI comparisons pass. |
| Review draft and native save | Passed: three real native DOCX/PDF/XLSX saves. Original files are in `native-exports/in2/`. Separate 614 semantic checks and 73 content/semantic checks pass with zero failures. Five PDF pages and four original DOCX CJK-fallback reader pages visually inspected. |
| Normal same-package restart | Passed within the observed named Survey job and three draft files. `survey-restored-after-restart.*` states that restored files have not been reverified. Exact original network/completed adjustment data_json and three export hashes remain unchanged in the observed comparison interval; no broad profile-wide identity claim. |
| Quality → Deliver regression | Passed: neutral Quality then Deliver retains the exact IN2 source and three Survey draft files; `quality-source-context.*` and `quality-to-deliver-regression.*`. |
| Pro/max read-only AI | Completed response on actual turn `turn_fl8um8f7`, deepseek-v4-pro/max, 3 completed survey_read_context calls, terminal completed at 2026-10-11T11:02:48.501Z. Original interrupted turn remains incomplete. Coordinates/units/source/fixed-control distinction corroborated; two advisory explanation defects below are retained. Compared numerical records and exports were unchanged. |
| Observed UI | Passed with coverage limit: actual English dark Result/Deliver and Chinese light Survey/Deliver/Settings, original JPEG bytes and public-safe AX. Full theme/language/window/keyboard/screen-reader matrix not claimed. |
| Real native updater | Passed within stored synthetic data/config-reference scope: official pinned 0.5.2 → same frozen 0.5.3 download/install/relaunch; original reports retained unchanged under `updater/`. |
| Independent AI review | Passed for this reduced scope, with seven findings; final `independent-final-ai-review/review.json`, SHA256 f706311bfdef005fe777d9e6b4d934f4958c88deab788568be99b509c723cc4e. |

Known findings are retained: synthetic datum/precision does not certify field quality; locally disabled Gatekeeper enforcement; DOCX long-decimal wrapping/sparse signoff; untagged PDF/native Excel display-print-live recalculation not certified; AI residual definition reverses the sign convention while numerical values remain correct; AI prior-conservativeness interpretation is unestablished; extra GSI automatic/default Plane configuration and subsequent datum/reimport remained blocked, so GSI is unaccepted and deferred. Both `cua-evidence/gsi/initial-wrong-network-blocked.*` and `ref-reimport-blocked.*` preserve that limitation.

Expanded 49-case/48-view/10-weighting, full advanced/source-bound/E/expanded-D, Flash-plan and GSI-positive workflows are deferred, never marked passed. Prior package failures remain historical and no prior package pass is inherited. These records are not a licensed professional signature, human approval, regulatory conformity or vendor/SUC interoperability evidence.

Normal acceptance-profile restore→fresh CUA Login Items comparison→verify completed; the exact current session is restored and verified. `profile-restoration.public-summary.json` records 263 protected entries, 100 assets, final verify at 2026-10-11T11:24:29.964Z, and matched RailWise Login Items state. Its reused older-session baseline is explicitly identified and not represented as a new baseline. Personal Login Items, credentials, DB/WAL/SHM, snapshots and raw runtime events are excluded from publication.
