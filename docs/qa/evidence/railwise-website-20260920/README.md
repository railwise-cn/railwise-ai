# 官网与 GitHub 文档同步上线

2026-09-20，[PR #29](https://github.com/wangjiawei508/WorkWise/pull/29) 已合入 main，精确提交 `bea9a0484ebbdf4b1abca89220ca45bba2c3eb1f`。官网、README 中英文和中文软件介绍同步四阶段 Survey、候选范围、V4.1 真实能力与内置搜索限制。三张中文浅色图片来自已安装的 `281dc87` 候选，仅使用合成演示数据。

## 实际上线

- [真实 PHP 预览 35488179105](https://github.com/wangjiawei508/WorkWise/actions/runs/35488179105)：通过；模板、header/footer 和 PHP 依赖使用官网实际环境，未写正式页面。
- [内容部署 35488462995](https://github.com/wangjiawei508/WorkWise/actions/runs/35488462995)：通过；公网标题、产品区段、三张 JPEG 和来源 JSON 均与精确源一致。
- 正式下载清单、include、下载区源码及真实渲染内容前后相同。公开版本保持 WorkWise 0.5.0，三个安装包、Release、tag 与更新 feed 未修改。
- 官网地址：<https://www.railwise.cn/products/workwise/>。

## 浏览器检查

使用同一 Ego 任务空间，实际浏览远端 PHP 预览和部署后的官网。桌面 CSS 视口 1440×1000，手机模拟 CSS 视口 390×844。桌面与手机正文无水平溢出；三张候选截图及标志、背景和图标字体加载成功。手机隐藏的导航抽屉位于视口外，不计作正文溢出。手机图为浏览器模拟，不声称真实手机硬件验收。

`railwise-website-preview-desktop.png`、`railwise-website-preview-mobile.png` 为预览首屏；`mobile-survey` 与 `mobile-download` 为实际滚动位置。`railwise-website-live-desktop.png` 和 `railwise-website-live-mobile.png` 为上线后官网，后者滚动至主截图和模型介绍。`render-metadata.json` 来自云端预览，`artifact-hashes.json` 记录本目录原始图像和元数据摘要。

首次浏览器截图超时，原因是任务页未在原生浏览器窗口中展开；用 Computer Use 展开原任务页后截图恢复。第一次手机滚动使用页面平滑滚动，截图尚未到目标位置，未作为验收证据；改为即时滚动后重截并检查实际滚动位置。预览 favicon 返回 404，未影响产品图像或样式；公网仍使用正式站点资源。

## 检查与修复记录

首轮 CI `35487639053` / `35487650295` 因部署脚本空 catch 的 ESLint 失败；保留原 Action 记录，补充清理意图注释后修正。真实站点资源核查另外发现预览缺少标志和图标字体白名单，补齐固定静态路径并验证无任意代理。最终源的 Quality `35487965197` / `35487966568` 全部通过，部署工具 12 项测试（含真实 PHP）及脚本 lint 通过。

此次内容更新沿用用户已明确授予的 0.5.0 README 和官网介绍更新授权，不将其当作新应用候选公开发布批准。新界面、规范接入和其他后续源码仍按精确候选分别验收。
