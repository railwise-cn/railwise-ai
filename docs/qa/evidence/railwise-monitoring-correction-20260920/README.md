# 监测修复源码证据，2026-09-20

对应产品提交：`43689493ab586c8d65bae729cfd291f3c813f679`。本目录只归档源码修复、测试日志、合成夹具和待执行验收工具；最终安装包验收全部 `not-run`。没有新的公开版本发布、签名/公证结论、真实 updater 往返、专业签字或生产 KPI 结论。

## 已知问题与源码修复

- XLSX 空白/空格可选累计值、速率不再转为数字 0；明确的 0 保留。
- 图表使用逐条原始观测，按监测项、单位和测点分组，实际时间比例绘图，单观测也可见。
- 时间有效性、数据范围、重复/逆序校核、分析和图表统一使用真实时刻；无时区 ISO 日期/时间明确按 UTC。不同 offset 的字符串顺序不代表时刻顺序。
- 分析和质量检查使用结构化身份，避免名称内 `|` 引起不同测点合并。新算法 `workwise-engineering-2` 与图表 `engineering-trend-2` 的缓存及自动请求键版本化；旧记录、旧文件及显式旧请求回放保留。
- 中文报告补单位、速率单位、趋势标签和待审查状态。

## 保留失败与通过记录

| 记录 | 事实及范围 |
| --- | --- |
| `logs/final-desktop-tests.txt` | 3 文件失败；4 用例失败、2814 通过、2 跳过。4 项超出 5 秒，并出现两处清理 `ENOTEMPTY`。失败未删除。 |
| `logs/final-runtime-tests.txt` | 2 文件失败；4 用例失败、2840 通过、22 跳过。3 项完成门控超时，队列测试在固定 20ms 后观测到空数组。 |
| `logs/desktop-serial-suite.txt` | 329 文件通过、2 跳过；2818 用例通过、2 跳过。该运行早于最后 GUI 算法键/自动选择改动，不能称为最终 GUI 代码的完整套件结果。 |
| `logs/runtime-frozen-suite.txt` | 188 文件通过、2 跳过；2853 用例通过、22 跳过。包含本次 Runtime 最终时间规则与迁移测试。 |
| `logs/frozen-workspace-tests.txt` | 定向命令误写 `.tsx`，没有找到测试，退出 1；保留该失败调用。 |
| `logs/frozen-workspace-tests-corrected.txt` | 改为真实 `.ts` 文件后最终工作区 DOM 38 项通过，覆盖最终 GUI 增量；另有类型检查与构建日志。 |
| `logs/frozen-typecheck.txt` / `frozen-runtime-types-explicit.txt` | 桌面双端类型及 Runtime 类型检查。后者输出为空；成功状态由执行者提供，空文件本身不能证明退出码。 |
| `logs/frozen-build.txt` / `frozen-lint.txt` / `frozen-openspec.txt` | 完整构建、lint、OpenSpec 的执行输出；保留原有警告，不把警告描述成零警告。 |

并行全量失败后分别运行的套件通过，**不能证明资源竞争就是失败根因**；测试期间也发生过明确的代码/测试修复，不能把这些运行当作仅改变一个变量的对照实验。

队列测试独立确认存在等待条件错误：生产队列在回调前须异步完成路径规范化与文件锁获取，固定 20ms 不保证首个回调已经开始。测试改成首个回调显式通知 `firstStarted`，等待通知后检查第二个回调尚未执行；`finally` 释放首个回调并等待两个任务结束。没有扩大 sleep、全局 timeout，也没有为此修改生产队列。整份队列所在测试文件 38 项通过，定向 ESLint 与 diff-check 通过；此定向结果由执行记录陈述，不伪造原始日志。

## 白名单与来源

`synthetic-input-manifest.json` 保留默认 16 份合成输入的名称、大小和哈希。14 份历史夹具原件仍在本机临时目录，本档案不含它们的字节；`inputs/` 仅包含两个新增合成监测输入和一个单列的 offset 反例。没有原始数据库、真实 P0 工程资料、用户配置、环境变量或凭据。

`source-copy-provenance.json` 记录纳入白名单的本机文件名、原始 SHA-256、归档 SHA-256 与转换类型。日志只将仓库绝对路径和系统临时目录前缀替换为 `<REPOSITORY>` / `<SYSTEM_TEMP>`，失败堆栈、计数与时间保留。工具路径适配另见下文，不能声称这些适配后的文件与原件逐字节相同。

`chart-review/review-manifest.json` 原样保留图表 agent 在较早源码时点进行的三组纯合成 SVG 渲染观察及哈希；对应 SVG/PNG 字节已一并归档。它是先前图表检查的证据，其 contracts/shared 源码哈希可能早于最终分析算法迁移，**不是最终提交或最终安装包的视觉验收**。`independent-geometry-preflight.svg` 是另一次离线真实 renderer→独立 Python 几何核验用图，也不是 GUI 截图。

## 工具与本机依赖

在本目录执行 `python3 -B tools/verify-archive.py`：只读检查归档文件集合、哈希、合成清单、失败/通过日志计数和未来矩阵；不打开数据库，不运行包验收，不写输出。`archive-manifest.json` 是内容完整性清单，不是数字签名或独立签字。

`python3 -B tools/monitoring-audit-selftest.py` 可重新运行 6 项独立算术/空零/时区/图形负例，仅读本目录两份新夹具。归档执行输出在 `logs/audit-selftest.txt`。使用 Python 3.10+；`-B` 防止产生字节码文件。

`tools/monitoring-audit.py` 是本机候选核验工具，会在指定的新私有输出目录复制已关闭的数据库、做 SQLite backup 并保存检查结果；它不是只读归档校验器。原库只作文件读取，不作为 SQLite 连接打开。它仅支持 `/private/tmp` 下的候选与输出，需要 macOS `lsof`、Python SQLite、PATH 中的 Node，以及本仓库已安装的 `pdfjs-dist`。PDF helper 改为包导入、audit 改为同目录 helper、selftest 改为本目录夹具；这些路径适配均记录原件与归档哈希。不保证任意机器直接可运行。

`tools/original-local-input-preparation.py` 原样保留最初的本机准备脚本：包含固定 `/private/tmp/railwise-*` 历史目录依赖，并使用独占创建防止覆盖。它用于解释来源，**不得把它当作可移植安装器直接运行**。未来包输入应从已核验的本机夹具复制并重新核验哈希；归档未包含全部 14 份历史原件。

最终包操作按照 `FUTURE_PACKAGE_MATRIX.md`，逐项填真实 head、ASAR、项目/清单 ID、截图及正常退出证据。所有未来行当前均 `not-run`，通过源码测试不改变这些状态。该最小监测矩阵也不替代全产品主题/尺寸矩阵、人审与真实 updater 往返。
