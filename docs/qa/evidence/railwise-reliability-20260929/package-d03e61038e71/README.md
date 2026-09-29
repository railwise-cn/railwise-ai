# d03e61038e71 私有候选：默认模型主流程失败

源码 `d03e61038e71314bab2aefad50428dbfc771db86`，包版本保持 0.5.1，独立 bundle `com.wangjiawei508.workwise.candidate.headd03e61038e71`。没有发布、推广 feed 或改官网。

## 安装与更新证据

- GUI 候选构建 [36506566679](https://github.com/railwise-cn/railwise-ai/actions/runs/36506566679)；已在独立目录安装并启动。ASAR `2283918ced8e7669701df843dd951d9e02d6c11040089a7a8db882a4e5e5e494`。
- codesign deep/strict、stapled notarization 和五个 executable 的 Runtime entitlements 通过。主机 Gatekeeper 原已 disabled，没有改变；不能将本机 assess 的 exit 0 解释成启用 Gatekeeper 的验收。CI updater 主机的 assessments enabled。
- 私有 updater [36506569859](https://github.com/railwise-cn/railwise-ai/actions/runs/36506569859) 完成独立 0.0.0 → 0.5.1 HTTPS 下载、安装、Squirrel 重启和 userData sentinel 保留。生产安装、公开 feed、系统信任库均未修改。
- updater 目标与 GUI 候选同源码、独立构建，因 updater 探针 metadata，ASAR 不同；本目录不能证明 GUI 使用了 updater 的同一字节目标包。下一轮须直接安装保留的 updater target 包。sentinel 保留不等于历史真实用户数据迁移验收。

## 真实包内失败

使用公开合成 `golden-plane-control-e2e.in2`，4 点（3 已知、1 未知）、5 观测、1 测站，源 SHA-256 `4281cc7a10673570756867e8c8665f22f82611839bd34c396a5eba9dbb89d9f0`。项目 `project_a8d369ca-d5cb-41bc-9293-a309ea6ff85a`，网络 `network_bbe5449c-88e9-48c2-8d52-b074b2a8bff6`。

新安装默认 Auto / Ultra 实际路由到 `deepseek-flash`。一轮实际请求生成计划 `eplan_72bd707b-4354-4ebe-8967-810a46981375`：validate 虚构 `sourceSha256`；export 虚构 `format`/`draft`、缺少 `projectId`/`expectedRevision`，并错误拆分三格式与 manifest。Runtime 正确保存为 needs_attention，未批准、未执行；界面却仅提示缺执行回执，没有显示参数原因。保留原始 plan、AX 和截图。

原模型工具只广告通用参数字典，缺少逐工具字段合同；同轮草稿幂等键仅含 turnId，也阻碍修正。后续源码修复逐工具 schema、结构化诊断、内容幂等和不自动发送的修正草稿入口。旧包不包含这些修复，其验收保持失败。

## 范围限制

生产模型设置仅只读复用必要 provider 凭据，未复制业务历史；候选 home/data/cache/logs/tools 独立，IM 和凭据工具关闭。locale 首次错误配置为 `zh-CN`（有效值是 `zh`），被规范化为英文；这属于验收配置错误，后续用 `zh`。其余 Pro、GSI、CSV/XLSX、导出/manifest、主题尺寸键盘、整改复查与用户确认仍未完成。
