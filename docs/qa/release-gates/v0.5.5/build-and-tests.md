# RailWise AI 0.5.5: final-source build and focused verification

Packaged source: `02165b64bffe5e24f4a4f50811d22086f1489299`.
Source package version remains 0.5.4. The existing release workflow applies
`WORKWISE_APP_VERSION=0.5.5` when producing the formal 0.5.5 packages.

On 2026-11-09, in the isolated checkout of that exact source:

- `node --test scripts/release-promotion-recovery.test.mjs scripts/repair-website-cache.test.mjs`: 30 passed, zero failed/skipped.
- `npm run build`: passed, including the main, preload, and renderer production builds.

The focused cases cover branded publication recovery, canonical and legacy
download verification, metadata cache migration, idempotency, rejection of
incomplete managed configuration, and restoration after Nginx failure.

The final source's Quality workflow is run
[`42624327229`](https://github.com/railwise-cn/railwise-ai/actions/runs/42624327229).
All three jobs passed: the main quality/build job, Electron production smoke,
and native Windows path/spawn/persistence. The main job recorded 4,091 desktop
tests passed (9 skipped), 3,306 KUN tests passed (22 skipped), and 493 release-gate
tests passed (one non-Windows parser test skipped). Brand, OpenSpec, license,
lint, type checks and production build also passed. Release approval verifies
the actual source, jobs and successful result again through GitHub's API.

The preceding PR's broader release tests passed (671 passed, one
non-Windows PowerShell parser test skipped), together with type checking and
production build. Final-source CI runs the source-owned test matrix again.
No new blanket UI matrix, independent AI review, or two-hour freeze is required.
