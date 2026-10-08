# Runtime Electron 启动与测试隔离修复

日期：2026-10-05。分支：`codex/survey-reliability`。修改前提交：`7bf3e6a129088232c35ae3d1320f87b7ba6cd735`。

这份记录是 AI 代码与测试复核。公共版本保持 `0.5.2`，本次未修改发布包、标签、更新源或官网。已安装包的界面验收和真实更新往返有各自独立证据。

## 已修复

- `kun/src/flow/restricted-code.ts` 原先以空环境启动 `process.execPath`。打包后该路径指向 Electron，缺少 `ELECTRON_RUN_AS_NODE=1` 时子进程进入图形模式，合法的 Flow 计算超时。现在只传此启动标记，继续隔离宿主凭据和 `NODE_OPTIONS`。
- `src/main/managed-runtime-process.test.ts` 原先访问真实 Flow 密钥服务，假应用路径使 macOS 凭据助手等待并造成 5 个启动测试超时。现在只 mock 外部密钥服务，保留真实 Runtime 子进程；验证正常密钥传递、不可用时空密钥回退、候选进程密钥覆盖和密钥不进入日志。
- 新增受限计算回归使用 Vitest 的 call-through spy，实际执行子进程并核验环境边界。分别在真实 Node 和 Electron 进程下运行，均验证 JSON 计算、宿主环境隔离、禁止访问 `process` / `require` / `fetch`、CPU 超时和额外权限拒绝。

## 原始失败与根因证据

共享 `better-sqlite3` 为 Electron ABI 148 编译。终端 Node 为 `v26.10.0` / ABI 147，Electron 为 `43.7.7` / Node `v24.21.0` / ABI 148。本轮未重建共享依赖。

| 检查 | 原始结果 | 日志 |
| --- | --- | --- |
| `npm test` | 3002 通过、110 失败、2 跳过；原生 SQLite ABI 不匹配及其连锁失败 | `root-test.log` |
| `npm --prefix kun test` | 2476 通过、587 失败、22 跳过；原生 SQLite ABI 不匹配及其连锁失败 | `kun-test.log` |
| ABI 匹配的 Electron，全套主应用 | 3107 通过、5 失败、2 跳过；启动测试实际访问凭据助手 | `root-test-electron.log` |
| ABI 匹配的 Electron，全套计算服务 | 3061 通过、2 失败、22 跳过；受限代码子进程进入图形模式 | `kun-test-electron.log` |
| 新增回归、修改生产代码前，Node | 3 通过、1 失败；缺少必需启动标记 | `restricted-code-node-red.log` |
| 新增回归、修改生产代码前，Electron | 1 通过、3 失败；真实计算超时 | `restricted-code-electron-red.log` |

## 修复后的实际结果

未使用 `WORKWISE_CANDIDATE_CREDENTIAL_ACCESS=0` 或全局凭据禁用开关来让套件通过。

| 检查 | 最终结果 | 日志 |
| --- | --- | --- |
| 受限代码，Node 真实子进程 | 4/4 通过，退出 0 | `restricted-code-node-green.log` |
| 受限代码，Electron 真实子进程 | 4/4 通过，退出 0 | `restricted-code-electron-green.log` |
| Runtime 启动与配置 | 31/31 通过，退出 0 | `managed-runtime-mocked.log` |
| 主应用 typecheck | 退出 0 | `root-typecheck-final.log` |
| 计算服务 typecheck | 退出 0 | `kun-typecheck-final.log` |
| 主应用全套，Electron / ABI 148 | 350 文件通过、2 文件跳过；3113 测试通过、2 跳过；退出 0 | `root-test-electron-final.log` |
| 计算服务全套，Electron / ABI 148 | 208 文件通过、2 文件跳过；3064 测试通过、22 跳过；退出 0 | `kun-test-electron-final.log` |
| `git diff --check` | 退出 0 | 提交前检查 |

计算服务全套中有一条依赖触发的 `fs.Stats` 弃用提示，未影响退出码和测试结果。跳过项沿用测试定义，未为本次检查新增跳过条件。

## 复现命令

从仓库根目录运行：

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run --maxWorkers=4
npm run typecheck
```

从 `kun/` 运行：

```sh
node ../node_modules/vitest/vitest.mjs run src/flow/restricted-code.test.ts --maxWorkers=1 --reporter=verbose
ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ../node_modules/vitest/vitest.mjs run src/flow/restricted-code.test.ts --maxWorkers=1 --reporter=verbose
ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ../node_modules/vitest/vitest.mjs run --maxWorkers=4
npm run typecheck
```

归档日志仅去除文件末尾冗余空行。原始输出与归档文件的 SHA-256 均保存在 `log-receipts.json`；原始文件保留于 `/tmp/railwise-052-quality-20261005/`。
