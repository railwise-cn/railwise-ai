# 0.5.1 官网品牌与图标修复验收

2026-09-28，针对产品下拉菜单仍显示 WorkWise、页面图标缺失进行修复并上线。沿用用户「批准发布 0.5.1 官网下载页」及本轮修复指示。

- 产品页源码：[railwise-ai PR #34](https://github.com/railwise-cn/railwise-ai/pull/34)，合并提交 `4170b757559360a4b7338a7d7c7eff0d5614df3f`。7 项发布校验测试和完整 CI 均通过。
- 共享导航源码：[railwise-website PR #2](https://github.com/railwise-cn/railwise-website/pull/2)，合并提交 `865e702620a97477f692676334a9dc0ebf1a3378`。导航配置、共享产品字典、首页、产品矩阵与帮助入口显示 RailWise AI。
- 替换免费 Font Awesome 不存在的 `fa-file-check` 为 `fa-file-circle-check`；修正产品页剩余两处 WORKWISE 英文标签。
- 正式站点比官网仓库主线有更新的部署内容。上线基于六个实际文件的原始 SHA-256 做精确修改，保留其他已有内容，没有用旧仓库页面覆盖线上。完整差异见 `live-changes.patch`；部署前检查五个 PHP 文件语法及 JSON 格式，并逐一备份。
- 公网首页、产品矩阵、帮助页和产品页均为 HTTP 200，导航版本 `2026-09-28.1`。桌面 1440×1000、手机 390×844 实际点击与截图通过，无横向溢出。手机通过导航「产品介绍」进入产品矩阵，产品入口显示 RailWise AI。
- 产品页 102 个字体图标均有 CSS 定义，字体字形检查见 `font-glyph-verification.json`；逐一滚动加载图片后无损坏图片。桌面、手机「工程成果复核」图标实际可见。
- 0.5.1 公开页面、下载清单和三个安装包 Range 请求通过。下载清单与产品 include 前后哈希一致；安装包、Release、tag、stable/frontier feed 未改动。历史文章标题与不可变安装包文件名中保留 WorkWise，不改已有下载路径或用户数据。

证据：`desktop-menu.png`、`desktop-review-icon.png`、`mobile-menu.png`、`mobile-product-entry.png`、`mobile-review-icon.png`、`desktop-full-page.png`、`browser-audit.json`、`download-verification.json`、`file-hashes.json`、`deployment.log`。

备份位置：服务器容器 `/www/audit-releases/audit-20260924-final/.railwise-ui-backups/20260928-brand-icons`，公开站点目录之外。
