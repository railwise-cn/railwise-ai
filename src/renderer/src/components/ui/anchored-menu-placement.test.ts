import { describe, expect, it } from 'vitest'
import { calculateAnchoredMenuPlacement } from './anchored-menu-placement'

describe('shared menu visual-to-layout coordinates', () => {
  it.each([0.8, 1, 1.25, 1.5])('keeps the same physical trigger gap with body UI scale %s', scale => {
    const result = calculateAnchoredMenuPlacement({
      anchor: { left: 400 * scale, right: 550 * scale, top: 500 * scale, bottom: 536 * scale },
      viewport: { width: 900 * scale, height: 700 * scale }, contentHeight: 200,
      preferredWidth: 264, scale
    })
    expect(result.side).toBe('top')
    expect(result.left * scale).toBeCloseTo(400 * scale)
    expect((result.top + 200 + 7) * scale).toBeCloseTo(500 * scale)
  })

  it.each([0.8, 1, 1.25, 1.5])('fits a narrow, short visual viewport at scale %s without a forced minimum', scale => {
    const result = calculateAnchoredMenuPlacement({
      anchor: { left: 30, right: 150, top: 105, bottom: 135 }, viewport: { width: 180, height: 160 },
      preferredWidth: 300, contentHeight: 900, scale
    })
    expect(result.width * scale).toBeLessThanOrEqual(180 - 20 * scale)
    expect(result.left * scale).toBeGreaterThanOrEqual(10 * scale)
    expect((result.left + result.width) * scale).toBeLessThanOrEqual(180 - 10 * scale)
    expect(result.top * scale).toBeGreaterThanOrEqual(10 * scale)
    expect((result.top + result.maxHeight) * scale).toBeLessThanOrEqual(160 - 10 * scale)
    expect(result.maxHeight * scale).toBeLessThan(112)
  })

  it('uses visualViewport offsets once and opens below a high trigger', () => {
    const result = calculateAnchoredMenuPlacement({
      anchor: { left: 120, right: 200, top: 60, bottom: 85 },
      viewport: { left: 100, top: 50, width: 320, height: 400 }, contentHeight: 180, preferredWidth: 264
    })
    expect(result.side).toBe('bottom')
    expect(result.left).toBe(120)
    expect(result.top).toBe(92)
    expect(result.left + result.width).toBeLessThanOrEqual(410)
  })

  it('right aligns to the actual trigger and limits long lists to available space', () => {
    const result = calculateAnchoredMenuPlacement({
      anchor: { left: 650, right: 750, top: 300, bottom: 336 }, viewport: { width: 800, height: 480 },
      align: 'end', contentHeight: 1600, preferredWidth: 300, maxHeight: 440
    })
    expect(result.left).toBe(450)
    expect(result.maxHeight).toBe(283)
    expect(result.top).toBe(10)
  })
})
