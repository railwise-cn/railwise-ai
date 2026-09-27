# b8df979 签名候选验收

2026-09-19，精确源码 `b8df9790e37fc6dc42dac0dec30a4a69799b681b`，版本 0.5.0，隔离候选，未公开发布。包身份、截图哈希及检查范围见 [acceptance.json](./acceptance.json)。

- Developer ID 严格深层签名通过；无公证票据（stapler 65）。本机 Gatekeeper 返回 security-disabled override，不能算正常公证验收；没有修改安全设置。
- 首次打包因既有 SQLite 失效符号链接失败。链接原样保存在私有候选目录，移出依赖目录后使用同一固定 builder 重试成功。
- 已安装包的真实 GSI、IN2 Runtime 导入、校核、平差和三种输出检查通过；它们不替代本包双真实 GUI 验收。GSI 独立比较最大差 0.020316 mm，IN2 最大差 0.063416 mm；GSI 七处来源转换差异仍需专业复核。
- GUI 原生文件选择器导入可再分发合成 IN2，完成校核、平差、DOCX/PDF/XLSX、待审查清单。任务重命名后重新生成 revision 3 的三份文件，磁盘 SHA-256 均与清单一致，见 [gui-artifact-hashes.json](./gui-artifact-hashes.json)。全部成果仍为 draft。
- 残差一键追问准备了问题和精确来源引用，并聚焦输入框；没有发送模型问题。摘要显示微小非零闭合差、精度；“计算校核通过”不再表示满足未指定的项目限差。
- 中文浅色常规 1171×768、最大化 1491×768，以及英文深色审查页已目视检查。重启后进入内业，任务、阶段和两份历史清单恢复。拖动未改变最窄窗口尺寸，因此窄窗口、全键盘和实际 Dock/托盘外观仍未验收。
- 应用包 ICNS 与新品牌源资源哈希一致；旧资产文件名保持兼容。官网候选三图更新为本包中文浅色合成数据实拍，仍未部署。
- GitHub 当前源码检查通过：桌面 2474/2 skipped、Runtime 1588/3 skipped、Electron smoke、Windows 相关检查、类型检查、构建与 OpenSpec；lint 仅一条既有 Hook warning。

公证、私有 HTTPS updater 往返、真实模型回合、真实旧用户数据迁移和用户专业确认未完成。全量 locale、全状态及 P1/P2 仍见[总台账](../../RAILWISE_SURVEY_CONVERGENCE_STATUS.md)。locale-inventory.json 只统计含中文字符串的位置，不能把中文目录原文或输入识别代码都算成未翻译缺陷。
