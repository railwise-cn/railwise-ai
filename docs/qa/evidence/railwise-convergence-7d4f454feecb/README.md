# 7d4f454 精确候选：历史完成卡与监测格式验收

2026-09-20，私有版本 0.5.0，源码 `7d4f454feecb09028007ae9b436a318db6856201`。**部分通过，XLSX 往返数值失败，不能作为最终验收通过。** 原有公开版本、下载页和更新源未变。

## 安装与更新

[私有工作流 35502074715](https://github.com/wangjiawei508/WorkWise/actions/runs/35502074715) 成功。完整 GitHub 工件、内层应用 ZIP、ASAR 摘要和本机校验见 [installation-context.json](./installation-context.json)、[package.json](./package.json)。安装报告的 `guiAcceptance: not-tested` 是安装时状态；后续 GUI 范围以本页为准。

- 完整工件 SHA-256：`9799c4fc194e5cdcf3607524052bcbe79a58396f814e66064b43775fa30ef23e`。
- 应用 ZIP：`bba7b45bc5e2fc3e2e0067cbff0eb1cb74aa8948452ac06a241c78b49188ba0b`。
- ASAR：`5bc6c213da21d9cc9f265a5ef26678ed92444500876ab8ac5351bd71033b2f6d`。
- 签名、公证有效；云端 Gatekeeper 开启。本机既有 Gatekeeper disabled 状态单独保留，未改变系统设置。
- [真实私有 updater](./private-updater.json) 完成同源隔离探针 0.0.0 → 0.5.0 HTTPS 下载、Squirrel 安装、重启及哨兵保留；不是旧真实用户版本迁移。

## 已实际操作

通过原生 GUI 使用中文、浅色主题。截图包含常规及缩放窗口，但未记录原生逻辑尺寸，不能当作全主题/语言/最小窗口矩阵。

| 操作 | 结果与证据 |
| --- | --- |
| 恢复既有合成完成任务 | 26 条旧消息恢复；Typed Plan 已完成、4 个已核验回执，底部无残留“需要处理”。[顶部](./gui/01-restored-completed-zh-light.png)、[底部](./gui/03-completed-card-bottom.png)及同名 AX 文本。未在此包重新执行真实模型四工具链。 |
| 旧零回执假完成记录 | 显示需要处理与缺少回执，不自动重跑；未点击重新规划。[截图](./gui/04-legacy-zero-receipts.png)及 AX 文本。 |
| 监测 CSV | 两条观测 2/4 mm，校核后当前值 4、累计变化 2、日变化率 2、上升；生成趋势图、预览三格式、独立 draft manifest。[分析](./gui/05-csv-analysis.png)、[清单复验](./gui/06-csv-manifest.png)。 |
| CSV 清单复验 | manifest/outputs/inputs 通过；surveyReplay/sources 不适用。监测数值不在该复验入口重新计算，不得称作五项数值重放通过。 |
| 监测 XLSX | 同源导出表重新导入识别两条观测，但空 cumulative/rate 被 Number('') 变为 0，累计变化错误为 0、趋势错误为稳定。[失败截图](./gui/07-xlsx-analysis-difference.png)与 AX 原始证据保留；未继续导出错误成果。 |
| 正常退出及历史保全 | 应用 Cmd-Q、进程退出 0；停止后的副本审计验证选定 Task、plan、回执、项目 JSON、线程身份/工作区及旧消息前缀不变。[保全摘要](./history-preservation.json)。该结论仅覆盖白名单副本，不扩大成全面用户迁移证明。 |

首次启动时，复制线程索引缓存仍引用原目录，已有消息暂未显示；正常退出/重启后索引从已复制 JSONL 重建，消息恢复。没有修改旧线程文件或项目绑定。历史内容属于白名单复制，凭据、插件配置及全局设置不在本次迁移证明范围。

[停止快照独立审计](./monitoring-independent-audit.json)确认 CSV 4/2/2/rising 与独立算术一致，清单/运行/输入绑定与四个文件的大小、类型、SHA-256 一致；XLSX 4/0/2/stable 的失败持久记录保持原样。PDF 只做类型/尾标记检查，尚未完成独立页面视觉审查。

## 修复与尚未通过范围

后续源码 `27738f42dc9d1774b9cfafe000d87e65158cd554` 修复共享数值解析：空白保持缺失、显式 0 保留、必填空白阻断。新增四项测试修复前失败，修复后与既有服务/XLSX 测试合计 17 项通过，Runtime 类型与目标 lint 通过。修复不改算法、旧数据或旧清单，必须在新的签名包重新导入验收。此包也不包含后续“观测期次”和原生工作目录标题翻译修复。

完整 GUI 矩阵、真实模型新包恢复、个人 UI/功能确认、专业适用及正式签认、生产 cohort 仍未因此通过。这里没有产生批准成果或公开发布操作。

后续只读渲染 CSV PDF，单页无裁切、乱码或重叠，但发现报告任务类型显示旧 `monitoringType=control-network`，而 UI 已选变形监测；结果趋势/阈值和符号约定仍使用英文枚举，速率未标单位。SVG 仅 189 字节，只有一个折线坐标 `40,40`：实现错误地使用每点当前值而不是每点观测时序。这些问题保持失败状态，后续修复与新包验收分别记录；CSV 数值正确不代表报告和图形整体通过。

截图均经查看，展示合成工程，不包含真实 P0 坐标。文本归档移除个人主目录，并规范化 AX 文本行尾空白；原始数据库、历史线程文件、凭据和未脱敏私有报告不入库。
