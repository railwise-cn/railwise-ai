import { describe, expect, it } from 'vitest'
import { computeWorkbenchLayout, WORKBENCH_MAIN_MIN } from './workbench-layout-model'

describe('workbench available-space layout', () => {
  it('does not invent a wider window when navigation and a preview cannot fit', () => {
    expect(computeWorkbenchLayout(960, 304, 560, { leftVisible: true, rightVisible: true }))
      .toMatchObject({ leftOverlay: true, rightOverlay: true, left: 304, right: 560 })
    expect(computeWorkbenchLayout(1100, 304, 560, { leftVisible: true, rightVisible: true }))
      .toMatchObject({ leftOverlay: false, rightOverlay: true })
  })

  it('keeps a readable main column at every supported desktop width and saved panel size', () => {
    for (const width of [960, 1023, 1024, 1100, 1279, 1280, 1336, 1440, 1920, 2560]) {
      for (const left of [180, 264, 304, 480]) for (const right of [280, 360, 560, 760]) {
        const result = computeWorkbenchLayout(width, left, right, { leftVisible: true, rightVisible: true })
        const occupied = (result.leftOverlay ? 0 : result.left + 1) + (result.rightOverlay ? 0 : result.right + 1)
        expect(width - occupied).toBeGreaterThanOrEqual(WORKBENCH_MAIN_MIN)
      }
    }
  })

  it('restores preferred sizes after a temporary shrink rather than permanently compressing them', () => {
    const preference = { left: 304, right: 700 }
    expect(computeWorkbenchLayout(1280, preference.left, preference.right, { leftVisible: true, rightVisible: true }).right).toBeLessThan(700)
    expect(computeWorkbenchLayout(1920, preference.left, preference.right, { leftVisible: true, rightVisible: true }).right).toBe(700)
    expect(preference).toEqual({ left: 304, right: 700 })
  })

  it('does not reserve space for a collapsed panel and bounds drawers to the actual viewport', () => {
    expect(computeWorkbenchLayout(1280, 304, 700, { leftVisible: false, rightVisible: true }).right).toBe(700)
    const compact = computeWorkbenchLayout(300, 360, 760, { leftVisible: true, rightVisible: true })
    expect(compact.left).toBeLessThanOrEqual(276)
    expect(compact.right).toBeLessThanOrEqual(276)
  })
})
