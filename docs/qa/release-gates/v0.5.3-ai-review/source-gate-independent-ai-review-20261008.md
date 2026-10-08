# 0.5.3 发布源码门禁独立复审

日期：2026-10-08。类型：AI review，仅为软件源码复审，不是安装包验收、真人批准、厂商互操作或专业签认。

复审来源：`codex/railwise-053-remediation`，基线 `e83e4d9bfbf98316e4593211bd7b2b4b98a5e020` 后本轮发布门禁差异。两位只读代理分别复审，均未编辑代码或执行公开发布操作。

## 构建与更新来源绑定

代理：`frozen_provenance_final_review`。

范围：`verify-release-approval.mjs`、`verify-reviewed-release-artifacts.mjs`、`verify-frozen-updater-evidence.mjs`、`run-frozen-release-updater-acceptance.mjs` 及对应测试。

结论：未发现确定的来源绑定绕过或合法 GitHub REST 误拒绝。只读真实 API 核对确认工作流运行返回 `path`，不返回 `workflow_ref`；artifact 的 `workflow_run` 返回运行、来源及仓库字段，不保证 `run_attempt`。校验采用实际字段，结合受保护 main 祖先关系、原始 receipt 的 workflowRef/SHA、不可变 artifact digest、native report digest 以及两报告逐字节比较。

独立测试：三个目标测试文件共 129 项通过。该计数与协调代理的正式 release-gate 入口重叠，不累计为额外覆盖。

## 发布事务

代理：`transaction_independent_review`，实现由另一个代理 `gate_cross_review` 完成。

结论：未发现剩余的确定事务代码缺陷。复审确认以下整改成立：

- Release draft 和实际安装包下载核验位于 official pointer promotion 之前。
- 保存精确旧/目标 metadata；旧版资料可恢复性在提升前和恢复前核验，恢复不重生 timestamp。
- 全部生产写入共用 concurrency group，阻止滞后版本降级或覆盖其他版本及同版本其他变化。
- promotion 禁用 retention，保留旧版恢复所需文件。
- 恢复在 archive 核验后重新检查所有权；局部失败不压制另一 surface 的恢复。
- GitHub 请求结果不确定时查询实际状态；已公开状态需实际重新下载并复核三安装包 SHA-256 和两 surface 目标字节。unknown 不自动回滚。
- snapshot/result 保留为私有 Actions artifact，失败不会被改写成通过。

独立测试：22 项事务测试和 1 项品牌测试通过；`git diff --check` 通过。事务测试采用内存 transport 和 workflow 源码断言，没有真实修改 R2、SSH 官网或 GitHub Release。

## 尚未闭合的发布门禁

本次复审不关闭最终公有身份包的签名、公证、computer-use UI、专业功能及可访问性检查，也不关闭官方 0.5.2 到同一冻结 0.5.3 的真实 native updater 验收。源码必须先通过真实独立 CODEOWNER 审核合入受保护 main，再冻结并验收。

GitHub 当前唯一有效维护者与 PR 作者相同，生产环境也禁止自审。这仍需实际独立维护者审批；AI review 和现有用户版本发布授权均不冒充该批准。没有创建通过的 `v0.5.3.json`，没有创建或移动 `v0.5.3` 标签，没有执行公开 Release、stable/feed 或官网更新。
