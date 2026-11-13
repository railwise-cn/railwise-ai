/** Offline baseline for generated webpages that do not provide their own styles. */
const REPORT_STYLE = `<style data-railwise-report>
:root{color-scheme:light;--ink:#182536;--muted:#57667a;--line:#dce3ec;--accent:#245ca8}
*{box-sizing:border-box}body{margin:0 auto;max-width:1180px;padding:48px 40px 72px;background:#fff;color:var(--ink);font:16px/1.8 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;overflow-wrap:anywhere}
h1,h2,h3{line-height:1.35;letter-spacing:-.025em}h1{margin:0 0 24px;font-size:clamp(28px,4vw,40px)}h2{margin:40px 0 16px;padding-top:16px;border-top:1px solid var(--line);font-size:24px}h3{margin:26px 0 12px;font-size:19px}
p,ul,ol{margin:12px 0}a{color:var(--accent);text-underline-offset:3px}header{padding-bottom:20px;border-bottom:2px solid var(--ink)}small,time,figcaption,.meta,.source{color:var(--muted);font-size:13px}blockquote{margin:20px 0;padding:12px 20px;border-left:3px solid var(--accent);background:#f4f7fb}
table{width:100%;border-collapse:collapse;margin:24px 0;font-size:14px;text-align:left}th{background:#edf2f8;font-weight:600}th,td{padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:nth-child(even){background:#f8fafc}img,svg,canvas{max-width:100%;height:auto}pre{padding:16px;overflow:auto;background:#f4f7fb;border-radius:8px}code{font-family:ui-monospace,monospace;font-size:.9em}footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted)}
@media(max-width:720px){body{padding:28px 20px 48px}table{display:block;overflow:auto}th,td{min-width:130px;padding:10px 12px}}
@media print{body{max-width:none;padding:0;font-size:11pt}h1,h2,h3{break-after:avoid}tr,figure,blockquote{break-inside:avoid}a{color:inherit}table{display:table;font-size:9pt}@page{margin:18mm}}
</style>`

export function prepareHtmlArtifact(content: string): string {
  if (/<style\b|<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(content)) return content
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${REPORT_STYLE}`
  if (/<head\b[^>]*>/i.test(content)) return content.replace(/<head\b[^>]*>/i, tag => `${tag}${head}`)
  if (/<html\b[^>]*>/i.test(content)) return content.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${head}</head>`)
  return `<!doctype html><html lang="zh-CN"><head>${head}</head><body>${content}</body></html>`
}
