# 声明检查记录评分：项目 Runtime 与桌面接入

日期：2026-09-20。本次在冻结的 GB/T 24356—2023 精确评分纯核之上，接入项目域保存、认证 HTTP、桌面 IPC 与双语质量工作区。评分纯核、公式和产品权树均未修改；冻结核的5份源码及4份编译文件 SHA256 与此前独立审查一致。

## 实际入口和数据链

现有工程项目“数据质检/质量”页顶部提供独立评分区，无需成果清单。用户选择七种评分阶段之一及平面/高程控制产品，填写声明 JSON 和检查依据，确认后提交。模板不自动填入或提交；未知字段使用 null/pending，不替用户假定检查通过。

认证项目 API：`/v1/engineering/projects/:projectId/quality-scoring` 支持 POST 创建、GET 分页；`/:recordId` GET 恢复；`/:recordId/reverify` POST `{}` 复核；`/:recordId/export` GET 严格复核后导出。所有操作先认证，响应 no-store。桌面沿用统一 Runtime 请求通道，新增严格方法/路径/查询/请求合同白名单。

独立 `survey-quality-scoring.sqlite3` 以 append-only SQL trigger 禁止 UPDATE、DELETE、INSERT OR REPLACE。保存原 UTF-8 请求字节和原声明字节、检查依据、项目 ID/修订/工作目录快照、严格解析声明、评分结果、算法版本、环境及各层哈希。相同幂等键只接受完全相同请求字节；改空白也不会静默新建或覆盖。

创建、恢复、历史和导出都绑定当前项目；每个被展示的健康记录经过原字节、所有字段/哈希与纯核逐值重放。结果哈希即使被一起重写，错误计算结果仍被重放拒绝。修订/目录变化、环境不符或损坏记录进入明确不可恢复状态，不遮掉同页健康记录。哈希是本地一致性检查，不是外部证据保管或签字认证。

## 展示与交互

- 所有得分和率保留精确分子/分母；不将 Number 舍入值用于判定或展示替代。9141/100、285/4、52/1 等直接可见。
- 结果头部展示记录自身产品及阶段，历史恢复时不借用当前草稿选择；完整、部分、待查、单项、样本和批范围显著区分。
- 单位子项否决时没有伪综合分；逐项 trace 保留原始扣分、诊断上界、A固定扣分以及各层原权/有效权。
- 读取、保存或导出新操作先清空旧结果。项目、修订、工作目录、连接状态变化及取消等待使迟到响应失效；reverify/create 的第二次 GET 和原生 Save As 也有当前会话检查。
- 不确定保存保留原请求和幂等标识，可重试同一次请求或从历史恢复，不因网络失败自动创建第二份。导出先走服务器新鲜重放，再校验浏览器哈希，通过原生 Save As 保存包含原始 JSON 文本的记录。
- `qualityScoring` 独立中英 namespace 覆盖控制、状态、范围、规则原因和精确值字段；现有 common.json 未改。

## 资源和信任边界

HTTP 原请求上限512 KiB（包括空白），原声明256 KiB，依据16 KiB，单记录4 MiB，每项目128条及64 MiB存储。创建最多8条/分钟；每进程按模型规模另计每项目240工作单位/分钟，重放、列表、重试都收费。分页最多10条。超长持久化字段先在 SQL 中限长再读取，损坏历史仍计入配额。

纯核预检的1,048,576是 JavaScript UTF-16码元预算；它不是UTF-8字节预算，与上述HTTP真实字节限额分别适用。数值与成员上限继承冻结核。

记录固定 `declared-inspection-trial-only`，证据引用、人工分类、此前批资格均 `not-verified`。没有真实材料验真、全表自动缺陷分类、抽样合规认定、规范认证或真人专业签署。本服务只依赖读取项目，不能修改 SurveyService 正式平差、旧质量计划、旧证据链、成果审核或批准状态。

## 验证与复现

- 原评分101测试；评分接入46项service测试、8项HTTP测试、1项真实Runtime工厂/重启测试；连同旧质量/抽样/高级模型存储回归共7 suites、222测试通过。
- 新评分桌面25项DOM/客户端/双语测试、3项IPC测试。连同既有工程页、证据保全页及IPC回归共5 suites、108测试全部通过。
- root双端 typecheck、Runtime typecheck、改动TS的ESLint、Runtime build与electron-vite production build通过。
- `fixtures/` 是主任务提供的四个安装包验收声明原样复制；service和DOM均实际重放：完整范围9141/100优；观测子项B4产生原始52分并否决；资料完整性pending不产生总分；两数学精度项60/100不聚合。
- 冻结纯核的6638条独立数值探针见兄弟目录 `railwise-quality-scoring/independent-review/`。接入独立复核见本目录 `independent-review/`：24项独立service/client/GUI测试、4个编译后父任务fixture重放通过，无未解决阻断；独立作者复跑55项Runtime/HTTP/factory和27项IPC/DOM通过，最后新增高程恢复头部的第28条由独立GUI探针另行覆盖。不能以纯核测试冒充UI或存储测试。

复现命令：

```sh
npm --prefix kun test -- src/engineering/survey-quality-scoring.test.ts src/engineering/survey-quality-scoring-workspace.test.ts tests/survey-quality-scoring-workspace-http.test.ts tests/runtime-quality-scoring-wiring.test.ts src/engineering/survey-quality-workspace.test.ts src/engineering/survey-sampling-workspace.test.ts src/engineering/survey-advanced-trials-workspace.test.ts
npm test -- src/main/ipc/app-ipc-quality-scoring.test.ts src/main/ipc/app-ipc-schemas.test.ts src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.dom.test.ts src/renderer/src/components/engineering/EngineeringWorkspaceView.dom.test.ts src/renderer/src/components/engineering/SurveyQualityWorkspace.dom.test.ts
npm run typecheck
npm --prefix kun run typecheck
npm --prefix kun run build
node_modules/.bin/electron-vite build
```

本次没有变更公开版本、标签、更新源或发布操作。安装包多主题/尺寸实机确认及用户验收由主任务执行；上述DOM、构建与本地一致性验证不替代它们。
