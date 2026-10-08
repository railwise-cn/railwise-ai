# 0.5.3 installed candidate acceptance findings

Status: failed; a new frozen package is required. This is AI review, not vendor interoperability evidence, professional signing or human release approval. This record supersedes the current-package conclusions in `functional-checklist.md` and `independent-ai-review.md`; those documents retain the earlier unsuccessful package history.

## Reviewed installation

- Source: `5a9dc7d0e028d096adfe4652a68803330212c46f`.
- Version: `0.5.3`; bundle: `com.wangjiawei508.workwise.candidate.head5a9dc7d0e028`.
- Installed app: `/private/tmp/railwise-0.5.3-installed-1791339929/app/RailWise AI Candidate 5a9dc7d0e028.app`.
- Origin: isolated Survey Actions run `37558975346`, artifact `11456795316`.
- DMG SHA-256: `e9a841920721595d36b24f64013046e999c56d6a95ad46609d40bb9e3bedb9ec`.
- ASAR SHA-256: `94c57695926e6fe75ff0fe2f4bb70c04aeedebac6d5971937ad6941b16b36404`.
- Developer ID signing, Apple notarization, staple and Gatekeeper validation had succeeded for this installation. The earlier ad-hoc package in the historical review is a different artifact.

## Computer-use findings

The installed app completed source import, preflight, coordinate-reference confirmation, plane-control adjustment, result inspection, review-draft generation and PDF preview/export using the public synthetic `golden-plane-control-e2e.in2` case. The results contain four points, five observations and one station, with two degrees of freedom. S1 point standard error is approximately `1.36e-4 mm`. Field observations, independent closure, standards conformity and authentic professional signing remain explicitly unevaluated.

Chinese dark-theme overview, processing, results and delivery screens were inspected. English and light-theme settings were applied and the result/processing views inspected. The AI drawer contains professional input and task controls; the processing attention message contains datum, control-point, observation, closure and precision advice. No developer protocol was present in those inspected default surfaces. This does not prove a live model answer: the isolated profile has no AI API key.

Keyboard inspection confirmed focus enters the AI and Advanced drawers on their close control. Closing AI restores its Open AI trigger. Tab from that trigger reaches Advanced; Return opens Advanced; Escape closes it and restores the Advanced trigger. The remaining keyboard sequence, narrow-window matrix, status announcements and recovery states are not complete.

### Blocking defect: delivery draft IPC

The installed delivery page displays an error loading saved editing drafts and disables review-note editing, figures and review/export. The renderer requests collaboration routes that the desktop IPC allowlist omitted, so they are rejected before reaching the packaged service. This is a real integration defect, not a sidecar-startup issue.

Fix: `fc082170c15d2a354e48a5c76a4c4cb852142c4e` adds exact draft routes and bounded strict request schemas. A failing desktop-handler reproduction was observed before the fix; 103 related checks and typechecks then passed. The reviewed package does not include this fix, so it cannot pass release acceptance.

### Blocking evidence mismatch: updater target

Private native updater run `37558975451` succeeded for the same source and version, but it built another artifact. Its target and installed ASAR SHA-256 are both `aa6572f01059792a824870667829f2805bd6bed54b637a7701fea1e3e9e67940`, not the ASAR inspected locally. The workflow sets a private package name, while the isolated Survey workflow uses the normal package name. These independently built packages cannot be combined as one acceptance identity.

Next package acceptance must download the exact target artifact of a single private updater run, verify its ZIP hash against the updater report, install that ZIP, and verify local ASAR equality before computer-use and independent AI review. Probe-file preservation is not proof of all historical projects/configuration migration.

## Screenshots

The `*-zh-dark-1280x840.png`, `advanced-zh-dark-source5a9dc7d0.*` and `results-en-light-source5a9dc7d0.*` files in `screenshots/` are from the installed identity above. Earlier English dark screenshots belong to historical candidate `9527ec5f1bcb` and cannot validate this package or a later one. The mistakenly captured WPS desktop image named `deliver-zh-dark-final.png` was rejected and moved outside repository evidence; it must never be listed in a release manifest.

## Release status

No passing public-release manifest is created. No `v0.5.3` tag, public Release, stable/frontier promotion or official download-page update is authorized by this failed review. The user's existing 0.5.3 publication instruction remains pending completion of the required acceptance gates.
