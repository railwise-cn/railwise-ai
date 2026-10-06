# GitHub release control hardening — 2026-10-06

Repository: `railwise-cn/railwise-ai`  
Operator: `railwise-cn` (repository administrator)

This record describes the repository controls applied after the historical
`v0.5.2` tag was pushed by `wangjiawei508` and automatically published by the
old tag-triggered workflow. It records controls only; it does not approve or
publish a release.

## Current controls

- `wangjiawei508` has no write permission. The collaborator permission API
  returns `read`; the owner is `railwise-cn`.
- Ruleset **Protect release tags** (`24564506`) is active for
  `refs/tags/v*`. It blocks tag creation, update, deletion, and non-fast-forward
  changes. The only bypass actor is the `railwise-cn` user (`263335082`).
- Environment **production-release** (`23559877952`) requires the
  `railwise-cn` reviewer and has `can_admins_bypass=false`.
- `main` requires a pull request, one approval, stale-review dismissal,
  CODEOWNERS review, and the Quality checks. Force pushes and branch deletion
  are disabled. Administrative bypass remains available to the repository
  owner so recovery is possible when the required checks themselves are
  unavailable.
- Actions default workflow permissions are read-only. The release workflow
  grants `contents: write` only to its gated `publish` job.

## Workflow control

The release workflow no longer listens for `push` events on `v*` tags. Stable
publication requires `workflow_dispatch`, `publish_release=true`, the exact
`PUBLISH-STABLE-vX.Y.Z` confirmation, a tag-bound and Git-tracked acceptance
manifest, successful build gates, and the protected `production-release`
environment. Candidate and maintenance paths remain private and do not publish
Stable pointers.

The evidence verifier also checks that the tag resolves to the supplied commit,
the package version and identity match, all required statuses are `passed`, and
screenshots/reports exist in `docs/qa/release-gates/` and are tracked by Git.

## Historical boundary

`v0.5.2` was published before these controls. Its tag and Release are retained
for audit and are not rewritten. No fabricated `v0.5.2` passing manifest is
added. The hardening change does not create, move, or republish any tag or
Release.

## Verification commands

The settings were re-read through the GitHub API after applying them:

```text
gh api repos/railwise-cn/railwise-ai/collaborators/wangjiawei508/permission
gh api repos/railwise-cn/railwise-ai/rulesets/24564506
gh api repos/railwise-cn/railwise-ai/environments/production-release
gh api repos/railwise-cn/railwise-ai/branches/main/protection
gh api repos/railwise-cn/railwise-ai/actions/permissions
```

The local workflow checks are `npm run test:release-gate` (7/7),
`node --check scripts/verify-release-approval.mjs`, and `git diff --check`.
