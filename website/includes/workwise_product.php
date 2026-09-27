<?php
/**
 * RailWise AI public product data.
 * This JSON file is the website-side source used by the product page, help
 * routes and the knowledge-base consistency check.
 */
if (!function_exists('rw_workwise_manifest')) {
    function rw_workwise_manifest(): array {
        static $manifest = null;
        if (is_array($manifest)) {
            return $manifest;
        }

        $fallback = [
            'name' => 'RailWise AI',
            'version' => '0.5.0',
            'publishedAt' => '2026-09-14',
            'releaseUrl' => 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.0',
            'repositoryUrl' => 'https://github.com/railwise-cn/railwise-ai',
            'platforms' => [],
            'docs' => [],
        ];
        $path = __DIR__ . '/../data/workwise-product.json';
        $payload = is_file($path) ? file_get_contents($path) : false;
        $decoded = is_string($payload) ? json_decode($payload, true) : null;
        $manifest = is_array($decoded) ? array_replace($fallback, $decoded) : $fallback;
        return $manifest;
    }
}

if (!function_exists('rw_workwise_docs')) {
    function rw_workwise_docs(): array {
        $manifest = rw_workwise_manifest();
        $docs = $manifest['docs'] ?? [];
        return [
            'quickstart' => ['title' => '快速开始', 'desc' => '安装、配置模型并完成第一个 Code / Write / Design 任务。', 'icon' => 'fa-rocket', 'url' => $docs['quickstart'] ?? 'https://kb.railwise.cn/products/workwise/quickstart/'],
            'install' => ['title' => '安装指南', 'desc' => 'macOS 芯片选择、首次打开和 Windows 安装步骤。', 'icon' => 'fa-download', 'url' => $docs['install'] ?? 'https://kb.railwise.cn/products/workwise/install-guide/'],
            'design' => ['title' => 'Design 工作台', 'desc' => '多页画板、图片与组合，以及 PNG、SVG、PPTX 交付边界。', 'icon' => 'fa-object-group', 'url' => $docs['design'] ?? 'https://kb.railwise.cn/products/workwise/design-workspace/'],
            'write-export' => ['title' => 'Write 与导出', 'desc' => 'Markdown、DOCX、PDF 和正式交付前的复核要点。', 'icon' => 'fa-file-export', 'url' => $docs['writeExport'] ?? 'https://kb.railwise.cn/products/workwise/write-export/'],
            'skills' => ['title' => 'Skills 与模板', 'desc' => 'AI Word、PPT Master、MCP 与团队复用能力。', 'icon' => 'fa-layer-group', 'url' => $docs['skills'] ?? 'https://kb.railwise.cn/products/workwise/templates/'],
            'harness' => ['title' => 'DeepSeek Harness 接入说明', 'desc' => 'RailWise AI 实际使用的适配器、结构化附件和视觉证据边界。', 'icon' => 'fa-eye', 'url' => $docs['harness'] ?? 'https://github.com/railwise-cn/railwise-ai/blob/main/docs/DEEPSEEK_HARNESS.zh-CN.md'],
            'security' => ['title' => '本地数据与安全', 'desc' => '工作区、API Key、权限和资料清理边界。', 'icon' => 'fa-shield-halved', 'url' => $docs['security'] ?? 'https://kb.railwise.cn/products/workwise/security-data/'],
            'faq' => ['title' => '常见问题', 'desc' => '安装、模型连接、DOCX 和图片表格问题排查。', 'icon' => 'fa-circle-question', 'url' => $docs['faq'] ?? 'https://kb.railwise.cn/products/workwise/faq/'],
        ];
    }
}

if (!function_exists('rw_workwise_legacy_help_redirect')) {
    function rw_workwise_legacy_help_redirect(int $id): ?string {
        $docs = rw_workwise_docs();
        $map = [
            12 => 'install',
            13 => 'skills',
            14 => 'security',
            15 => 'install',
            29 => 'quickstart',
            30 => 'install',
            31 => 'write-export',
            32 => 'skills',
        ];
        return isset($map[$id], $docs[$map[$id]]) ? $docs[$map[$id]]['url'] : null;
    }
}

if (!function_exists('rw_workwise_legacy_help_ids')) {
    function rw_workwise_legacy_help_ids(): array {
        return [12, 13, 14, 15, 29, 30, 31, 32];
    }
}
