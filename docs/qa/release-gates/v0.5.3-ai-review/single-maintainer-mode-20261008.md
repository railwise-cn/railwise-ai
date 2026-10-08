# Single-Maintainer Publication Mode

Date: 2026-10-08. Type: governance audit and AI review, not package acceptance.

The user explicitly authorized restoring single-maintainer publication mode:
allow the current maintainer to merge and publish without another GitHub
maintainer. Existing explicit approval to publish 0.5.3 remains valid; this
policy change does not pass any outstanding package acceptance gate.

## Applied Configuration

Repository: `railwise-cn/railwise-ai`. Effective maintainer: `railwise-cn`.

| Control | Before | Verified After |
| --- | --- | --- |
| main PR reviews | One approval and CODEOWNER approval required | PR-based merge retained; zero approvals, no CODEOWNER or last-pusher approval requirement |
| Required CI | Three GitHub Actions checks, app 15368, strict | Unchanged |
| Administrator enforcement | Enabled | Unchanged |
| Force pushes and branch deletion | Disabled | Unchanged |
| Production reviewers | Only railwise-cn; self-review prohibited | Required reviewer removed |
| Production deployment policy | Only v* tags; admin bypass disabled | Unchanged |
| v* tag ruleset | Creation, update, deletion and non-fast-forward restricted | Active; only railwise-cn has the maintainer exception |
| Default workflow token | contents read; Actions cannot approve PRs | Unchanged |
| Package acceptance | Computer use, separate AI review, signing, notarization and real updater | Unchanged |

REST readback confirmed `required_approving_review_count=0`,
`require_code_owner_reviews=false`, `require_last_push_approval=false`, and
`dismiss_stale_reviews=true`. PR-based merging remains required, together with
all three required status checks with `strict=true` and
`enforce_admins.enabled=true`.
The production environment retained its branch policy and no longer contains
a `required_reviewers` rule. No collaborator gained write permission.

The required-review subresource was initially removed to clear the deadlock,
then restored with zero required approvals. The final readback above records
the effective policy, not the intermediate configuration.

PR #44 merged normally after CI passed, without an administrator bypass, at
`64b8ab24df502ac321e0f8365493539bf44ff18c` on 2026-10-08 05:34 UTC.
The merge's required CI also passed. A separate agent independently read back
the configuration and identified stale descriptions of human approval, which
are corrected alongside this record.

## Freeze Status

Private freeze run `37733154187` used source `64b8ab24` with publication disabled
and full stability enabled. It was cancelled before package construction because
the governance wording correction changes the frozen workflow/source tree.
The cancelled run is not acceptance evidence. The next freeze must use the new
protected-main commit after this correction passes CI and merges.

This audit does not authorize another public version, create a tag, publish a
Release, promote a feed, or update the official download page. The current
official version remains 0.5.2. Final 0.5.3 package and native updater acceptance
still must pass before the existing publication authorization can be executed.
