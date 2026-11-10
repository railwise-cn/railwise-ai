# 插件市场国内访问整改方案

## 已确认的根因

内置精选目录是 `workwise-official` 的 bundled snapshot，应用启动时从本地目录生成，不需要访问 GitHub。旧版页面把目录、已安装插件、MCP 状态、Skill 索引和凭据状态放在同一个 `Promise.all` 中读取，任一入口失败都会显示“无法连接下载源”。这会把本地精选目录的可用性和在线来源的可达性混在一起。

外部目录同步和插件安装是两条网络链路。GitHub 目录同步请求 `api.github.com` 和 `raw.githubusercontent.com`。GitHub 插件安装请求 `codeload.github.com`，失败后还会尝试 `git clone`。npm 包依赖 npm registry，PyPI 包依赖 PyPI 元数据和 wheel 下载，部分许可证信息还会读取 GitHub。

## 已完成的客户端整改

- 市场首页各读取入口独立结算。辅助入口失败不会清空已加载的内置精选。
- 精选目录可在离线状态显示，并使用明确的“精选目录可离线使用”提示。
- 外部源的 `offline`、`failed`、`synced` 和 `unchanged` 状态分开显示。
- 已有可信缓存时，外部源离线会继续使用缓存，不再显示为同步成功。
- 内置源显示“已内置，可离线使用”，不提供网络同步按钮。
- GitHub、npm 或 PyPI 安装失败时，提示具体为“目录可见但安装包下载源不可用”，并引导使用镜像或本地导入。
- 增加辅助读取失败和内置精选继续显示的 DOM 回归测试。

这些修改尚未进入用户当前的 0.5.4 安装包，需要在下一候选包中验收。

## 镜像发布方案

RailWise 建立自己的 HTTPS 分发域名和静态对象路径。目录和制品由 CI 从固定版本生成，客户端默认访问镜像，原始 GitHub、npm 和 PyPI 地址只作为受限回退来源。

目录清单至少记录以下字段。

- `sourceHead`、目录版本和生成时间
- 每个包的来源类型、仓库、immutable commit 或包版本
- archive、tarball 和 wheel 的大小、SHA-256、SRI 或签名
- 许可证证据、运行时依赖和支持平台
- 镜像 URL、原始 URL 和回滚版本

首批覆盖范围是 7 个 GitHub archive、9 个 npm 包和 5 个 PyPI 包。16 个 system-managed 项目继续随应用提供，3 个远程 MCP 服务保留在线连接状态。

镜像不会改变 GitHub provenance，也不会把镜像地址伪装成 GitHub source。现有路径安全、许可证、内容 SHA-256、SRI 和可选签名检查继续在客户端下载后执行。

## 实施顺序

1. 将当前离线 UI 修复打入新的候选包，验收断网进入市场、外部源同步失败、缓存显示和内置插件安装。
2. 新增镜像构建脚本，从官方 catalog 生成冻结清单，下载并核验 GitHub archive、npm tarball、PyPI wheel 及依赖闭包。
3. 将清单和制品上传到 RailWise 自有 CDN/R2，启用 ETag、短缓存、Range、Content-Length 和不可变路径。
4. 在客户端加入镜像 artifact resolver。顺序为本地缓存、RailWise 镜像、原始来源。每次候选安装完成后继续执行现有安全审查。
5. 在真实国内网络环境验收目录加载、7 个 GitHub Skill、npm、PyPI、缓存回退和镜像回滚。

## 发布验收

- 断网打开插件市场仍显示精选和 system-managed 项目。
- GitHub 源同步失败只影响来源卡片，不能覆盖首页内容。
- 有可信缓存时显示缓存时间和离线状态。
- 镜像目录与提交、包版本、大小和摘要一致。
- 镜像成功、镜像超时、摘要不匹配、镜像回滚和原始来源回退都有测试。
- 失败安装不会留下半安装目录，用户可以改用本地 `.wwx`、`.mcpb` 或目录导入。
