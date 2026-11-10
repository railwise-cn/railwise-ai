# DingTalk Provider Boundary

RailWise uses the first-party `api.dingtalk.com` OpenAPI directly. It does not invoke a CLI, generate shell commands, or substitute Feishu/Lark.

The adapter follows the published Alibaba Cloud Go SDK endpoint definitions:

- User todo list/detail/update: `todo_1_0`, `QueryTodoTasks`, `GetTodoTask`, `UpdateTodoTaskExecutorStatus`.
- User authorization exchange: `oauth2_1_0`, `GetUserToken` and `GetAccessToken`.
- Workflow task list and actions: `workflow_1_0`, `QueryIntegratedTodoTask`, `GetProcessInstance`, `ExecuteProcessInstance`, `RedirectWorkflowTask`.
- The `open-dingtalk/dingtalk-mcp` permission table identifies `Todo.Todo.Read` and `Todo.Todo.Write` for todo access. Workflow requires `Workflow.Instance.Read` and `Workflow.Instance.Write`; the integrated process-centre todo endpoint requires the `qyapi_aflow` permission.

OAuth delegated user access and enterprise internal-app credentials are distinct. User OAuth does not grant internal-app Workflow API permissions. Workflow tools require a separately configured internal-app credential, an explicitly bound operator user ID, an allowlisted writer, and configured permissions. A platform API denial remains a failure and does not get rewritten as a successful connection.

Every write has a typed input, fixed official API host/path, an explicit confirmation requirement, a pre-write target/ownership check, and a readback check. Uncertain transport results or failed readback return `outcome_unknown`; callers must inspect remote state before trying again. Approval APIs expose a boolean response rather than a durable operation ID, so the adapter reports a provider request ID only when DingTalk actually returns one. It never fabricates a remote operation ID.

## Primary references

- [Alibaba Cloud DingTalk Go SDK: todo_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/todo_1_0/client.go)
- [Alibaba Cloud DingTalk Go SDK: workflow_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/workflow_1_0/client.go)
- [Alibaba Cloud DingTalk Go SDK: oauth2_1_0](https://github.com/alibabacloud-go/dingtalk/blob/master/oauth2_1_0/client.go)
- [DingTalk Developerpedia: browser delegated OAuth](https://opensource.dingtalk.com/developerpedia/docs/develop/permission/token/browser/get_user_app_token_browser/)
- [open-dingtalk/dingtalk-mcp permission table](https://github.com/open-dingtalk/dingtalk-mcp/blob/main/README.md)
- [DingTalk API: approve/reject workflow nodes](https://dingtalk.apifox.cn/doc-3568375)
