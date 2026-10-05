# 官网来源与只读验收

2026-09-29 的生效根目录由 `nginx -T` 解析确认只有 `/www/audit-releases/audit-20260924-final/site`。`/www/sites/www.railwise.cn/index` 不是当前发布目标。读取失败或找到多个根目录必须保留未确认状态，不能按旧路径部署。

| 内容 | 权威来源 | 边界 |
| --- | --- | --- |
| 导航、首页、产品矩阵、帮助及产品展示路由 | `railwise-cn/railwise-website` 的 `index/` | 当前主线 `d4e55731a539f156c98ac4df4b734b97827da982`；新官网已采用 `/products/railwise-ai/`。 |
| 应用版本、安装包大小/摘要、不可变下载地址 | 应用发布工件与 `website/data/workwise-product.json` | 仍为已经批准发布的 0.5.1；后续修改要精确版本/动作批准。 |
| 应用仓库的旧产品 PHP 页面 | 历史产品发布副本 | 不再可用来整站覆盖新版官网；任何更新先与官网仓库当前路由及线上摘要核对。 |
| 线上部署 | 生效 nginx 根目录与逐文件 SHA-256 | 不能仅凭 Git 主线或工作流绿色判断已部署。 |

当前线上导航 SHA-256 为 `3eb03b162fa1acc9ec01e325ae45e878b2ce55f50339edf07b8c47737d9d33d3`，与上述官网主线的 `index/config/site-navigation.json` 一致；与 9 月 28 日的旧基线不同。其他页面不能由这一个匹配推定同步。旧基线及首次失败不覆盖。

## 检查工具

`scripts/website-surface-audit.mjs` 提供三个只读入口：

- `auditWebsitePage(page, options)`：对已打开的 Ego 页面检查全 DOM 产品菜单、同源导航目标、图片响应/解码状态、实际加载字体及 TTF Unicode cmap。缺少 CSS 字形、字体中的码位、图片 404、旧产品名、跨域重定向均单独报告。无法读取字体或样式记为 incomplete，不能算通过。
- `fontHasCodePoint(bytes, codePoint)`：有界读取 TTF Unicode cmap 4/12，能识别 CSS 定义存在但字体文件实际缺字的情况。字体字形轮廓和最终视觉仍需截图实看。
- `compareWebsiteSources(baseline, snapshot)`：按已确认源码的文件摘要比较唯一生效根目录；漂移只出报告，不自动覆盖、更新基线或发布。

在 ego-browser 已有 TaskSpace 中复用页面，执行序列化的 `inspectWebsiteDocument` 探针，然后在宿主 Node 调用 `auditWebsitePage`，以 `evaluate: async () => collectedDocument` 传入本轮真实观察。本机 Ego Node 的外部模块/文件 I/O 出现无响应，已停止挂起 CLI；不要把这个环境问题记成网站通过。共享 `cache: new Map()` 可避免全站重复读取同一字体和图片。巡检首页、产品列表、各产品页、服务、帮助、关于、联系和兼容下载入口；桌面/移动端菜单仍需分别打开。懒加载图片应滚动后再次观察，尚未解码返回 incomplete。下载校验继续复用 `verifyProductPublication`，不可用首页 HTTP 200 替代三端下载链接检查。

CI 使用离线夹具运行 `node --test scripts/website-surface-audit.test.mjs`，覆盖缺字、缺图、旧品牌、未知字体、越界字体和部署漂移；CI 夹具通过不等于线上巡检通过。本轮不修改官网或公开下载页。
