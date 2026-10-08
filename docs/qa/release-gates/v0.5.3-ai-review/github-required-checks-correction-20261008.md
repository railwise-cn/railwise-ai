# GitHub 必需检查名称整改

日期：2026-10-08。仓库：`railwise-cn/railwise-ai`；分支：`main`。类型：仓库门禁配置审计，包含独立 AI 只读复核。

## 问题与证据

REST 与 GraphQL 的 branch protection 配置将三个必需检查写为 `Quality / ...` 且 app 未限定。真实 GitHub Actions CheckRun 名称没有该前缀。独立代理 `transaction_independent_review` 读取 PR #44，确认当时全部 6 个真实 check 的 `isRequired(pullRequestNumber:44)=false`。历史成功提交 `e83e4d9b` 的真实检查也使用相同裸名称，因此该配置不能匹配实际 CI。

## 实际修正

使用既有用户对权限与工作流门禁整改的授权，仅 PATCH `repos/railwise-cn/railwise-ai/branches/main/protection/required_status_checks`：

```json
{
  "strict": true,
  "checks": [
    { "context": "OpenSpec, brand, lint, type, test, build", "app_id": 15368 },
    { "context": "Windows path, spawn, persistence", "app_id": 15368 },
    { "context": "Electron production smoke", "app_id": 15368 }
  ]
}
```

15368 是实际 checkSuite 的 `github-actions` App ID。修正保留三项检查和严格最新 main 要求，同时限制检查来源为 GitHub Actions。

## 回读验收

- PATCH 返回 strict=true、精确三名称和 app_id=15368；后续 GET 返回一致。
- PR #44 head `ff01a1784797bed097d576aa0c9e2175cd85bc12` 的 GraphQL rollup 返回六项实际检查均为 `isRequired=true`、`status=COMPLETED`、`conclusion=SUCCESS`、app=github-actions/15368。
- Quality push run `37722185209` 和 PR run `37722189688` 全部成功，三个 job 分别覆盖完整源码质量、Windows 安全/持久化和 Electron production smoke。
- main 仍要求 1 个独立批准、CODEOWNER、旧批准失效及 enforce_admins=true；allow_force_pushes=false、allow_deletions=false。
- production-release 仍 prevent_self_review=true、can_admins_bypass=false。未增加用户权限、改变 CODEOWNERS、降低审批门槛或使用管理员绕过。

回读中曾发生 GitHub API TCP timeout；成功重试后才记录以上结论。没有公开发布操作。该修正不能补足缺失的独立维护者批准；最终公有身份安装包与真实更新验收仍待受保护 main 合并后执行。
