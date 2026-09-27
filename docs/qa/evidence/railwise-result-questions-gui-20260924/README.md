# 3f0dbf1 候选真实 GUI 追问：失败记录

2026-09-24，继续操作已经签名、公证、隔离安装并完成私有 updater 往返的 0.5.0 候选。源码与 ASAR 身份沿用[精确成果追问验收](../../RAILWISE_EXACT_RESULT_QUESTIONS_ACCEPTANCE.md)，本次没有替换包或公开发布。

原生“文件 → 选择工作区”成功切换到隔离合成目录，随后可进入中文浅色 Survey 页面。实际点击点位 A 的追问按钮仅准备草稿与引用，显式点击发送后产生 `turn_ttb36he0`。第二次先输入“只解释我选中的合成来源，不执行计算。”，再点击 Q10 来源摘要追问，原问题保留；显式发送产生 `turn_suau4ag3`，其真实持久用户消息携带 `typedEvidence.kind=network`、准确网络 ID、修订与来源 SHA-256。

两回合都返回 `http_401` / `Authentication Fails (governor)`，各记录 7 次相同鉴权错误后以 `turn_failed` 结束。没有 `survey_read_evidence` 或其他工具调用，也没有模型回答。GUI 显示失败、重试 Runtime 和检查配置入口。故**真实模型读回失败**，不能将“已发送准确引用”写成模型已读回。

Q10 发送前后使用同一候选 Electron/ASAR 执行只读业务快照：8 个工程数据库与 23 个保留/成果文件，快照字节完全一致，SHA-256 均为 `1b88fd1f95676b3ff44d9019674981fa4b2f0e1ecebf3be7748964b56bd2a6a8`。这证明该失败回合没有改变所覆盖业务记录，不证明成功模型回合的只读性。

[summary.json](summary.json)保存脱敏摘要与原始导出摘要。真实 events/messages/metadata 导出留在 `/private/tmp/railwise-exact-questions-package-audit/gui-20260924/`，业务前后快照分别为同父目录的 `gui-before-20260924-q10.json` 和 `gui-after-20260924-q10.json`。原生窗口与失败界面的 Computer Use 截图留在本次任务工具记录中；未将其冒称仓库中的独立截图文件。没有复制配置、凭据或真实工程数据。

本次只覆盖以上两个追问表面及失败状态。Q10–Q17 全矩阵、成功模型读回、恢复/重启、语言主题窗口与键盘、用户本人和专业确认仍未完成。最初内容区按钮无响应的尝试保留为操作失败；工作区切换后恢复，尚未确定根因，不据此声称已修复应用交互缺陷。
