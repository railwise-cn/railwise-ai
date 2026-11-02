# 0.5.4 release blockers

Status: blocked pending repository write access and a fresh exact-package freeze.

1. The frozen public package from run `41352323901` cannot be reused after the DeepSeek picker correction. Its renderer still exposed `deepseek-v4-*` options.
2. The correction is committed locally as `0f2c8618`, with documentation commits `c3b879c0` and `fcf6e7f6`. It requires a PR/CI run and a new signed/notarized freeze.
3. The trusted updater run `41390447292` failed after Squirrel installation: codesign passed, but the post-update `xcrun stapler validate` exited 68. No native updater report was produced. The failure is retained in `/private/tmp/railwise-054-acceptance/updater-failed-41390447292/`.
4. The local `gh` credential currently reports invalid for `railwise-cn`; GitHub connector write calls return HTTP 403. No branch, PR, rerun, tag, release, Stable feed, or website operation was performed.

The product version remains 0.5.4. No public release approval is inferred from the successful local lint, focused tests, or build.
