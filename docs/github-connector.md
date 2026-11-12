# GitHub 连接器

在“技能与连接器 → 连接器”中打开 GitHub。当前版本使用 GitHub 官方远端 MCP 服务和个人访问令牌，凭据在本机保存。

## 配置与启用

1. 点击“在 GitHub 创建令牌”，登录 GitHub 并创建细粒度个人访问令牌。
2. 选择资源所有者、有效期和本次任务需要的具体仓库。
3. 按实际任务设置权限。文件读取需要 Contents 读取权限，议题读取需要 Issues 读取权限，合并请求读取需要 Pull requests 读取权限。Metadata 读取权限由 GitHub 自动提供。需要写入时，为相应能力选择读写权限。组织可能要求批准或 SSO 授权。
4. 将令牌填入 GitHub 连接详情，点击“保存并检查”。新连接默认选择官方只读服务。可以明确选择“按令牌权限启用读写操作”。
5. 检查通过后点击“启用任务工具”。应用确认本机任务执行服务已加载可用工具后显示就绪。回到原任务手动选择继续。

连接检查仅执行 MCP 初始化与工具目录读取。具体仓库是否可访问取决于令牌范围和组织策略。连接成功后的写操作继续遵循任务授权和工具审批。[GitHub 令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) · [官方远端 MCP 配置](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)

## 保存与权限

令牌通过现有系统保护存储保存。保护存储不可用时使用当前进程的会话存储，并在界面说明重启后需要重新配置。MCP 配置只保存凭据引用，Runtime 配置只保存内存变量占位符。令牌请求使用 GitHub 固定 HTTPS 地址，并拒绝重定向。

保存、更换令牌、验证和启用分别执行。更换已启用连接的令牌时，应用先停用该连接，完成验证后由用户重新启用。停用保留连接和凭据。连接失败、零项可用工具或 Runtime 热应用失败都维持未就绪状态。

## 连接问题

| 页面状态 | 处理方式 |
| --- | --- |
| 等待配置访问令牌 | 通过页面官方入口创建令牌并保存 |
| 令牌无效或已过期 | 在 GitHub 创建有效令牌，在连接详情替换 |
| 权限或组织策略拒绝 | 核对选中仓库、细粒度权限、组织审批及 SSO |
| 官方服务网络不可达 | 检查到 `api.githubcopilot.com` 的网络连接，恢复后重试 |
| 已认证但没有可用工具 | 核对令牌权限与高级工具规则 |
| 已保存但任务执行服务未就绪 | 检查连接，随后重新应用到任务 |

## 0.5.5 配置兼容

0.5.5 的 GitHub 目录条目标记了 OAuth 已具备接入条件，通用“连接”流程因此直接尝试 OAuth 注册。GitHub 远端 MCP 要求宿主具有已注册的 GitHub App 或 OAuth App，当前目录没有可用的宿主 Client ID，流程在授权前失败。官方同时支持个人访问令牌，因此本版提供直接可完成的令牌接入流程。[GitHub 宿主集成说明](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)

现有 MCP 条目、名称、工作区范围、端点、OAuth 字段、工具规则和凭据引用继续保留。打开新详情不会自动修改连接。已有 GitHub 配置可以直接检查并重新应用，多项连接可分别选择。只有用户点击保存、更换令牌、调整能力或启停时才修改对应条目。用户自定义的同名其他服务继续保留，新建 GitHub 连接使用独立标识。

已注册自有 GitHub App 或 OAuth App 的用户可通过详情中的高级 MCP 设置管理既有配置。远端 MCP 的 OAuth 注册与本地官方 stdio 服务内置登录是不同接入方式。当前页面使用远端 MCP 的个人访问令牌流程。[官方本地服务 OAuth 说明](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md)
