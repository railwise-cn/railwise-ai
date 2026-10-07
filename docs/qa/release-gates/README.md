# Public release evidence

Files in this directory are the committed acceptance manifest for a public
Stable release. The manifest is read by
[`scripts/verify-release-approval.mjs`](../../../scripts/verify-release-approval.mjs)
before the publication job can build or upload public artifacts.

Do not create a manifest for a release that has not completed the required
installed-package review. A green unit test, build, candidate run, old
screenshot, manual website download, or mocked updater check cannot be used as
the public-release evidence.

The file name must be `vX.Y.Z.json` and the JSON must contain:

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
      "bundleId": "com.example.product",
      "artifactSha256": "64-character sha256"
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
      "path": "docs/qa/release-gates/vX.Y.Z/updater-round-trip.md"
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
professional signature, or human approval. The environment approval by the
current release maintainer remains a separate required decision.

The repository intentionally contains no passing `v0.5.2.json`: the historical
0.5.2 publication predates this gate and must not be backfilled with fabricated
evidence.
