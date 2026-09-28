<?php
$workwiseIncludeRoot = __DIR__ . '/../../includes';
require_once $workwiseIncludeRoot . '/workwise_product.php';
$workwiseManifest = rw_workwise_manifest();
$workwiseDocs = rw_workwise_docs();
$currentPage = 'products';
$bodyClass = 'page-product page-product-workwise';
$pageTitle = 'RailWise AI · Survey 工程测量内业';
$pageDesc = 'RailWise Survey 将原始测量资料处理为可审查、可追溯的成果：导入预检、建网平差、精度分析与待审查成果包。提供 macOS 与 Windows 客户端，成果仍需工程人员复核。';
$pageKeywords = 'RailWise AI,RailWise Survey,工程测量工作台,DeepSeek V4.1-Flash,deepseek-flash,统一插件市场,Codex 插件,DeepSeek Harness,结构化视觉,应用内更新,Skills,MCP,AI 工作台';
$pageHeroVisualKey = 'product-workwise';
$pageOgImage = 'https://www.railwise.cn/products/screenshots/workwise/07-survey-051-zh-light.jpg';
$workwiseReleaseUrl = (string)$workwiseManifest['releaseUrl'];
$workwiseRepoUrl = (string)$workwiseManifest['repositoryUrl'];
$workwiseVersion = 'v' . (string)$workwiseManifest['version'];
$workwiseReleaseDate = (string)$workwiseManifest['publishedAt'];
$workwiseDownloads = array_map(static function (array $item): array {
  return [
    'platform' => (string)$item['name'],
    'platformClass' => strpos((string)($item['id'] ?? ''), 'macos-') === 0 ? 'is-macos' : 'is-windows',
    'file' => (string)$item['file'],
    'size' => (string)$item['size'],
    'sha256' => (string)$item['sha256'],
    'url' => (string)$item['url'],
    'icon' => (string)$item['icon'],
    'desc' => (string)$item['description'],
  ];
}, is_array($workwiseManifest['platforms'] ?? null) ? $workwiseManifest['platforms'] : []);
$workwiseShots = [
  ['src' => '/products/screenshots/workwise/07-survey-051-zh-light.jpg', 'title' => '工程测量内业 · 中文浅色', 'desc' => '0.5.1 安装包实拍：4 点、1 测站、5 观测的公开合成控制网，查看平差结果、残差与精度。'],
  ['src' => '/products/screenshots/workwise/08-survey-051-delivery.jpg', 'title' => '成果中心', 'desc' => '同一合成控制网的 DOCX、PDF、XLSX 与文件哈希，保留运行来源和待审查状态。'],
  ['src' => '/products/screenshots/workwise/09-survey-051-settings.jpg', 'title' => '设置与外观', 'desc' => '按使用习惯选择语言和明暗主题；已有配置保持兼容。'],
];
$workwiseWriteShots = $workwiseShots;
$workwiseCapabilities = [
  ['title' => '导入与预检', 'desc' => '先检查内容签名、记录结构、单位与来源。需要转换器、GNSS 后处理或仅可归档的资料会给出明确处置，不能直接开始平差。', 'icon' => 'fas fa-file-import', 'tone' => 'workwise-local'],
  ['title' => '建网与确定性平差', 'desc' => '选择工程任务，确认控制点和基准。P0 验收聚焦 GSI 水准观测与 COSA IN2 控制网，数值由本地 Runtime 生成。', 'icon' => 'fas fa-compass', 'tone' => 'workwise-code'],
  ['title' => '分析与精度', 'desc' => '集中查看闭合差、残差、点位精度、观测数与冗余度。异常记录保留来源定位，供工程人员复核。', 'icon' => 'fas fa-chart-line', 'tone' => 'workwise-session'],
  ['title' => '成果与审查', 'desc' => '生成 DOCX、PDF 和 XLSX，将材料保全、首轮抽样与单位评分关联，分别查看资料缺项和已声明不合格结果。成果保持待审查，交由工程人员复核。', 'icon' => 'fas fa-file-export', 'tone' => 'workwise-write'],
  ['title' => '持续 AI 协作', 'desc' => 'DeepSeek V4.1-Flash（deepseek-flash）协助理解、解释与规划。计算或导出计划需确认；模型不可用时可继续手动确定性操作。', 'icon' => 'fas fa-comments', 'tone' => 'workwise-skills'],
  ['title' => '平台辅助工具', 'desc' => '编程与内业是主入口；写作、设计、Flow、插件及定时任务提供辅助。Survey 与这些工具的深度专业联动属于后续计划。', 'icon' => 'fas fa-layer-group', 'tone' => 'workwise-plugin'],
];
$workwiseStatus = [
  ['label' => '正式下载', 'title' => 'RailWise AI ' . $workwiseVersion, 'text' => '下方提供当前正式版本的三个客户端，并列出文件摘要供核对。', 'icon' => 'fas fa-download'],
  ['label' => '本版核对', 'title' => '精确引用与数据保全', 'text' => '公开合成控制网已核对导入、平差、成果追问、文件导出与重启恢复。示例通过不代表真实工程已经验收或签认。', 'icon' => 'fas fa-flask'],
  ['label' => '后续计划', 'title' => '专业可信度与生态扩展', 'text' => '完整规范评定、人员签认、外业采集、点云及更广的格式与跨功能覆盖仍在计划中。', 'icon' => 'fas fa-route'],
];
$workwiseAdvantages = [
  ['title' => '一个任务贯穿四个阶段', 'desc' => '原始文件、网络、运行与成果沿用同一任务上下文，减少在分散页面中寻找当前工作。', 'icon' => 'fas fa-compass'],
  ['title' => '问题与下一步一起呈现', 'desc' => '缺少控制点、单位不明或解析失败时保留具体诊断；修正输入并重新校核后才能计算。', 'icon' => 'fas fa-list-check'],
  ['title' => '数字来自可核对的运行', 'desc' => '来源 SHA-256、解析器身份、原始记录锚点与算法版本跟随结果，便于复核计算依据。', 'icon' => 'fas fa-file-circle-check'],
  ['title' => '候选成果明确标注', 'desc' => '文件生成、待审查清单和正式批准是不同状态。应用不会把预览自动认定为已批准交付的成果。', 'icon' => 'fas fa-clipboard-check'],
];
$workwiseExportFeatures = [
  ['title' => '报告与证据表', 'desc' => 'DOCX、PDF 与 XLSX 来自同一确定性成果来源，包含运行和输入引用。', 'icon' => 'fas fa-file-word'],
  ['title' => '文件完整性', 'desc' => '每份输出记录 SHA-256，可核对磁盘文件是否与清单一致。', 'icon' => 'fas fa-fingerprint'],
  ['title' => '历史记录保留', 'desc' => '每次待审查清单独立保存，保留历史版本与人工处置记录。', 'icon' => 'fas fa-clock-rotate-left'],
  ['title' => '人工审查边界', 'desc' => '预览和草稿不代表审核批准。数字签名及完整质量评定链属于后续专业能力。', 'icon' => 'fas fa-user-check'],
];
$workwiseUseCases = [
  ['title' => '控制网与水准网内业', 'desc' => '导入原始观测，检查控制点、单位和几何条件，完成平差与精度复核。', 'icon' => 'fas fa-compass'],
  ['title' => '工程成果复核', 'desc' => '把残差、闭合差、点位精度与原始记录对应起来，形成待审查证据包。', 'icon' => 'fas fa-file-circle-check'],
  ['title' => '长文档写作', 'desc' => '从 Markdown 到 Word / PDF，减少反复搬运。', 'icon' => 'fas fa-file-export'],
  ['title' => '桌面端 AI 工作区', 'desc' => '用图形化界面管理会话、模板、Skills 和项目资料。', 'icon' => 'fas fa-desktop'],
  ['title' => '项目资料整理', 'desc' => '把资料、会话和成果放进同一个工作区。', 'icon' => 'fas fa-folder-tree'],
  ['title' => '知识与模板沉淀', 'desc' => '将常用方法做成 Skills，团队直接复用。', 'icon' => 'fas fa-boxes-stacked'],
  ['title' => '投标与汇报材料', 'desc' => '梳理结构、提炼要点，辅助形成交付稿。', 'icon' => 'fas fa-list-check'],
  ['title' => '代码项目协作', 'desc' => '围绕本地仓库完成解释、修改、测试和发布。', 'icon' => 'fas fa-code-branch'],
];
$pageJsonLd = [
  [
    '@context' => 'https://schema.org',
    '@type' => 'SoftwareApplication',
    'name' => 'RailWise AI',
    'alternateName' => '桌面端 AI 工作台',
    'applicationCategory' => 'BusinessApplication',
    'operatingSystem' => 'Windows, macOS',
    'softwareVersion' => $workwiseVersion,
    'datePublished' => $workwiseReleaseDate,
    'description' => $pageDesc,
    'url' => 'https://www.railwise.cn/products/workwise/',
    'image' => $pageOgImage,
    'downloadUrl' => 'https://www.railwise.cn' . ($workwiseDownloads[0]['url'] ?? '/downloads/workwise/'),
    'codeRepository' => $workwiseRepoUrl,
    'publisher' => [
      '@type' => 'Organization',
      'name' => '宁波睿威工程技术有限公司',
      'url' => 'https://www.railwise.cn/',
    ],
  ],
  [
    '@context' => 'https://schema.org',
    '@type' => 'BreadcrumbList',
    'itemListElement' => [
      ['@type' => 'ListItem', 'position' => 1, 'name' => '首页', 'item' => 'https://www.railwise.cn/'],
      ['@type' => 'ListItem', 'position' => 2, 'name' => '产品矩阵', 'item' => 'https://www.railwise.cn/products'],
      ['@type' => 'ListItem', 'position' => 3, 'name' => 'RailWise AI', 'item' => 'https://www.railwise.cn/products/workwise/'],
    ],
  ],
];
$rwConversionDock = [
  'eyebrow' => 'RAILWISE AI DEMO',
  'title' => '预约 RailWise AI 场景演示',
  'description' => '围绕工程测量内业、代码协作或文档编排，演示从资料处理到可复核成果的工作流程。',
  'subject' => 'RailWise AI 产品演示',
  'product' => 'workwise',
  'source' => 'product',
  'primary_label' => '预约演示',
];
require_once __DIR__ . '/../../includes/header.php';
?>

<link rel="stylesheet" href="/css/product-detail.css?v=<?php echo filemtime(__DIR__ . '/../../css/product-detail.css'); ?>">

<section class="pd-hero rw-scene-hero">
  <?php echo rw_render_hero_picture('product-workwise', ['loading' => 'eager', 'fetchpriority' => 'high']); ?>
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-breadcrumb">
      <a href="/">首页</a>
      <i class="fas fa-chevron-right"></i>
      <a href="/products">产品矩阵</a>
      <i class="fas fa-chevron-right"></i>
      <span>RailWise AI</span>
    </div>
    <div class="pd-hero-grid">
      <div class="pd-hero-text">
        <div class="pd-eyebrow"><span class="dot"></span> DeepSeek V4.1-Flash 原生默认支持 <span class="pd-product-badge brand-workwise">RailWise AI</span></div>
        <h1 class="pd-title">RailWise Survey</h1>
        <p class="pd-subtitle">RailWise AI 平台 · 工程测量内业</p>
        <p class="pd-desc">面向内业计算员，在同一工程任务中完成导入与预检、建网与平差、分析与精度、成果与审查。AI 持续协助理解问题、解释证据和规划步骤；坐标、高程、闭合差与精度由确定性计算服务生成。</p>
        <p class="pd-desc"><strong>四阶段工程测量内业：</strong>从原始资料预检到平差、精度分析与成果包，保留原始依据和精确结果追问。下方下载对应 RailWise AI <?php echo htmlspecialchars($workwiseVersion); ?>；解释和草稿仍需人工复核。</p>
        <div class="pd-cta-row">
          <a href="#download" class="pd-btn primary" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_hero', 'label' => 'RailWise AI 站内下载', 'product' => 'workwise', 'source' => 'product', 'destination' => 'local_mirror']); ?>>站内下载 <i class="fas fa-download"></i></a>
          <a href="https://kb.railwise.cn/products/workwise/" class="pd-btn ghost" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_hero', 'label' => 'RailWise AI 知识库', 'product' => 'workwise', 'source' => 'product', 'destination' => 'knowledge_base']); ?>>知识库文档 <i class="fas fa-book-open"></i></a>
          <a href="<?php echo htmlspecialchars($workwiseReleaseUrl); ?>" target="_blank" rel="noopener" class="pd-btn ghost" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_hero', 'label' => 'RailWise AI Release', 'product' => 'workwise', 'source' => 'product', 'destination' => 'github_release']); ?>>查看 Release <i class="fas fa-arrow-up-right-from-square"></i></a>
          <a href="/contact?subject=<?php echo urlencode('RailWise AI 产品演示'); ?>&product=workwise&source=product" class="pd-btn ghost" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_hero', 'label' => 'RailWise AI 预约演示', 'product' => 'workwise', 'source' => 'product', 'destination' => 'contact']); ?>>预约演示 <i class="fas fa-comments"></i></a>
        </div>
        <div class="pd-stack">
          <span>Survey 工程测量</span>
          <span>Code</span>
          <span>Write</span>
          <span>Design</span>
          <span>Skills</span>
          <span>MCP</span>
          <span>WWX / Codex / MCPB</span>
          <span>克制的玻璃界面</span>
          <span>DOCX / PDF / XLSX</span>
          <span>Flow Preview</span>
          <span>V4.1-Flash · 默认模型</span>
          <span>deepseek-flash</span>
          <span>1M 上下文</span>
          <span>附件本地解析</span>
          <span>本地优先</span>
          <span><?php echo htmlspecialchars($workwiseVersion); ?></span>
        </div>
      </div>
      <div class="pd-hero-visual">
        <div class="pd-screenshot featured">
          <div class="pd-browser-bar">
            <span></span><span></span><span></span>
            <div class="pd-url">RailWise Survey · 中文浅色界面 · 公开合成数据</div>
          </div>
          <img src="<?php echo htmlspecialchars(optimizeImage('/products/screenshots/workwise/07-survey-051-zh-light.jpg')); ?>" alt="RailWise Survey 0.5.1 中文浅色界面，使用公开合成数据" fetchpriority="high" decoding="async">
        </div>
      </div>
    </div>
  </div>
</section>

<section class="pd-section">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">DEEPSEEK V4.1-FLASH NATIVE</div>
      <h2>DeepSeek V4.1-Flash，协助理解与规划</h2>
      <p class="pd-section-sub">默认模型 ID <code>deepseek-flash</code> 用于 Agent、Write 和 Survey。已有显式模型设置保持不变。Survey 的成果解释先读取所选证据；工程数值和专业结论仍需人工复核。</p>
    </div>
    <div class="pd-caps-grid">
      <article class="pd-cap">
        <div class="pd-cap-head">
          <span class="pd-cap-ico workwise-code"><i class="fas fa-bolt"></i></span>
          <div>
            <span class="pd-eyebrow dark">RAILWISE AI <?php echo htmlspecialchars($workwiseVersion); ?> · AVAILABLE NOW</span>
            <h3>统一默认模型 deepseek-flash</h3>
            <p>首次启动只需配置 DeepSeek API Key 和可选服务地址。主 Agent、Write、定时任务和其他 Agent 默认使用官方模型 ID <code>deepseek-flash</code>；<code>deepseek-v4-pro</code> 可作为显式兼容选择，旧 Flash ID 仅为迁移保留。</p>
            <a href="https://github.com/railwise-cn/railwise-ai/blob/main/docs/product-introduction.zh-CN.md" target="_blank" rel="noopener" class="cli-inline-link">查看 RailWise AI 软件介绍 <i class="fas fa-arrow-up-right-from-square"></i></a>
          </div>
        </div>
      </article>
      <article class="pd-cap">
        <div class="pd-cap-head">
          <span class="pd-cap-ico workwise-skills"><i class="fas fa-diagram-project"></i></span>
          <div>
            <span class="pd-eyebrow dark">1M CONTEXT · UP TO 384K OUTPUT</span>
            <h3>长上下文与结构化工具调用</h3>
            <p>模型目录按 100 万 token 上下文与最高 384K 输出配置，并提供思考模式、工具调用、上下文压缩、缓存统计与 JSON 适配。当前官方 Responses 接口会忽略内置网页搜索，产品不将其列为 V4.1 可用能力；联网工具需另行配置。</p>
            <a href="https://api-docs.deepseek.com/quick_start/pricing" target="_blank" rel="noopener" class="cli-inline-link">查看 DeepSeek 官方模型说明 <i class="fas fa-arrow-up-right-from-square"></i></a>
          </div>
        </div>
      </article>
      <article class="pd-cap">
        <div class="pd-cap-head">
          <span class="pd-cap-ico workwise-update"><i class="fas fa-forward"></i></span>
          <div>
            <span class="pd-eyebrow dark">2026-09-14 · DEEPSEEK-FLASH</span>
            <h3>V4.1-Flash 已接入默认运行时</h3>
            <p>RailWise AI 默认使用官方基础地址 <code>https://api.deepseek.com</code> 与模型 ID <code>deepseek-flash</code>。视觉附件按模型能力发送结构化 text/image 部分；不支持的 Provider 会明确报告，不把图片退化为 Base64 文本。</p>
            <a href="https://api-docs.deepseek.com/updates" target="_blank" rel="noopener" class="cli-inline-link">查看 DeepSeek 官方更新日志 <i class="fas fa-arrow-up-right-from-square"></i></a>
          </div>
        </div>
      </article>
    </div>
  </div>
</section>

<section class="pd-section">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">SURVEY WORKFLOW</div>
      <h2>围绕工程测量生产链组织工作</h2>
      <p class="pd-section-sub">每一步都有明确输入、处理状态与证据。遇到缺少控制点、单位不明或需要后处理的资料，先补足条件再计算。</p>
    </div>
    <div class="ww-advantage-layout">
      <div class="ww-advantage-visual">
        <div class="ww-visual-tag">RailWise Survey · 工程测量内业</div>
        <img src="<?php echo htmlspecialchars(optimizeImage('/products/screenshots/workwise/07-survey-051-zh-light.jpg')); ?>" alt="RailWise Survey 0.5.1 中文浅色界面，使用公开合成数据" loading="lazy" decoding="async">
        <div class="ww-visual-points">
          <span><i class="fas fa-layer-group"></i> Skills</span>
          <span><i class="fas fa-file-word"></i> DOCX</span>
          <span><i class="fas fa-file-pdf"></i> PDF</span>
          <span><i class="fas fa-plug"></i> MCP</span>
        </div>
      </div>
      <div class="ww-advantage-list">
        <?php foreach ($workwiseAdvantages as $item): ?>
        <div class="ww-advantage-card">
          <span><i class="<?php echo htmlspecialchars($item['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
          <div>
            <h3><?php echo htmlspecialchars($item['title'], ENT_QUOTES, 'UTF-8'); ?></h3>
            <p><?php echo htmlspecialchars($item['desc'], ENT_QUOTES, 'UTF-8'); ?></p>
          </div>
        </div>
        <?php endforeach; ?>
      </div>
    </div>
  </div>
</section>

<section class="pd-section dark">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow">CORE CAPABILITIES</div>
      <h2>核心能力</h2>
      <p class="pd-section-sub">主入口为“编程 / 内业”。写作、设计、Flow、插件与定时任务作为侧边工具，围绕当前工作提供辅助。</p>
    </div>
    <div class="pd-caps-grid">
      <?php foreach ($workwiseCapabilities as $item): ?>
      <div class="pd-cap">
        <div class="pd-cap-head">
          <span class="pd-cap-ico <?php echo htmlspecialchars($item['tone'], ENT_QUOTES, 'UTF-8'); ?>"><i class="<?php echo htmlspecialchars($item['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
          <div>
            <h3><?php echo htmlspecialchars($item['title']); ?></h3>
            <p><?php echo htmlspecialchars($item['desc']); ?></p>
          </div>
        </div>
      </div>
      <?php endforeach; ?>
    </div>
    <div class="ww-status-grid">
      <?php foreach ($workwiseStatus as $item): ?>
        <div class="ww-status-card">
          <span class="ww-status-icon"><i class="<?php echo htmlspecialchars($item['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
          <div>
            <span class="ww-status-label"><?php echo htmlspecialchars($item['label'], ENT_QUOTES, 'UTF-8'); ?></span>
            <h3><?php echo htmlspecialchars($item['title'], ENT_QUOTES, 'UTF-8'); ?></h3>
            <p><?php echo htmlspecialchars($item['text'], ENT_QUOTES, 'UTF-8'); ?></p>
          </div>
        </div>
      <?php endforeach; ?>
    </div>
    <p><a href="<?php echo htmlspecialchars($workwiseReleaseUrl, ENT_QUOTES, 'UTF-8'); ?>" target="_blank" rel="noopener" class="cli-inline-link">查看本版更新说明 <i class="fas fa-arrow-up-right-from-square"></i></a></p>
  </div>
</section>

<section class="pd-section" id="download">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">DOWNLOAD</div>
      <h2>下载与安装</h2>
      <p class="pd-section-sub">RailWise AI <?php echo htmlspecialchars($workwiseVersion); ?> 已发布。选择与你的设备匹配的客户端，站内镜像优先下载。</p>
    </div>
    <div class="cli-release-grid">
      <div class="cli-release-card">
        <span>当前版本</span>
        <strong><?php echo htmlspecialchars($workwiseVersion); ?></strong>
        <p>RailWise AI <?php echo htmlspecialchars($workwiseVersion); ?> stable 的站内安装包已同步到下载目录。</p>
      </div>
      <div class="cli-release-card">
        <span>安装包</span>
        <strong>3</strong>
        <p>macOS Apple Silicon、macOS Intel、Windows x64 三个安装包。</p>
      </div>
      <div class="cli-release-card">
        <span>发布时间</span>
        <strong><?php echo htmlspecialchars($workwiseReleaseDate); ?></strong>
        <p>四阶段 Survey 工作区、精确成果追问与启动修复随本版发布。</p>
      </div>
      <a href="<?php echo htmlspecialchars($workwiseReleaseUrl); ?>" target="_blank" rel="noopener" class="cli-release-card" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'download_release', 'label' => 'RailWise AI GitHub Release', 'product' => 'workwise', 'source' => 'product', 'destination' => 'github_release']); ?>>
        <span>Release</span>
        <strong>查看 GitHub Release</strong>
        <p>适合核对上游说明、问题反馈和历史版本。</p>
      </a>
    </div>

    <div class="ww-download-picker">
      <div class="ww-download-picker__head">
        <div>
          <span class="ww-download-picker__eyebrow">CHOOSE YOUR PLATFORM</span>
          <h3>选择适合你的客户端</h3>
          <p>macOS 按芯片选择，Windows 提供 x64 安装包。三个版本均来自 RailWise AI <?php echo htmlspecialchars($workwiseVersion); ?> 正式 Release。</p>
        </div>
        <a href="<?php echo htmlspecialchars($workwiseReleaseUrl, ENT_QUOTES, 'UTF-8'); ?>" target="_blank" rel="noopener" class="ww-download-picker__release" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'download_platforms', 'label' => 'RailWise AI GitHub Release', 'product' => 'workwise', 'source' => 'product', 'destination' => 'github_release']); ?>>查看完整 Release <i class="fas fa-arrow-up-right-from-square"></i></a>
      </div>
      <div class="ww-download-grid">
        <?php foreach ($workwiseDownloads as $download): ?>
        <a href="<?php echo htmlspecialchars($download['url'], ENT_QUOTES, 'UTF-8'); ?>" class="ww-download-option <?php echo htmlspecialchars($download['platformClass'], ENT_QUOTES, 'UTF-8'); ?>" download <?php echo rw_tracking_attrs('conversion_click', ['location' => 'download_card', 'label' => $download['platform'], 'product' => 'workwise', 'source' => 'product', 'destination' => 'local_mirror']); ?>>
          <div class="ww-download-option__mark"><i class="<?php echo htmlspecialchars($download['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></div>
          <div class="ww-download-option__body">
            <div class="ww-download-option__eyebrow">
              <span><?php echo $download['platformClass'] === 'is-macos' ? 'macOS' : 'Windows'; ?></span>
              <span><?php echo htmlspecialchars($workwiseVersion, ENT_QUOTES, 'UTF-8'); ?></span>
            </div>
            <h3><?php echo htmlspecialchars($download['platform'], ENT_QUOTES, 'UTF-8'); ?></h3>
            <p><?php echo htmlspecialchars($download['desc'], ENT_QUOTES, 'UTF-8'); ?></p>
            <div class="ww-download-option__meta">
              <span><?php echo htmlspecialchars($download['size'], ENT_QUOTES, 'UTF-8'); ?></span>
              <span><?php echo htmlspecialchars(pathinfo($download['file'], PATHINFO_EXTENSION), ENT_QUOTES, 'UTF-8'); ?> 安装包</span>
            </div>
            <code class="ww-download-option__file"><?php echo htmlspecialchars($download['file'], ENT_QUOTES, 'UTF-8'); ?></code>
            <span class="ww-download-option__action">立即下载 <i class="fas fa-download"></i></span>
          </div>
        </a>
        <?php endforeach; ?>
      </div>
    </div>
    <details class="mt-6">
      <summary>安装包 SHA-256 校验值</summary>
      <dl class="mt-4 space-y-4">
        <?php foreach ($workwiseDownloads as $download): ?>
          <div>
            <dt><?php echo htmlspecialchars($download['file'], ENT_QUOTES, 'UTF-8'); ?></dt>
            <dd><code style="overflow-wrap: anywhere;"><?php echo htmlspecialchars($download['sha256'], ENT_QUOTES, 'UTF-8'); ?></code></dd>
          </div>
        <?php endforeach; ?>
      </dl>
    </details>
  </div>
</section>

<section class="pd-section ww-docs-section">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">DOCUMENTATION</div>
      <h2>从下载到交付的使用文档</h2>
      <p class="pd-section-sub">详细教程由 RailWise 知识库维护；DeepSeek Harness 接入边界同时提供可核对的仓库说明，当前版本与后续专业能力分别说明。</p>
    </div>
    <div class="ww-doc-grid">
      <?php foreach ($workwiseDocs as $key => $doc): ?>
      <a class="ww-doc-card" href="<?php echo htmlspecialchars($doc['url'], ENT_QUOTES, 'UTF-8'); ?>" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_docs', 'label' => $doc['title'], 'product' => 'workwise', 'source' => 'product', 'destination' => 'knowledge_base']); ?>>
        <span class="ww-doc-card__icon"><i class="fas <?php echo htmlspecialchars($doc['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
        <span class="ww-doc-card__copy"><strong><?php echo htmlspecialchars($doc['title'], ENT_QUOTES, 'UTF-8'); ?></strong><small><?php echo htmlspecialchars($doc['desc'], ENT_QUOTES, 'UTF-8'); ?></small></span>
        <i class="fas fa-arrow-up-right-from-square ww-doc-card__arrow"></i>
      </a>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<section class="pd-section dark">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow">DELIVERABLES & REVIEW</div>
      <h2>成果文件与审查证据</h2>
      <p class="pd-section-sub">工程成果进入待审查清单；通用写作与设计工具继续提供文档和演示材料编排。</p>
    </div>
    <div class="ww-write-layout">
      <div class="ww-write-copy">
        <span class="ww-write-kicker">DETERMINISTIC RESULTS</span>
        <h3>把计算结果整理成可复核的 DOCX / PDF / XLSX</h3>
        <p>Survey 输出的数值来自确定性运行。成果文件附有 SHA-256，运行记录保留输入与算法身份。人工复核、批准和数字签名属于独立环节，生成文件不会自动改变审查状态。</p>
        <div class="ww-export-grid">
          <?php foreach ($workwiseExportFeatures as $item): ?>
          <div class="ww-export-card">
            <span><i class="<?php echo htmlspecialchars($item['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
            <h4><?php echo htmlspecialchars($item['title'], ENT_QUOTES, 'UTF-8'); ?></h4>
            <p><?php echo htmlspecialchars($item['desc'], ENT_QUOTES, 'UTF-8'); ?></p>
          </div>
          <?php endforeach; ?>
        </div>
      </div>
      <div class="ww-write-visual">
        <div class="pd-screenshot featured">
          <div class="pd-browser-bar">
            <span></span><span></span><span></span>
            <div class="pd-url">Survey · 待审查成果</div>
          </div>
          <img src="<?php echo htmlspecialchars(optimizeImage('/products/screenshots/workwise/08-survey-051-delivery.jpg')); ?>" alt="Survey 待审查成果预览与文件哈希" loading="lazy" decoding="async">
        </div>
        <div class="ww-export-flow">
          <span>确定性计算</span>
          <i class="fas fa-arrow-right"></i>
          <span>成果预览</span>
          <i class="fas fa-arrow-right"></i>
          <span>DOCX / PDF / XLSX</span>
        </div>
      </div>
    </div>
    <div class="ww-gallery-strip">
      <?php foreach ($workwiseWriteShots as $shot): ?>
      <figure>
        <img src="<?php echo htmlspecialchars(optimizeImage($shot['src'])); ?>" alt="<?php echo htmlspecialchars($shot['title']); ?>" loading="lazy" decoding="async">
        <figcaption>
          <strong><?php echo htmlspecialchars($shot['title']); ?></strong>
          <span><?php echo htmlspecialchars($shot['desc']); ?></span>
        </figcaption>
      </figure>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<section class="pd-section">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">USE CASES</div>
      <h2>推荐使用场景</h2>
      <p class="pd-section-sub">适合长期积累、反复迭代、重视交付质量的工作。</p>
    </div>
    <div class="pd-usecase-grid">
      <?php foreach ($workwiseUseCases as $item): ?>
      <div class="pd-usecase-card">
        <span class="pd-usecase-ico"><i class="<?php echo htmlspecialchars($item['icon'], ENT_QUOTES, 'UTF-8'); ?>"></i></span>
        <h3><?php echo htmlspecialchars($item['title'], ENT_QUOTES, 'UTF-8'); ?></h3>
        <p><?php echo htmlspecialchars($item['desc'], ENT_QUOTES, 'UTF-8'); ?></p>
      </div>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<section class="pd-section pd-conversion">
  <div class="container mx-auto px-6 max-w-7xl">
    <div class="pd-section-head">
      <div class="pd-eyebrow dark">FEEDBACK</div>
      <h2>反馈与发布规则</h2>
      <p class="pd-section-sub">RailWise AI <?php echo htmlspecialchars($workwiseVersion); ?> 的 macOS 安装包已完成 Developer ID 签名与公证；已安装用户可在应用内检查更新，或下载对应客户端安装。</p>
    </div>
    <div class="pd-faq-grid">
      <div class="pd-faq-card">
        <h3>发布规则</h3>
        <p>公开 Release 只保留三个面向用户的安装包，不发布 Linux 客户端，不公开中间构建文件。</p>
      </div>
      <div class="pd-faq-card">
        <h3>更新方式</h3>
        <p>首次点击更新只下载；再次点击“重启并更新”。应用会先保存编辑内容、列出活动任务并建立检查点，再停止 Runtime 完成安装。</p>
      </div>
      <div class="pd-faq-card">
        <h3>反馈入口</h3>
        <p>问题、建议和复现步骤请优先通过 GitHub Issues 或官网联系页提交。</p>
      </div>
    </div>
    <div class="pd-cta-actions" style="margin-top:2rem;">
      <a href="<?php echo htmlspecialchars($workwiseReleaseUrl); ?>" target="_blank" rel="noopener" class="pd-btn primary large" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_cta', 'label' => 'RailWise AI Release', 'product' => 'workwise', 'source' => 'product', 'destination' => 'github_release']); ?>>查看 Release <i class="fas fa-arrow-up-right-from-square"></i></a>
      <a href="https://kb.railwise.cn/products/workwise/" class="pd-btn ghost large" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_cta', 'label' => 'RailWise AI 知识库', 'product' => 'workwise', 'source' => 'product', 'destination' => 'knowledge_base']); ?>>查看知识库 <i class="fas fa-book-open"></i></a>
      <a href="/contact?subject=<?php echo urlencode('RailWise AI 产品演示'); ?>&product=workwise&source=product" class="pd-btn ghost large" <?php echo rw_tracking_attrs('conversion_click', ['location' => 'product_cta', 'label' => 'RailWise AI 联系支持', 'product' => 'workwise', 'source' => 'product', 'destination' => 'contact']); ?>>联系支持 <i class="fas fa-comments"></i></a>
    </div>
  </div>
</section>

<?php require_once __DIR__ . '/../../includes/footer.php'; ?>
