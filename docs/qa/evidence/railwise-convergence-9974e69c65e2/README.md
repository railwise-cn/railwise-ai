# 9974e69 Private Candidate Baseline

**This is a private testing baseline, not the final acceptance candidate.** A P1 completion-guard defect is reproduced in this signed package: one simulated model answer claiming completion, with zero tool calls and four missing step receipts, still completes the TaskRun and execution turn. The fix must be tested in a newly built candidate. Successful CI, notarization and updater checks do not override this failure or authorize release.

Source: `9974e69c65e2f76bf3318e713191b4125cb0e75e`. Package version: `0.5.0`. Bundle: `com.wangjiawei508.workwise.candidate.head9974e69c65e2`.

## Package and Updater

- [Private updater workflow 35494784734](https://github.com/wangjiawei508/WorkWise/actions/runs/35494784734) succeeded. Public build/release/feed/website operations were skipped.
- `package-summary.json` records local installation checks and source-report SHA-256. Local codesign, stapler and spctl assessment returned zero. Local Gatekeeper status is **assessments disabled**; the cloud updater ran with **assessments enabled**.
- `private-updater-summary.json` records the actual isolated `0.0.0 -> 0.5.0` HTTPS/Squirrel round-trip and synthetic user-data sentinel preservation. The private feed URL is removed. The test-channel label is not public frontier promotion.
- `artifact-download-summary.json` records explicit GitHub artifact metadata and download integrity. Evidence artifact `10600099265` was fully hashed against its GitHub digest. Inner application ZIP from target artifact `10600373805` was fully hashed against that authenticated updater evidence. The outer target artifact was range-read, not fully downloaded or rehashed.
- Embedded source provenance and the loopback-only updater host were checked. At installation handoff the application had not been launched and no user data had been copied. Subsequent packaged probing is documented separately below.

| Item | SHA-256 |
| --- | --- |
| Application ZIP | `236a70cccccffb4f37c471eec560fd3b240f3fd207d1474a07b3e52fb502784b` |
| Installed ASAR, equal to cloud updater target | `ab3b385b6d6f422c609694ca36adb0512a6486b1ce005f3976acce4a7c97a0a5` |
| Complete evidence artifact | `880ea4d27cb7f2141c2117cbc9972bb5bc796f6c63250c7d70657fbd87bb75a3` |

No large ZIP or application bundle is included here. These checks establish package identity and the private updater path, not real-project migration or GUI/user acceptance.

## Quality Log

`CloudQuality.log` is the original 1,510,496-byte log, copied without whitespace, line-ending, control-text or formatting changes. Its SHA-256 is `ddb4a98302f754a882c1c24f6799bf2efc6471f87f69b75fbad9c7231bad883c`.

Its origin was independently confirmed by re-fetching [Quality run 35494774730](https://github.com/wangjiawei508/WorkWise/actions/runs/35494774730) through explicit-repository `gh run view --log`: both files were byte-for-byte identical. Run `35494773433` is a separate successful Quality run for the same source, not the source of this log.

`CloudQuality-summary.json` records that provenance and observed results: desktop 2,776 passed / 6 skipped; Runtime 2,795 passed / 22 skipped; Windows core security 128 passed; plugin security 104 passed; persistence subset 58 passed / 2 skipped. The log was scanned for high-confidence token, private-key, credential-URL and unmasked Authorization patterns before copying; no such values were found. Expected synthetic failure output and skipped tests remain intact.

## Signed-Package Counterexample

`packaged-text-only-completion-probe-S7X5xb.json` and `packaged-text-only-completion-probe.log` preserve the original probe result and successful reproduction log. Their hashes are recorded in `CloudQuality-summary.json`. The generated temporary fixture path is synthetic and is retained as part of the original evidence.

The probe verifies signature before imports, exact ASAR/source/version, and then exercises the packaged Runtime against an isolated synthetic fixture. A simulated model makes one response and no tool calls. All four typed step receipts are null, there are zero adjustments, and the fabricated completion statement is present in persisted `assistant_text`. Nevertheless, TaskRun and turn become `completed`; the raw/projected plan is still `started` with no execution evidence. `expectation: reproduce` and process exit zero mean the defect was successfully reproduced, not that acceptance passed. No real external model was used for this counterexample.

The operator's first shell invocation used the wrong executable name and exited 127 before starting a process. After reading the actual `CFBundleExecutable`, the corrected invocation reproduced the defect. The retained log is the corrected run; the initial shell error was overwritten and is not represented as a retained log artifact.

## Limited Native UI Checks

After the package counterexample, the isolated app was launched with its candidate environment. Native controls selected Chinese/light, created and named one synthetic project, and set Low reasoning effort. Opening Settings and returning preserved Low; `gui/01-effort-after-settings.txt` retains the menu state. A screenshot of the main light workspace is `gui/02-survey-light.png`. The native menu screenshot was unavailable, so its AX text is the evidence for the effort selection.

A new credential-free synthetic provider at `http://127.0.0.1:9/v1` declared the same `deepseek-flash` model as built-in DeepSeek. The native menus retained both provider groups. The saved AX states show the built-in model unselected and the synthetic provider model selected. No request was sent to this inert endpoint and no real credential was entered. This verifies menu identity, not actual upstream routing. The app exited normally; the synthetic configuration is preserved for traceability.

The completion guard and related UI behavior require correction and fresh package verification. These limited native observations do not establish full GUI acceptance, formal delivery approval, production KPI achievement, final candidate acceptance or public-release authorization.
