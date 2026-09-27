# Survey 恢复测试预算修正证据

2026-09-20。产品源码 `7d4f454feecb09028007ae9b436a318db6856201`；测试修正提交 `1f07e929825427481134dc3c12f25e9ca333a3db`。本目录独立保留 CI 失败、同提交 CI 成功、原样本机检查及修正后检查，不覆盖或删除失败记录。

## 原因与修正范围

`kun/tests/engineering-completion-gate.test.ts` 的恢复用例需要真实回环 HTTP、持久写入、先停滞再恢复和四个真实工具执行。重启参数用例另外重新建立 Runtime，并包含两段各允许 10 秒的 `expect.poll`。原外层 `it` 使用 Vitest 默认 5 秒预算，小于其内部声明的单段等待期限。

失败 CI 仅报告三项 `Test timed out in 5000ms`，没有业务断言失败；本证据不能确定宿主 CPU、I/O 或调度具体慢因，也不把其他成功运行当作失败不存在。修正仅给恢复用例显式 15 秒、两个重启参数用例显式 30 秒，并附原因注释；产品代码、断言、内部轮询、全局 timeout、重试次数均未改变。

该测试文件不属于产品 Runtime 编译产物。`1f07e92` 不改变 `7d4f454` 产品运行代码，也不据此要求重打其产品包；安装包、GUI、真实模型、用户确认和发布资格均不由这些测试日志授予。

后续修正提交 `1f07e92` 的云端 Quality [35502679368](https://github.com/wangjiawei508/WorkWise/actions/runs/35502679368) 与 [35502677502](https://github.com/wangjiawei508/WorkWise/actions/runs/35502677502) 均为 success。前者的整合检查、Windows 路径/持久化和 Electron 生产烟测三项 job 全部通过。本目录六份原日志仍保持各自原执行范围；上述是另行查询的云端结果，不改写原失败。

## 保留结果

| 记录 | 结果与实际耗时 | 保留文件 |
| --- | --- | --- |
| [CI 35502052038](https://github.com/wangjiawei508/WorkWise/actions/runs/35502052038)，head 7d4f454 | Runtime 三项超时；恢复 5596ms、重启两例 6208/8110ms（报告时长包含测试/清理，不当作成功完成耗时），该文件36672ms；其余7项通过 | [失败步骤日志](ci-35502052038-failed.txt)，原始下载命令使用 `gh run view ... --log-failed`，不是该 run 全部成功步骤 |
| [CI 35502054402](https://github.com/wangjiawei508/WorkWise/actions/runs/35502054402)，同head | run success，文件10/10；对应964/870/837ms，文件5985ms | [完整 run 日志](ci-35502054402-success.txt) |
| 原样本机定向检查 | 10/10；恢复1752ms、重启1654/1753ms；退出0 | [原样结果](completion-gate-independent.txt) |
| 修改外层预算后本机首次检查 | 10/10；恢复1793ms、重启1599/1653ms；退出0，无失败重试 | [修后结果](completion-gate-budget-fixed.txt) |
| Runtime typecheck | `npm --prefix kun run typecheck`，退出0 | [类型检查](completion-gate-budget-typecheck.txt) |
| 目标 ESLint | `npx eslint kun/tests/engineering-completion-gate.test.ts`，退出0，无输出 | [空日志](completion-gate-budget-lint.txt) |

两个定向测试命令均为 `npm --prefix kun test -- tests/engineering-completion-gate.test.ts --reporter=verbose --maxWorkers=1`。退出码依据执行时工具返回记录，文本日志自身没有打印退出码；空lint日志不能单独证明通过。`git diff --check` 当时也退出0，本目录不虚构一份原始diff-check日志。没有为获得绿灯而删除失败、缩减断言或增加自动重试。

## 原始与脱敏摘要

[source-provenance.json](source-provenance.json) 逐份记录原日志文件名、原始字节数/SHA-256、归档字节数/SHA-256、转换策略及扫描计数。源路径仅在本机保留；仓库、个人home和CI home前缀替换为占位符，其余字节包括时间戳、ANSI控制序列、失败堆栈与测试名称保持原样。六份日志使用 `.txt` 避开日志忽略规则。原始日志仍在本机，不要求公开原始路径或凭据。

归档时扫描未发现 GitHub/API令牌、私钥、含凭据URL、长未遮罩Authorization或私有回环feed模式。模式扫描不是对所有可能秘密形式的完备证明；本目录仅保留测试输出，不包含设置、数据库或用户业务资料。

## 默认只读核验

```sh
node docs/qa/evidence/railwise-recovery-test-budget-20260920/verify-archive.mjs
```

默认命令读取已有 `archive-manifest.json`，核对完整文件集合、字节数和SHA-256，并交叉核对六份日志的脱敏摘要，不写清单。只有显式 `--write-manifest` 才重新生成；不能用它掩盖既有归档损坏。校验不能重新认证已不在归档中的原始字节，原始摘要来源由上方留存日志和归档程序的固定期望值约束。

`archive-evidence.mjs --source-dir <retained-local-log-directory>` 仅为显式归档工具，先逐份核对固定原始摘要；已存在归档不同则拒绝覆盖。它不跑测试、不重建产品、不读用户数据库、不操作GUI。原始报告中失败和成功状态均保留。
