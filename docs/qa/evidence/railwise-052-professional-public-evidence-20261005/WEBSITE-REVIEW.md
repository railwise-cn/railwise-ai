# 官网独立审查：公开包身份、能力边界与专业文案

2026-10-05；AI 模拟工程测量/软件/产品高级工程师 source review。审查 `8a066645`、`8fc7e397`、`9b0921d1`；没有浏览器验收，本轮浏览器由协调任务另行记录。

## 核对结果

- 官网 manifest 为 `0.5.2`、stable、`releaseCommit=ea763458567ccf069067a165d812f561e9af6b62`，Release URL 对应 `v0.5.2`。
- 三个平台文件名和 SHA-256 与 [GitHub Release 回执](../railwise-public-052-exact-package-20261005/github-release.txt)逐一完全一致；ARM DMG 亦与该目录 package-identity 的实际本地字节一致。这里没有自行下载/安装 Intel 或 Windows。
- `8a066645` 将 fallback/Release 从 0.5.1 对齐已发布 0.5.2，不宣称较新 7bf/2f 改动进入 PUBLIC。默认 Survey 文案解释资料、基准、坐标/高程/精度与待审查成果；全规范评定、真实签认、采集/点云/专业跨工作区属于后续。
- PUBLIC ea763 的源码已经包含四视图、精确问题入口与质量材料/首轮抽样/单位评分关联。网页没有把限定源码能力说成已认证现场精度、完整 GB/T 24356 合规或可直接签认。
- `8fc7e397` 只在 exact `www.railwise.cn` server-level root 的现有 allowlist 内，规范化末尾 `/`、允许 release identifier 中的 `.`；仍列出冲突 roots，部署 fail closed。实际运行 `node --test scripts/workwise-product-public-verification.test.mjs`，8/8 通过。
- 下载区域的 SHA-256 是用户可核对安装文件的完整性信息，有实际决策价值；可保留。Survey 主流程里不必要的 JSON/tool IDs/runtime 协议则应后置。

## 发现与建议

1. **P1，截图身份需明确。** 默认页仍用 `07-survey-051-zh-light.jpg`、`08-survey-051-delivery.jpg`、`09-survey-051-settings.jpg`。8a 移除了 0.5.1 实拍说明，而当前页处处介绍 0.5.2，可能造成“这些是本版实拍”的误读。应注明“0.5.1 历史界面演示，公开合成数据”，或替换成真实 PUBLIC ea763 的0.5.2图；不能拿较新私有候选图冒充。
2. **P2，默认教程卡有实现细节残留。** `website/includes/workwise_product.php` 的 `rw_workwise_docs()` 仍展示“DeepSeek Harness 接入说明”及“实际适配器、结构化附件、视觉证据边界”。建议默认标题改成“AI 资料理解与使用边界”，描述用户可做什么、需核对什么，保留原 URL 供深入阅读。通用编程/Write/Design 的入口是平台范围，不等同 Survey 把开发协议暴露给工程用户。

本 source review 未见版本/摘要或工程能力夸大的阻断缺陷；截图来源和默认教程文案需要由协调任务处理并在最终网页实际检查。本审查不操作官网、不重新发布 0.5.2、不认证厂商互操作或真实专业签名。
