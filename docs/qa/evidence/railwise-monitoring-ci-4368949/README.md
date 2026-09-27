# 监测修复精确源码 CI 证据

源码 HEAD：`43689493ab586c8d65bae729cfd291f3c813f679`。2026-09-20 通过只读 GitHub CLI 获取 `wangjiawei508/WorkWise` 的两组 Quality 运行；结构化记录见 `ci-runs.json`。

| Run | 触发 | 结果 |
| --- | --- | --- |
| [35505927334](https://github.com/wangjiawei508/WorkWise/actions/runs/35505927334) | pull_request | completed / success |
| [35505923747](https://github.com/wangjiawei508/WorkWise/actions/runs/35505923747) | push | completed / success |

两组运行的 `headSha` 都是上述完整 HEAD。每组均有三个成功 job：`OpenSpec, brand, lint, type, test, build`、`Electron production smoke`、`Windows path, spawn, persistence`。步骤状态完整保留，包括 OpenSpec、品牌边界、文档许可、lint、桌面类型、Runtime 类型、两套完整测试、构建、Electron 启动、Windows 安全和持久化检查。

同时按 checkout 步骤的 `git log -1 --format=%H` 输出逐 job 核对：push 运行实际 checkout 为 `43689493ab586c8d65bae729cfd291f3c813f679`；PR 运行实际 checkout 为 `477248e6960a4d64c16e9e4d930953651f3955f1`，即把该源码 HEAD 合入基线 `bea9a0484ebbdf4b1abca89220ca45bba2c3eb1f` 的测试合并提交。`jobs[].checkoutSha` 明确保留二者差异；不能把 PR 测试合并提交声称为原始 HEAD 字节本身。

两组日志的测试汇总相同：

| 范围 | 文件 | 用例 |
| --- | --- | --- |
| 桌面完整套件 | 328 passed / 3 skipped | 2814 passed / 6 skipped |
| Runtime 完整套件 | 188 passed / 2 skipped | 2853 passed / 22 skipped |
| Windows core | 14 passed | 128 passed |
| Windows plugin | 9 passed | 104 passed |
| Windows Runtime 定向 | 6 passed | 60 passed / 2 skipped |

OpenSpec 汇总为 11 passed / 0 failed；品牌检查扫描 2204 个文件。CI 桌面计数不同于本机先前的 2818 passed / 2 skipped；本档案按每次实际日志记录，未将跳过测试计为通过。所有 job 成功不表示零警告，也不证明先前并行测试失败的根因。

归档只包含明确列出的 run/job/step 元信息和严格白名单的测试/检查汇总行。没有纳入完整控制台日志、环境变量、checkout 配置、凭据或用户工程资料。`retrievedLogSha256` 是当次 CLI 返回日志字节的哈希，原始日志未入库；重新获取时格式可能变化，应以 run URL、headSha 和结构化结果复核。最初未显式指定仓库的只读查询错误解析到上游并返回 404，随后所有有效查询均使用 `--repo wangjiawei508/WorkWise`；没有修改远端配置。

在本目录执行 `python3 -B verify.py`，仅读取文件并验证文件集合、SHA-256、精确源码、两个运行和每个 job/step 的成功状态，以及实际汇总数字。清单不是数字签名；离线验证不重新认证 GitHub。

这两组 CI 是源码检查证据。Electron job 的 `Launch packaged production preview` 成功不能代替本机最终候选包的安装、中文界面、主题/窗口检查、真实 updater 往返或用户确认。此任务未运行候选 GUI、未发布版本、未 commit、未 push。

`ui-static-summary.json` 是主任务对同一源码 HEAD 生成的静态 UI 清单白名单摘要：21 组件、14 helper、1233 个 literal 调用、134 个 dynamic 调用、441 个 catalog 字符串候选位置、1338 个选中唯一键、171 个 JSX 候选位置；选中键中英文缺失均为 0，英文 Han 字符键为 0。源码集合 SHA-256 为 `6eb1d244ba4af0031e1416cc756e06ff8851015aea9cec95833a128c06f2f9f3`。只保留摘要和来源哈希，未把动态文本、外部共享组件、运行时状态或 JSX 候选数量等同于 GUI 覆盖率。既有 `RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md` 的 `267aadeafebeecdbbb3bc012f3844793d060990a` 基准保持原样，没有重写历史基准。

附带本机兼容性检查：现有 `/private/tmp/railwise-final-monitoring-audit.py` 已兼容 `/private/tmp/railwise-4368949-monitoring-inputs.json` 中的 `files[].fingerprint` 和 `target` 字段。已核验 16 个默认输入及 1 个可选输入的目标路径、大小和 SHA-256；两份新监测源独立计算为 S01 当前8/上期2/累计8/速率2、S02 当前-1/上期5/累计-9/速率-2，6 项原有自测通过。无须修改临时工具；未打开候选数据库或执行 before/afterrestart 审计。该兼容性结果不能视作候选包功能通过。
