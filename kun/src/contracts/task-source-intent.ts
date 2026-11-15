/** Browser-neutral source intent. Rendering a local file is not external research. */
export const TASK_SOURCE_INFERENCE_VERSION = 1

const explanatory = /^(?:如何|怎么|怎样|什么是|介绍|解释|how\s+to\b|what\s+is\b)/i
const browserTool = /(?:browser|broswer|browse)[-_ ]?skill/i
const sourceAction = /采集|抓取|爬取|检索|搜索|查询|读取|获取|收集|调研|调查|访问|\b(?:fetch|scrape|crawl|collect|research|search|retrieve|read|browse)\b/i
const externalSource = /网页|网站|平台|在线|网上|互联网|公告|资讯|新闻|天气|原文|https?:\/\/|\b(?:web(?:page|site)?|sites?|urls?|online|news|weather)\b|\b(?:external|online|web)\s+sources?\b/i

function asksForExternalRead(text: string): boolean {
  // Explicit local inputs and prohibitions are not requests to fetch a website.
  const request = text.replace(/(?:无需|不需要|不要|禁止|不必)(?:从(?:互联网|网上|网站|网页))?(?:联网|采集|抓取|爬取|检索|搜索|查询|读取|获取|访问)(?:网页|网站|平台|外部(?:资料|数据|来源)|互联网|网上)?/g, '')
    .replace(/(?:读取|解析|\bread\b|\bparse\b)\s*(?:本地|附件|local|attached)/gi, '')
  return sourceAction.test(request) && externalSource.test(request) ||
    /(?:打开|浏览|访问|\bopen\b|\bvisit\b)[\s\S]{0,100}https?:\/\//i.test(request) ||
    /(?:根据|参照|基于|\b(?:from|based\s+on)\b)[\s\S]{0,60}https?:\/\//i.test(request)
}

/** Positive local creation intent, never a blanket exemption for HTML output. */
export function isLocalHtmlCreativeRequest(text: string): boolean {
  return !explanatory.test(text.trim()) &&
    /创建|生成|制作|编写|绘制|设计|写一个|做一个|\b(?:create|generate|make|build|write|draw|design)\b/i.test(text) &&
    /\bhtml?\b|\bsvg\b|网页|动画|\b(?:webpage|animation)\b/i.test(text) && !asksForExternalRead(text)
}

export function requiresWebSourceEvidence(text: string): boolean {
  if (explanatory.test(text.trim())) return false
  if (asksForExternalRead(text)) return true
  if (isLocalHtmlCreativeRequest(text)) return false
  return browserTool.test(text) || /浏览器|网页.*(?:点击|填写|填表|操作|截图|提取|打开)|(?:点击|填写|填表|操作|截图|提取).*网页|\b(?:chrome|edge)\b/i.test(text)
}

/** Literal output names only; wildcard or absolute-path requests remain unmet by an unrelated managed file. */
export function requiredLocalHtmlFileNames(text: string): string[] {
  const names = [...text.matchAll(/(?:命名(?:为)?|文件名(?:为|是|叫)?|保存(?:为|到)|输出(?:为)?|\bname(?:d)?\b|\bfile\s*name\b|\bsave\s+as\b)\s*[:：=]?\s*["“'`「]?([^"“”'`「」，。；\n]{1,300}?\.html?)\b/gi)]
    .map(match => match[1]!.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
  return [...new Set(names)]
}

/** UI hint only. The server additionally checks stopped state, receipts and files. */
export function legacyLocalArtifactSourceMismatch(task: { goal: string; acceptance: {
  kind: string; requiresWebEvidence?: boolean; requiredSourceOrigins?: readonly string[]; requiredFormats?: readonly string[]
  sourceInferenceVersion?: number; requiresExternalEffects?: boolean; schedule?: unknown
} }): boolean {
  return task.acceptance.kind === 'files' && task.acceptance.requiresWebEvidence === true &&
    task.acceptance.sourceInferenceVersion === undefined && !task.acceptance.requiredSourceOrigins?.length &&
    !task.acceptance.requiresExternalEffects && !task.acceptance.schedule &&
    Boolean(task.acceptance.requiredFormats?.length && task.acceptance.requiredFormats.every(format => ['html', 'htm'].includes(format))) &&
    !/(?:生成|导出|保存|输出|制作|创建|\b(?:create|generate|export|save|produce)\b)[^。；\n]{0,80}\b(?:pdf|docx?|pptx?|xlsx?|markdown|png|jpe?g|dxf|dwg)\b/i.test(task.goal) &&
    !/(?:生成|导出|保存|输出|\b(?:create|generate|export|save)\b)[^。；\n]{0,50}\bsvg\s*(?:文件|files?\b)/i.test(task.goal) && isLocalHtmlCreativeRequest(task.goal)
}
