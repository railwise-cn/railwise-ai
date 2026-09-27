# b193fc7 Monitoring Replay Package Acceptance

Date: 2026-09-21. Status: `passed-selected-synthetic-monitoring-scenarios`; this is not release, professional or user acceptance.

## Exact Package

- Source: `b193fc70d6363dc768e715087ca9c0d9975158c9`; package version: `0.5.0`.
- ASAR SHA-256: `f50b2c373902aae90cdd60726ac0158925aa91e9babb2a12b51ed173f171119a`.
- Application ZIP SHA-256: `e3858ef528873b8e96fccd447a74fd31ade6aeb2a5c66f6618bf6c7f2c8109b7`.
- [Private workflow 35537110911](https://github.com/wangjiawei508/WorkWise/actions/runs/35537110911) passed signing, stapled notarization and the actual native updater round trip from an isolated same-source `0.0.0` probe to `0.5.0`. All six updater stages and seven TLS checks passed. No public feed, download metadata or Release was changed.
- The locally installed application is the same ZIP/ASAR as the cloud updater target. Local signature and stapled ticket passed. Local Gatekeeper was already disabled; cloud Gatekeeper was enabled. No system trust settings were changed.
- `package.json` and `installation-context.json` retain the install-time `guiAcceptance: not-tested` snapshot. The subsequent GUI work is recorded below, not backfilled into those original files.

## Native GUI Operations

The primary agent operated the installed application through Computer Use. All inputs are synthetic. The historical project was created with the older signed `4368949` package Runtime in a new isolated directory, before the new candidate first opened it.

| Project | Manifest | Observed result |
| --- | --- | --- |
| Historical `project_9b98b139-6794-4830-95d1-0ac55449a399` | `manifest_220c5caa-5177-4e66-8928-6bf9d05b1b44` | Original five checks passed; numerical replay returned `not-evaluated/source-unavailable` before and after restart. |
| CSV `project_ad84b119-0570-4637-a9cf-a629e4b54bc6` | `manifest_748d98f3-163f-402d-8142-c7055f0267da` | GUI import, validation, analysis, chart, DOCX/PDF/XLSX preview and draft manifest; original five checks passed; numerical replay passed. |
| XLSX `project_8d90b15f-02b3-46cf-a5ed-26c34fff42dc` | `manifest_49552e7a-2af1-4193-8db4-d475717d7621` | Same complete GUI workflow, including zero/blank input handling; original five checks and numerical replay passed. |

Both new projects reported S01 current/change/rate `8/8/2`, S02 `-1/-9/-2`, with actual observation intervals of one and three days. The CSV draft PDF was deliberately replaced with test bytes: replay failed with `prerequisite-failed`. Restoring the exact original bytes restored successful replay. The failed attempt remains recorded.

The application exited normally, passed a stopped-copy audit, restarted using the same `candidate.env` and executable, restored all three projects, and performed one new numerical replay for each. The original five-check action was not repeated after the baseline audit. The application then exited normally again. Both application command sessions exited 0.

Selected replay states were visually checked in Chinese/English and light/dark themes. Screenshots include a normal 1171-by-768 view and a zoomed 1490-by-768 view; the final setting is Chinese/light. See [Chinese monitoring analysis](gui/xlsx-analysis-zh-light.jpg), [tampered-output failure](gui/csv-output-tampered-zh-light.jpg), [successful replay after restoration](gui/csv-restored-replay-zh-light.jpg) and [restart result](gui/restart-csv-zh-light.jpg). The `.txt` files are Computer Use accessibility diffs, often only a no-change observation, not complete accessibility trees. Screenshots and independently stored audit records are the substantive evidence.

## Independent Persistence Audit

The [audit directory](audit/README.md) preserves the historical baseline, initial audit-script failure, corrected pre-restart report and final post-restart report. Only copies of the stopped candidate database were opened by SQLite. Original files remained unchanged by the audits.

The initial script failed because Python treated a Boolean as a number when checking the workbook's literal `false`. The helper was corrected to compare Booleans explicitly, with nine self-tests, and rerun into a new directory. Neither product data nor expected values were changed to obtain a pass. The original failure and helper diff remain available.

The final audit verifies complete source bytes, mappings/context, normalized observations, independent arithmetic, document/workbook metadata, SVG geometry, replay identity/hash chains and preservation across restart. Historical business rows and four outputs match the pre-GUI old-package baseline. The three original five-check receipts remain unchanged.

## Limits and Observations

- This closes the selected monitoring-replay package scenarios only. It does not cover all project workflows, native minimum window size, a complete keyboard/accessibility matrix, real user data migration or real model conversations.
- Local startup/settings emitted `Unable to set login item: Operation not permitted`. Login-at-startup was off; no successful login-item behavior is claimed. This did not stop the selected monitoring actions or normal shutdown.
- Synthetic arithmetic and agent review cannot establish authentic field data, engineering applicability, organization roles, signatures or production KPIs.
- No user has personally accepted this installed UI or its functions in this evidence. Public release gates and the wider plan remain open.
