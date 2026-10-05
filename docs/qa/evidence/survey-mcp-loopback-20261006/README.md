# Survey 只读 MCP：真实本地连接与持久可撤销授权

日期：2026-10-06。这是私有工作树增量的源码与实际 TCP 验证报告；审查角色为 AI 软件/工程测量复核。基线提交和逐文件 SHA-256 见 [验证回执](verification.json)。本目录不代表新安装包已通过验收，也不改变现有公开 0.5.2 的身份。

本次补上先前只存在传输无关 reader / MCP server factory 的宿主接线。外部 SDK 客户端通过现有本地计算服务的真实 loopback HTTP socket 完成 initialize、tools/list 和 tools/call。没有以 InMemoryTransport 或手工下载代替此次 TCP 连接；既有 reader/server 的 18 项内部回归测试另行保留。

## 已实现范围

- 在现有 HTTP server 注册只读摘要入口，使用 MCP SDK 的 Streamable HTTP 服务端传输，响应为 stateless JSON，不持有 SSE 通道或永久客户端 session。
- 本地宿主凭据仅管理客户端及项目授权；MCP 读取需要新签发的独立客户端凭据。客户端名称、clientInfo、principalId 或工具参数不能自授身份。
- 新客户端默认零项目授权。项目读取前后均检查当前授权；已有 SDK 连接在授权或客户端撤销后不能继续读。
- SQLite 持久保存客户端凭据的 SHA-256、项目 grant 与撤销记录；凭据仅创建时返回一次，列表与数据库不含原始凭据。访问目录权限 0700、数据库 0600；存储根目录及数据库本身的符号链接拒绝。
- 每次请求重新鉴权；仅在安全模式、非空宿主 token、loopback 配置下启用。非本地主机名、跨 Origin、空身份与伪造身份拒绝。
- 读取仍是 `read-only-summary` / `context-metadata-only`，每集合最多 20 条，序列化结果最多 64 KiB；仅投影限定元数据。没有原始观测、坐标、资料正文、文件路径、写入、导出或仪器控制。
- 管理请求最多 8 KiB，MCP 请求最多 32 KiB；64 个活动客户端、4096 个累计客户端、每客户端 200 个累计项目授权槽，防止存储无限增长。错误为限定安全代码，返回均禁止缓存。
- 关闭 runtime 时关闭访问数据库。没有修改或删除旧 outbound MCP 配置、插件、Skill、用户工程或历史记录。

## 功能检查与实际结果

| 检查 | 证据与结果 |
| --- | --- |
| 真实 TCP 与 SDK 协议 | HTTP 测试调用 `startKunServe` 绑定 `127.0.0.1:0`，SDK 客户端连接实际分配端口，成功初始化、列出唯一工具并执行摘要读取。 |
| 默认拒绝 / 授权 / 项目隔离 | 新客户端初次读取拒绝，owner 明确授权后成功，另一项目仍拒绝。 |
| 重启持久化 | 客户端及项目授权经完整 runtime 关闭与再启动后继续有效。 |
| 当前连接撤销 | 删除项目授权后已连接 SDK 客户端读取拒绝；恢复授权后可读；撤销客户端后读取返回 401。 |
| 撤销记录持久化 | 再次重启后旧客户端凭据仍返回 401；client 列表为空；工程名称与数据未被删除。 |
| 身份与管理边界 | 未认证管理、客户端自授、owner token 直接读取、伪造参数与不存在项目授权均拒绝。 |
| Host / Origin 边界 | 使用 Node HTTP socket API 发送实际恶意 Host（避免 fetch 替换禁止的 Host header），服务端 403；恶意 Origin 与 `null` Origin 均 403。 |
| 大小与输出隔离 | 超过 32 KiB 的 MCP 请求返回 413；真实摘要、列表及数据库不泄漏测试私有项目正文或原始凭据。既有 reader 的 64 KiB / 异常投影 / 前后撤销回归通过。 |
| insecure / 非本地配置 | insecure 实际 HTTP 请求返回 503；非 loopback 配置在真实 factory/router 组合下不创建宿主并返回 503（测试没有打开对外 listener）。 |
| Runtime 接线回归 | factory、sampling、quality assessment、advanced trials 与 HTTP server 共 5 文件 65/65 通过。 |
| 编译 | `kun` typecheck 和 build 均 exit 0。SQLite 测试使用 Electron 的现有 ABI 运行，未重编或替换共享依赖。 |

最终 targeted 为 3 文件 22/22 通过，包括新增 HTTP 4 项及既有 reader/server 18 项。完整输出见 [targeted](targeted.txt)、[runtime 回归](runtime-regression.txt)、[typecheck](typecheck.txt)与[build](build.txt)。更早一轮 runtime 回归的 advanced-trials 测试比较口径失败由其负责代理修正；本目录保存的是修正后再次执行的 65/65 结果，不能据此隐去此前失败。

最终冻结前补充 6 文件 37/37 路由与 MCP 回归，见 [final-regression.txt](final-regression.txt)。其中旧路由测试的简化 runtime 不提供 `info()`，现检查函数存在后才读取宿主；未知宿主仍默认拒绝，没有为兼容测试放开外部访问。

## 使用与兼容说明

这是一条由本地宿主明确创建客户端、单项目授权、撤销的管理 API，不是默认开放的外部客户端访问。管理与 MCP 读取角色分离，旧 outward client 配置未迁移。技术路径用于实现审查，不应展示在普通测量工作流中：

| 管理/协议动作 | 路径 |
| --- | --- |
| 创建/列出客户端 | `POST / GET /v1/engineering/mcp/clients` |
| 撤销客户端 | `DELETE /v1/engineering/mcp/clients/:clientId` |
| 授权/撤销单项目 | `PUT / DELETE /v1/engineering/mcp/clients/:clientId/grants/:projectId` |
| MCP Streamable HTTP 读取 | `POST /v1/engineering/mcp/survey` |

管理 body 采用严格字段验证；授权 body 为空对象，caller 不能追加身份或权限字段。删除授权不要求原工程仍存在，以免工程删除后无法撤销。客户端撤销为留存审计记录，不是删除工程或替换旧配置。

## 证据边界与剩余验收

此目录只证明明确范围的本地摘要连接、鉴权和重启行为。它不能关闭整个采集/空间工作包：真实 GeoCOM 型号/固件、现场采集、坐标基准、DXF/点云/3D 和跨产品协作仍按各自证据验收。它也不提供原始资料的第三方读取、专业签认、规范合格或厂商认证。

尚需在最终冻结私有安装包确认相同接线可达、应用重启和退出行为正常；普通用户界面不得暴露内部凭据或协议状态。最终包 UI、签名/公证、真实 updater 回环与独立综合 AI 审查由协调任务保存，源码测试不能替代。独立边界审查结果另附，不将本实现者的自查写成独立审查。
