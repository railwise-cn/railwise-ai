# WorkWise Delivery Rules

## Release checks

- The current maintainer may review, merge, and publish in single-maintainer mode.
- Run required CI, focused tests, and a production build for the change. For a distributed package, install the exact package and verify its version, bundle identity, signature, and notarization when applicable.
- When the release changes the updater or introduces a new updater path, run one real updater smoke test against the exact package and record the result.
- Do not make repeated private freezes, full UI matrices, screenshot archives, exhaustive checklists, or separate AI reviews mandatory unless the change specifically requires them.

## Compatibility and migration

- Never silently delete an existing plugin, MCP configuration, Skill, credential reference, or user data during a catalog migration.
- Any plugin removal, replacement, license restriction, or default-state change requires a migration note covering the old item, new status, reason, data preservation, and user action.
- Keep legacy IPC/config readers as migration compatibility until the replacement has been exercised against real user data.

## UI acceptance

- Glass material is limited to approved window chrome, startup UI, and transient overlays. Work surfaces and navigation content must remain readable and opaque enough for scanning.
- For a visual change, inspect the packaged application on the primary supported language, theme, and window size affected by the change, and record any defects. Testing every language/theme/size combination and preserving a screenshot archive is optional unless the change is specifically about responsive or visual coverage.
- Any simulated engineering or domain review must be labeled as AI review and must not be represented as licensed, regulatory, vendor, or human professional sign-off.
