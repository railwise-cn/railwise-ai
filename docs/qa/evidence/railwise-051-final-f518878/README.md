# RailWise AI 0.5.1 / #156 本机最终包验收

日期：2026-09-27；源码：`f51887885655476e2e7ba766c16d1383454b5b3f`。

**状态：失败，不能发布。** 签名、限定 GUI/计算链和同源码隔离原生 updater 通过；真实 Survey AI 结果读回遭模型服务 HTTP 400，必须由新包复验。修复提交为 `9a7cd6c3`，不能倒填本包通过。

## 工件身份与安装

- Actions：`36311354908`（#156），三客户端构建及候选校验成功，Publish GitHub Release skipped。完整 job 记录见 `candidate-run-156.json`。
- 汇总归档：`candidate-installers-0.5.1-156.zip`，SHA256 `097d9f72d03f3bfbe6b4a9a9068001bc117fa0b8a2a37572a5b8d2dbe8e468c1`。
- Apple Silicon DMG：`9ca1cfded470eaba5156c611fcbf34b2c2870ce4d0422d7d92c897a3da2e67f0`；Intel DMG：`5c54850c99853b52e58d65e70638795483cc84b82788d57de7db687368c01c56`；Windows EXE：`ae535cc2e831e0ced5b1ab53d4dbdd8e3536ecfeb3db86bc1a77e7030e06be1a`。
- 本机安装：`/Applications/RailWise AI.app`；旧应用保存在 `/private/tmp/railwise-pre156-backup/RailWise AI.app`，未删除用户资料。
- 版本 `0.5.1`，bundle `com.wangjiawei508.workgpt`，Team `R35G7F4A9U`，Developer ID 公司签名。
- DMG 内与安装后 ASAR 相同：`d544d8412caac38fb24b4adc1694db34479e41ac55fdc9ec3dc6c41f4b986623`。
- `codesign --verify --deep --strict`、5 个 Electron/V8 executable 权限、公证 stapler 校验通过。更新配置为 `generic / https://127.0.0.1/`。
- 本机 Gatekeeper 原先为 `assessments disabled`，没有改动。因此 `spctl accepted / Notarized Developer ID / override=security disabled` 不能视作开启策略的验收；独立 hosted runner 报告记录 assessments enabled。

## 本机操作清单

主机 macOS 27.0 (26A428)，arm64。

| 检查 | 结果与证据 |
| --- | --- |
| 启动、正常退出及普通入口重启 | 首次 `open` 在 AppTranslocation 路径停在 `_dyld_start`；停止该实例后直接运行安装路径成功。随后 Cmd-Q + 普通 `open` 重启成功，窗口和 Runtime 正常。首次异常保留，不宣称原因已查明。 |
| 单实例端口 | 8787/8788 由同一主进程监听，无本轮新增 EADDRINUSE。 |
| 浅色、深色、跟随系统 | 三种模式可切换；截图 01–10。最终恢复 `theme: system`，重启后保留。 |
| 窗口 | 常规 1280×840、最大化 1920×985 和最小 960×640 逻辑像素已检查（截图分别为 2560×1680、3840×1970、1920×1280）。补录截图16显示最小尺寸上下布局，导航及输入区可见；不扩写为全部页面/键盘矩阵通过。 |
| 旧资料 | 旧编程会话和原内业项目仍可见；这仅是本机保留证据，不代表完整旧用户迁移矩阵。 |
| Survey 页面 | 数据资产、质量校核、来源预检、平差页面可用；空数据校核/平差按钮禁用，提示资料边界。 |
| 真实 IN2 操作链 | 独立项目“候选156功能验收（合成样例）”，从原生文件对话框导入仓库 `golden-plane-control-e2e.in2`，4 点/5 观测，校核通过、平差完成。 |
| 数值与来源 | S1 显示 (50,50)，σ₀≈0.000107，无量纲方差因子 1.13874e-8，最大点位中误差 1.35922e-7 m。点击距离残差定位到 `cosa-in2-record-8`、偏移103、长度11，摘录 `B,S,100.000`。见 12–14。合成样例不是仪器或生产认证。 |
| 真实 AI 读回 | 点击 S1 追问并实际发送；模型拒绝 `survey_read_evidence` 的顶层 schema：`type: null`，HTTP400。见 15。没有成功工具调用/解释证据。 |
| 崩溃 | 本轮操作期间最新 RailWise 崩溃报告仍为 2026-09-27 16:02:41，没有新增报告。 |

## 同源码私有 updater 往返

Actions `36315443767`（#157），原始证据在 `updater/`，job 记录在 `updater-run-157.json`。

- `private-updater.json` 和 `native-updater.json` 均为 passed。
- macOS arm64，隔离 bundle `com.wangjiawei508.workwise.candidate.headf51887885655`，同源码 `0.0.0 → 0.5.1`。
- 真实阶段：base_started → update_available → download_completed → install_requested → target_relaunched → user_data_preserved。
- 1 次 manifest、1 次 ZIP，303006971 字节；完成时间 `2026-09-27T11:39:13.887Z`。
- 目标/安装后 ASAR 均为 `1f4c375c564cad3637bb61b5e7bea78de2e5a454d5f569d88cf8460f639825ba`；target ZIP SHA256 `bddfa40a6158e782b7c5d436e9aea6cc16c9e05d7df6827939b59e80784449b6`。
- 签名、公证及开启状态 Gatekeeper 已验证，数据哨兵保留、cleanup 完成；productionTouched、publicFeedUploaded、systemTrustModified、browserOpened 均 false。
- 该隔离包和 #156 正式身份候选的 ASAR 不同，不能声称是同一二进制；同源码往返不代替 #156 GUI 或历史版本迁移验收。

## 修复与复验边界

根因：`z.toJSONSchema(SurveyEvidenceReferenceV1)` 输出 `$schema` + `oneOf`（17分支），没有顶层 type。模型 wire 请求原样携带该 schema。修复补显式 `type: object`，保留全部原分支；执行侧严格引用和项目/工作区校验不变。

新增回归在旧代码上复现 HTTP400，修复后相关 89 项通过。全量 Runtime 2945通过/22跳过；桌面2870通过/2跳过；双端类型、构建、两文件 ESLint通过。首次测试受 SQLite Node ABI 与工作目录影响，已按当前 Node 重编译工作区原生依赖并在 kun 目录重跑通过；未改安装应用依赖。

新候选和新私有 updater 必须绑定修复后的源码。用户本人 UI/功能确认及明确版本发布批准仍未取得；本轮未创建 tag、Release 或改公共 feed/官网。
