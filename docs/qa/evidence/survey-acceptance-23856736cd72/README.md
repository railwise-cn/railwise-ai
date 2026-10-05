# Private Survey candidate 23856736cd72

## Package identity

- Source snapshot: `23856736cd7283a241aeb62c7f89b3f128807f1a`
- App version: `0.5.1` (private candidate only)
- Platform: macOS arm64
- Archive: `/private/tmp/railwise-professional-candidate/current-quality-dist/WorkWise-Candidate-23856736cd72-0.5.1-mac-arm64.zip`
- SHA-256: `6d57789eea5d0450bebc5d1b93cb8ccd18f0dc61c081b2fad5c6341d71a232ec`
- Package integrity: ZIP CRC check passed; ASAR recorded 18,369 files and 466 compiled files.
- Signature: ad-hoc signature verifies on disk; no Developer ID signature or notarization.
- Public release, website, stable feed and Git tags: unchanged.

## CUA launch result

The app was extracted under `/private/tmp/railwise-professional-candidate/installed/current-23856736cd72/` with isolated candidate data. Static inspection confirmed that `Info.plist` names the existing arm64 Mach-O executable and the app bundle passes `codesign --verify --deep --strict`.

This host reports Spotlight disabled for both `/` and `/System/Volumes/Data`. `lsregister -lint` fails for the current and historical RailWise bundles with `-10822 from spotlight`; `open -a` returns `kLSNoExecutableErr (-10827)`. The candidate crash report at `~/Library/Logs/DiagnosticReports/RailWise AI Candidate 23856736cd72-2026-10-01-155845.ips` shows an abort during `NSApplication` initialization in `GetCurrentProcess` / `_RegisterApplication`, with a concurrent LaunchServices local-database lookup failure. CUA could not open this exact bundle (`-10005 timeoutReached`). The same host-level registration failure was reproduced against historical bundles, so this does not establish a candidate-specific UI defect.

No current-candidate UI screenshot or functional pass is claimed. A CUA screenshot of candidate `69842e5c5376` was available as an older visual baseline but is not evidence for this source snapshot. The 48-screen evidence for `2ac333b7fd88` remains tied to that earlier package.

## Source fix after freeze

Independent AI review identified a high-priority leveling risk in this package: concatenated independent loops could be treated as one route and opposite misclosures could cancel. The current working tree now constructs closures per graph component, checks components without known controls and emits attached routes from controls. Regression coverage includes `+10 mm` and `-10 mm` loop cancellation, an uncontrolled closed component and out-of-order attached-route observations. This source fix is newer than the package above and has not been included in a frozen candidate.

## Verification

- `npm --prefix kun test -- --run src/engineering/survey-professional-review.test.ts --maxWorkers=1`: 11/11 passed after the fix.
- `npm --prefix kun run typecheck`: passed after the fix.
- `npm run openspec:validate`: 12/12 passed.
- `git diff --check`: passed.
- The three-file SQLite integration run could not complete: 10 tests passed and 14 could not load the native module because `better-sqlite3` was built for ABI 148 while the active Node runtime requires ABI 147. npm's `allowScripts` policy blocked rebuilding; that policy was not bypassed.

## Status

OpenSpec task 4.2 remains open. The current host cannot provide a valid GUI session while its Spotlight/LaunchServices service is unavailable, and the frozen package predates the closure fix. Once the host service works, freeze and install the exact fixed source, then complete the CUA screen and workflow review with an independent senior-engineer-mode AI review. Task 4.4 remains open for current licensed COSA/SUC interoperability evidence and authentic professional signoff. Neither status requires the user to perform routine software UI acceptance; public release still requires explicit user approval for the exact version and action.
