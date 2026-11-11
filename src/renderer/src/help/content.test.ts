import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { HELP_HOME, helpDocuments, helpImages, helpRepositoryUrl, helpResource, helpSlug, searchHelp } from './content'

describe('bundled user help', () => {
  it('keeps all thirteen manual chapters and resolves every manual image offline', () => {
    const body = helpDocuments[HELP_HOME]
    expect(body.match(/^## \d+\./gm)).toHaveLength(13)
    for (const match of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const resource = helpResource(HELP_HOME, match[1])!
      expect(helpImages[resource.path]).toBeTruthy()
    }
    expect(body).toContain('点击一次 **升级**')
    expect(body).toContain('技能、插件、连接器')
  })

  it('searches Chinese text across the handbook and bundled related guides', () => {
    expect(searchHelp('二维码')).toEqual(expect.arrayContaining([expect.objectContaining({ document: HELP_HOME, anchor: '94-连接钉钉或飞书' })]))
    expect(searchHelp('已知点').length).toBeGreaterThan(0)
    expect(helpDocuments[helpResource(HELP_HOME, './SURVEY_AI_GUIDE.zh-CN.md')!.path]).toContain('Survey')
  })

  it('keeps the packaged resource boundary when resolving links', () => {
    expect(helpResource(HELP_HOME, '../secret.md')).toBeUndefined()
    expect(helpResource(HELP_HOME, 'file:///private/account.json')).toBeUndefined()
    expect(helpResource(HELP_HOME, 'javascript:alert(1)')).toBeUndefined()
    expect(helpResource(HELP_HOME, '#12-版本更新')).toEqual({ path: HELP_HOME, anchor: '12-版本更新' })
    expect(helpRepositoryUrl(HELP_HOME, '../src/main/index.ts')).toBe('https://github.com/railwise-cn/railwise-ai/blob/main/src/main/index.ts')
    expect(helpRepositoryUrl(HELP_HOME, 'file:///private/account.json')).toBeUndefined()
    expect(helpRepositoryUrl(HELP_HOME, '//evil.example/account')).toBeUndefined()
  })

  it('resolves all bundled manual links and anchors, with explicit repository fallback for source evidence', () => {
    for (const [document, body] of Object.entries(helpDocuments)) {
      for (const match of body.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1]
        if (/^https?:/i.test(href)) continue
        const resource = helpResource(document, href)
        if (resource && helpDocuments[resource.path]) {
          if (resource.anchor) {
            const headings = [...helpDocuments[resource.path].matchAll(/^#{1,6}\s+(.+)$/gm)].map(heading => helpSlug(heading[1]))
            expect(headings, `${document} → ${href}`).toContain(resource.anchor)
          }
          continue
        }
        const url = helpRepositoryUrl(document, href)
        expect(url, `${document} → ${href}`).toMatch(/^https:\/\/github\.com\/railwise-cn\/railwise-ai\/(blob|tree)\/main\//)
        const path = new URL(url!).pathname.replace(/^\/railwise-cn\/railwise-ai\/(?:blob|tree)\/main\//, '')
        expect(existsSync(resolve(process.cwd(), decodeURIComponent(path))), `${document} → ${href}`).toBe(true)
      }
    }
    expect(helpDocuments[helpResource(HELP_HOME, './github-connector.md')!.path]).toContain('具体仓库')
    expect(searchHelp('个人访问令牌')).toEqual(expect.arrayContaining([expect.objectContaining({ document: 'github-connector.md' })]))
  })
})
