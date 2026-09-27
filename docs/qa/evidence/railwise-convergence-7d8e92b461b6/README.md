# 7d8e92b 精确候选：广义 w 与 VCE 工作区

源码 `7d8e92b461b6697cf782d197c05c392b6d62de03`，隔离版本 `0.5.0`。本包包含广义 w / VCE 的持久化和桌面入口，**不包含随后新增的统计家族、Huber 或参考基准试算**。限定检查通过，整体验收仍为 partial；没有公开发布或用户本人确认。

## 包与真实更新

[私有 Actions](https://github.com/wangjiawei508/WorkWise/actions/runs/35475090766) 成功。[原始报告](private-updater.json)与[六阶段原生记录](native-updater.redacted.json)确认真实 HTTPS 下载、Squirrel 安装、0.5.0 重启与测试数据保留。签名、公证和 hosted runner 启用状态的 Gatekeeper 通过；生产应用、公开 feed 和系统信任未修改。同源 0.0.0 基线只用于 updater 探针，不代表历史用户迁移。

[本机记录](package.json)核对 ASAR `c352ee1327a4c465109acaf898149923c3bf398403c131211ef10d2e02da9e86` 与更新后目标相同，codesign/stapler 通过。本机 Gatekeeper 为 disabled，不以本机 assess 退出 0 冒充启用检查。[附件清单](github-artifacts.json)保存 GitHub artifact ID 和摘要。

## GUI 与独立核算

[逐项检查](gui-acceptance.json)绑定同一项目、修订和三条原记录。只使用合成/公开数学算例，不包含现场资料。

- 未导入正式网也可使用入口；空声明、空依据和未确认状态不能保存。Tab/Enter 提交成功。
- 广义 w：均值 18/11、残差 [-7,4,15]/11、完整 Cvv 与先验能量 12/11 一致；首观测方向 w=-7/√55，共模方向不可检测且不显示为零。
- 单组 VCE 两轮收敛到 10/3 mm²；公开负例首轮保留 [-1.48,8.4] mm² 并停止，没有接受负方差或伪造收敛。
- 原生另存为取消明确提示未导出；实际保存的 [JSON](survey-generalized-w-trial.json)与 SQLite 完整记录逐字段相同。原始声明和归一化模型均可展开查看。
- 完整退出并重新启动后，项目仍为一个，三条历史原 ID 不变；严格恢复重新计算。
- 备份数据库后，仅给一条 `declaration_bytes` 追加一个 ASCII 空格，保留其他摘要。[GUI 拒绝](tamper-rejected.ax.txt)，[坏历史单独呈现](damaged-history.ax.txt)，正常 VCE 仍可恢复。恢复原字节和触发器后再次通过。
- 独立 Python/Fraction 直接读取实际安装包数据库，核对 SQL 身份、UTF-8 字节摘要和三份数学结果：[重启前](independent-before-restart.json)、[重启及篡改恢复后](independent-restored.json)均为三条通过。工具位于相邻 `railwise-advanced-workspace-acceptance/`，未导入产品算法；JS 规范化哈希由 Runtime 严格重放核对，不冒称由 Python 独立重算。
- 中文浅色常规/最大化、英文深色常规与滚动结果表已查看，[截图清单](screenshots.json)保存原图哈希。多次边框拖动未成功缩窄，精确最小窗口不计通过。应用最后恢复中文浅色，官网营销图没有替换成英文深色 QA 图。

## 保留的问题与范围

首轮 Computer Use 枚举超时，之后原生应用控制恢复；Go To 对话框粘贴超时，原生 setValue 恢复后实际文件核对通过。AX 一度保留旧会话占位文字，截图显示输入区已就绪，未复现会话卡住。上述工具失败不隐去，也不判为产品功能通过。

7d8e92b 首轮 Quality 的最大 VCE HTTP 压力测试超出 15 秒预算。d2803d5 只将该测试预算改为 60 秒，保留原计算与断言；随后 [35475591625](https://github.com/wangjiawei508/WorkWise/actions/runs/35475591625) 和 [35475588831](https://github.com/wangjiawei508/WorkWise/actions/runs/35475588831) 均通过。生产实现相同，包的源码身份仍为 7d8e92b。

精确最小窗口、完整键盘/a11y、全部离线/过期状态、真实模型成功回合、历史用户迁移和用户本人/专业确认未完成。该包验收不覆盖下一批源码，也不关闭完整高级平差或 GB/T 质检链任务。
