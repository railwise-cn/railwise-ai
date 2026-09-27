# 官网介绍和候选截图限定部署

`content-only` 只允许写入产品页面、04/05/06 三张中文浅色 JPEG 和 `candidate-screenshots.json`。旧截图、公共 include、下载清单、安装包、stable/frontier feed、GitHub Release 和公开版本均不在写入范围。原 `full` 流程保持兼容。

## 来源和保护条件

- `source_sha` 必须是完整的小写 40 位提交哈希且可从 `main` 到达；工作流把可信部署工具从 `main` checkout，把候选内容另行 checkout 到 `.content-source`，再次比对 HEAD。两个 checkout 均不持久化 Git 凭据；生产 SSH secrets 仅提供给 SSH 准备和远端操作步骤，验证和测试不能读取私钥。预览 artifact 同时记录工具和内容提交。
- 五个内容文件和两个受保护文件必须与该提交逐字节一致；图片必须匹配来源 JSON 中的 SHA-256，并声明 `zh-CN`、`light`、`released: false`。
- 远端 `includes/workwise_product.php` 与 `data/workwise-product.json` 必须匹配源提交哈希；写入前后以及回滚后均检查，绝不覆盖这两个文件。
- 新旧页面的 `id="download"` section PHP 源码必须完全相同；还要在远端真实 PHP 运行环境、真实 header/footer/include 下各自执行并比较下载区渲染哈希。因此下载区以外的变量改动也不能改变下载区呈现。
- 页面与截图先备份，再按固定白名单写入。中断或后置保护失败会自动回滚；公开验证失败由工作流触发显式回滚。原本不存在的新增图片和来源 JSON 会删除，原有图片按备份恢复。不同 source_sha 不能回滚该批次。
- 公网验证检查服务器页面/图片/来源清单字节、下载区渲染，并把公网 title 和所有 `pd-*` 产品 section 与实际 PHP 渲染结果逐字节比较，覆盖介绍及下载区旧缓存；另检查三张图片引用及图片、来源 JSON 的公网哈希。验证失败不代表部署成功。

## 可审查命令

下面仅是运行方式。本次实现没有执行部署；`SOURCE_SHA` 应替换为包含已审查文案、截图和脚本的完整提交，`DEPLOY_ID` 应为唯一值。

```sh
node scripts/deploy-workwise-product-page.mjs validate --source website --version 0.5.0 --mode content-only --source-sha "$SOURCE_SHA"
node scripts/deploy-workwise-product-page.mjs deploy --source website --version 0.5.0 --mode content-only --source-sha "$SOURCE_SHA" --deploy-id "$DEPLOY_ID"
node scripts/deploy-workwise-product-page.mjs verify-public --source website --version 0.5.0 --mode content-only --source-sha "$SOURCE_SHA" --deploy-id "$DEPLOY_ID"
node scripts/deploy-workwise-product-page.mjs rollback --source website --version 0.5.0 --mode content-only --source-sha "$SOURCE_SHA" --deploy-id "$DEPLOY_ID"
```

具备既有授权且完成审查后，可用仓库中已有 SSH secrets 的工作流：

```sh
gh workflow run deploy-workwise-product-page.yml -R railwise-cn/railwise-ai --ref main -f version=0.5.0 -f confirmation=DEPLOY-WORKWISE-PRODUCT-PAGE-v0.5.0 -f mode=content-only -f operation=deploy -f source_sha="$SOURCE_SHA"
```

工作流定义、部署工具和已审查官网内容须先进入 `main`，预览和部署须使用同一精确源提交。不要省略 `-R`：本机 gh 的默认仓库可能指向上游仓库。工作流表单默认 `content-only` / `preview`，不会直接部署。

## 真正的官网预览

当前仓库只有页面覆盖文件，没有完整 header/footer、CSS 及其依赖。本机也没有原生 PHP，Docker daemon 未运行。占位 header/CSS 无法作为视觉验收证据。

`preview` 复用已固定 SSH host key 的工作流，在真实 PHP 容器中对私有 staging 的候选页面执行 PHP：用 `token_get_all` 仅把 `T_DIR` 替换为真实产品目录，设置公开站点的 `DOCUMENT_ROOT`/`HTTP_HOST`/`REQUEST_URI`，输出已渲染 HTML。模板使用服务器原文件，不覆盖官网文件；artifact 不导出 PHP 源码和配置。PHP warning/exception 会中止，仅输出通用错误摘要。返回 HTML、三张图片、来源 JSON 和含来源 SHA/哈希的 `render-metadata.json`。

```sh
gh workflow run deploy-workwise-product-page.yml -R railwise-cn/railwise-ai --ref main -f version=0.5.0 -f confirmation=DEPLOY-WORKWISE-PRODUCT-PAGE-v0.5.0 -f mode=content-only -f operation=preview -f source_sha="$SOURCE_SHA"
gh run download "$RUN_ID" -R railwise-cn/railwise-ai -n "workwise-content-preview-$SOURCE_SHA" -D "$PREVIEW_DIR"
node scripts/preview-workwise-content.mjs --directory "$PREVIEW_DIR" --port 4175
```

在 `http://127.0.0.1:4175/products/workwise/` 检查真实 PHP 渲染的页面。服务启动先验 HTML/本地图像哈希，仅绑定 loopback；官网 CSS、字体、脚本和图片只允许固定官网 origin 下静态资源白名单的 GET，拒绝代理重定向、任意主机、表单 POST、下载和 API。CSP 禁止表单、连接和 frame，不把预览当线上交互验收。验收后停止本地服务。

这条方式导出的是实际 PHP 渲染结果，不是假造模板。但本次开发未运行远端预览/部署，不可标记官网视觉验收通过。若必须本地运行完整 PHP 网站，则需要另行取得经过检查的完整模板及依赖包；不能只取 header/footer 两个文件后用桩函数冒充完整网站，也不能无筛选导出服务器 PHP 配置。

## 验证

```sh
node --test scripts/workwise-content-deploy.test.mjs
WORKWISE_CONTENT_PHP_TEST=php node --test scripts/workwise-content-deploy.test.mjs
```

事务测试实际执行 Bash 和临时文件读写/回滚；其中 PHP transport 为明确标注的测试替身。第二条额外用真实 PHP 执行源码/渲染保护器和无敏感错误输出，工作流在 content-only 模式强制运行该项。另有公网旧介绍/下载区/标题/来源清单拒绝测试及本地只读代理测试。它们不代替真实官网模板的整页渲染和视觉验收。
