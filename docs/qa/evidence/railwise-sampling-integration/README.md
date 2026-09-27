# 抽样工作区：独立 Python 复算证据

日期：2026-09-20（Asia/Shanghai）。本目录记录新增抽样合同与真实 Runtime 服务生成的**合成 fixture**独立核验，不是 `ba38649` 精确候选包的 GUI 验收；该包在本增量开始前已经冻结。此处没有采样新安装包数据，也没有宣称工程验收、现场随机性或真人签认通过。

## 范围与来源

[`railwise-sampling-independent-audit.py`](railwise-sampling-independent-audit.py) 使用 Python 标准库独立实现表 1 查询、最少均匀分批、HMAC-SHA256、uint32 拒绝取模偏差、部分 Fisher–Yates、请求/计划/行摘要和完整记录绑定。不导入或执行产品代码。来源表为已逐页核读的 GB/T 24356-2023 第 8 页/印刷第 5 页表 1，官方 PDF SHA-256 为 `96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`，完整 16 区间编码摘要为 `1a5e4aa0cf43412f0663f6ce619d829a703c84dc7c3b67c1eb7c626fa402c363`。来源登记见[规范证据](../railwise-standards-20260920/README.md)，抽样范围见[质量证据工作区说明](../../RAILWISE_SURVEY_QUALITY_WORKSPACE.md)。本轮没有重新宣称核读其他规范条款。

核验项目包括：工程数据库 SQL/JSON 项目身份和当前 revision、声明原文的实际 UTF-8 BLOB 及摘要、总体顺序与唯一 ID、第一轮和同总体同阶段唯一性、API 幂等请求摘要、SQL 行摘要、完整抽样计划独立复算、种子收据、随机过程摘要、run 摘要以及未认证边界。数值类型仅接受安全整数；浮点或不安全整数明确拒绝，不假定 Python JSON 与 JavaScript 数字格式相同。缺数据库或没有抽样运行时为 `not-evaluated`，不会因空循环给出通过。

源数据库均通过 SQLite `mode=ro` 和 `PRAGMA query_only=ON` 读取，各自建立只读事务，并检查 `data_version` 是否在审计期间改变。两个数据库不能共享原子快照，应在候选 GUI 操作暂停时执行；变更检测不能把这两个快照变成原子快照。SHA-256/HMAC 与本地记录一致不能证明独立保管、签名、种子不可挑选、总体完整、空间均匀或专业审批。

## 已执行结果

环境：Python **3.12.7**，macOS 27.0，arm64。以下验证均实际执行。

| 记录 | 实际结果 | 适用边界 |
|---|---|---|
| [内置自测](self-test.json) | 固定 30 单位随机向量及完整计划摘要、N=1/2/3/1001/10000 全数检查、安全整数负例通过 | `status=not-evaluated` 表示仅自测，不是实际候选数据 |
| [真实服务 fixture 核验](service-fixture-audit.json) | 1 个总体、1001 单位；process 全数 1001、final-field 随机 80；两条运行独立复算均通过 | 使用真实 EngineeringService 与 SamplingService 生成合成输入的临时数据库，不是 GUI 或生产工程 |
| [审计器负例](negative-cases.json) | 六个负例均得到预期拒绝或未评定 | 仅更改临时只读备份副本，原始服务 fixture 未改写 |
| [归档生成器重建](rebuilt-fixture-manifest.json)及[独立核验](rebuilt-service-fixture-audit.json) | 从 `a3072e25ebc33ee30702d5278c8144e3fbb625f7` 源码另建真实服务 fixture，生成测试 1/1、两条运行独立复算 2/2、[负例 6/6](rebuilt-negative-cases.json)通过 | 归档生成器调用真实服务，Python 审计器仍独立；不启动安装包或 GUI |

固定随机向量的独立结果：选中 `unit-019, unit-009, unit-030, unit-021, unit-027`；请求摘要 `0ed73999c6a04b70b381d02a1ef66d8737c1c988e461940ea38bd1105dc17f96`；完整计划摘要 `095bb4e26f12f6c2274d4ed9cf9c18f35f9facdf3ec6f4d002b852b35a248b57`；五次 draw 的 transcript 摘要 `68283403452db55f47c1201b9dd3a21b754a9351f2879c02c1e8ebcd70946807`。新增环境无关 Unicode schema 后，这些产品纯核向量保持不变。

六个负例为 SQL 阶段列篡改、修复外层行摘要后的伪造样本、修复外层行摘要后的声明 BLOB 改写、当前工程 revision 改变、删除全部运行以及移除 SQL 唯一约束后伪造合法外层摘要的同阶段重复抽样。删除全部运行明确返回 `not-evaluated`，其余拒绝。具体临时副本操作保存在 [`test-independent-audit.py`](test-independent-audit.py)，不依赖产品实现计算期望结果。

真实服务 fixture 当前路径（临时资源，系统清理后需要重新生成）为：

```text
/private/var/folders/t8/1bkjpgdx5zbd2ynlyzpqd7zw0000gn/T/railwise-sampling-service-audit-awvviyvb/runtime
```

该目录由真实服务经临时 Vitest 场景创建并关闭连接，含 `engineering.sqlite3` 与 `survey-sampling.sqlite3`。输入声明明确为 synthetic，未触碰当前 GUI 候选数据库。CSPRNG 使新生成 fixture 的 ID、种子和 planHash 可以不同；独立脚本应对新记录重新推导，不能要求随机结果等于本次临时样本。

## 临时目录清理后的重建

[`create-service-fixture.test.ts`](create-service-fixture.test.ts)由原先实际执行的临时生成器整理而来，使用相对产品导入和显式[独立 Vitest 配置](fixture.vitest.config.mts)，不会进入默认产品测试集合。生成器默认在系统临时目录新建唯一目录，关闭数据库并等待工程元数据写入完成后，输出 `fixture.json` 和审计器所需的 **`runtime` 子目录**。它不打开已有目录；如指定已存在的输出路径，会直接失败，不能覆盖候选数据。

先安装仓库原有依赖，在仓库根目录运行：

```sh
node kun/node_modules/vitest/vitest.mjs run \
  --config docs/qa/evidence/railwise-sampling-integration/fixture.vitest.config.mts
```

终端打印 `Sampling audit --root: .../runtime`，将该完整路径传给下文两个 Python 命令。不要使用其父目录，父目录只有生成说明，数据库位于 `runtime` 中。需要明确输出位置时，可设置任务专用变量 `RAILWISE_SAMPLING_FIXTURE_DIR`，其值必须是绝对且尚不存在的新目录，父目录应已存在；不设置时无需手工建立或清理目录。

本次归档生成器的实际重建目录为：

```text
/var/folders/t8/1bkjpgdx5zbd2ynlyzpqd7zw0000gn/T/railwise-sampling-service-rebuild-Bu0yPf/runtime
```

对应生成说明和独立报告另存于本目录的 `rebuilt-*` 文件，原先的报告未覆盖。Node v26.8.2、Vitest v4.1.8 实际执行生成测试通过；生成器 TypeScript 的目标 ESLint 无错误，`.mts` 配置不属于当前 ESLint 匹配范围，已由真实 Vitest 加载执行验证。

## 运行命令

在仓库根目录执行自测：

```sh
python3 -B docs/qa/evidence/railwise-sampling-integration/railwise-sampling-independent-audit.py --self-test
```

核验真实服务 fixture，或在后续精确候选 GUI 操作结束后替换为其工程数据库目录。后者输出必须另存，不能覆盖此处合成 fixture 报告后继续沿用其来源说明。

```sh
python3 -B docs/qa/evidence/railwise-sampling-integration/railwise-sampling-independent-audit.py \
  --root /private/var/folders/t8/1bkjpgdx5zbd2ynlyzpqd7zw0000gn/T/railwise-sampling-service-audit-awvviyvb/runtime \
  --output /private/tmp/railwise-sampling-audit-report.json
```

从上述合成 fixture 建立临时备份副本并执行负例；源数据库只读，副本自动清理：

```sh
python3 -B docs/qa/evidence/railwise-sampling-integration/test-independent-audit.py \
  --root /private/var/folders/t8/1bkjpgdx5zbd2ynlyzpqd7zw0000gn/T/railwise-sampling-service-audit-awvviyvb/runtime \
  --output /private/tmp/railwise-sampling-audit-negative-report.json
```

## 文件指纹

| 文件 | SHA-256 |
|---|---|
| `railwise-sampling-independent-audit.py` | `61740c8204af04fedadc2211aa83d1d9540d42dd728c5cffb5712fda527e9762` |
| `test-independent-audit.py` | `94e4898203ca102adc7f2f52e5489ce280a54192d80f1e99286168521a7e8bff` |
| `service-fixture-audit.json` | `47197eafe1678e191de4273de6d835e997a09e359fa7de9474b4037a55d1a886` |
| `create-service-fixture.test.ts` | `d47b1cd915baad3caa782d1c12808133fb9181f8646546214d0705423b15221e` |
| `fixture.vitest.config.mts` | `be25b7dbf1f8de0479f9975560705c4164ccfb950ed1979a28b3d2cfe06e5749` |
| `rebuilt-fixture-manifest.json` | `b007e88d500f95670fec926f70ad9c70d5bb0ed082bd932cb33b95bd720d0c29` |
| `rebuilt-service-fixture-audit.json` | `7212015764444f90a48e683bd389d0b9f12827ca2e5025d48572453d6399436c` |
| `rebuilt-negative-cases.json` | `a45400954f364ad674bf91dd37a7a961ef079372dc695bd2b78b531eb17db63e` |

文件摘要用于复算来源定位，不是第三方签名。当前目录不计作精确包 GUI、正式抽检流程、材料覆盖、质量评分或真人签认完成证据。
