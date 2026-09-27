# ba38649 精确候选：质量证据保全与窄窗口

源码 `ba3864917e128f7318b88895441b2b632291d564`，隔离版本 `0.5.0`，不是新的公开发布。后续抽样接线和历史成果副标题修正不在本包内。

## 包与更新

[私有 Actions](https://github.com/wangjiawei508/WorkWise/actions/runs/35467214890)成功；[原始报告](private-updater.json)记录真实 HTTPS 下载、原生安装、目标重启和数据保留六阶段，签名、公证及 hosted runner 启用状态的 Gatekeeper 验证通过。未修改生产应用、公开 feed 或系统信任。[附件记录](artifacts.json)逐个核对 GitHub 摘要；目标附件 SHA-256 为 `3099ad36008fd4012ea19174bc7b7028a4430d32c42df06464c7ff90e7901dc7`。

[本机安装记录](package.json)：ASAR `c8e6430a1c82f52103efd56c7e5ecc450fca14d47e60777fd2407f3720660337` 与真实 updater 安装目标一致，codesign/stapler/assess 成功。本机 `spctl --status` 仍为 `assessments disabled`，没有改变安全设置，也不把它作为本机启用 Gatekeeper 的证明。

## 实际界面检查

[GUI 记录](gui-acceptance.json)绑定合成三点水准网、两个独立 manifest、两个计划和一个留存记录：

- 合成网络导入、校核、算法7平差、DOCX/PDF/XLSX及草案清单完成；五项成果复验通过。
- 冻结前必须勾选范围确认。新留存记录没有自动通过项；四个单独动作依次记录包字节、DOCX、PDF、XLSX。复验不追加事件。
- 改动第一份成果的一个输出后，复验明确拒绝并清空旧结果。第二份工作区仍显示第一份不可恢复条目及第二份可恢复计划；Tab/Return 成功恢复有效计划。随后恢复精确原字节。
- 完全退出进程、以相同隔离环境重启后，原项目仍为1个。恢复同一计划、同一记录，事件数4与链头 `c7aff541289ab0d991ac17a93ed63d289bc95fee774f1785c668441037a2908c` 一致，再次字节复验通过。
- 中文浅色常规、最大化和实际960×640；英文深色960×640及重启常规窗口检查。窄窗切换为单列工作面/下方聊天，错误说明及恢复按钮可滚动和键盘到达。此范围不代表完整四种语言/主题组合和全部a11y验收。
- 自由试算最后一条观测来源定位完成，关闭后焦点回到 `Locate CA`；历史读取及恢复后焦点保留在 `Read trial history`。独立[解析检查](free-trial-analytic.json)核对高程、残差、SSE和原固定点保护。

[独立Python存储检查](quality-integrity.json)验证SQL/JSON身份、原件/留存blob、成员、4事件及5链头、manifest仍draft。它保守地将含浮点manifest的跨语言canonical哈希标为未评估；补充[独立Node标准库哈希检查](manifest-hashes.json)核对两份manifest摘要，没有导入产品实现。两者不代替Runtime业务复验，也不证明人工签名或规范合格。[篡改前快照](quality-before-tamper.json)保留原始计数。

[截图索引](screenshots.json)记录本机截图哈希。三张营销图使用本包合成数据和空密钥设置，已更新至网站本地稿；不包含真实工程资料。官网仍未部署。

## 检查与剩余

[源码验证](local-checks.json)：桌面2584通过/2跳过，Runtime1825通过/3跳过，双端类型、构建、strict OpenSpec 11/11通过，lint 0 error/1既有warning；[push Quality](https://github.com/wangjiawei508/WorkWise/actions/runs/35467209182)和[PR Quality](https://github.com/wangjiawei508/WorkWise/actions/runs/35467211991)成功。

实机另发现重启后成果中心有历史输出时副标题仍显示“尚未生成预览”；后续源码单独修正，本包保留此已知问题。首次Computer Use网页/全设备读取超时，直接连接候选应用后恢复；初次后台shell启动没有存活进程，随后改为受控前台会话并核对退出与重启。附件并行下载的首次Python TLS环境缺根证书，改用系统CA文件后验证下载，未关闭证书验证。上述失败不隐去，也不计作GUI通过。

本包仅做合成JSON流程，不把它计作新的GSI/IN2 P0验收。真实模型成功、历史用户迁移、完整主题/locale/异常状态、专业签认和用户亲自确认仍未完成。规范抽样纯核不等于生产抽样流程；后续集成、评分、材料覆盖、签名与高级算法任务按[总台账](../../RAILWISE_SURVEY_CONVERGENCE_STATUS.md)继续推进。
