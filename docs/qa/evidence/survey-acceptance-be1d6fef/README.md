# Survey Candidate Acceptance: be1d6fef

## Identity and package checks

- Source commit: `be1d6fef2e070a4996c14ec9413a331292e246f0` in an isolated local snapshot based on the current `codex/survey-reliability` history.
- Application version: `0.5.1`.
- Platform: macOS arm64.
- Private candidate ZIP: `/private/tmp/railwise-survey-candidate.5xcEqY/candidate-dist/WorkWise-Candidate-be1d6fef2e07-0.5.1-mac-arm64.zip`.
- ZIP SHA-256: `d2d20680d64d8a70cb6c160947e024a7e6ae72ff238129fe2b63e71d0236f6b3`.
- ZIP CRC test: passed; no compressed-data errors.
- ASAR verification: passed; 18,369 files and 466 compiled files.
- Code signature: ad-hoc signature valid on disk; no Developer ID identity or Team ID.
- Notarization: not performed because Apple notary credentials were unavailable.
- Build provenance in the app bundle identifies source `be1d6fef2e070a4996c14ec9413a331292e246f0`.
- The package is private. No public version, Git tag, GitHub Release, update feed, or website was changed.

## Build and source verification

- Runtime TypeScript check: passed.
- Desktop TypeScript check: passed.
- XLSX importer tests: 9/9 passed.
- Survey panel DOM tests: 52/52 passed.
- Production renderer and Runtime build: passed.
- Electron arm64 app packaging and app-bundle validation: passed.
- The DMG step failed when electron-builder tried to create a lock in the user's default Library cache (`EPERM`). The already-built app was packaged with the repository's ZIP helper and the resulting ZIP was verified.
- The XLSX source summary now reports worksheet row numbers instead of mislabeling ZIP payload offsets as source-file byte positions. Worksheet relationships accept only the OOXML Strict and Transitional URIs. Regression tests cover accepted absolute/dot/encoded targets, invalid relation URIs, and path escape rejection.

## Installed-app acceptance

The ZIP was extracted to an isolated directory under `/private/tmp/railwise-survey-candidate.5xcEqY/installed/`. macOS `open -n` failed with LaunchServices `kLSNoExecutableErr (-10827)`. Direct executable launch exited 134 during AppKit initialization. Computer Use selection of the exact candidate timed out (`-10005`). The host's Spotlight/LaunchServices failure is also recorded for the earlier candidate in [survey-acceptance-23856736cd72](../survey-acceptance-23856736cd72/README.md).

Therefore this candidate has no current-package UI screenshots and no claimed CUA or functional acceptance pass. The following remain unverified:

- Chinese/English, light/dark, and 960x800, 1280x800, and 1440x900 UI matrix.
- Overview, process, results, and delivery workflows; import, precheck, adjustment, period comparison, and generated deliverables in the installed app.
- Keyboard/focus/accessibility states and error recovery in the installed app.
- Private updater round-trip.
- Independent AI senior-engineer review of the installed UI and workflows.

No Spotlight indexing or system LaunchServices settings were changed. OpenSpec task 4.2 remains open until the exact package can be inspected. Task 4.4 remains open for licensed COSA/SUC comparison evidence and authentic role-based professional signoff; AI review cannot substitute for either.

## 2026-10-02 follow-up

- Current-source verification passed again: OpenSpec strict 12/12, Runtime typecheck, professional numerical/report/monitoring tests 46/46, desktop Survey DOM tests 71/71, production `npm run build`, and `git diff --check`.
- [Launch diagnostics](launch-diagnostics-20261002.md) records the reproducible AppKit/LaunchServices `SIGABRT` for the exact candidate and historical candidates on this host.
- [AI senior-engineer review](ai-review-20261002.md) records the static and historical-UI review. It is explicitly not current-package CUA acceptance, licensed COSA/SUC evidence, professional signoff, or release approval.

## 2026-10-02 current-source rebuild

- The current dirty worktree was rebuilt privately at version `0.5.1` after the source-only UI and raw-observation congruence increments. The resulting arm64 ZIP is `/Users/wangjiawei/Documents/WorkWise/dist/WorkWise-0.5.1-mac-arm64.zip` with SHA-256 `365fdbc9c03d809bdfff1edecc6fb6b6b12eac9a0e4f243b0b25c89e7de65174` and size `403617960` bytes.
- ASAR integrity and `codesign --verify --deep --strict` passed for the rebuilt app bundle. Signing remains ad-hoc and notarization was skipped because Apple credentials are unavailable. This package is a private local artifact and is not a release candidate with public provenance because the worktree contains uncommitted changes.
- Direct executable launch returned `0` and a process was observed. Computer-use can attach to the already-installed `/Applications/RailWise AI.app`, but binding the exact rebuilt app path still timed out with `-10005`; its screenshot therefore is not accepted as evidence for the rebuilt ZIP. Task 4.2 remains open pending an exact-path current-package CUA run with a unique candidate bundle identity or repaired host binding.
- The rebuilt package was not notarized, uploaded, promoted, published, or used for updater round-trip. Task 4.4 remains open for licensed COSA/SUC material, independent golden references, and authentic role-based signoff.
