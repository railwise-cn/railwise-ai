# Public release evidence

Files in this directory are the committed acceptance manifest for a public
Stable release. The manifest is read by
[`scripts/verify-release-approval.mjs`](../../../scripts/verify-release-approval.mjs)
before the publication job can download and upload the exact reviewed artifacts.
Publication does not rebuild the application.

Do not create a manifest for a release that has not completed the required
installed-package review. A green unit test, build, candidate run, old
screenshot, manual website download, or mocked updater check cannot be used as
the public-release evidence.

The file name must be `vX.Y.Z.json`. The following is a schema example, not
acceptance evidence: replace every version, ID, size, hash and path with the
observed values of the successful frozen build and installed-package review.
Never copy the illustrative `passed` statuses into a real manifest before the
corresponding checks have passed.

```json
{
  "schemaVersion": 1,
  "scope": "public-release",
  "status": "passed",
  "release": {
    "tag": "vX.Y.Z",
    "version": "X.Y.Z",
    "sourceHead": "40-character commit sha of the reviewed package source"
  },
  "package": {
    "version": "X.Y.Z",
    "identity": {
      "bundleId": "com.wangjiawei508.workgpt",
      "artifactSha256": "64-character sha256 of the exact installed DMG, ZIP or EXE",
      "asarSha256": "64-character sha256 of the actual UI-reviewed installation app.asar"
    },
    "reviewedBuild": {
      "repository": "railwise-cn/railwise-ai",
      "workflowPath": ".github/workflows/release.yml",
      "sourceHead": "same 40-character commit sha as release.sourceHead",
      "runId": 1,
      "runAttempt": 1,
      "publicIdentity": {
        "bundleId": "com.wangjiawei508.workgpt",
        "packageName": "workwise",
        "productName": "RailWise AI"
      },
      "artifacts": [
        {
          "name": "release-mac",
          "id": 1,
          "digest": "sha256:64-character immutable artifact archive digest from GitHub"
        },
        {
          "name": "release-win",
          "id": 2,
          "digest": "sha256:64-character immutable artifact archive digest from GitHub"
        }
      ],
      "files": [
        {
          "name": "WorkWise-X.Y.Z-mac-arm64.dmg",
          "platform": "darwin-arm64",
          "artifact": "release-mac",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "WorkWise-X.Y.Z-mac-arm64.zip",
          "platform": "darwin-arm64",
          "artifact": "release-mac",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "WorkWise-X.Y.Z-mac-x64.dmg",
          "platform": "darwin-x64",
          "artifact": "release-mac",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "WorkWise-X.Y.Z-mac-x64.zip",
          "platform": "darwin-x64",
          "artifact": "release-mac",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "latest-mac.yml",
          "platform": "darwin",
          "artifact": "release-mac",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "WorkWise-X.Y.Z-win-x64.exe",
          "platform": "win32-x64",
          "artifact": "release-win",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "WorkWise-X.Y.Z-win-x64.exe.blockmap",
          "platform": "win32-x64",
          "artifact": "release-win",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        },
        {
          "name": "latest.yml",
          "platform": "win32-x64",
          "artifact": "release-win",
          "size": 1,
          "sha256": "64-character lowercase sha256"
        }
      ]
    },
    "signature": { "status": "passed" },
    "notarization": { "status": "passed" },
    "screenshots": [
      "docs/qa/release-gates/vX.Y.Z/overview.png"
    ]
  },
  "acceptance": {
    "functionalChecklist": {
      "status": "passed",
      "path": "docs/qa/release-gates/vX.Y.Z/functional-checklist.md"
    },
    "uiComputerUse": {
      "status": "passed",
      "path": "docs/qa/release-gates/vX.Y.Z/cua-review.md"
    },
    "updaterRoundTrip": {
      "status": "passed",
      "path": "docs/qa/release-gates/vX.Y.Z/updater-round-trip.md",
      "machineReportPath": "docs/qa/release-gates/vX.Y.Z/frozen-updater.json",
      "nativeReportPath": "docs/qa/release-gates/vX.Y.Z/native-updater.json",
      "workflowRun": {
        "repository": "railwise-cn/railwise-ai",
        "workflowPath": ".github/workflows/frozen-release-updater-acceptance.yml",
        "sourceHead": "same 40-character commit sha as package.reviewedBuild.sourceHead",
        "runId": 3,
        "runAttempt": 1,
        "artifact": {
          "id": 3,
          "name": "frozen-updater-arm64-3",
          "digest": "sha256:64-character immutable updater artifact archive digest from GitHub"
        }
      }
    },
    "independentSeniorEngineerReview": {
      "status": "passed",
      "reviewerType": "AI review",
      "reviewRole": "senior engineering-survey / software / product-design review",
      "path": "docs/qa/release-gates/vX.Y.Z/independent-ai-review.md"
    }
  }
}
```

`package.reviewedBuild` is required. Its two artifact IDs must be distinct and
identify unexpired immutable Actions artifacts from the same successful run and
attempt. The file list must contain exactly the eight files above with actual
positive byte sizes and lowercase SHA-256 values. The artifact archive digest
is different from a DMG, ZIP, EXE or metadata-file hash; retain both. The
`package.identity.artifactSha256` must equal the hash of a reviewed installer or
updater package in this list. `package.identity.asarSha256` is also required: it
is the 64-character hash measured from `app.asar` in the actual computer-use
reviewed installation. It must equal both `targetAsarSha256` and
`installedAsarSha256` in the committed frozen-updater machine report. This binds
the UI inspection and native update to the same compiled application and rejects
an independently rebuilt package with a similar version/source label. Legacy
package and bundle identifiers preserve
updater compatibility; the source and publication repository is
`railwise-cn/railwise-ai`.

`acceptance.updaterRoundTrip.workflowRun` is also required. It identifies the
separate successful native updater run, not the package-freeze run. Its source
must equal `package.reviewedBuild.sourceHead`; its artifact name is exactly
`frozen-updater-${arch}-${runId}`, with `arch` taken from the actual machine
report. Record the artifact's positive ID and `sha256:` archive digest from
GitHub. The two committed report files must be the exact retained bytes in this
immutable artifact, including its redaction and newlines; do not rewrite,
pretty-print or recreate them locally.

The machine report contains the runner's seven-field `provenance` object:

```json
{
  "repository": "railwise-cn/railwise-ai",
  "workflowPath": ".github/workflows/frozen-release-updater-acceptance.yml",
  "workflowRef": "railwise-cn/railwise-ai/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/main",
  "workflowSha": "same frozen 40-character source sha",
  "sourceHead": "same frozen 40-character source sha",
  "runId": 3,
  "runAttempt": 1
}
```

The machine report also requires `nativeReportSha256`, the lowercase SHA-256 of
the exact retained `native-updater.json` bytes. The gate matches all seven
provenance fields to `workflowRun` and the frozen source, checks that native
digest, and verifies actual GitHub repository/workflow IDs, run source and
attempt, protected-main ancestry, successful native-run and retention steps,
and the unexpired artifact's identity. It downloads the immutable updater
archive, checks its digest, and byte-matches both `frozen-updater.json` and
`native-updater.json` against the committed reports. REST responses do not need
to contain the nonexistent `workflow_ref` field; the trusted runner's recorded
workflow ref/SHA and actual API fields provide the binding. An edited JSON
report, a passing status string, or an unrelated successful run fails this gate.

## Freeze, inspect and publish the same bytes

1. Complete the release-control code review and required checks, then merge to
   protected `main` through a PR under the authorized single-maintainer mode.
   No second GitHub maintainer approval is required. Dispatch `release.yml`
   on that exact main commit with `candidate_only=true`,
   `prepare_public_artifacts=true`, `publish_release=false`, and
   `skip_stability=false`. The complete two-hour stability and three-client
   verification jobs must succeed. This is a private build operation; it does
   not authorize or perform a public release or feed promotion.
2. Record the run ID, attempt, source SHA and the immutable GitHub artifact IDs
   and archive digests. Download those exact IDs. Each extracted artifact has
   its own `reviewed-build.json` receipt, generated by the build job. Preserve
   the receipts with the acceptance evidence and combine their observed file
   lists into `package.reviewedBuild`; do not regenerate a receipt from a local
   rebuild or substitute a similarly named artifact from another run.
3. Verify the downloaded receipts and files before installation. Each receipt
   binds the repository, workflow path/ref/SHA, run/attempt, source SHA, version,
   public identity, freeze inputs and file hashes/sizes. Its `workflowRef` must
   be exactly `railwise-cn/railwise-ai/.github/workflows/release.yml@refs/heads/main`,
   and its `workflowSha` must equal the reviewed `sourceHead`. Remote provenance
   is checked using actual GitHub REST run/workflow fields and protected-main
   ancestry; a missing REST `workflow_ref` is not evidence of a different source.
   `release-mac` must have
   exactly its five listed files plus its receipt; `release-win` must have its
   three files plus its receipt. Verify the packaged provenance, stable updater
   URL, signing and notarization. `verifyDownloadedReleaseArtifacts` in
   `scripts/verify-reviewed-release-artifacts.mjs` checks the complete set before
   copying any verified files to a new output directory.
4. Install the exact reviewed package without modifying its bundle. Use an
   isolated acceptance profile, record installed version/source and ASAR hash,
   and complete computer-use inspection of the supported language/theme/window
   matrix, professional import/calculation/delivery flows, report readback,
   keyboard/focus/state announcements, error recovery and restart. Archive
   screenshots, checklist, signing/notarization diagnostics and findings. A
   separately identified candidate bundle cannot close this public-identity
   package gate.
5. For 0.5.3, dispatch `frozen-release-updater-acceptance.yml` on protected main
   with the exact `reviewedBuild` JSON as its `reviewed_build` input. It consumes
   the frozen target ZIP and official pinned 0.5.2 baseline through a temporary
   default-trust HTTPS feed, performs the native updater install/restart and
   verifies historical-data readback. Retain `frozen-updater.json`,
   `native-updater.json` and the seed/readback reports. The installed target ASAR
   must equal the frozen ZIP's ASAR and the UI-reviewed installation. A
   same-source version probe, mocked updater or manual download does not replace
   this round trip. Report the measured preservation scope, including any
   historical artifacts or configuration classes not exercised. Commit the
   actual machine reports and reference them through the required
   `acceptance.updaterRoundTrip.machineReportPath` and `nativeReportPath`, in
   addition to the human-readable `path`. Record the observed updater
   `workflowRun`, its exact immutable artifact ID/name/digest, the machine's
   seven-field `provenance`, and `nativeReportSha256`. Download the artifact by
   ID while it remains unexpired and preserve its retained report bytes exactly.
   The gate authenticates the actual GitHub API run/job/step/artifact provenance,
   verifies the downloaded archive digest and byte-matches both committed
   reports; it also checks the exact baseline,
   reviewed build, signing, nonce, ASAR equality, data readback, owned-resource
   cleanup and native updater stages; prose claiming success is insufficient.
6. Have a separate senior-engineer-mode agent review the exact installation,
   screenshots, workflows and numerical/reporting evidence. Label the result
   `AI review`. Resolve all failed or incomplete required acceptance before
   creating a passing manifest. Authentic vendor/SUC interoperability,
   regulatory conformity and professional signatures require their own evidence.
7. Commit the completed manifest and all referenced evidence under `docs/qa/`.
   Only after exact-version/action user authorization, package acceptance and
   the required CI checks pass under single-maintainer mode, tag the evidence
   commit and dispatch publication
   with `publish_release=true`, `candidate_only=false`,
   `release_confirmation=PUBLISH-STABLE-vX.Y.Z`, and the committed manifest
   path. Publication verifies and downloads the recorded immutable artifact IDs,
   validates every receipt/file, and publishes those bytes without rebuilding.
   Verify public Release assets, stable feed, official page and update behavior.

`release.sourceHead` identifies the frozen source used to build the installed
package that was reviewed. Commit the acceptance evidence after that review,
then create the approved release tag on the evidence commit. The verifier
requires the reviewed source to be a resolvable ancestor of the exact tag, and
allows only `docs/qa/` changes in every intervening commit, including merge
histories. Runtime, build, dependency, workflow, version, configuration or other
documentation changes require a newly frozen package and renewed acceptance.
Changing runtime code and reverting it before tagging also fails this check.
This avoids requiring an evidence manifest to contain the hash of its own
commit while preserving the reviewed runtime/build/configuration tree.

The workflow must check out the exact tag with full Git history. `GITHUB_SHA`
continues to identify that tag's commit; it need not equal the earlier reviewed
source commit. Version and manifest JSON are read from the committed tag tree.
Every screenshot and report path must exist in the repository as a regular file
committed in that same tag. A staged addition, a symlink, or a working-copy edit
cannot substitute for tagged evidence. The independent review must be labeled as AI review; it cannot be
presented as a licensed vendor result, regulatory conformity certificate,
professional signature, or human approval. In the user-authorized
single-maintainer mode, human PR/CODEOWNER approvals and a production environment
reviewer are not required. Strict required CI, tag protection, the production
environment's tag deployment policy, immutable package evidence, installed-package
acceptance, and exact-version user approval remain required. Adding a second
maintainer should be followed by a deliberate review of the governance policy.

The repository intentionally contains no passing `v0.5.2.json`: the historical
0.5.2 publication predates this gate and must not be backfilled with fabricated
evidence.
