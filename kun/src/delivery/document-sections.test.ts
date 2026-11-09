import { describe, expect, it } from 'vitest'
import { documentSections, patchDocumentSections } from './document-sections.js'

describe('candidate section spans and selective regeneration', () => {
  it('ignores frontmatter and fenced headings, supports Setext, and preserves unselected bytes', () => {
    const original = '---\ntitle: 合成\n# yaml comment\n---\n# 报告\n保持引言\n## 风险\n旧风险\n```md\n# 代码中的标题\n```\n结论\n----\n保留结论\n'
    const sections = documentSections(original)
    expect(sections.map(item => item.heading)).toEqual(['报告', '风险', '结论'])
    expect(sections[1]).toMatchObject({ level: 2, startLine: 7, endLine: 11 })
    const next = patchDocumentSections(original, [{ heading: '风险', content: '已按新来源重写风险。\n' }])
    expect(next.content).toBe(original.replace('旧风险\n```md\n# 代码中的标题\n```\n', '已按新来源重写风险。\n'))
    expect(next.content.slice(next.content.indexOf('结论\n----'))).toBe(original.slice(original.indexOf('结论\n----')))
  })
  it('rejects ambiguous, overlapping or structural patches and accepts stable IDs', () => {
    const original = '# 报告\n## 同名\nA\n### 子标题\n子内容\n## 同名\nB\n'
    expect(() => patchDocumentSections(original, [{ heading: '同名', content: 'ambiguous' }])).toThrow(/ambiguous/)
    expect(() => patchDocumentSections(original, [{ heading: '报告', content: 'change' }])).toThrow(/subsection headings/)
    const sections = documentSections(original)
    expect(() => patchDocumentSections(original, [{ heading: sections[1]!.id, content: 'new\n### 子标题\n子内容\n' }, { heading: '子标题', content: 'child' }])).toThrow(/overlap/)
    const next = patchDocumentSections(original, [{ heading: sections[3]!.id, content: '新B' }])
    expect(next.content).toBe(original.replace('B\n', '新B\n'))
    expect(patchDocumentSections('## 空章', [{ heading: '空章', content: '正文' }]).content).toBe('## 空章\n正文\n')
  })
})
