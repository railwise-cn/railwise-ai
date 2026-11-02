import { WRITE_MATH_RASTER_FONT_SIZE_PX } from './write-advanced-renderer'

type LogicalImageSize = { width: number; height: number }

/**
 * Chromium reports CSS pixels; DOCX image transformations also use 96-dpi
 * logical pixels. Keep the captured PNG untouched, including Retina pixels,
 * and scale its document extent from the render font to the template font.
 */
export function writeMathImageTransformation(
  image: LogicalImageSize,
  fontSizePt: number,
  display: boolean
): LogicalImageSize {
  const width = Number.isFinite(image.width) && image.width > 0 ? image.width : 1
  const height = Number.isFinite(image.height) && image.height > 0 ? image.height : 1
  const effectiveFontSizePt = Number.isFinite(fontSizePt) && fontSizePt > 0 ? fontSizePt : 11
  const fontScale = effectiveFontSizePt * (96 / 72) / WRITE_MATH_RASTER_FONT_SIZE_PX
  const scale = Math.min(fontScale, (display ? 560 : 300) / width, 760 / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}
