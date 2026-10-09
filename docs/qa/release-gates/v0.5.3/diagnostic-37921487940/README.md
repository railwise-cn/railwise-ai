# 0.5.3 frozen-package failures retained — 2026-10-09

This is failed/incomplete acceptance evidence and AI investigation, not release approval or final package acceptance. No public 0.5.3 tag, Release, Stable promotion, or product-page publication was performed.

## Exact package and execution

Private freeze `37921487940`, attempt 1, source `6bcfe0db516eafbecfed546e7077088975cda804` completed all five required jobs, including the actual 7200-second stability step. The original macOS/Windows immutable artifacts, receipts and eight files were verified. The arm64 DMG installed at `/Applications/RailWise AI.app` was version 0.5.3 with ASAR SHA256 `2134c273af4b7e86e6f0243b0178fd1ffedeb120f260bca7094b5726b7474af7` and DMG SHA256 `0a33b5f6a8655b677762304dc9052b5cfbd8028249376323da0289579be0d852`.

Signature and stapled notarization were verified. The local Gatekeeper output includes `override=security disabled`; enforced local Gatekeeper validation is not claimed. OS security policy was not changed.

The user profile was privately snapshotted and isolated before launch. Only the already authorized official DeepSeek provider was reused. The original installation receipt predates activation and says `profileChanged:false`; the separate lifecycle receipt records subsequent activation. Original captures are retained without rewriting that chronological difference.

## Actual updater failure

Run `37939882485`, attempt 1, used the exact frozen source and target. The official pinned 0.5.2 baseline, compatibility-service seed and target-package service inspection completed. The temporary tunnel printed its URL, but the script immediately fetched the manifest before a registered connection. That fetch failed. The native updater harness, installation, relaunch and historical target readbacks were **not executed**.

Failure artifact `11620971963`, SHA256 `63c516ce2f66ae135809ba36f3c90db3091ed16be5e57a7e100f80c1d36c5d79`, contains four original files retained byte for byte in [updater/original](updater/original). No `native-updater.json` exists in that artifact; none was fabricated. [The independent AI investigation](updater/root-cause-ai-review.md) classifies the observed failure as a harness readiness race before product updater execution. The raw failure does not distinguish DNS from QUIC/setup latency.

The remediation waits for a registered tunnel and bounds HTTPS manifest readiness retries. Default TLS, exact origin/path, manifest size/digest, isolated feed and terminal identity/security failure checks remain enforced. Regression tests exercise readiness boundaries; they do not replace the required real updater round trip.

[Source regression and independent AI review](readiness-remediation/README.md) retain 36 focused, 431 release-related and 21 release-delivery passing checks. One separate transport-only smoke used the verified official pinned binary and exact frozen files. The tunnel registered, but this Mac's manifest probes returned `ENOTFOUND` throughout the bounded 60 attempts. Its original report remains **failed**; the owned process and feed were closed. This local transport smoke neither ran the native updater nor establishes the hosted runner's DNS behavior. No successful external manifest retrieval or updater round trip is claimed.

## Actual professional-answer defect

In the second synthetic task, actual input enabled Send and an official model reply arrived. The [original synthetic reply](professional-answer/raw-assistant.synthetic.txt) and [CUA capture](cua/new-task-actual-professional-answer/capture.json) show a confirmed rendering defect:

| Original professional prose | Installed package rendering |
| --- | --- |
| `This is the true pre-adjustment check.` | `This is the Yes pre-adjustment check.` |
| `no observation files or adjustment records are registered yet` | `no observation files or s are registered yet` |
| `any-station`, `station-level` | `any-Station`, `Station-level` |

The renderer treated prose `true` as a boolean, deleted the `adjustment record` prefix from the plural noun, and changed ordinary station capitalization. The scoped fix preserves professional prose while retaining translation/removal of actual internal fields and technical identifiers. It does not alter observations, numerical results or stored messages.

[The source root-cause report](professional-answer/remediation/root-cause.md) and [169 passing source regressions](professional-answer/remediation/validation.json) also cover ordinary known/unknown datum statements, point names/source filenames, recognized scalar field rows and complete removal of implementation-only rows. The independent source readback preserves numerical quantities, failed precision, declaration-verification limits and repeated-filter stability. These checks cover the corrected source only; the replacement packaged UI is still untested.

An earlier AX observation said Preparing while its same capture screenshot showed Ask the agent. Closing/reopening and the second task's actual input/send succeeded. [The read-only startup diagnostic](startup/diagnostic-ai-report.md) found the service healthy and exact project/thread binding present. A persistent startup defect is not established; the AX/screenshot disagreement is retained explicitly rather than presented as screenshot proof of a stuck application.

## Restoration and unfinished acceptance

The application was normally quit; the private profile session was restored and verified. Fresh CUA Login Items evidence was compared with the original: RailWise remains absent from Open at Login and its background activity remains on. The full personal application list, settings, credentials, user profile and synthetic runtime database stay private and are not included here.

The blocked 0.5.3 app was preserved privately and the exact previously installed 0.5.2 application was restored, with its original ASAR hash checked. This is restoration of the user's prior application, not a separate pinned-asset acceptance claim.

The 49 scenarios, ten weighting cases, six advanced methods, 48 language/theme/window/page cells, native result/export readbacks, failures/recovery and complete final acceptance remain unfinished. A fresh freeze after the source PR and strict CI is required. None of this package's partial observations may be inherited as final acceptance of replacement bytes. Independent senior-engineer-mode AI review remains required for the same replacement package; these AI investigations do not claim vendor/SUC certification, licensed professional signature or human approval.

[preserved-evidence-sha256.json](preserved-evidence-sha256.json) binds each copied original byte sequence to its private source. Subsequent remediation checks and independent source review are supplementary evidence, not successful installed-package acceptance.

[Final source checks](source-validation/checks.json) passed the complete renderer suite (357 files and 3271 tests passed; two files/tests skipped), full TypeScript checks and full lint. The four reviewed implementation/test hashes are recorded there. Strict PR CI and fresh package acceptance are still separate required steps.
