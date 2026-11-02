# 0.5.4 release blockers

Status: pending strict acceptance fixes, a fresh exact-package freeze and package acceptance.

1. The frozen public package from run `41352323901` cannot be reused after the DeepSeek picker correction. Its renderer still exposed `deepseek-v4-*` options.
2. PR #77 merged the initial DeepSeek correction. PR #78 restores strict updater verification and preserves displayed/submitted saved model identities and third-party provider models. Required CI and a new signed/notarized freeze remain necessary.
3. The trusted updater run `41390447292` failed during target ZIP preflight before Squirrel installation: target codesign passed, but target `xcrun stapler validate` exited 68. Target Gatekeeper was not checked, no updater round-trip was attempted, and no native updater report was produced. The failure is retained in `/private/tmp/railwise-054-acceptance/updater-failed-41390447292/`.
4. Repository write access through the maintainer's `gh` session is restored. Freeze run `41404402960` was cancelled after independent review found unsupported relaxation of the notarization gate. It must not be reused. No public tag, release, Stable feed or download-page operation has been performed.
5. Complete the new package's installed CUA inspection, real-model writing review, strict native updater round-trip and separate AI review before public publication. The old local profile-protection session was restored and its original Login Items state was verified; its evidence is not acceptance of a new package.

The product version remains 0.5.4. No public release approval is inferred from the successful local lint, focused tests, or build.
