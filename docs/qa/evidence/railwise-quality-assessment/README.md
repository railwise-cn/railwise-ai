# 声明检查关联评估：独立接入验证

2026-09-20。基于 `8f81d8a` 的下一项独立变更；未进入当前最终候选包，未修改公开版本、正式清单状态、签名、批准或发布渠道。本证据不是安装包验收。

## 已实现范围

在成果与审查中增加独立双语面板，将实际成果清单、材料保全计划/记录、一个首轮抽样运行的全部实际选中单位与明确选择的已有单位评分关联。仅支持平面控制点（表 43/44）、高程控制测段（表 45/46）。一次 1–8 单位、最多 64 个逐单位材料映射，不截断样本，不自动选择最新或最高分。

资料覆盖、完整单位结果覆盖、声明否决分别展示。缺项、部分范围、不可用评分不能计作完整单位结果；完整不合格单位结果仍可计作已存在的完整结果，但否决始终独立显示。任一原保全要求未完成，包括未映射的原要求，资料覆盖即不完整。所有评分引用按确切 schema 位置解析，必须命中同一单位已保全映射。

评估固定声明真实检查真实性、总体穷尽、分类真实性、组织职责、阶段完成、规范符合性与专业签认未验证。成果原清单状态只读回显。已有批准字符串不视作本评估完成签认。此能力不关闭完整 GB/T 24356 质检链大项。

## 读取、资源与持久化边界

构造器只获得固定只读能力，不获得审批、追加检查、创建评分、成果生成或 `verifyDeliverable`。原成果五项复验和成果数值重放明确未执行；严格保全读取核对精确字节，抽样/评分服务真实重放自己的记录。真实跨服务测试确认 `engineering_verification_attempts` 行数与成果字节不变。

每个创建/详情/复验/导出执行两遍严格来源读取，比较完整来源向量和关联结果，并在存储前再次核对项目。无跨库 ACID、独立托管、恶意 ABA 或整库回滚保护承诺。保全正常追加会使旧评估返回 `source-changed`；原计划仍可用于新评估。返回创建与复验的完整记录，客户端不追加第三次 GET。

独立 SQLite 保存原始 UTF-8 请求 BLOB、解析请求、来源摘要、关联结果与元数据摘要；UPDATE/DELETE/REPLACE 触发器保护。相同幂等键必须原字节相同。列表仅验证自身记录和当前项目，明确标注保存时结果与依赖未复验；打开才重放依赖。

上限：请求 256 KiB，单记录 512 KiB，每项目 128 计划、128 评估、共 64 MiB，列表每页 10。每次最大 8×(64 精度项+6叶)×2 遍，评分工作量 224，仍使用源 240/min 限流。自身每分钟每项目 32 工作单位（来源重放操作 4，列表 1），失败与重试收费。最多每单位 2336 个不同引用、总 18688，仍受 512 KiB 记录上限约束；该引用数量不是规范阈值。文件保全继续遵守 32 MiB/件与 128 MiB/包限制。

## 验证证据

- 作者 Runtime 30 项：新真实跨服务、认证路由、既有保全回归与新旧真实 Runtime 工厂认证分发/重启恢复/关闭。
- 作者桌面 46 项：新 IPC/DOM/client 和既有评分 IPC/DOM 回归。新界面测试涵盖实际来源选择、冻结完整样本、单次创建/复验、否决与缺项并列、中英、原生 SaveAs 成功/取消、无 Buffer、切换项目/修订/目录/离线/取消后迟到响应隔离。DOM 中只将 PDF 渲染器换成测试字节以避免浏览器测试环境的字体 URL 转换；Runtime 测试真实生成 PDF/DOCX/XLSX。
- 独立完整接入审查共 81 项：核心 33（作者 13 + 独立 20）、HTTP/保全 20、UI/IPC/客户端 28；另有全新副本重放独立 Runtime 25 + DOM 10、build 与编译 JS 真实服务/SQLite 冒烟 5 检查。初审发现并已修复最大引用上限、来源 Zod/SyntaxError 损坏分类、硬资源 limit 与临时 rate-limit 区分。另关闭了旧核验结果残留、其它计划混显、响应角色混淆和非法 SQL ID 隔离问题，无未关闭开发接入阻断。详见 independent-review/FINAL_REVIEW.md。
- Runtime 和桌面 typecheck、targeted ESLint、Runtime build 与 electron-vite build 通过。构建动态导入共用模块警告不影响分包正确性。
- 冻结评分核 5 源码、4 编译文件摘要全部一致；采样合同/纯核与基线字节一致。见 frozen-kernel-hashes.json。

命令（从仓库根目录）：

```sh
npm --prefix kun run typecheck
npm run typecheck
npm --prefix kun test -- --run src/engineering/survey-quality-assessment.test.ts src/server/routes/survey-quality-assessment.test.ts src/engineering/survey-quality-workspace.test.ts tests/runtime-quality-assessment-wiring.test.ts tests/runtime-quality-scoring-wiring.test.ts
npm test -- --run src/main/ipc/app-ipc-quality-assessment.test.ts src/renderer/src/components/engineering/SurveyQualityAssessmentWorkspace.dom.test.ts src/main/ipc/app-ipc-quality-scoring.test.ts src/renderer/src/components/engineering/SurveyQualityScoringWorkspace.dom.test.ts
npm --prefix kun run build
node_modules/.bin/electron-vite build
```

完整封装应用的明暗/尺寸截图、用户 UI 确认、签名公证与 updater 验收由主任务在此独立变更之后另行安排。不得将这里的 DOM 或编译冒烟作为该封装验收的替代品。

归档独立重放：

```sh
node docs/qa/evidence/railwise-quality-assessment/independent-review/replay-independent.mjs /absolute/path/to/implementation-repository
```

脚本仅向新临时副本写入，保留独立首次失败与最终成功证据。CORE_REVIEW 是早期阶段报告，最终结论以 FINAL_REVIEW 为准。
