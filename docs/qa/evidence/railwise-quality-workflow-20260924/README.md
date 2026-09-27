# 声明式整改链源码验证

日期：2026-09-24。本轮基于 `f219b7614c9241106c6143b05d58c491253d7617`，新增文件摘要见 `source-sha256.json`；这是源码验证，不是安装包验收或专业签认。

## 已完成

- 独立持久化声明检查、问题、整改和复查；绑定当前项目及真实保全材料，拒绝过期头、损坏、跨项目与无效状态迁移；幂等重试和追加式本地链头。
- 认证 Runtime、严格 IPC/client、中英文人工表单、历史恢复、短页游标、同键重试、项目/修订/关闭/卸载作用域保护。
- 独立智能体复审并修复绑定中多余字段、每轮源读取去重与资源预算、恢复丢失待重试请求、异步摘要后写入守卫、短页分页、响应来源/时间校验。

## 验证结果

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| Runtime 全量 | 194 文件通过、2 跳过；2,944 项通过、22 跳过 | runtime-tests-unrestricted.log |
| 桌面全量（4 workers） | 334 文件通过、2 跳过；2,868 项通过、2 跳过 | desktop-tests-unrestricted.log |
| 评分历史加载等待回归 | 26 项通过，在上方全量后仅修改测试等待逻辑 | scoring-dom.log |
| 双端 TypeScript | 通过 | runtime-typecheck.log、desktop-typecheck.log |
| 双端生产构建 | 通过；原有大 chunk 提示保留 | runtime-build.log、desktop-build.log |
| 全量 lint | 0 错误；Workbench.tsx 既有 Hook 依赖警告 1 条 | lint.log |
| Strict OpenSpec | 11/11 通过 | openspec.log |
| 品牌边界 | 通过 | brand.log |

首轮 Runtime 沙箱运行被终止（exit 130），真实回环监听报 EPERM；桌面首轮 15 项失败，包含相同权限限制、旧技能安装 5 秒超时和异步界面等待失败。原日志 `runtime-tests.log` / `desktop-tests.log` 保留。允许本地回环并降低桌面并发后的全量通过，不能仅凭重跑将所有首次失败断言为资源竞争。新工作流测试已改为等待实际忙状态结束，既有评分追问测试也补充等待历史加载完成。

本记录没有新候选包签名、公证、GUI 或 updater 结论。旧候选真实发送出现模型 401，见[失败证据](../railwise-result-questions-gui-20260924/README.md)。所有声明保持非专业签名、未评估规范符合性及未批准交付；不产生真实生产 KPI。
