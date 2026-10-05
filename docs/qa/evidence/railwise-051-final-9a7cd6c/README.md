# RailWise AI 0.5.1 / #158 最终候选复验

日期：2026-09-27；源码：`9a7cd6c394d0f796ccb28f06f694439bf280227d`。

**状态：失败，不能发布。** 安装启动、签名公证、系统主题及同源码私有updater通过；HTTP400修复已在真实模型请求中验证，但旧版精确上下文引用被模型误送到类型化接口，必须由后续候选复验。

## 本次修复

真实 #156 安装包发送 S1 结果追问时，DeepSeek 拒绝 `survey_read_evidence` 顶层 schema，HTTP400。Zod 为17分支对象联合输出 `oneOf`，没有根 `type`。本提交显式补 `type: object`，原分支、引用校验和执行权限保持原有语义。回归先在旧实现复现失败，再验证模型 wire 请求完整保留全部分支。

原包失败、安装身份及历史 updater 证据见 [#156 报告](../railwise-051-final-f518878/README.md)。旧包通过的子项不倒填为本包已通过。

## 已通过的源码验证

- 相关回归89项；Runtime全量2945通过/22跳过，桌面全量2870通过/2跳过。
- 双端类型检查、构建、改动文件ESLint、OpenSpec strict 11项通过。
- PR #28 的质量门禁、Windows路径/进程/持久化、Electron production smoke通过。
- 测试日志保留在旧失败报告目录的 `schema-fix-*.log`，对应本修复后的源码验证，非旧二进制功能证明。

## 同源码隔离真实 updater 已通过

#159报告见 `updater/`：签名及公证通过、Gatekeeper开启。实际完成基线启动、发现更新、下载、请求安装、目标重启、数据保留六阶段。0.0.0 → 0.5.1，下载1次manifest和1次ZIP（303005848字节），没有打开浏览器。目标/安装后ASAR均为 `0dc62b42c198ad6ed3093d09103dfee3f7eba4a588fc6d5cd9a379da3f23b79c`；目标ZIP SHA256为 `4322a502e66a025c245daed9a5c52b30f9f904692001cb14a304ad93d7973d54`。数据哨兵保留，清理完成，未接触生产或上传公共feed，也未改系统信任。

隔离身份为 `com.wangjiawei508.workwise.candidate.head9a7cd6c394d0`。这是同源码隔离更新探针，不是历史版本用户资料迁移，也不宣称与#158正式身份候选为同一二进制。报告中的frontier标签仅用于本地回环测试feed，没有推进公共frontier。

## 最终安装包结果

#158三客户端构建、候选校验与DMG独立复核全部成功，Publish GitHub Release skipped。Apple Silicon DMG SHA256 `9de0327e141aa55e392d1a9ef23eb085bd877a827add2e0d77536a189afb18a4`；从认证Actions工件通过HTTP Range提取对应ZIP成员，CRC及工件内SHA256SUMS均通过。没有下载完整外层ZIP，不声称复算外层归档digest。

2026-09-27 20:20安装 `/Applications/RailWise AI.app`，#156备份在 `/private/tmp/railwise-pre158-backup/RailWise AI.app`。版本0.5.1，arm64，bundle `com.wangjiawei508.workgpt`，Team `R35G7F4A9U`。deep strict签名、公证stapler、5个Runtime可执行文件Electron/V8权限通过；私有更新地址 `https://127.0.0.1/`。普通open入口直接启动成功，旧项目和成果保留，system深色主题生效，8787/8788同一主进程。

安装和DMG ASAR均为 `d544d8412caac38fb24b4adc1694db34479e41ac55fdc9ec3dc6c41f4b986623`，与#156相同是因为本次修复在ASAR外的kun Runtime。已独立核对修复模块：安装与DMG均 `75fbe0cba5909fe19ea0a977263a8bc66c4144c600e5c167c362402c3e0af40c`，#156为 `0b17fdbeff4f7500d652cc91f9ee0bb5ec396b173440181a18185d32bce31e21`。见 `runtime-fix-identity.json`。

真实模型turn `turn_uiqkoafy` 调用了 `survey_read_evidence`（invalid-reference）及 `survey_read_context`（精确S1读取成功），随后回答S1≈(50,50)，同时错误地把legacy引用说成缺字段的typed引用。HTTP400已经消失，但此条完整体验未通过。完整非推理工具/回答保留在 `real-model-readback.json`，截图与AX见02。

根因：S1结果入口生成兼容的legacy selector，composer没有像typedEvidence分支一样显式说明应调用的工具。后续提交 `5e49d220` 补明确 `survey_read_context` 指令及禁止发明typed引用，相关回归先红后绿，17项针对性、全量桌面2870通过/2跳过，类型、构建、ESLint、strict通过。首次全量受沙箱EPERM禁止localhost监听影响，在允许本地监听的测试环境重跑通过。后续候选#161与私有updater#160需独立验收。

## 历史验收计划（对应上述结果）

- [#158 三客户端私有候选构建](https://github.com/railwise-cn/railwise-ai/actions/runs/36316718463)：完成后安装最终 Apple Silicon DMG，核对签名、公证、版本、ASAR、V8权限及私有更新配置。
- [#159 同源码隔离真实 updater](https://github.com/railwise-cn/railwise-ai/actions/runs/36316720232)：归档实际下载、Squirrel重启和用户数据保留证据，核对目标/安装后二进制。隔离身份和正式身份候选的包不宣称二进制相同。
- 实际 GUI：正常启动/退出/重启，系统主题及浅深色，常规/最大/最小窗口，原数据保留，合成IN2确定性结果与证据锚点，真实AI工具读回及正确回答。

## 范围与发布门禁

本轮针对用户报告的安装后启动崩溃、系统深色主题与最终包功能复验。合成IN2仅用于回归，不是生产/仪器认证；完整P1/P2、全功能组合和专业签认仍由[剩余工作清单](../../RAILWISE_SURVEY_REMAINING_WORK.md)追踪。

本机Gatekeeper原先关闭；没有改变系统安全设置。本机签名/公证检查不能替代开启Gatekeeper的hosted runner验证。用户本人对精确包UI/功能确认以及明确版本发布批准仍未取得。本轮没有创建tag、发布Release、推进公共feed或修改官方下载页面。

## 后续预验证（不倒填完整通过）

在相同#158安装包手工加入后续路由指令后，turn `turn_n6ehcqej` 只调用 `survey_read_context`，S1成果读取成功；见 `manual-routing-prevalidation.json`。回答把sourceSha256与计算inputHash直接比较，属于模型解释偏差，不能用作证据版本判定。

通过原始点位入口的真正typed引用，turn `turn_qc8erety` 调用 `survey_read_evidence` 返回resolved，精确命中network revision2、unknownPoints[0]、identity S1；回答正确区分初始坐标与平差结果并说明未签认边界。见 `typed-evidence-prevalidation.json` 及03截图/AX。此项验证schema修复可执行真实严格读取；不能代替后续#161自动legacy路由复验。
