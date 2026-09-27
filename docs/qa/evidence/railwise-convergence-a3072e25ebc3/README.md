# a3072e2 精确候选：总体冻结与首轮抽样

源码 `a3072e25ebc33ee30702d5278c8144e3fbb625f7`，隔离版本 `0.5.0`。本包包含抽样工作区和历史成果副标题修正；随后广义 w / VCE 纯核不在此包。**限定检查通过，整体验收仍未完成；未发布公开版本。**

## 包、签名与真实更新

[私有 Actions](https://github.com/wangjiawei508/WorkWise/actions/runs/35470964394)成功。[原始 updater 报告](private-updater.json)和[六阶段原生记录](native-updater.redacted.json)确认真实下载、原生安装、目标重启及哨兵数据保留。签名、公证和 hosted runner 启用状态的 Gatekeeper 均通过；生产应用、公开 feed、系统信任均未修改。`0.0.0` 基线是同源码升级探针，不代表真实历史用户迁移。

[本机包记录](package.json)的 ASAR 为 `3c8d0a22c8bc3bbeea2ea38fa44c7035aaf347b11ca4bd47323e9a2d574c62ea`，与 updater 安装目标一致；codesign/stapler/assess 退出 0。本机 `spctl --status` 显示 assessments disabled，不作为本机启用 Gatekeeper 的证明。[附件清单](artifacts.json)保留逐件 GitHub 摘要。

## 实际 GUI 与独立复算

[GUI 检查](gui-acceptance.json)逐项记录通过和未完成范围：

- 没有 manifest 的项目可以打开抽样入口。空声明不能冻结；输入显式产品、单位定义原文和 1,001 个合成单位后仍需勾选确认。总体分页逐页到第 1,001 项，尾页无下一页。
- 过程检查执行全数，共 1,001 项，分 501/500 两批；最终内业只提供全数模式（本次未另建最终内业运行）。验收随机抽样选中 80 项，两批各 40；样本两页为 50/30。
- 重复同总体、同阶段运行被明确拒绝。历史仅保留原来两条；重新核验、切换语言、完全退出重启后恢复原 ID、planHash 和样本。
- 在备份精确原行及数据库后，仅向隔离候选随机记录的 `data_json` 追加一个空格，不更新摘要。GUI 拒绝核验，历史将坏记录单列；正常全数记录仍可恢复。随后恢复精确原字节与触发器。[操作记录](tamper-operation.json)保留该过程。
- 独立 Python 直接读取本包的实际 SQLite，重算定义、总体、SQL/JSON 身份、分批及 HMAC 选择；[篡改前](sampling-before-tamper.json)、[原字节恢复后](sampling-restored-audit.json)、[重启后](sampling-after-restart.json)均为 1 总体 / 2 运行一致。脚本在相邻 `railwise-sampling-integration/`，没有导入产品算法。
- 中文浅色常规、最大化和窄窗，英文深色常规和窄窗已查看。窄窗改为上下排列，说明和按钮可滚动到达；英文通过 Tab 到达重新核验并用 Enter 执行，完成后焦点回标题。**本轮没有独立确认精确 960×640 高度，不将该项计为完成。** 截图像素与原生窗口尺寸不可混用。
- 显式合成三点水准网完成校核、平差、DOCX/PDF/XLSX 和 draft manifest，五项成果复验通过。完全退出重启后，成果中心正确显示“最近待审查清单输出”及原 manifest ID；[三份文件独立哈希](manifest-hashes.json)匹配。此前误点默认结构化导入产生的一份两点合成网络保留，项目总数仍为 1；这些 JSON 均不计作厂商 P0 格式验收。

AX 文本归档仅去掉行尾空格，原始工具输出仍保留在本机证据目录。[截图索引](screenshots.json)固定原始实拍文件哈希，仅含合成资料。官网营销图仍来自前一 ba38649 精确包，没有将本包英文深色验收图用作中文首页图。

## 验证与未完成

[源码检查](local-checks.json)：桌面 2,606 通过 / 2 跳过，Runtime 1,852 通过 / 3 跳过；双端类型、构建、strict OpenSpec 11/11 通过，lint 0 error / 1 既有 warning。两组 [Quality](https://github.com/wangjiawei508/WorkWise/actions/runs/35470941770) [检查](https://github.com/wangjiawei508/WorkWise/actions/runs/35470939174)成功。

首轮 Computer Use 全表面枚举超时，直接连接已运行应用后恢复。多次边框拖动无变化，最终左边框缩窄成功；精确最小高度仍未确认，没有修改窗口配置来伪造实机验收。定义输入早期使用中文逐键输入失败，改用字段 setValue 并核对实际冻结字节；项目修订为 3，该失败不隐去。

选中单位不代表材料齐全、质量评分或批准。样本材料归集、评分/阶段完成、数字签名、完整主题/异常/a11y、成功真实模型回合、真实旧用户迁移及用户本人/专业确认仍需完成。抽样功能和本轮合成导出检查不替代这些任务。
