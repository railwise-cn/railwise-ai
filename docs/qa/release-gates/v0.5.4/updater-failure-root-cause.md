# 0.5.4 private updater failure review

This is a read-only AI root-cause review of the failed private updater run. It is not a successful updater report and does not approve release.

## Exact failure

- Source: `41a66227e9dd557f21a11be42fb30c3addf0fa7c`
- Target: RailWise AI `0.5.4`, macOS arm64
- Run: `41390447292`, attempt `1`
- Preserved machine report: `/private/tmp/railwise-054-acceptance/updater-failed-41390447292/frozen-updater.json`
- Result: `failed`; no public feed, tag, release, or production state was changed.

The baseline DMG and target ZIP were downloaded, extracted, signed/notarized, and checked before the updater process. The updater then reached the native install boundary. The final retained operation sequence was:

1. target ZIP extracted with `ditto`;
2. installed target `Info.plist` read;
3. installed target deep/strict `codesign` verification passed;
4. installed target `xcrun stapler validate` failed with exit code `68`.

No `native-updater.json` was produced, so download, relaunch, data preservation, and the full updater round-trip are not certified by this run.

## Technical assessment

`electron-updater` 6.8.9 uses `MacUpdater` and Squirrel.Mac on macOS. It downloads a ZIP, serves it through a localhost proxy, and asks the native Electron updater to install it. Squirrel.Mac unarchives the ZIP with `/usr/bin/ditto -x -k --keepParent`.

The failure occurred after the installed app passed code-signature verification and only when validating the stapled notarization ticket. The most likely class of cause is loss or invalidation of the stapled ticket during the Squirrel/ditto ZIP installation path. This is consistent with the boundary and does not establish that the JavaScript or packaged ASAR content is corrupt.

The exact changed metadata was not retained: the harness failed before writing `native-updater.json` and removed its isolated temporary root during cleanup. Therefore the run cannot distinguish ticket metadata loss from a runner-side stapler service failure. The evidence must remain classified as an updater gate failure.

## Required next step

Do not retry blindly and do not publish Stable. A corrective acceptance change must retain the post-update bundle and capture sanitized `codesign`, `stapler`, xattr/resource-fork, and bundle-fingerprint evidence before cleanup. If the harness is changed, it requires normal PR/CI review and a fresh frozen build before another real updater run. The next run must pass the native updater, target relaunch, user-data sentinel, exact ASAR hash, and post-update signature/notarization checks.
