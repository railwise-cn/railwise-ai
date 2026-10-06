# Stable release gate

Stable publication is a manually approved operation. Pushing a `v*` tag never
publishes a release, update feed, or website pointer.

Run **Release** with `workflow_dispatch` from the exact release tag and leave
`publish_release` disabled while producing a private candidate. The release
confirmation input is optional for candidate and maintenance runs; a Stable
run must set:

- `publish_release=true`;
- `release_confirmation=PUBLISH-STABLE-vX.Y.Z` for the exact selected tag;
- `release_evidence=docs/qa/release-gates/vX.Y.Z.json` (the `${tag}` default
  resolves to that path).

The evidence file must be committed on the tagged commit and must follow schema
version 1 described in `docs/qa/release-gates/README.md`. It must bind the
exact tag, package version, package identity, and source commit and record
`passed` status for the installed-package signature/notarization check,
computer-use UI review screenshots, functional checklist, updater round-trip,
and the independent senior-engineer AI review. Every referenced screenshot and
report must exist and be Git-tracked. The workflow validates this manifest and
the tag's resolved commit before building any publication artifact.

The final publication job is protected by the GitHub environment
`production-release`. Configure required reviewers for that environment in the
`railwise-cn/railwise-ai` repository. The environment approval is an additional
release decision; a green build or an AI review never substitutes for it.

Repository administrators should also enforce the following settings:

1. Remove write/admin access for accounts that are not current maintainers.
2. Protect `v*` tags so they cannot be force-moved or deleted by ordinary
   collaborators. Tag creation should be limited to the release maintainers.
3. Keep the default workflow token read-only. Only the `publish` job receives
   `contents: write` after the evidence gate and environment approval pass.
4. Require pull-request review and the workflow checks for changes to release
   workflows, release scripts, and this document.

These settings are intentionally external repository controls; this workflow
fails closed when the committed evidence or exact confirmation is missing.
