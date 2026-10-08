# Survey 只读 MCP 独立 AI 审查

审查日期：2026-10-06。审查者为独立子智能体，模拟工程测量实践、软件质量与产品设计综合视角；不是实现者自查，也不是厂商认证、真实专业签名或发布批准。

本轮结论：在下面限定的源码与真实 loopback TCP 范围内，未发现需要阻断该增量的缺陷。最终冻结安装包接线、退出和重启仍须另行验收；本报告不替代安装包截图、签名/公证或真实更新往返。

## 实际核对

- 阅读访问存储、宿主路由、runtime 接线、reader/server 和真实 HTTP 测试。宿主凭据仅管理客户端；独立随机客户端凭据默认没有工程授权，工具参数与客户端声明不能自授身份。
- 数据库仅保存凭据摘要，签发时一次返回原凭据。目录及数据库权限、符号链接拒绝、客户端及授权数量上限均已核对；撤销持久化并在每次读取前后检查。
- 实际 Node loopback socket 与 MCP SDK 完成初始化、列工具和调用；已连接客户端在工程授权撤销或客户端撤销后不能继续读取，完整 runtime 重启后继续拒绝旧凭据。
- 原始观测、坐标、资料正文、路径和写入/导出/仪器控制未进入摘要。严格输出投影、20 条集合上限、64 KiB 摘要上限及 32 KiB 协议请求上限保留。
- 恶意 Host/Origin、无凭据、宿主 token 直接读取、客户端自授、伪造输入、insecure 及非 loopback 配置负例保留；协议响应禁止缓存。
- 旧 outbound MCP、Skill、插件与工程数据未迁移或删除。

## Fresh verification

在现有 Electron ABI 中实际执行，没有重编或替换共享 SQLite 依赖：

`ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ../node_modules/vitest/vitest.mjs run src/engineering/survey-sampling-workspace.test.ts src/engineering/survey-quality-workflow.test.ts src/engineering/survey-quality-record.test.ts tests/survey-context-mcp-http.test.ts src/adapters/mcp/survey-context-reader.test.ts src/adapters/mcp/survey-context-server.test.ts --maxWorkers=1`

结果：6 文件、68/68 通过，exit 0。其中 MCP 三文件为真实 HTTP 及 reader/server 的独立复跑；质量文件结果另见质量独审。本轮完整输出保存在 [独立复跑日志](independent-regression.txt)。工作树身份及逐文件摘要见 [新独审回执](../survey-source-trials-20261006/fresh-independent-review.json)。

## 范围与后续

此增量是明确授权的工程元数据摘要入口。它没有关闭 GeoCOM 型号/固件、现场采集、工程基准、DXF/点云/3D、原始资料互操作或跨产品协作的整体计划；也不能把存储完整性解释为工程真实性或规范合格。待新安装包冻结后，重新核对相同入口可达、重启撤销和退出行为，使用新包证据，不复用旧包回执。
