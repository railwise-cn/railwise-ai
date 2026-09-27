# 监测成果严格重算验收合同与独立算例

原合同日期：2026-09-20；实现进展更新：2026-09-21。原合同核对源码为 `43689493ab586c8d65bae729cfd291f3c813f679`，其候选包没有监测数值复算。本文件保留原有独立算例和历史设计依据；下节记录后续源码增量，不追溯改变旧候选结论。审查主体为 agent，不是专业签字。

## 2026-09-21 精确包验收

[b193fc7 签名候选](evidence/railwise-monitoring-replay-package-b193fc7/README.md)已完成实际 CSV/XLSX 导入到三格式与清单、原件复算、历史缺源未评估、输出篡改阻断与原字节恢复、重启后复算及独立持久化审计。中英文浅深主题与常规/宽窗口截图已留存。最初审计辅助脚本的布尔比较错误及修正记录保留，未改产品数据。此范围不包含全键盘/最小窗口矩阵、真实生产或用户本人验收。

## 2026-09-21 源码增量

新增独立 `POST /v1/engineering/projects/:id/manifests/:manifestId/monitoring-replay`，不改变原 `manifest/outputs/inputs/surveyReplay/sources` 五项合同。桌面草稿清单下增加“复算监测成果”，结果带项目、清单、分析、算法、源文件、导入上下文、结果摘要及执行环境；切项目、清单、修订或 Runtime 状态后旧响应失效。

新导入将原始 CSV/XLSX 字节及导入时项目、原请求映射和有效映射与 dataset 一起原子保存到追加表。复算先核实成果绑定及文件，再从原字节重新解析、比较全部规范化观测，最后调用无缓存的 v2 纯计算并逐字段比较完整 results；异步解析后再次检查原件、SQL 行、输入和输出。只追加独立 started/finished 审计，不改写原分析、清单、报告或旧五项复验记录。

支持边界为 `workwise-engineering-2`、不超过20,000条观测、32 MiB原件和256 KiB上下文。v1/未知算法返回未评估；旧记录缺原件返回未评估，不能事后补造原件；无监测分析才不适用。同组同一实际时刻存在多条观测时，因原分析未记录排序环境，本增量统一未评估：即使ASCII观测ID，系统 numeric collation 也会改变 `_10` 与 `_2` 的顺序。资源超限、来源不符、结果不符及前置条件失败分别记录原因。独立统计脚本仅汇总新表的持久开始，未完成保留分母，不改变旧指标或给出真实生产达标结论。

源码测试、独立审查和新精确包验收结果见[执行台账](RAILWISE_SURVEY_CONVERGENCE_STATUS.md)。此处功能说明不等于签名安装包、用户本人或专业验收已通过。以下“建议实现”是原合同历史措辞，以本节现有实现为准。

XLSX解析额外限制2,048个ZIP条目、实际读取的共享字符串/工作表累计32 MiB及相对原文件200:1展开比，并拒绝超出XFD的列号。累计量来自流实际输出，不依赖压缩包声明尺寸。这些约束同时用于新导入与重放；不把未读取的ZIP附件当作已扫描内容。

## 已核实的起点

[createAnalysis](../../kun/src/engineering/engineering-service.ts) 的 `workwise-engineering-2` 已按实际时刻排序、计算间隔，并与[趋势时间解析](../../kun/src/engineering/engineering-trend-chart.ts)共享无时区按 UTC 的规则；[时区及迁移测试](../../kun/src/engineering/engineering-service.analysis-time.test.ts)已覆盖跨偏移逆序、夏令时和旧记录保留。

原审计时，同服务的 `verifyDeliverable` 核对 manifest、文件、输入快照及 Survey 平差/变形重算；纯监测清单的 `surveyReplay` 为 `not-applicable`，没有独立重新计算 `MonitoringAnalysisV1.results`。该五项旧合同仍保持原样；新增监测复算使用独立合同和端点，不能把历史五项通过冒充已经运行新功能。

## 数值字段到来源的映射

先验证同一 project/dataset/analysis/run/manifest 的绑定和文件字节，再做数值重算；任何单项都不能代替其他项。

| 字段 | v2 软件语义与来源 | 验收要求 |
| --- | --- | --- |
| `monitoringItem, point` | 原始行映射后的身份，按二元组分组 | `c / a|b` 与 `c|a / b` 必须分开；输出顺序保持该算法的首次组出现顺序 |
| `currentValue` | 组内按 UTC instant 升序、同刻按 observation ID 的当前算法排序规则，最后观测的 `value` | 绑定确切 observationId、原 timestamp、sourceRow/sourceFields 和源文件 SHA-256；不取最后文件行 |
| `previousValue` | 同排序倒数第二条的 `value` | 单记录缺省，不补0；同刻记录不是独立时间间隔 |
| `cumulativeChange` | 有至少两条时，`(last.cumulative ?? last.value) - (first.cumulative ?? first.value)` | 原始缺省、明确0、非零分开；这是当前软件的首末差定义，不认定现场“累计量”一定应如此解释 |
| `changeRate` | 最近两条 `value` 差除以 UTC elapsed days，一日=86400秒 | 不使用调用者填写的 `rate`；同刻或无上期缺省，不除0，不代入累计量差 |
| `trend` | 无累计差为 unknown；绝对差 `<1e-9` 为 stable；否则按差符号 rising/falling | `1e-9` 是既有软件阈值，不是工程规范限差；边界及浮点结果须按原算法复现 |
| `thresholdStatus` | 项目按监测项阈值优先，否则 default；无阈值 unresolved；`abs(current)>=T` alarm，`>=0.8T` warning，否则 normal | 这是当前单阈值投影；即使 schema 允许 control，本算法也没有产生 control 的分支，不补造多级告警语义 |
| `anomaly` | `abs(cumulativeChange ?? 0) > T`；无阈值则false | 严格大于，与 thresholdStatus 的当前值及大于等于不同；不可把两字段强行统一 |
| 图表和 XLSX `chart_data` | 全部原始观测，分项/点/单位，真实时间、原文时间和来源行 | 不以 currentValue 一行替代历史；图表是 observation values，不是累计差/速率曲线 |
| 报告单位 | 当前监测报告结果用 project.unit，速率用 project.unit/d | 重算一致不能证明原资料单位一致；混合/缺失单位、零或负阈值的专业适用性须单独标未评估，不能由重算绿灯覆盖 |

上述来源类别沿用[UI 数值清单 N21/N24/N25](RAILWISE_SURVEY_UI_EVIDENCE_COVERAGE.md)：调用者声明、Runtime 派生值、界面格式化和审计元数据分别保留。软件结果可复现不等于阈值获批、来源真实、随机模型有效或规范符合。

## 建议实现合同与旧版本迁移

1. 新建无写操作的版本分派纯计算入口，输入为明确冻结的项目、observations 和 algorithmVersion。不能调用 `createAnalysis` 冒充重算：它会读取缓存或旧幂等结果，并可能新增分析记录。
2. 新的重算副记录绑定 analysisId、算法、输入摘要、存储结果摘要、重新计算结果摘要、比较策略版本和执行环境；返回 `passed/failed/not-evaluated/not-applicable` 的明确原因。初次可采用独立版本化 sidecar/端点，使旧 manifest、旧复验记录及严格旧 schema 继续可读；具体路由为待实现设计，不在本文发明已存在 API。
3. `passed` 要求来源绑定可核实、版本已支持、完整结果逐字段相同。同一算法的重放不能用数值容差掩盖记录变化；独立 Fraction 算术只作外部 oracle，其有理数转换到 binary64 的比较政策另记，不当成历史字节相等证明。
4. `failed` 适用于已可评估但输入绑定、存储结果或严格重算不一致；`not-evaluated` 适用于旧版本缺执行依据、未知算法、无法建立来源/环境等情况；`not-applicable` 仅用于本次成果确实不含监测分析。后两者均不能计入通过分子。
5. 比较结果只追加验证证据，不修改原分析、run、manifest、文件、用户审查状态或旧成功/失败事件。修改原始行后必须新导入/分析，不能为了使旧结果通过而补值、换算法或重新排序原始存储。

| 历史情形 | 合法读取/重放行为 | 禁止行为 |
| --- | --- | --- |
| v2 原记录 | 按v2规则重新计算，保留当前版本输入哈希语义；明确记录执行环境和完整比较范围 | 用当前 latest analysis/cache 当参考答案 |
| v1 且来源、旧实现和时区/日期语义可证明 | 显式旧算法分支可重现其原有字符串排序和宿主时间行为；复现旧缺陷仍只证明历史一致 | 把v2正确排序回填为v1结果，或只因不同于v2就删除历史 |
| v1 含无时区 datetime/非标准日期，原宿主规则未知 | 原记录仍可读；重算给 `not-evaluated` 并列缺失的环境依据 | 默认以当前电脑时区或UTC解释，然后声称旧算法通过 |
| 早期导入已把空 cumulative 变成0 | 保留当时已存观测；独立指出源行为空与存储0的语义差异，修复路径为显式重新导入 | 在重算器里偷偷把旧0改成缺省 |
| 同刻多记录或任意非ASCII身份 | 保存全部；重放需匹配原 localeCompare/ICU排序语义，不能任意合并或猜测顺序 | 使用新的自然排序、去重或平均数替换旧算法 |
| 未知 algorithmVersion | 历史读取保留；未支持版本明确未评估 | 自动回退到v2并沿用旧算法标签 |

v1 原记录未必保存足够的宿主日期/locale/引擎资料，不能通过事后搜索给它补造环境证据。新增版本可冻结更完整环境信息，但不得覆盖既有 inputHash 或已有数字。

## 独立精确算术基准

以下只处理表内合成观测，使用 Python 标准库 `datetime` 和有理数 `Fraction`，不导入产品函数、不读取数据库、不启动应用。它不复制产品日期词法校验器，不能取代严格 ISO 的非法输入测试；也不覆盖任意 ID 的 ICU 排序。所有样例 ID 为简单 ASCII a/b/c，数值刻意选择无边界歧义的精确值。`None` 表示字段缺省，而非 JSON null 写入现有可选数值字段。

| 编号 | 输入要点 | current / previous / cumulative / rate | trend / threshold / anomaly |
| --- | --- | --- | --- |
| M01 | 日间隔 value 2→4，无 cumulative，T=10 | 4 / 2 / 2 / 2 | rising / normal / false |
| M02 | Aug1 23:00-08=7；Aug2 01:00+08=2，文件顺序逆实际时刻 | 7 / 2 / 5 / 60÷7 | rising / normal / false |
| M03 | 03-07 12:00→03-08 12:00，无时区，2→6 | 6 / 2 / 4 / 4 | rising / normal / false |
| M04 | 10-31 12:00→11-01 12:00，无时区，2→6 | 6 / 2 / 4 / 4 | rising / normal / false |
| M05 | 2→4，两条 cumulative 均明确0 | 4 / 2 / 0 / 2 | stable / normal / false |
| M06 | 2→4，首 cumulative=0，末缺省 | 4 / 2 / 4 / 2 | rising / normal / false |
| M07 | 单条 value=0 | 0 / 缺省 / 缺省 / 缺省 | unknown / normal / false |
| M08 | 同一instant以Z/+08表示，ID a=2,b=4 | 4 / 2 / 2 / 缺省 | rising / normal / false |
| M09 | 1日、2日、5日 value=2,4,10 | 10 / 4 / 8 / 2 | rising / alarm / false |
| M10 | 0→8，T=10 | 8 / 0 / 8 / 8 | rising / warning / false |
| M11 | 0→10，T=10 | 10 / 0 / 10 / 10 | rising / alarm / false |
| M12 | 0→11，T=10 | 11 / 0 / 11 / 11 | rising / alarm / true |
| M13 | 4→2，无阈值 | 2 / 4 / -2 / -2 | falling / unresolved / false |

可执行代码：

```python
from datetime import datetime, timezone
from fractions import Fraction as F
import json

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

def instant(text):
    value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    delta = value.astimezone(timezone.utc) - EPOCH
    return F(delta.days * 86400 + delta.seconds) + F(delta.microseconds, 1000000)

def row(identity, timestamp, value, cumulative=None):
    return (identity, timestamp, F(value), None if cumulative is None else F(cumulative))

def calculate(rows, threshold):
    ordered = sorted(rows, key=lambda r: (instant(r[1]), r[0]))
    first, current = ordered[0], ordered[-1]
    previous = ordered[-2] if len(ordered) > 1 else None
    baseline = lambda r: r[2] if r[3] is None else r[3]
    change = baseline(current) - baseline(first) if previous else None
    elapsed = instant(current[1]) - instant(previous[1]) if previous else None
    rate = (current[2] - previous[2]) * 86400 / elapsed if elapsed else None
    trend = "unknown" if change is None else (
        "stable" if abs(change) < F(1, 1000000000) else "rising" if change > 0 else "falling")
    status = "unresolved" if threshold is None else (
        "alarm" if abs(current[2]) >= threshold else
        "warning" if abs(current[2]) >= F(4, 5) * threshold else "normal")
    anomaly = threshold is not None and abs(change or 0) > threshold
    values = [current[2], previous[2] if previous else None, change, rate]
    return [None if x is None else str(x) for x in values] + [trend, status, anomaly]

def pair(a, b, ca=None, cb=None):
    return [row("a", "2026-08-01", a, ca), row("b", "2026-08-02", b, cb)]

cases = [
    ("M01", pair(2, 4), 10, ["4", "2", "2", "2", "rising", "normal", False]),
    ("M02", [row("a", "2026-08-01T23:00:00-08:00", 7), row("b", "2026-08-02T01:00:00+08:00", 2)], 10, ["7", "2", "5", "60/7", "rising", "normal", False]),
    ("M03", [row("a", "2026-03-07T12:00:00", 2), row("b", "2026-03-08T12:00:00", 6)], 10, ["6", "2", "4", "4", "rising", "normal", False]),
    ("M04", [row("a", "2026-10-31 12:00:00", 2), row("b", "2026-11-01 12:00:00", 6)], 10, ["6", "2", "4", "4", "rising", "normal", False]),
    ("M05", pair(2, 4, 0, 0), 10, ["4", "2", "0", "2", "stable", "normal", False]),
    ("M06", pair(2, 4, 0), 10, ["4", "2", "4", "2", "rising", "normal", False]),
    ("M07", [row("a", "2026-08-01", 0)], 10, ["0", None, None, None, "unknown", "normal", False]),
    ("M08", [row("a", "2026-08-01T00:00:00Z", 2), row("b", "2026-08-01T08:00:00+08:00", 4)], 10, ["4", "2", "2", None, "rising", "normal", False]),
    ("M09", pair(2, 4) + [row("c", "2026-08-05", 10)], 10, ["10", "4", "8", "2", "rising", "alarm", False]),
    ("M10", pair(0, 8), 10, ["8", "0", "8", "8", "rising", "warning", False]),
    ("M11", pair(0, 10), 10, ["10", "0", "10", "10", "rising", "alarm", False]),
    ("M12", pair(0, 11), 10, ["11", "0", "11", "11", "rising", "alarm", True]),
    ("M13", pair(4, 2), None, ["2", "4", "-2", "-2", "falling", "unresolved", False]),
]
for name, rows, threshold, expected in cases:
    actual = calculate(rows, None if threshold is None else F(threshold))
    assert actual == expected, (name, actual, expected)
print(json.dumps({"oracle": "monitoring-replay-fraction-1", "cases": len(cases), "passed": len(cases), "scope": "synthetic-arithmetic-only"}))
```

仓库根目录执行以下只读命令可从本文件提取并运行同一代码；不另存脚本、不修改仓库：

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess, os
text = Path('docs/qa/RAILWISE_MONITORING_REPLAY_ACCEPTANCE.md').read_text()
source = text.split('```python\n', 1)[1].split('\n```', 1)[0]
for zone in ('UTC', 'America/Los_Angeles'):
    result = subprocess.run(['python3', '-c', source], env={**os.environ, 'TZ': zone}, check=True, capture_output=True, text=True)
    print(zone, result.stdout.strip())
PY
```

本次实际运行：UTC 和 America/Los_Angeles 各13/13通过。它只确认本文件合成算术及无时区UTC语义；没有连接产品 Runtime、执行新重算端点或增加真实生产样本。

## 产品实现后的负例与通过条件

| ID | 操作/输入 | 必需结果与保留证据 |
| --- | --- | --- |
| V01 | 清洁v2结果，对照M01–M13 | 可评估记录全字段重算；准确报告比较策略/环境/版本，不只比currentValue。M08同刻算术基准保留，但本次产品因缺原排序环境明确未评估 |
| V02 | 只改已存 current/cumulative/rate/trend/anomaly/status 任一字段 | 单字段变化均被发现；不自动修复结果；来源及文件原件不变 |
| V03 | 伪造analysis结果，同时重算普通输入快照摘要以保持表面自洽 | 真正数值重算仍失败；不能仅与同库的声明摘要互证 |
| V04 | 改源文件、行映射、原值、cumulative、时间、项目阈值之一 | 来源或绑定失败，不先把重算值当可信；明确哪个证据范围不可评估 |
| V05 | 返回别的project/dataset/run/analysis结果，或同项目错误analysis ID | 归属/绑定拒绝；响应不暴露其他项目内容 |
| V06 | v1历史key、v2新key、未知版本、v1宿主时区缺失 | 历史显式读取/重放保持原字节；新计算新版；未知/无依据不给通过 |
| V07 | `08/01/2026`、无效日、同刻不同偏移、非有限值、缺失/重复observation ID | 非法输入明确拒绝；同刻保留全部、不除0；不改原始行、不截断 |
| V08 | `c/a\|b` 与 `c\|a/b`；不同单位但同测点 | 身份无碰撞；单位问题独立显示，不因数值相等授予专业适用性 |
| V09 | 数据集超分析/图表预算，计算取消、数据库写验证记录失败 | 明确终态/未评估；不得缓存部分通过；资源预算与取消恢复须单独证据 |
| V10 | 重启后同一历史清单再次验证；期间有一次故意失败 | 新验证独立记录且绑定原清单；旧成功/失败事件不改写，原reviewStatus保持 |
| V11 | 中英文界面与文件预览，源缺失、旧算法、零值、无上期 | 状态及原因可理解；缺省不显示0；not-evaluated不显示通过；键盘/窄窗可读 |
| V12 | 按预冻结样本总体采集成功/失败/未评估/中断 | 全部保留分母，分别统计；不把两次重算或三格式文件当多个工程项目 |

校验前后应对项目、数据集、分析、run、manifest、文件及旧审计行分别保存身份/字节摘要。只读数值验证可以新增独立审计记录，但不能以 SQLite 文件整体哈希变化判定原业务记录被修改；需明确允许追加的表并比较原行与文件。

## 规范与生产指标映射

[GB/T 24356-2023 官方核读](evidence/railwise-standards-20260920/README.md)的4.5条支持检查记录留存、4.6条支持整改及重新检验；它没有指定本文件的软件算法、UTC约定、阈值倍率或13个合成算例。不能把本合同命名为该标准完整符合性验收。

[生产指标口径](RAILWISE_SURVEY_PRODUCTION_METRICS.md)中的可复现率要求预先固定运行总体和逐项终态；本文件提供单次软件数值核对资料，未解决生产总体真实性、正式批准和真实签章。[采集合同](RAILWISE_SURVEY_PRODUCTION_COLLECTION_CONTRACT.md)的授权/签认仍为未认证声明；数值重算通过不改变这些状态。

原2026-09-20合同完成范围为字段来源、版本/迁移决策、13个有理数基准及12组负例要求。2026-09-21已实现首节所列纯重算器、独立审计、Runtime/IPC/双语接线与限定负例回归；新精确候选及更广专业适用性验收另行留证。历史v1缺失的环境仍不补造，本次不实现取消中的计算恢复，也不据此完成总计划任务44/46。
