import guide from '../../../../docs/USER_GUIDE.zh-CN.md?raw'
import survey from '../../../../docs/SURVEY_AI_GUIDE.zh-CN.md?raw'
import introduction from '../../../../docs/product-introduction.zh-CN.md?raw'
import harness from '../../../../docs/DEEPSEEK_HARNESS.zh-CN.md?raw'
import migration from '../../../../docs/plugin-migration-matrix.md?raw'
import overview from '../../../../docs/qa/release-gates/v0.5.3-ai-review/screenshots/overview-zh-dark-1280x840.png?url'
import process from '../../../../docs/qa/release-gates/v0.5.3-ai-review/screenshots/process-zh-dark-1280x840.png?url'
import results from '../../../../docs/qa/release-gates/v0.5.3-ai-review/screenshots/results-zh-dark-1280x840.png?url'
import deliver from '../../../../docs/qa/release-gates/v0.5.3-ai-review/screenshots/deliver-zh-dark-1280x840.png?url'
import { version } from '../../../../package.json'

export const HELP_VERSION = version
export const HELP_UPDATED_AT = '2026-11-11'
export const HELP_HOME = 'USER_GUIDE.zh-CN.md'
export const helpDocuments: Record<string, string> = {
  [HELP_HOME]: guide,
  'SURVEY_AI_GUIDE.zh-CN.md': survey,
  'product-introduction.zh-CN.md': introduction,
  'DEEPSEEK_HARNESS.zh-CN.md': harness,
  'plugin-migration-matrix.md': migration
}
const imageRoot = 'qa/release-gates/v0.5.3-ai-review/screenshots/'
export const helpImages: Record<string, string> = {
  [`${imageRoot}overview-zh-dark-1280x840.png`]: overview,
  [`${imageRoot}process-zh-dark-1280x840.png`]: process,
  [`${imageRoot}results-zh-dark-1280x840.png`]: results,
  [`${imageRoot}deliver-zh-dark-1280x840.png`]: deliver
}

export function helpSlug(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-')
}

export function helpResource(from: string, href: string): { path: string; anchor: string } | undefined {
  try {
    const url = new URL(href, `https://help.railwise.invalid/docs/${from}`)
    if (url.origin !== 'https://help.railwise.invalid' || !url.pathname.startsWith('/docs/')) return undefined
    return { path: decodeURIComponent(url.pathname.slice('/docs/'.length)), anchor: decodeURIComponent(url.hash.slice(1)) }
  } catch { return undefined }
}

export type HelpSearchResult = { document: string; heading: string; anchor: string; excerpt: string }
export function searchHelp(query: string): HelpSearchResult[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const found: HelpSearchResult[] = []
  for (const [document, body] of Object.entries(helpDocuments)) {
    let heading = document
    const occurrences = new Map<string, number>()
    let anchor = ''
    for (const line of body.split('\n')) {
      const title = /^#{1,6}\s+(.+)$/.exec(line)
      if (title) {
        heading = title[1]
        const slug = helpSlug(heading)
        const count = occurrences.get(slug) ?? 0
        occurrences.set(slug, count + 1)
        anchor = count ? `${slug}-${count}` : slug
      }
      if (line.toLocaleLowerCase().includes(needle)) found.push({ document, heading, anchor, excerpt: line.slice(0, 220) })
      if (found.length >= 60) return found
    }
  }
  return found
}
