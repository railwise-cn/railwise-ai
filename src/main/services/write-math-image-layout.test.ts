import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }))

import { writeMathImageTransformation } from './write-math-image-layout'

describe('DOCX formula image layout', () => {
  it('maps 30px raster layout to a 12pt document font without enlarging the formula', () => {
    expect(writeMathImageTransformation({ width: 300, height: 120 }, 12, true)).toEqual({
      width: 160,
      height: 64
    })
  })

  it('follows the template font size proportionally for both logical dimensions', () => {
    const image = { width: 300, height: 120 }
    expect(writeMathImageTransformation(image, 24, true)).toEqual({ width: 320, height: 128 })
    expect(writeMathImageTransformation(image, 6, true)).toEqual({ width: 80, height: 32 })
  })

  it('uses logical dimensions regardless of the PNG physical pixel density and preserves its bytes', () => {
    const singleDensity = { width: 300, height: 120, png: Buffer.from('300x120-raster-pixels') }
    const doubleDensity = { width: 300, height: 120, png: Buffer.from('600x240-raster-pixels') }
    const originalSingleBytes = Buffer.from(singleDensity.png)
    const originalDoubleBytes = Buffer.from(doubleDensity.png)

    expect(writeMathImageTransformation(singleDensity, 12, true)).toEqual({ width: 160, height: 64 })
    expect(writeMathImageTransformation(doubleDensity, 12, true)).toEqual({ width: 160, height: 64 })
    expect(singleDensity.png).toEqual(originalSingleBytes)
    expect(doubleDensity.png).toEqual(originalDoubleBytes)
    expect(singleDensity.width).toBe(300)
    expect(doubleDensity.width).toBe(300)
  })

  it.each([
    { display: true, maxWidth: 560, expectedHeight: 140 },
    { display: false, maxWidth: 300, expectedHeight: 75 }
  ])('constrains display=$display width while retaining the formula aspect ratio', ({ display, maxWidth, expectedHeight }) => {
    expect(writeMathImageTransformation({ width: 3_000, height: 750 }, 12, display)).toEqual({
      width: maxWidth,
      height: expectedHeight
    })
  })

  it.each([false, true])('constrains very tall display=%s formulas proportionally', (display) => {
    expect(writeMathImageTransformation({ width: 600, height: 6_000 }, 12, display)).toEqual({
      width: 76,
      height: 760
    })
  })

  it('does not constrain image enlargement at a larger template font until a document boundary is reached', () => {
    expect(writeMathImageTransformation({ width: 90, height: 45 }, 45, true)).toEqual({
      width: 180,
      height: 90
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -12])(
    'uses the 11pt default for invalid template font size %s',
    (fontSizePt) => {
      expect(writeMathImageTransformation({ width: 300, height: 120 }, fontSizePt, true)).toEqual({
        width: 147,
        height: 59
      })
    }
  )

  it('keeps finite nonzero dimensions for subpixel formulas', () => {
    expect(writeMathImageTransformation({ width: 0.01, height: 0.01 }, 0.01, false)).toEqual({
      width: 1,
      height: 1
    })
  })

  it.each([
    { width: Number.NaN, height: Number.POSITIVE_INFINITY },
    { width: 0, height: -10 }
  ])('keeps invalid source dimensions safe: %o', (image) => {
    expect(writeMathImageTransformation(image, 12, false)).toEqual({ width: 1, height: 1 })
  })
})
