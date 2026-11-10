# Typed Feishu/Lark execution boundary

The provider is an independent RailWise adapter around the official `larksuite/cli` executable managed by the main process. It never accepts arbitrary command lines, executable paths, shell fragments or API URLs from model arguments. DingTalk is a separate provider and is never routed to this adapter.

The CLI protocol was checked against upstream commit `1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a` on 2026-11-10:

- [Task list](https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/skills/lark-task/references/lark-task-get-my-tasks.md): `task +get-my-tasks --complete=false`.
- [Task completion](https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/shortcuts/task/task_complete.go): target GUID, nonzero completion time and `done` state.
- [Approval catalog](https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/internal/registry/catalog/services/approval.json): task query, instance detail, approve/reject and exact scopes.
- [Authorization status](https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/cmd/auth/status.go) and [device login](https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/cmd/auth/login.go): structured identity and granted user scope parsing; no-wait/device-code flow.

`auth status` can exit zero with no usable user identity. Exit status alone is therefore insufficient. The adapter requires the diagnosed user identity, known Feishu/Lark brand and actual user scopes. Unknown/old CLI output fails closed and does not register tools. Existing user disables remain effective. Scope changes/removal clear stale capability state.

Writes always use the existing approval service even under the runtime `auto` policy. Approval cards contain the exact task/instance IDs. Only after approval does the provider add the CLI's required `--yes` flag. The model never receives credentials or the device code. The main process holds a single expiring device authorization, validates the official HTTPS verification URL, then persists a fresh diagnosed snapshot and requests a Runtime hot refresh without restarting active tasks.

Mutation success requires a target-specific observed remote state. Task completion checks the GUID and completion timestamp. Approval changes read the exact instance and compare the exact approval task status. Failed/absent readback produces `outcome_unknown`; it does not rerun the write. Persistent receipts retain bounded evidence metadata and redact remote form contents and comments.

Focused automated tests cover argument validation, scope filtering, explicit write denial, approval readback, wrong target, malformed responses, bot-only identity, private device-code flow, persisted evidence and capability refresh. These use synthetic fixtures. No live user account, real approval, or real todo mutation was executed during this implementation. Real configured-account and exact-package acceptance remain integration checks; fixture tests are not substitutes for those checks.
