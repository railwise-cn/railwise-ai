# 最终候选包选定监测流程证据

源码 `43689493ab586c8d65bae729cfd291f3c813f679`；私有候选包版本 `0.5.0`；已安装 ASAR SHA-256 `11a060ec6a7c42385eed433a336967a91647251f51a07f0781302420b2f9e20c`。本档案记录两个合成监测工程在安装包中的流程、同清单重启复验、独立数值/文件/审计绑定检查，以及同一目标包的私有原生 updater 证据。

## 本次通过的范围

| 范围 | 实际证据 |
| --- | --- |
| 安装身份 | `package/installation-context.json`、`package/package.json`：云端认证 artifact、内层 ZIP 和本机 ASAR 一致，签名与 stapled notarization 校验通过。 |
| 原生 updater | `cloud/`：工作流 35505966672，私有隔离的同源码基线 0.0.0 → 0.5.0，真实下载、安装请求、Squirrel 重启、合成 user-data sentinel 保留，browserOpened=false。不是历史真实用户迁移。 |
| CSV 与 XLSX 分析 | 每工程 6 条观测/2 个测点；S01 当前8、上期2、累计8、速率2、上升；S02 当前-1、上期5、累计-9、速率-2、下降。XLSX 空白/空格与明确0分别保留。 |
| 三报告与图表 | 每工程 DOCX/PDF/XLSX/SVG 各1份，实际包生成的原字节在 `outputs/`；中文任务类型、单位mm、速率mm/d、草稿边界和来源/输入哈希一致。图表2测点各3点，横轴间隔1:3，垂直数值比例正确。 |
| 独立 before | `audit/before.json`：2026-09-20 11:41:02 UTC，CSV 1次成功、XLSX 3次成功，均无失败/未完成。 |
| 独立 afterrestart | `audit/afterrestart.json`：11:45:05 UTC，CSV 2次成功、XLSX 4次成功。新增开始时间 CSV 11:44:21.456Z、XLSX 11:43:51.604Z，均晚于 before。旧attempt完整保留。 |
| 重启一致性 | 两工程项目/dataset/analysis/run/manifest ID、算法 `workwise-engineering-2`、输入hash、图表 `engineering-trend-2` 记录及8份输出路径/字节保持不变；复验均为3 passed + 2 not-applicable，成果仍draft。 |

独立审计自行检查文件句柄；正常退出后仅把原库/存在的sidecar按字节复制到本机私有目录，SQLite只打开副本并backup，再以immutable读取。前后两轮都确认原库/sidecar集合、关闭状态及所有读取文件哈希未变。数据库、副本、候选环境文件、用户配置及密钥均未纳入本档案。

产品 `verifyDeliverable` 未重算监测数值；`surveyReplay`/`sources` 均为 not-applicable。本次独立 Python 算术检查是额外验收证据，不是该产品复验能力。

`audit/before.json` 原始 SHA-256 为 `a1ec51382a2cecb88a74e4d7d182483d713399ae92cfb873ff154c28a6ba6499`；afterrestart 原始 SHA-256 为 `04a6fb7c2e6d6d85f1e487bdc6fde76e6546cd7c964372e26371f673f892dc2c`。两份摘要字节原样归档，路径只含合成项目相对成果路径。

## 界面与实际渲染

`gui/01` 至 `04` 为中文浅色CSV/XLSX分析和成果，`05` 为加宽窗口，`06`/`07` 为中文深色，`08` 为英文深色，`09` 为英文浅色，`10`/`11` 为有效重启后的原清单复验。AX文本在有采集的画面旁归档；不存在的AX没有补造。截图像素尺寸为1171×768或1491×768，不能据此推断原生窗口逻辑bounds或最小窗口尺寸已经验收。

CUA产生的01–11截图沿用源`.png`文件名，其实际字节格式是JPEG/JFIF；归档保持原始字节和哈希。`csv-report-1.png`、`xlsx-report-1.png` 是实际PDF经pdftoppm渲染的990×1400 PNG；`csv-trend.png`、`xlsx-trend.png` 是实际SVG经bundled sharp渲染的960×560 PNG。主任务已查看这4张图，记录报告中文/单位/草稿可读且无裁切，折线分点及真实时间间隔正确；原成果未修改。该视觉观察与Python文件/数值审计分别记录，不混为同一项自动证明。

这些是选定监测页面的实际包检查，不替代全产品12格、所有键盘/窗口尺寸、全部专业测量流程或用户本人验收。`package/`的guiAcceptance=not-tested是安装前快照，原样语义保留；本次随后完成的选定操作以本档案的GUI和双阶段审计为准。

## 保留的偏差与限制

主任务操作说明保存在 `operator-events.json`，属于操作者记录，未伪造额外终端日志。第一次用CUA直接启动未显式传入原`candidate.env`，观察编程首页default/运行时未连接，未进入Survey、未操作数据即退出；不能据此判定实际环境加载情况、读错数据库或数据丢失，这次启动不计有效重启验收。随后猜错MacOS可执行文件名返回127；读取实际名并加载原隔离环境后用exec正确启动，原工程恢复，才进行同ID复验。正确启动仍有login item `Operation not permitted`，但未阻断本次操作；最终super+q，进程会话正常exit0、pgrep无进程，再独立确认无文件句柄。

英文深色检查期间XLSX额外复验发生在11:39:10.415Z，已保留为重启前第3次成功，不能充当重启后的新增次数。11:32:59.279Z的一次重启前成功同样保留。

云端Gatekeeper为assessments enabled；本机是assessments disabled。因此本机`spctl --assess`的0退出码不能单独证明启用Gatekeeper下的行为；云端检查与本机签名/stapler结果分别保留。下载由12并发改24并发的主动中止143及完整范围保留记录在`package/evidence-download-adjustment.json`，不改写为网络失败。

私有updater native记录中的channel=frontier是隔离测试通道参数，feed只指向loopback且随机私有路径已脱敏；没有推广公共frontier/stable、发布GitHub Release或更新下载页。复验不是专业签字，合成结果不是生产KPI。用户本人对最终安装UI及功能的确认仍未执行。

## 归档与复验

`source-copy-provenance.json` 保留各源文件原始SHA-256与归档SHA-256；JSON/AX中的候选绝对路径替换为`<CANDIDATE_ROOT>`，随机私有feed路径脱敏。`inputs/manifest.json`保留16份默认+1份可选合成源指纹，只纳入本次两份新监测源和可选offset源字节；未纳入14份历史夹具字节。`outputs/`8份成果与15张截图/渲染图保持源字节。

运行 `python3 -B verify.py` 只读核验文件集合/哈希、包身份、双阶段ID与成果及历史attempt保留、合成输入、图表和原生updater绑定。它不连接数据库、不重新执行GUI/云端、不授予批准，哈希清单不是数字签名。

`python3 -B tools/monitoring-audit-selftest.py` 运行10项算术/零空白/时间/图形/草稿/原始chart/typed绑定/旧attempt保留自测。归档版工具仅将helper和夹具路径改为同目录；PDF helper需要仓库已安装的pdfjs-dist和PATH中的Node。完整`tools/monitoring-audit.py`仍是macOS本机工具：要求Python3.10+、lsof、/private/tmp候选与新的私有输出目录，会写数据库副本和报告；它与只读`verify.py`不同。无原候选数据的其他机器不能凭本档案重放完整数据库审计。
