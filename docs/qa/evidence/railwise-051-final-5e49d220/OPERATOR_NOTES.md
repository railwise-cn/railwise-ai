# 本轮复验经验

- Runtime位于 `Contents/Resources/app.asar.unpacked/kun/dist/`。仅改Runtime时ASAR可能不变；身份核验必须包括对应Runtime模块及完整签名，不能仅以ASAR不同判断修复是否入包。
- macOS候选的V8权限需检查主进程及全部Helper共5个可执行文件；对最终DMG和安装目录核验，不能只验临时输出目录。
- 本机原有Gatekeeper assessments disabled，不修改系统安全设置；报告明确此限制，补用启用Gatekeeper的hosted runner真实检查。
- GitHub完整汇总artifact下载遇到单连接约40KB/s限制。经认证API获取临时URL，支持HTTP Range；直接提取Apple Silicon ZIP成员并并行下载，验证CRC和工件内SHA256。没有完整下载外层ZIP时不得声称复算外层artifact digest。临时凭据URL仅驻留进程内，不写报告。
- 原生CUA截图是JPEG字节，保存时使用.jpg。Retina截图像素尺寸为逻辑窗口尺寸的2倍；960×640逻辑窗口截图为1920×1280。原生窗口拖动坐标使用工具截图坐标；必须看返回截图验证实际尺寸。
- typedEvidence和legacy选择器有不同读取入口。前者使用survey_read_evidence，后者使用survey_read_context；新schema修复不能替代两条真实模型调用验收。
- 模型可能将原文件sourceSha256与计算输入inputHash混为同类。它们语义不同，不因不同就断言过期；依据Runtime绑定与严格原件重放校验。AI解释不替代确定性计算与专业签认。
- Node本地测试须按宿主ABI构建better-sqlite3；本地服务类测试须允许localhost监听。沙箱EPERM与ABI错误先排除环境原因，完整重跑后再记录通过。
