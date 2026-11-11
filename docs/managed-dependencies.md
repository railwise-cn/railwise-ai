# Managed connector dependency delivery

The application pins managed dependency identity in `src/shared/managed-dependencies.json`. Each resource records its upstream URL, version, byte size, SHA-256, license and content-addressed mirror path. Runtime entries also link to corresponding license and source artifacts.

## Runtime installation

- uv 0.12.3 uses official PyPI wheels for macOS, Windows and Linux on arm64 and x64. The installer extracts the pinned executable and checks its reported version.
- CPython 3.12.12 uses the exact python-build-standalone 20260211 distributions recorded by the pinned uv release. The application downloads and hashes the archive, then gives uv a local metadata file referencing that verified archive. uv has no need to download Python from GitHub during installation.
- Lark CLI 1.0.100 uses the official macOS and Windows arm64/x64 distributions. Its companion Skills come from source commit `ac22a60a23d66c37d43a7ec6d9e99b99a4320356`.

Downloads first use `https://www.railwise.cn/downloads/railwise-ai/dependencies/`. Each path contains the exact content hash. An unavailable mirror falls back to the fixed official upstream, with identical size and digest verification. The download layer accepts only registered HTTPS origins and rejects redirects to other hosts.

Existing managed uv archives and runtime records remain readable. When the uv archive format changes from a release tarball to the official wheel, the existing verification logic reconstructs the executable from the new pinned archive. Managed Python stays within the existing runtime directory. Existing Lark configuration, account references and user-modified companion Skill directories remain preserved. Preserved Skills are reported for review.

## Immutable resource staging

The Release workflow input `stage_dependency_mirror=true` runs only the dependency staging job. The job reads the committed manifest and uploads public upstream resources to R2 and the existing website download directory. Application packages, release records, updater feeds and website version data use separate workflow modes.

R2 creation uses a conditional write followed by a full hash check. The website server pulls verified R2 objects through the existing parallel range-download worker. SSH transfers only the temporary download manifest and worker script. The existing RailWise AI download alias resolves to the compatible storage namespace. Website finalization uses a new hard link into the content-addressed location. An existing matching object is verified and retained. Conflicting content fails staging. The job verifies every public download and records the source commit, manifest hash and resource hashes in `dependency-mirror-evidence.json`.

License and corresponding source resources are staged alongside the runtimes. Upstream identities and license declarations stay in the committed manifest, including uv MIT/Apache-2.0, CPython Python-2.0, python-build-standalone MPL-2.0 and Lark CLI MIT. Distributed runtime archives retain their upstream bundled notices.

## Verification

Run the focused tests with these commands.

```sh
node --test scripts/stage-managed-dependencies.test.mjs
npm test -- src/main/services/managed-dependency-download.test.ts src/main/services/managed-uv-runtime-service.test.ts src/main/services/managed-tool-service.test.ts
```

After the committed mirror has been staged, run the opt-in cold-cache check. The test creates an isolated temporary runtime, blocks all upstream fallback, installs uv, Python, Lark and companion Skills through production services, and writes a local evidence file. Credential access remains disabled throughout this installation check.

```sh
RAILWISE_DEPENDENCY_MIRROR_ACCEPTANCE=1 npm test -- src/main/services/managed-dependency-download.live.test.ts
```

The install check establishes dependency delivery and executable versions. Account authorization and platform business-operation acceptance have their own test evidence.
