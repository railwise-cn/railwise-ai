# GitHub repository transfer — 2026-09-26

The user authorized transferring `wangjiawei508/WorkWise` to their `railwise-cn` personal account. GitHub now returns `railwise-cn/WorkWise` for repository ID `1268259206`; the old repository API path redirects to that same ID. The destination web session displayed the transfer-in-progress notice, then exposed the new repository's owner settings.

Verified after transfer:

- Default branch remains `main`, remote HEAD `bea9a0484ebbdf4b1abca89220ca45bba2c3eb1f`.
- PR [#28](https://github.com/railwise-cn/WorkWise/pull/28) remains open on `codex/railwise-survey-convergence`.
- The latest public release is still [v0.5.0](https://github.com/railwise-cn/WorkWise/releases/tag/v0.5.0), with Windows x64, macOS Intel, and macOS Apple Silicon installers.
- Local `origin` uses the new owner with the existing SSH host alias. `git ls-remote` successfully read HEAD, the working branch and `v0.5.0`.
- All 15 repository Actions secret names remain present. Secret values were not read or changed; presence does not prove credentials remain operational.
- The destination owner's web settings show Actions enabled, allowing all actions/reusable workflows. Default workflow token permissions remain read-only. These settings were inspected without modification.
- The existing CLI account `wangjiawei508` retains push access but no longer has admin access. The saved `railwise-cn` CLI credential is invalid; its web session works. No credentials were replaced.

## Address migration

| Item | Before → after | Compatibility / user action |
| --- | --- | --- |
| Repository, issue/help links, README | Old owner → `railwise-cn/WorkWise` | GitHub redirects the old repository URL; local origin updated. |
| GitHub updater fallback and release build target | Old owner → new owner | Default stable feed remains the existing official generic feed. No feed was promoted. |
| Official catalog repository locations | Same repository under new owner | Plugin IDs, defaults, installed plugins, MCP/Skill configurations, credentials and user data are unchanged; no reinstall required. |
| Website source links | Old owner → new owner | Source updated only; no website deployment or download metadata publication in this transfer step. |
| Application identity and audit provenance | Preserved | Bundle IDs, package name, data directories, historical source commits and signed audit records are not renamed. |

This change prepares the new repository address for the separately authorized 0.5.1 release. It does not claim that 0.5.1 has been built, accepted or published.

## Follow-up rename — 2026-09-26

The owner web session renamed the same repository to `railwise-cn/railwise-ai`. The GitHub API confirms repository ID `1268259206` is unchanged and the existing CLI account retains push permission. Local origin now targets `railwise-cn/railwise-ai.git` through the existing SSH host alias. Current README/help/catalog/updater/build/website-source URLs follow the new address; historical evidence and pinned specialist provenance remain unchanged. PR #28 is now https://github.com/railwise-cn/railwise-ai/pull/28.

Desktop and internal Runtime manifests and lockfiles prepare version **0.5.1**. This is release preparation, not a public release or acceptance result.
