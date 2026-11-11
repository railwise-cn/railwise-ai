# Stable release gate

Stable publication requires the user's authorization for the release being
prepared. Pushing a `v*` tag leaves publication under the explicit Release
workflow inputs. The current maintainer may review, merge and publish in the
single-maintainer mode authorized by `AGENTS.md`.

Run required CI, focused tests and a production build. Build the final
public-identity packages privately and retain their exact source, run, attempt,
artifact IDs, archive digests and file hashes. Install those same packages and
verify version, bundle identity, signature status and applicable notarization.
For visual changes, inspect the packaged application's affected primary
language, theme and window size. Changes to updater or download paths require
one real updater smoke against the exact package.

The current exact-build path uses `Release` (`release.yml`) from the selected
source ref with these inputs when updater acceptance is required.

- `candidate_only=false`
- `publish_release=false`
- `exact_package_updater_smoke=true`
- `skip_stability=true`

This path retains private public-identity artifacts, Windows installation/UI
evidence and the same-run macOS updater evidence. The earlier
`candidate_only=true` / `prepare_public_artifacts=true` path remains supported
for existing release evidence. Additional stability runs, UI matrices,
screenshot archives and separate AI reviews are optional unless the user's
request or a concrete change requires them.

Verify the immutable artifact archive digests and each installer's, updater
package's and metadata file's hashes and sizes. The installed UI-reviewed ASAR
must match the selected package. When updater acceptance applies, its target
and updated installation must match that same ASAR. Retain the original
machine/native report bytes and immutable workflow references. The gate checks
GitHub API provenance, archive digests and report byte equality. This preserves
the binding between the accepted package and the bytes published later.

Commit the release evidence under `docs/qa/` and use schema version 2 for current
exact-build records. Legacy schema version 1 evidence remains readable. The
reviewed package source must be an ancestor of the exact release tag. Later QA
evidence commits can retain the same package source. The verifier also has an
explicit allowlist of package-external evidence and policy files. Keep that
allowlist narrow and verify every post-build change against it. Application,
version, dependency, build or packaged-content changes require a corresponding
new package and acceptance.

Once the applicable acceptance is complete and covered by the user's release
authorization, create the tag on the evidence commit and dispatch `Release`
from that tag with the exact publication values.

- `publish_release=true`
- `candidate_only=false`
- `release_confirmation=PUBLISH-STABLE-vX.Y.Z`
- `release_evidence=docs/qa/release-gates/vX.Y.Z.json`

The confirmation value records the authorized version in the workflow. The
evidence file must be committed in the exact tag tree and bind the version,
public identity, reviewed source, build run/attempt, immutable artifact
IDs/digests and all eight release files. Supplied reports and screenshots must
also be committed. Publication validates source ancestry, trusted runs and
actual downloaded bytes, then consumes the accepted artifacts without a build
step.

Windows Authenticode verification currently accepts `Valid` or `NotSigned` and
records the actual status. Invalid or indeterminate signatures fail the check.
The existing unsigned Windows policy must remain visible in release evidence.
macOS signature and notarization checks follow the selected public package's
requirements.

Publication prepares the release notes and draft, uploads the three installers,
and downloads and byte-compares them against the reviewed files before changing
any official latest pointer. An already-published same-tag GitHub Release is
refused; its notes and assets must not be replaced by a rerun.

Immediately before promotion, the job saves the actual R2 and pinned-SSH website
Stable and legacy metadata. Those pointers must consistently select one prior
version, and the target must be newer. The previous website archive must match
the saved metadata and pass its file checksums; the saved R2 package references
must resolve to bytes with the recorded SHA-512 and size. Conflicting references
fail validation. Promotion rechecks the old pointers and immutable target
metadata before starting. `PREVIOUS_TAG` is only a release-notes input; it is
not a rollback target.

Publication, rollback, official-page deployment and cache repair share the
repository-wide `production-release-public` concurrency group. Transactional
promotion disables retention so recovery cannot lose the prior archive.
Recovery restores only metadata equal to this attempt's saved old or intended
new bytes, rechecks ownership after archive validation, and verifies exact old
bytes afterward. This includes partial updater-YAML writes even when
`latest.json` still selects the old version; a changed version or same-version
mutation cannot be overwritten.

After a final GitHub publication request, including a timeout or error, query
the actual release state. A published release is reconciled only after checking
the three accepted installers by size and SHA-256, downloading and hashing them
again, and confirming both official surfaces still select the intended bytes.
An authoritative draft/absent state permits recovery; unknown state blocks
automatic rollback. Snapshot and result reports are retained as a private
Actions artifact, including failures. Incomplete recovery requires reconciliation
before another publication attempt. Recovery never deletes or rewrites a
published GitHub Release.

The final publication job is protected by the GitHub environment
`production-release`. In the single-maintainer mode authorized by `AGENTS.md`,
the environment has no required reviewer. Branch protection retains required
CI, strict status checks, admin enforcement and tag protection. The applicable
package checks, immutable evidence and user release authorization continue to
apply. Any supplied simulated engineering or domain review must identify itself
as AI review and describe its actual scope. Licensed, regulatory, vendor and
human professional sign-off require their own evidence.

When maintainers or repository governance change, review CODEOWNER and
environment reviewer settings explicitly.

Repository administrators should also enforce the following settings:

1. Remove write/admin access for accounts that are not current maintainers.
2. Protect `v*` tags so they cannot be force-moved or deleted by ordinary
   collaborators. Tag creation should be limited to the release maintainers.
3. Keep the default workflow token read-only. Only the `publish` job receives
   `contents: write` after the evidence gate passes and the selected tag is
   admitted by the production environment's deployment policy.
4. Require the workflow checks for changes to release workflows, release
   scripts and this document, following the configured single-maintainer
   approval policy.

These settings are intentionally external repository controls; this workflow
fails closed when the committed evidence or exact confirmation is missing.
