# Markdown 工作台迁移矩阵

| 旧数据/接口 | 新状态 | 原因 | 数据保留 | 用户动作 |
|---|---|---|---|---|
| `activeFilePath` 内存状态 | 迁移为当前工作区的一个 `DocumentTab` | 支持多文档标签 | 原路径保留；旧读取者继续可读 | 无 |
| `kun.write.active-file:<workspace>` | 继续保留并作为无会话记录时的活动文档回退 | 兼容旧版本和旧 IPC | 键和值不删除 | 无 |
| 新 `workwise.write.document-session.v1:<workspace>` | 新增标签、固定、最近关闭、最近打开元数据 | 跨重启恢复工作台 | 只保存路径和状态，不保存正文 | 文件不存在时重新定位或移除标签 |
| `writeWorkspaceFile` / 旧文件 IPC | 保留 | 旧 renderer、插件和用户配置仍会调用 | 不迁移、不删除 | 无 |
| `readDocumentSnapshot` / `writeDocumentChecked` | 新增兼容 IPC | 指纹基线和冲突保护 | 旧 IPC 仍可读；缺少新 IPC 时回退旧写入 | 冲突时查看双方内容后重试 |
| `documentRevision: null` 的旧状态 | 新增 `documentBaselineKnown` 区分未知基线与已确认文件缺失 | 防止重建草稿时覆盖重新出现的文件 | 旧 IPC 未知基线继续传 `undefined`；明确缺失传 `null` | 冲突处理界面确认后继续 |
| 文件树重命名 IPC | 新增可选 `targetDirectory`，支持工作区内移动 | 保持旧名称参数行为并完成文档整理 | 原路径和目标路径一起返回，标签与边车记录迁移；拒绝覆盖 | 选择已有目标文件夹 |
| `activeFilePath` 的脏正文 | 不写入浏览器存储 | Markdown 文件是唯一权威内容 | 不复制正文到 session storage | 先保存或放弃后切换 |
| `.workwise` 工作区、插件、凭据和用户文件 | 保持原位置 | 避免迁移破坏 | 不删除、不改名 | 无 |
| 历史/快照目录 | 新增工作区 `.workwise/document-history/<relative-path-sha256>/`；不使用 `.ok` 或 shadow Git | 保持 MIT 产品边界 | 追加记录，恢复不删除后续历史；应用内移动/重命名复制重映射记录并保留旧记录 | 可查看和恢复历史；外部改名使用重新定位，不自动猜测对应关系 |
| 本地批注目录 | 新增工作区 `.workwise/document-comments/<relative-path-sha256>/` | 批注不污染 Markdown 正文 | 单条批注按 ID 保存，解决/重新打开更新状态；应用内移动/重命名保留旧记录并复制到新路径标识 | 可添加、解决、重新打开及加入 AI 写作队列 |
| OpenKnowledge GPL 源码、Hocuspocus/Yjs 服务 | 不引入 | 本期自主重实现 | 不复制其运行时或扩展 | 无 |

迁移只新增元数据并保留旧读者；任何路径越界、文件删除或外部重命名都必须让用户可见并提供重新定位，不能静默覆盖或删除内容。
