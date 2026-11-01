import { describe, expect, it } from 'vitest'
import type { PptxElement } from 'pptx-vanilla-viewer'
import { assertNativePptxRoundTrip, nativePptxPrompt, parseNativePptxProposal, type NativePptxSnapshot } from './native-pptx-model'

const text = (id: string, value = id): PptxElement => ({ id, type: 'text', text: value, x: 1, y: 2, width: 10, height: 20 })
function snapshot(elements: PptxElement[] = [text('t1')]): NativePptxSnapshot {
  return { documentId: 'doc', slideId: 'slide', slideIndex: 26, revision: 3, selectedIds: [], preview: 'data:image/png;base64,secretpixels', slide: { id: 'slide', elements } }
}
const proposal = (elementId: string, patch: unknown): string => JSON.stringify({ summary: 'Edit title', updates: [{ elementId, patch }] })

describe('native PPTX AI boundary', () => {
  it('describes all 160 objects including nested groups without embedding binary preview in text', () => {
    const state = snapshot([{ id: 'group', type: 'group', x: 0, y: 0, width: 500, height: 500, children: Array.from({ length: 160 }, (_, i) => text(`t${i}`)) }])
    state.selectedIds = ['t159']
    const prompt = nativePptxPrompt('change last text', state)
    expect(prompt).toContain('t159')
    expect(prompt).toContain('selectedObjects')
    expect(prompt).toContain('slide-27.png')
    expect(prompt).not.toContain('secretpixels')
  })
  it('patches nested objects through one parent update preserving every sibling', () => {
    const state = snapshot([{ id: 'group', type: 'group', x: 0, y: 0, width: 500, height: 500, children: [text('a'), text('b')] }])
    state.selectedIds = ['b']
    const result = parseNativePptxProposal(proposal('b', { text: 'changed' }), state)
    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].elementId).toBe('group')
    expect((result.updates[0].patch as Partial<PptxElement>).children).toEqual([
      text('a'),
      { ...text('b', 'changed'), textSegments: [{ text: 'changed', style: {} }] }
    ])
    expect(state.slide.elements[0].children[1].text).toBe('b')
  })
  it('rejects out of scope, protected, locked and unsafe identity changes', () => {
    const state = snapshot([text('a'), { ...text('b'), locks: { noTextEdit: true } }, { ...text('c'), type: 'smartArt' }])
    state.selectedIds = ['a']
    expect(() => parseNativePptxProposal(proposal('b', { text: 'wrong scope' }), state)).toThrow(/scope/)
    state.selectedIds = []
    expect(() => parseNativePptxProposal(proposal('b', { text: 'locked' }), state)).toThrow(/locked/)
    expect(() => parseNativePptxProposal(proposal('c', { x: 25 }), state)).toThrow(/protected/)
    expect(() => parseNativePptxProposal(proposal('a', { id: 'new' }), state)).toThrow(/unsupported/)
    expect(() => parseNativePptxProposal(proposal('a', { x: '100' }), state)).toThrow(/Invalid x/)
    expect(() => parseNativePptxProposal(proposal('a', { shapeStyle: { fill: 'url(https://evil.test/x)' } }), state)).toThrow(/unsafe/)
  })
  it('retains source-only table properties while applying a partial cell edit', () => {
    const state = snapshot([{ ...text('table'), type: 'table', tableData: { rows: [{ cells: [{ text: 'old', rawXml: { source: 'kept' } }] }], columnWidths: [1] } }])
    const result = parseNativePptxProposal(proposal('table', { tableData: { rows: [{ cells: [{ text: 'new' }] }] } }), state)
    expect((result.updates[0].patch as Partial<PptxElement>).tableData?.rows[0].cells[0]).toEqual({ text: 'new', rawXml: { source: 'kept' } })
  })
  it('permits normal URL text without permitting relationship changes', () => {
    expect(parseNativePptxProposal(proposal('t1', { text: 'Visit https://example.com' }), snapshot()).updates).toHaveLength(1)
  })
})

describe('native PPTX semantic readback', () => {
  it('accepts changed SDK identifiers but rejects lost objects and text', () => {
    const expected = [snapshot([text('a', 'Edited title')]).slide]
    expect(() => assertNativePptxRoundTrip(expected, [snapshot([text('renumbered', 'Edited title')]).slide])).not.toThrow()
    expect(() => assertNativePptxRoundTrip(expected, [snapshot([text('a', 'Old title')]).slide])).toThrow(/content/)
    expect(() => assertNativePptxRoundTrip(expected, [snapshot([]).slide])).toThrow(/content/)
    expect(() => assertNativePptxRoundTrip(expected, [])).toThrow(/slide count/)
  })
})
