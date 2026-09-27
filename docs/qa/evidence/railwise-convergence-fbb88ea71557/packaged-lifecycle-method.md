# Packaged Verification Lifecycle Evidence

Candidate source: `fbb88ea715571e9689cbc1c0802da08762e4318d`; package version: `0.5.0`.
Probe completed successfully at `2026-09-20T05:56:27.711Z` using the installed application's Electron 43.1.1 (ABI 148).

## Reproduction

Place a copy of `verify-lifecycle-packaged.cjs` in an isolated, writable evidence directory. The script creates a fresh sibling `audit-fixture/lifecycle-*` directory and writes its result beside the script. Do not run the archived copy directly inside the repository.

```sh
ELECTRON_RUN_AS_NODE=1 '<app>/Contents/MacOS/<CFBundleExecutable>' '<isolated-evidence>/verify-lifecycle-packaged.cjs' '<app>' '<cloud-ASAR-SHA256>'
```

Read CFBundleExecutable from the installed Info.plist. Obtain the expected ASAR digest from independently retained cloud candidate evidence. The archived run used `15c19b63ea39fe5618e9d02ca8d977b348e6a12a8db5a8e64f56274a244ed96e`.

## Method and Result

The probe asserts embedded source and version, compares the complete ASAR hash with the independent cloud value, records three packaged Runtime module hashes, and imports the packaged engineering and Survey services and native SQLite binding.

A synthetic leveling source is imported, validated and adjusted through those services. The service creates a draft deliverable. All non-verification database tables and all workspace file bytes are hashed before verification.

Successful verification passes all five strict checks. A missing-manifest request produces an error terminal. Together they yield two terminals and four lifecycle events. JSON record hashes, start/finish links, terminal identifiers, outcomes, and timestamps match; original tables and file bytes remain unchanged and review status stays draft.

A SQLite backup of only the synthetic engineering database models terminal-only legacy history by dropping the copied lifecycle table. Reopening preserves both old terminal rows byte-for-byte and creates no historical starts. A subsequent verification adds one new terminal and its own two events. The resulting copy has three terminals and two lifecycle events.

The fixture databases and generated deliverables remain local and are excluded from this archive. The retained baseline hashes refer solely to the synthetic fixture, including its generated relative paths.

## Boundaries

This is packaged-service integration, not GUI automation. It never opens or changes the running GUI database or real user data. It is not a production KPI measurement, professional signoff or release approval. GUI acceptance is recorded separately by the main task.

`package-summary.json` preserves local signature/notarization checks and explicitly records disabled local Gatekeeper assessments. `private-updater-summary.json` records the isolated cloud updater round-trip with Gatekeeper enabled, synthetic sentinel preservation, and no public feed promotion. Both summaries retain SHA-256 digests of their original reports; local absolute paths and the private feed URL are removed.
