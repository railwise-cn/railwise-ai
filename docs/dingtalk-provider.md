# DingTalk Provider Boundary

RailWise offers the official DingTalk DWS device-authorization flow as the primary connection path. The previous direct `api.dingtalk.com` OpenAPI adapter remains available under advanced enterprise settings. These are two backends of the DingTalk Provider; neither substitutes Feishu/Lark or exposes a free-form CLI to the model.

## Official DWS connection

The managed dependency is pinned to [DingTalk DWS v1.0.67](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.67), source `63a7c4906c7dee10750011ea309b9eb78abb7eb0` (Apache-2.0). Installation downloads a platform-specific release archive and verifies its fixed SHA-256 before extraction. It does not execute `curl | sh` or use an unverified third-party proxy. The official Gitee mirror can be used only for the same pinned asset and digest.

After an explicit Connect action, RailWise runs the managed executable with fixed `auth login --device` arguments, keeps that original process while the user authorizes, and displays only an allowlisted official verification link and public device code. No app secret is requested in chat. Some organizations require administrators to enable CLI access; the application cannot approve that permission itself.

Managed DWS uses isolated configuration and credential storage through `DWS_CONFIG_DIR`, `DWS_KEYCHAIN_DIR` and `DWS_DISABLE_KEYCHAIN=1`. It does not reuse or migrate a user's independently installed DWS credentials. Candidate credential restrictions apply before account reads. Cancelling signals only the captured login child, never a persisted PID.

Read-only diagnosis uses `auth status --readonly --format json`. This verifies local token/identity metadata, not every remote business permission. The official status does not provide todo or approval scopes; RailWise must not invent granted scopes or claim remote permissions were tested. A nonempty diagnostic reason or malformed response remains unverified.

Execution binds the executable digest and exact `corpId:userId` profile to the task grant. Only fixed, typed task and approval commands are exposed. Writes still require explicit target confirmation, a durable receipt and a verified target readback. A platform permission denial remains a failure. Unknown results are not replayed automatically. Live account authorization and actual business operations are recorded separately from mocked protocol tests.

## Legacy direct OpenAPI adapter

The adapter follows the published Alibaba Cloud Go SDK endpoint definitions:

- User todo list/detail/update: `todo_1_0`, `QueryTodoTasks`, `GetTodoTask`, `UpdateTodoTaskExecutorStatus`.
- User authorization exchange: `oauth2_1_0`, `GetUserToken` and `GetAccessToken`.
- Workflow task list and actions: `workflow_1_0`, `QueryIntegratedTodoTask`, `GetProcessInstance`, `ExecuteProcessInstance`, `RedirectWorkflowTask`.
- The `open-dingtalk/dingtalk-mcp` permission table identifies `Todo.Todo.Read` and `Todo.Todo.Write` for todo access. Workflow requires `Workflow.Instance.Read` and `Workflow.Instance.Write`; the integrated process-centre todo endpoint requires the `qyapi_aflow` permission.

OAuth delegated user access and enterprise internal-app credentials are distinct. User OAuth does not grant internal-app Workflow API permissions. Workflow tools require a separately configured internal-app credential, an explicitly bound operator user ID, an allowlisted writer, and configured permissions. A platform API denial remains a failure and does not get rewritten as a successful connection.

Every write has a typed input, fixed official API host/path, an explicit confirmation requirement, a pre-write target/ownership check, and a readback check. Uncertain transport results or failed readback return `outcome_unknown`; callers must inspect remote state before trying again. Approval APIs expose a boolean response rather than a durable operation ID, so the adapter reports a provider request ID only when DingTalk actually returns one. It never fabricates a remote operation ID.

## Primary references

- [DingTalk official CLI documentation](https://open.dingtalk.com/dingtalk-dev/wiki)
- [Official DWS source at the pinned release](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/63a7c4906c7dee10750011ea309b9eb78abb7eb0)
- [Official DWS Gitee mirror](https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli)
- [Alibaba Cloud DingTalk Go SDK: todo_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/todo_1_0/client.go)
- [Alibaba Cloud DingTalk Go SDK: workflow_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/workflow_1_0/client.go)
- [Alibaba Cloud DingTalk Go SDK: oauth2_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/oauth2_1_0/client.go)
- [DingTalk Developerpedia: browser delegated OAuth](https://opensource.dingtalk.com/developerpedia/docs/develop/permission/token/browser/get_user_app_token_browser/)
- [open-dingtalk/dingtalk-mcp permission table](https://github.com/open-dingtalk/dingtalk-mcp/blob/main/README.md)
- [DingTalk API: approve/reject workflow nodes](https://dingtalk.apifox.cn/doc-3568375)

## Local official-binary verification (2026-11-10)

The pinned macOS arm64 archive was downloaded from the official Gitee release; its SHA-256 matched `ffbb8962de879a5693ea380654813f45f9252f39d5527a24e135567aa2c36dea`. The extracted binary reported `v1.0.67` and source `63a7c490`. With new empty private configuration and credential directories and system Keychain disabled, `auth status --readonly --format json` returned a structured unauthenticated state. System `HOME` was preserved. This verifies the download, binary version and empty-state protocol; it is not evidence of user login, remote business permissions or actual todo/approval execution.

A separate real `ManagedDwsService` probe used a new empty private state directory, launched that same verified official executable, captured its first allowlisted device verification URL, cancelled the captured child, observed its exit, and verified the cancelled state. No user scanned the code and no business operation ran. Authorization URLs and codes remain in private evidence and are not stored in this repository. This confirms the service can reach and parse the official scan-page handoff; authorized-account behavior still needs user acceptance.
