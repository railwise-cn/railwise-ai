# 最终候选监测最小精确矩阵（全部待执行）

源码已冻结为 `43689493ab586c8d65bae729cfd291f3c813f679`；最终安装包身份与ASAR尚未验收。`/private/tmp/FINAL_CANDIDATE`是待替换的示例路径，不能由目录名推断包身份。输入清单 `synthetic-input-manifest.json` 记录14份原样合成输入和2份新输入；本任务没有复制数据库、启动GUI或建立任何通过结论。7d已停止历史审计结果只作为旧包背景，不算最终包验收。

两个新工程放最终候选自己的独立workspace，单位mm、正号positive、默认阈值100，禁止使用原532/7d工程作新计算。先记录最终完整HEAD、签名包版本/ASAR、bundle、窗口逻辑bounds和主题。每一步记录project/dataset/analysis/run/manifest及源hash；截图只含合成数据。

| ID | 动作 | 必须看到的结果 | 状态 |
| --- | --- | --- | --- |
| M01 | 中文浅色创建CSV独立工程，导入 `synthetic-monitoring-two-points-irregular.csv`，预检→校核→分析 | 6观测/2点；S01当前8/上期2/累计8/速率2/上升；S02当前-1/上期5/累计-9/速率-2/下降，单位mm、mm/d | not-run |
| M02 | CSV预览并生成DOCX/PDF/XLSX与draft manifest；打开图和报告 | 图为2条独立测点线、各3点；8月1→2→5的水平间距1:3；S01由0升8，S02由8降-1。中文报告数字与分析一致，DOCX/PDF文字非英文trend代码；SVG非旧单点折线 | not-run |
| M03 | 点击CSV清单复验 | manifest/outputs/inputs通过；surveyReplay/sources为not-applicable；仍draft | not-run |
| M04 | 新XLSX独立工程导入 `synthetic-monitoring-zero-blank.xlsx`，校核→分析→三格式/图/draft | 同M01结果。S01累计/速率可选源列空或空白，保留缺失；S02首期累计/速率明确0，保留0。两工程ID不同且不串结果 | not-run |
| M05 | XLSX清单首次复验 | 同M03；记录精确manifestID，不以成果预览代替清单 | not-run |
| M06 | 两新工程分别在中文浅色常规和原生最小窗口查看分析、图/导出、清单；再深色最小检查相同内容 | 数字/中文/单位清晰、按钮不遮挡、表格滚动可达；Tab/Shift-Tab到导出和复验、Enter、Esc返回。此最小矩阵不替代全产品12格 | not-run |
| M07 | 正常CmdQ，进程退出；执行 `before` 独立审计 | 必须输出真实 `passed-selected-monitoring-checks` 才继续；来源独立数值、归一化空/零、analysis、报告文字、工作簿值、SVG几何与文件hash通过 | not-run |
| M08 | 重新启动同最终包，同两个manifest各再次GUI复验，仍draft；正常CmdQ后执行afterrestart | 同ID、输入/算法/六报告与两图hash不变，各新增1次晚于before审计的完整成功复验，合计各至少2次；保留失败/未完成记录 | not-run |

可选针对旧故障的短探针：在另一个新工程导入既有 `synthetic-monitoring-roundtrip.xlsx`（原SHA42bd...），必须得到S01当前4/累计2/速率2/上升；此探针不是双工程默认审计的输入，也不可引用7d旧0/stable为通过。

可选offset逆序反例：`inputs/monitoring-offset-counterexample.csv` 为另存的2观测合成输入，不计入上述16份默认清单。真实时间为8月1日17Z值2→8月2日07Z值7，故当前7、上期2、累计5、速率60/7≈8.571428571 mm/d、上升。字符串日期顺序会反转，不能用字符串比较代替时刻。此例没有预填GUI通过。

## 独立审计入口

`tools/monitoring-audit.py` 接收root、最终完整head/asar、CSV/XLSX各project/manifestID；从manifest确定dataset/analysis/run，按固定合成源hash重新独立计算。只在正常退出无handles后，复制DB及存在的WAL/SHM到新私有输出目录；SQLite只打开副本，backup后immutable读，原库/成果前后hash与文件集合不变。PDF文字由同目录Node辅助脚本用pdfjs解析，DOCX/XLSX通过独立XML读取，SVG核验6个观测位置、2线、实际时间比例与数值上下关系。

模板中的全部大写值必须换成最终实值。不得直接运行占位命令，也不得把7d/277旧包结果回填新HEAD：

```sh
python3 -B tools/monitoring-audit.py \
  --root /private/tmp/FINAL_CANDIDATE \
  --head 43689493ab586c8d65bae729cfd291f3c813f679 --asar FINAL_ASAR_SHA256 \
  --input-manifest synthetic-input-manifest.json \
  --csv-project CSV_PROJECT_ID --csv-manifest CSV_MANIFEST_ID \
  --xlsx-project XLSX_PROJECT_ID --xlsx-manifest XLSX_MANIFEST_ID \
  --phase before --output /private/tmp/railwise-final-monitoring-before
```

实际重启/两次GUI复验并退出后，同参数改 `--phase afterrestart`，添加 `--before-summary /private/tmp/railwise-final-monitoring-before/public-summary.json`，输出用全新 `/private/tmp/railwise-final-monitoring-afterrestart`。输出已存在就选择新目录，保留旧失败。默认不认临时目录名等于包身份；要求root/evidence/package.json的sourceHead/asar吻合且实读installed app.asar哈希。

已有6项独立自测通过：CSV/XLSX源算术与空/0、旧零累计错误拒绝、不等间隔速率错误拒绝、真实时间比例SVG通过、错误等间隔SVG拒绝、无时区明确UTC与offset逆序的独立算术。PDF解析辅助仅对旧7d合成PDF试读成功，不代表最终候选输出通过。`public-summary.json`可用于脱敏汇总；private数据库/原件哈希路径仅留本机。脚本不证明实际GUI重启、截图视觉、人审或生产KPI。
