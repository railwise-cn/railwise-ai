# 0878c6c Final Icon Private Candidate

Source: `0878c6cc932c6f7e85855b2ad5be199d7aee67d7`. Version: `0.5.0`. [Private signing and native updater run 35956601831](https://github.com/wangjiawei508/WorkWise/actions/runs/35956601831) succeeded on 2026-09-24.

This package includes the final user-provided icon crop/theme corrections. The preceding `c9a97b7` candidate was cancelled and is not installed or accepted. The earlier `b9ea004` remediation-workflow candidate lacks these new icons and remains separate.

Expected target ZIP SHA-256: `5d37da574e3a0ff07642ec081f91d2ac5c36a0f42ef8fe793138d0a8772e402a`.

Expected target ASAR SHA-256: `1c39d7b8ee5e94aa8bf3769f7585376ec7f53f802b535298cf19758dfcfabb6a`.

The combined private artifact is 601,967,933 bytes. Authenticated HTTP Range extraction selects only the target ZIP entry, 302,095,155 bytes compressed / 306,571,668 bytes inflated. The final inner ZIP must match the real updater acceptance report before installation.

## Local Installation and UI Check

The exact ZIP was downloaded from the hosted artifact using authenticated HTTP Range extraction and matched the workflow's expected hash. It was installed into a new isolated directory without replacing any candidate. The installed ASAR matched the hosted SHA-256; the package audit matched all seven required Mac runtime assets to commit `0878c6c`. `codesign --verify --deep --strict` and stapled-notarization validation passed. Local Gatekeeper is disabled, so its local override result is not a Gatekeeper acceptance claim. See `installation-icon-report.json`.

The packaged app was launched and inspected in the actual macOS UI at version 0.5.0. The Chinese Engineering Survey page was visually checked in both the app's light and dark themes; screenshots are `survey-light.png` and `survey-dark.png`. Finder displayed the new light icon while the system was in Dark appearance; its appearance is static because this package contains ICNS, not an Icon Composer asset. That Finder screenshot is `finder-dark-system.png`. The app was normally quit after inspection. The Dock accessibility surface timed out, so Dock icon appearance and live theme switching were not visually accepted in this run, even though the packaged code selects an icon and listens for system appearance updates.

Source checks retained here: 20 tests passed across the three focused files, TypeScript passed, and the production build log is `source-build.log`. `asset-checks.json` records PNG bounds and ICO sizes; `small-size-contact-sheet.png` shows rendered assets from 16 to 128 pixels. The screenshots and logs supplement, rather than alter, the hash-indexed package records.

The workflow report's `0.0.0` baseline is a same-source isolated updater probe, not an old-user-data migration. This candidate was not a public release, and these checks do not establish Windows Explorer behavior or public release approval. No model credentials or old candidate data were accessed, and no public release operations were performed.
