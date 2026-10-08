# GitHub release-control hardening audit — 2026-10-06

This record captures the repository controls that were checked after the
release-control changes landed. It is an operational audit record, not a
release approval and not evidence that a new version was published.

The human PR/CODEOWNER and production-reviewer requirements below are a
historical snapshot. They were superseded on 2026-10-08 by the explicitly
authorized [single-maintainer policy](../qa/release-gates/v0.5.3-ai-review/single-maintainer-mode-20261008.md).
PR-based merging and the other protections remain required under that policy.

## Scope and remote snapshot

- Repository: `railwise-cn/railwise-ai`
- Initial remote snapshot: 2026-10-06 09:19 UTC (17:19 Asia/Shanghai)
- Final permission/environment recheck: 2026-10-06 09:28 UTC (17:28 Asia/Shanghai)
- Default branch: `main`
- Main HEAD at the initial snapshot: `c20d68d47a1b7b996d9601bea0e2866eb65c4589`
- Final main HEAD after audit PR #41: `5e81cccf32a472f951977631a4bcf99a6dddab4c`
- Open pull requests at audit time: none
- Public release state: `v0.5.2` remains the existing published release; no
  tag, release, Stable feed, or official download-page pointer was changed by
  this audit.

## Repository identity and permissions

The active GitHub CLI/API identity used for the checks was `railwise-cn`.
The collaborators listing returned only `railwise-cn` with administrator,
maintain, push, pull, triage, and admin permissions. The explicit permission
endpoint for `wangjiawei508` returned `permission=read` and `push=false`; the
account therefore cannot push branches, tags, or force-update the repository.
GitHub's listing endpoint does not include that read-only account in the
owner's response, so the permission endpoint is the authoritative check used
here. The repository `CODEOWNERS` file on `main` intentionally names only
`@railwise-cn`; the attempted read-only reviewer entry was not merged and is
not represented as an effective reviewer.

The `main` branch protection record currently has:

- strict required checks for the three `Quality` jobs;
- one required approving review and required CODEOWNER review;
- stale-review dismissal;
- force-push and branch-deletion prohibition;
- administrator enforcement disabled (`enforce_admins=false`).

The last item is an explicit residual bypass: repository administrators can
still merge around branch protection. PRs 39 and 40 were merged by the
administrator while GitHub still reported `reviewDecision=REVIEW_REQUIRED`.
Their Quality checks passed, but they must not be described as having received
an effective CODEOWNER approval.

## Release tag protection

Ruleset `24564506` (`Protect release tags`) is active for
`refs/tags/v*`. It blocks tag creation, updates, deletion, and non-fast-forward
moves. The only bypass actor is `railwise-cn` (GitHub user id `263335082`,
`bypass_mode=always`). This keeps ordinary collaborators from creating or
rewriting release tags while retaining an explicit maintainer break-glass path.

## Workflow and environment controls

`main:.github/workflows/release.yml` is `workflow_dispatch` only; it has no
`push.tags` trigger. The workflow defaults to `permissions: contents: read`.
The public `publish` job is the only job that receives `contents: write`, and
it is gated by the exact tag, `publish_release=true`, the matching
`PUBLISH-STABLE-vX.Y.Z` confirmation, a committed release evidence manifest,
and the `production-release` environment.

The `production-release` environment exists as id `23559877952` and has:

- required reviewer: `railwise-cn`;
- `can_admins_bypass=false`;
- no wait timer;
- no deployment branch restriction.

The standalone website cache-repair workflow is also `workflow_dispatch` only.
Its `apply` path uses `production-release`; its `inspect` path is read-only and
uses the explicitly created `release-inspection` environment (id
`23566793280`). That environment has `can_admins_bypass=false`, no secrets, no
required reviewers, and no deployment protection rules because the job only
inspects server configuration. Keeping the environment named and explicit
prevents a typo from silently creating an unrelated environment.

Repository Actions settings were checked as follows:

```json
{
  "enabled": true,
  "allowed_actions": "all",
  "sha_pinning_required": false,
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false
}
```

The read-only default token and disabled workflow-based review approval are
required controls and are active. `allowed_actions=all` and disabled SHA
pinning remain hardening opportunities; changing them safely requires first
inventorying every third-party action reference and pinning compatible SHAs.
They were intentionally not changed in this audit because an unscoped change
could break the quality and release workflows.

## Verification evidence

- PR 39 merged as `4e59ad8b6e42ee02a223d6f3eb67363b1b21ca30`; all three required
  Quality checks passed. GitHub still reported `REVIEW_REQUIRED` at merge time.
- PR 40 merged as `c20d68d47a1b7b996d9601bea0e2866eb65c4589`; all three required
  Quality checks passed. GitHub still reported `REVIEW_REQUIRED` at merge time.
- PR 41 (this audit record) merged as `5e81cccf32a472f951977631a4bcf99a6dddab4c`; all three required
  Quality checks passed. It also used the administrator bypass because no effective
  CODEOWNER approval was available.
- `v0.5.2` remains the published release (published 2026-10-05 13:07 UTC).
- No `v0.5.3` tag, release, feed promotion, or website Stable-pointer update
  was performed as part of this work.

## Follow-up controls

1. Keep administrator bypass exceptional and record the reason whenever it is
   used; require a real CODEOWNER approval for normal release-control changes.
2. Inventory and SHA-pin external Actions, then restrict `allowed_actions` to
   the reviewed set in a separate change with its own Quality run.
3. Keep `wangjiawei508` at read permission unless a future role explicitly
   requires a different access level; if changed, verify it cannot bypass tag
   or environment protection.
