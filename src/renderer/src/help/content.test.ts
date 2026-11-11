import { describe, expect, it } from 'vitest'
import { HELP_HOME, helpDocuments, helpImages, helpResource, searchHelp } from './content'

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
  })
})
