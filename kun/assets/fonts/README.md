# Survey Report Font

`NotoSansSC.ttf` is the unmodified variable Noto Sans SC font from Google Fonts.
It is bundled solely for offline, cross-platform Chinese PDF report rendering.

- Repository: https://github.com/google/fonts
- Commit: `5e35378e6bda803962ee6fd257e444a7d459660d`
- Source: `ofl/notosanssc/NotoSansSC[wght].ttf`
- License: SIL Open Font License 1.1, reproduced in `OFL.txt`
- Font bytes: `17772300`
- Font SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- License SHA-256: `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`
- The font is embedded as a subset in generated PDFs; report data never leaves
  the local Runtime for font lookup or document conversion.

`NotoSansSC-Regular.ttf` is the static `wght=400` instance derived from the above
source with FontTools 4.61.1. PDFKit uses the default axis of a variable font,
which is Thin (`wght=100`) in this source; the static instance keeps report text
readable at print sizes. It remains covered by the same SIL Open Font License.

- Font bytes: `10595932`
- Font SHA-256: `eeb06b8a64fd04a2744d95579db1571b51027cda61ed78c62e4b730791525461`
- Reproduction command:

  ```bash
  python3 -m fontTools.varLib.instancer NotoSansSC.ttf wght=400 --update-name-table --no-recalc-timestamp --output NotoSansSC-Regular.ttf
  ```

The font transformation is a build-time operation; FontTools is not a runtime
dependency. Both font files and the license are included by the existing
`assets/fonts/**/*` packaged-runtime rule.
