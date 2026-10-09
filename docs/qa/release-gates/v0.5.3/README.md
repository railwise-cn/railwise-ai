# Final public-identity 0.5.3 acceptance preparation

This directory contains preparation tools and plans. It is not a passing
package acceptance report or publication manifest. On 2026-10-09, freeze run
`37861714441`, sourced from `1aae1717926de575220cb01e2289613f3c34c639`, was
canceled after independent source review found that an archived review-draft
question still exposed its internal record identifier. PR #49 is being revised
to fix that question, capability presentation and profile-protection link
boundaries before another protected-main freeze. No new final package or
passing installed-package acceptance is recorded here.

Earlier runs `37749218440`, `37767883793` and `37860746475` are historical
only. Their packages, screenshots and updater reports cannot authorize the
next package or publication. Required final screenshots, functional checks,
AI review and native updater evidence must all identify the new frozen bytes.

## Preparation and evidence index

- [Release execution order and current freeze status](release-execution-order-20261008.md)
- [Normal public-identity profile protection procedure](normal-profile-protection.md)
- [Profile protection script](normal-profile-protection.mjs)
- [Synthetic profile protection self-test record](normal-profile-protection-selftest.json)
- [Independent AI review of profile protection](normal-profile-protection-independent-review.md)
- [Independent synthetic numerical expectations and comparison rules](independent-numerical-expectations-20261008.md)
- [Independent numerical calculation script](independent-numerical-expectations-20261008.py)
- [Original numerical expectation JSON](independent-numerical-expectations-20261008.json)
- [Full final-package functional and visual acceptance plan](../../evidence/railwise-next-private-cua-plan-20261006/README.md)

The helper self-tests and independent synthetic calculations below validate
preparation tools only. Real profile activation, installed-package inspection,
export readback and the native updater round-trip remain unexecuted for the new
freeze. Their final reports must bind the actual new source and package hashes.

## Original computer-use captures

`capture-cua-evidence.mjs` saves the original CUA PNG and full AX text, an
unmodified CoreGraphics window observation, and a capture metadata record.
It never resizes an image, changes a window, clicks a control, or marks a
capture as passed. Use it from the native CUA runtime, with the actual app
binding returned by `cua.getApp()`.

1. Verify the installed final package and save a private identity JSON with
   `version`, `bundleId`, `sourceHead`, `asarSha256`, `pid`, and `appPath`.
2. Adjust the window through CUA. Run `observe-window.swift` with the exact
   package PID and retain its JSON in a private file.
3. Within 60 seconds, call `captureCuaEvidence()` with that observation's
   main `windowId`, the package identity path, and the actual page/theme/locale.
4. Review the screenshot and AX. `requestedSizeMatches=false` is an unfulfilled
   matrix size, not a passing size. Keep screenshot pixel dimensions separate
   from native window logical dimensions. Capture metadata begins at
   `observed-not-reviewed`; findings and acceptance conclusions belong in the
   real review report.
5. Copy only credential-screened final evidence into this QA directory and
   record original capture paths and hashes. Private system-login snapshots,
   settings, keys, user projects and profile backups must not be committed.

Example call, with every path and observed value replaced by actual evidence:

```js
var evidenceCapture = await import('/absolute/worktree/docs/qa/release-gates/v0.5.3/capture-cua-evidence.mjs')
var capture = await evidenceCapture.captureCuaEvidence(reviewedApp, {
  root: '/private/tmp/actual-acceptance-root',
  id: 'zh-light-1280x800-overview',
  identityPath: '/private/tmp/actual-acceptance-root/installed-identity.json',
  observationPath: '/private/tmp/actual-acceptance-root/current-window.json',
  windowId: actualWindowId,
  locale: 'zh', theme: 'light', page: 'overview',
  requestedWindowLogicalSize: { width: 1280, height: 800 }
})
```

Helper validation on 2026-10-08 used synthetic bytes and a synthetic app
binding only: PNG dimensions, exact PID/window/title/visibility matching,
size mismatch retention, original-byte preservation and overwrite refusal
passed. These are helper checks and do not constitute installed-package
screenshots, a valid PNG image fixture, or product acceptance.

The actual release order, single-maintainer governance and separate product
page deployment are documented in the [release execution order](release-execution-order-20261008.md).
