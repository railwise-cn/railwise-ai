# RailWise AI 0.5.1 官网发布验收

2026-09-28，用户明确批准“发布 0.5.1 官网下载页”后完成。公开入口：<https://www.railwise.cn/products/workwise/>。

## 发布结果

- 根目录修复 [PR #32](https://github.com/railwise-cn/railwise-ai/pull/32) 已合并，六项 CI 检查通过。
- 部署工具与内容源：`01bccd2fcedce1e94f02e308d9e0ebcd57f9f4a9`。
- [完整官网部署运行 36366801508](https://github.com/railwise-cn/railwise-ai/actions/runs/36366801508) 成功，参数 `version=0.5.1`、`mode=full`、`operation=deploy`，未触发回滚。
- 实际选择的 OpenResty 根目录为 `/www/audit-releases/audit-20260924-final/site`；页面、PHP include 和 manifest 在 Web/PHP 容器内均与提交源 SHA-256 一致，PHP 返回版本 `0.5.1`。关键日志见 [deployment-proof.log](./deployment-proof.log)。
- 此次仅发布官网；已存在的 `v0.5.1` Release、tag、安装包与 stable feed 沿用此前发布结果。

## 独立公网核验

核验时间 `2026-09-28T01:43:04Z`，详细结果见 [public-verification.json](./public-verification.json)。

| 检查 | 结果 |
| --- | --- |
| 默认网址与带查询参数的网址 | 均为 HTTP 200，显示 RailWise AI v0.5.1 与正确 Release/安装包链接 |
| 公开 manifest | 0.5.1，Release commit 与三个安装包 SHA-256 元数据匹配 |
| macOS Apple Silicon / Intel / Windows x64 | 三项均 HTTP 206，Range 返回 0–1023 字节 |
| 07 / 08 / 09 三张正式截图 | 均 HTTP 200，实际字节 SHA-256 与本地提交源一致 |
| 浏览器桌面 1920px | 首页、下载区及图片显示正常，站内下载按钮正确滚动到下载区，无横向溢出 |
| 浏览器手机模拟 390×844 | 首页与下载区可读，页面宽度 390px、内容宽度 390px，无横向溢出 |

浏览器截图：[桌面首页](./website-desktop.png)、[桌面下载区](./website-download-desktop.png)、[手机首页](./website-mobile.png)、[手机下载区](./website-download-mobile.png)。

## 失败尝试与恢复记录

- 前序运行 `36360784189`、`36362064585` 写入旧根目录，公开验证失败后已回滚。
- 本轮 `36365835203` 错选 `content-only`，受保护 include 差异检查在备份/写入前拒绝部署；未修改公开内容，无需回滚。
- 改用批准范围内的完整发布模式后，`36366801508` 成功，最终核验不依赖缓存绕过网址。
- 本机全量测试有 10 项因沙箱拒绝监听 127.0.0.1 而失败，2,858 项通过；PR #32 的 GitHub 全量测试、构建、Windows 与 Electron smoke 均成功。

收尾为失败事务中的截图恢复增加容器边界回归，覆盖原有截图恢复、新图删除、无历史截图及保留无关图片；[PR #33](https://github.com/railwise-cn/railwise-ai/pull/33) 已合并到 `9d478080bdd4ead87444a6c1b7f803b2db98c21e`。本地 7 项回归通过，GitHub 六项检查通过。PR 质量任务首轮遇到未修改的 monitoring-replay 并发文件改写测试偶发失败，同提交 push 质量任务已成功，只重跑失败任务后 PR 质量任务也成功。该修正只更改以后运行的失败恢复路径，不改变已发布官网内容，无需重复发布。
