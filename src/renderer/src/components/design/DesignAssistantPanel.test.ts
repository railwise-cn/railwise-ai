import { describe, expect, it } from 'vitest'
import { createDesignDocument, createDesignElement } from '@shared/design-document'
import { buildDesignPrompt, designAssistantScopeKey } from './DesignAssistantPanel'

describe('Design assistant active-canvas prompt', () => {
  it('binds the request to one exact document revision and atomic command key', () => {
    const document = createDesignDocument({ name: 'Test board' })
    const page = document.pages[0]
    const element = createDesignElement('rect', { id: 'shape_1', x: 40, y: 60 })
    page.elements.push(element)
    document.revision = 7

    const prompt = buildDesignPrompt(
      '把选中的矩形改成蓝色',
      document,
      page,
      [element.id],
      'design-command-test'
    )

    expect(prompt).toContain('call design_apply_canvas_commands exactly once')
    expect(prompt).toContain('Use this exact idempotency_key: design-command-test')
    expect(prompt).toContain(`"documentId":"${document.id}"`)
    expect(prompt).toContain(`"pageId":"${page.id}"`)
    expect(prompt).toContain('"revision":7')
    expect(prompt).toContain('"selectedElementIds":["shape_1"]')
    expect(prompt).toContain('Do not write SVG, HTML, JSON, scripts, or other files')
    expect(prompt).toContain('User request: 把选中的矩形改成蓝色')
  })

  it('isolates assistant state by document and page', () => {
    expect(designAssistantScopeKey('document-a', 'page-1')).toBe('document-a:page-1')
    expect(designAssistantScopeKey('document-a', 'page-1'))
      .not.toBe(designAssistantScopeKey('document-b', 'page-1'))
    expect(designAssistantScopeKey('document-a', 'page-1'))
      .not.toBe(designAssistantScopeKey('document-a', 'page-2'))
  })

  it('includes objects beyond 120 and complete selected properties with lock constraints', () => {
    const document = createDesignDocument({ name: 'Dense slide' })
    const page = document.pages[0]
    page.elements = Array.from({ length: 180 }, (_, index) => createDesignElement('text', {
      id: `text_${index}`, text: `Item ${index}`, locked: index === 179, fontSize: 27
    }))
    const prompt = buildDesignPrompt('修改最后一个对象', document, page, ['text_179'])
    expect(prompt).toContain('"id":"text_179"')
    expect(prompt).toContain('"elementCount":180')
    expect(prompt).toContain('"locked":true')
    expect(prompt).toContain('"fontSize":27')
    expect(prompt).toContain('Preserve locked objects')
  })
})
