# Advanced Markdown candidate — signing and updater readiness

Date: 2026-11-01. Product version remains **0.5.4**. This is preparation for an isolated signed/notarized candidate and a real private native updater round trip. It does not approve or perform public publication, tag changes, feed promotion or download-page changes.

## Available credentials and tools

- Local `security find-identity -v -p codesigning` reports **0 valid identities**. Local CSC/P12, Apple API and named-notary-profile environment variables are absent. No private key was exported or installed, and no keychain/account settings were changed.
- Repository secret **metadata only** confirms `MAC_CODESIGN_P12_BASE64`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` exist in `railwise-cn/railwise-ai`; all were last updated in August 2026. Values are unreadable through this metadata API and were not retrieved or printed. Presence does not establish current certificate validity or Apple acceptance; the actual signed build must do that.
- GitHub API reads of repository permission metadata, the active Release workflow and its run list succeed. `gh auth status` separately reports invalid saved accounts; actual API access is the operative evidence and must be checked again when dispatching. Existing account permissions include push/admin. No credentials were copied to the candidate.

## Existing isolated workflow

`.github/workflows/release.yml` accepts `private_updater_acceptance=true`, `candidate_only=true`, `publish_release=false` on the final reviewed `codex/` source branch. The reusable `.github/workflows/private-updater-acceptance.yml` uses that event source SHA, existing repository Apple secrets, an ephemeral GitHub-hosted macOS runner, a separately identified candidate, and authenticated Actions artifacts. It does not upload to R2, create a Release, promote an updater feed or change the website.

The internal baseline sets `WORKWISE_APP_VERSION=0.0.0`, while the target uses `package.json` version **0.5.4**. Both are built from the same frozen source and must have the same Developer ID designated requirement. `package.json` and its public version are not changed. This probes a real native updater using a same-source internal baseline; it is not a claim of historical user-data migration from an older official release.

The runner creates a certificate-pinned loopback HTTPS manifest/ZIP transport without modifying system trust. Actual Electron download, Squirrel replacement and target relaunch are required, as are manifest/ZIP requests, the exact target ASAR hash and preservation of an isolated user-data sentinel. Tests, a manual download or a mock cannot substitute for that result.

Expected retained artifacts:

- `private-updater-arm64-<source-SHA>`: native updater, TLS preflight, private wrapper and notarization reports.
- `private-updater-target-arm64-<source-SHA>`: the exact signed/notarized target DMG and ZIP, retained for seven days.

The signed target must then be downloaded, installed to a new local candidate root, checked with strict/deep `codesign`, `stapler validate`, provenance/ASAR/native dependency checks, and inspected through computer-use tooling. Existing screenshots of another candidate retain their original identities.

## Preparation checks

The existing private updater isolation/transport suite passed **12/12** on this machine. The first sandboxed run could not bind loopback (`listen EPERM`); the same authorized test ran successfully with the temporary loopback permission. Its assertions cover real local HTTPS transport and ranges, public-job exclusion, private cache/identity validation, credential redaction and command timeouts. These are readiness tests, not a completed signed/native round trip.

The snapshot helper in this directory preserves the original repository/branch, starts from its recorded HEAD, overlays reviewed tracked changes and selected source/docs/fixtures, retains prior Markdown workbench evidence, and writes a per-file inventory. It refuses source drift during copying. `--skip-dependency-copy` is intended for CI, where lockfiles are installed afresh. Push and dispatch are separate operations after the final source freeze and pre-push review; no mixed root working tree is pushed directly, no branch is force-updated, and no public tag is created.

## Pending execution

Wait for the implementation owner to finish source checks and independent review, then freeze an exact checkpoint. Before the one-branch push, review the complete diff and inventory for unwanted files, sensitive material and excessive file sizes; record the exact branch/SHA. Dispatch the private-only Release inputs, bind its run ID to that SHA, retain original reports and exact target package, and complete local installed-package acceptance. A failed notarization or updater report remains a failure until corrected and re-executed.
