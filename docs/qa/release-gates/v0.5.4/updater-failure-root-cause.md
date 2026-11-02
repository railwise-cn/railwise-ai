# 0.5.4 private updater failure review

This is a read-only AI root-cause review of the failed private updater run. It is not a successful updater report and does not approve release.

## Exact failure

- Source: `41a66227e9dd557f21a11be42fb30c3addf0fa7c`
- Target: RailWise AI `0.5.4`, macOS arm64
- Run: `41390447292`, attempt `1`
- Preserved machine report: `/private/tmp/railwise-054-acceptance/updater-failed-41390447292/frozen-updater.json`
- Result: `failed`; no public feed, tag, release, or production state was changed.

The baseline DMG was downloaded, copied into the isolated profile, and passed signature, stapler, and Gatekeeper checks. The target public ZIP was downloaded and unpacked for a preflight check. The final retained sequence was:

1. target ZIP extracted with `ditto`;
2. target app `Info.plist` read;
3. target app deep/strict `codesign` verification passed;
4. target app `xcrun stapler validate` failed with exit code `68`.

The recorded `spctl --assess --type execute` check belongs to the baseline app and passed. The old harness did not record `spctl --status`, so this report does not prove Gatekeeper was enabled. It contains no `targetIdentity`, target `spctl` assessment, target ZIP hash, native harness report, tunnel, or Squirrel steps. The target stapler failure is therefore **before Squirrel installation**. No updater round-trip was attempted.

## Technical assessment

This run does not establish a Squirrel, ditto post-install, ticket-loss, or Gatekeeper cause. The target app had passed code-signature verification but `stapler validate` failed before Gatekeeper was checked on that target. The target diagnostic streams and temporary extracted bundle were not retained, so the precise stapler rejection and its bundle metadata cannot be reconstructed from this run.

## Required next step

Keep `stapler validate` strict at baseline, target-ZIP preflight, and post-update boundaries. For each bundle, record an explicit boundary name, sanitized `codesign`, verbose `stapler validate`, `spctl --status`, and verbose Gatekeeper assessment output before cleanup. Acceptance must require Gatekeeper enabled, an accepted assessment, source `Notarized Developer ID`, and successful stapler validation; diagnostics never turn a trust failure into success. Then rerun the exact updater flow on a fresh frozen build. Do not publish Stable from the original failed run.
