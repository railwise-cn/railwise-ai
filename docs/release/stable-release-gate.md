# Stable release gate

Stable publication is a manually approved operation. Pushing a `v*` tag never
publishes a release, update feed, or website pointer.

Freeze the final public-identity package privately before creating a release
tag. After the implementation and release controls have passed review and
merged to protected `main`, dispatch **Release** (`release.yml`) from the exact
reviewed main commit with:

- `candidate_only=true`;
- `prepare_public_artifacts=true`;
- `publish_release=false`;
- `skip_stability=false`.

The complete two-hour stability and three-client verification jobs must pass.
This operation produces immutable private Actions artifacts and build receipts;
it does not publish a Release, promote a feed, or update the website. Download
the exact artifact IDs, verify their archive digests, receipts, file hashes and
signatures, then install those same bytes for acceptance. A candidate with a
separate bundle identity or a local rebuild cannot substitute for the final
public-identity package.

Complete and record installed-package signature/notarization, computer-use UI
inspection, the functional checklist, the official 0.5.2-to-frozen-0.5.3 native
updater round trip, and the independent senior-engineer AI review. The updater
reports must come from the trusted
`frozen-release-updater-acceptance.yml` workflow on the same frozen main source.
Commit their immutable run/artifact reference and the unmodified retained
machine/native reports. The gate verifies real GitHub API provenance, downloads
the immutable artifact, checks its archive digest, and byte-matches both reports
against the committed evidence. An old screenshot, same-source version probe,
manual download, prose declaration, or mocked updater is insufficient.

After all required acceptance passes, commit the evidence and manifest under
`docs/qa/`. Only `docs/qa/` evidence changes may follow the frozen source before
the release tag, including intervening merge histories. Changes to runtime,
build, version, dependencies, workflows, configuration, or other documentation
require a new freeze and acceptance. The reviewed source must be an ancestor of
the exact release tag; the tag's evidence commit need not equal the earlier
frozen source commit.

With explicit user approval naming the exact public version and action, create
the tag on the evidence commit and run **Release** with `workflow_dispatch` from
that exact tag. A Stable run must set:

- `publish_release=true`;
- `candidate_only=false`;
- `release_confirmation=PUBLISH-STABLE-vX.Y.Z` for the exact selected tag;
- `release_evidence=docs/qa/release-gates/vX.Y.Z.json` (the `${tag}` default
  resolves to that path).

The evidence file must be a regular file committed in the exact tag tree and
follow schema version 1 in `docs/qa/release-gates/README.md`. It must bind the tag,
package version, public identity, frozen source, build run/attempt, immutable
artifact IDs/digests and all eight file hashes/sizes. Every referenced screenshot
and report must also be committed in that tree. The UI-reviewed installed ASAR
hash must equal both the frozen updater target and the updated installation.
Publication validates the manifest, source ancestry, trusted runs, receipts and
downloaded bytes. It consumes the reviewed artifacts **without rebuilding**;
tagging cannot replace, relabel or regenerate the accepted package.

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
`production-release`. This repository currently operates in **single-maintainer
mode**, explicitly authorized for the 0.5.3 release: the environment has no
required reviewer, and branch protection keeps CI, strict status checks, admin
enforcement, and tag protection while requiring no human PR approval. The
computer-use inspection, separate senior-engineer-mode AI review, immutable
evidence, and explicit user release approval remain mandatory. AI review is
product and software acceptance evidence, not a human approval, licensed
vendor/SUC interoperability result, regulatory certificate or professional
signature.

This mode is a governance choice for a repository with one effective maintainer;
it is not a claim that the package has independent human approval. If a second
maintainer is added later, restore CODEOWNER and environment reviewer gates
before the next consequential release.

Repository administrators should also enforce the following settings:

1. Remove write/admin access for accounts that are not current maintainers.
2. Protect `v*` tags so they cannot be force-moved or deleted by ordinary
   collaborators. Tag creation should be limited to the release maintainers.
3. Keep the default workflow token read-only. Only the `publish` job receives
   `contents: write` after the evidence gate passes and the selected tag is
   admitted by the production environment's deployment policy.
4. Require the workflow checks for changes to release workflows, release
   scripts, and this document. Record a separate AI review before merging;
   human PR and CODEOWNER approvals are not required in single-maintainer mode.

These settings are intentionally external repository controls; this workflow
fails closed when the committed evidence or exact confirmation is missing.
