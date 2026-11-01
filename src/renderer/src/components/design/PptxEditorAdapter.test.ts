import { describe, expect, it } from 'vitest'
import { designEditorModeForDocumentName } from './design-editor-mode'

describe('PPTX editor mode routing', () => {
  it('routes explicit PPTX documents to the dedicated adapter entry', () => {
    expect(designEditorModeForDocumentName('Quarterly review.PPTX')).toBe('pptx')
  })

  it('keeps legacy and canvas documents on the free canvas', () => {
    expect(designEditorModeForDocumentName('Quarterly review')).toBe('canvas')
    expect(designEditorModeForDocumentName('board.svg')).toBe('canvas')
    expect(designEditorModeForDocumentName(undefined)).toBe('canvas')
  })
})
