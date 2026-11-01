#!/usr/bin/env python3
"""Focused regression tests for the editable PPTX compatibility importer."""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.util import Centipoints, Inches

from pptx_native_to_svg import (
    convert_pptx_to_svg,
    paragraph_line_height,
)


class _Paragraph:
    def __init__(self, spacing):
        self.line_spacing = spacing


class NativePptxImporterTests(unittest.TestCase):
    def test_fixed_line_spacing_uses_length_units(self):
        # 54pt is 72px at the importer's 96dpi coordinate system. It must not
        # be interpreted as a 685800x font-size multiplier.
        self.assertAlmostEqual(
            paragraph_line_height(_Paragraph(Centipoints(5400)), 24.0),
            72.0,
        )

    def test_gradient_alpha_theme_color_and_page_scoped_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "pixel.png"
            image.write_bytes(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
                "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
            ))
            prs = Presentation()
            for slide_number in range(2):
                slide = prs.slides.add_slide(prs.slide_layouts[6])
                shape = slide.shapes.add_shape(
                    MSO_AUTO_SHAPE_TYPE.OVAL,
                    Inches(1), Inches(1), Inches(2), Inches(2),
                )
                shape.fill.gradient()
                shape.fill.gradient_stops[0].color.theme_color = 6
                shape.fill.gradient_stops[0].color.transparency = 30
                shape.fill.gradient_stops[1].color.rgb = RGBColor(0x11, 0x22, 0x33)
                shape.fill.gradient_stops[1].color.transparency = 100
                slide.shapes.add_picture(str(image), Inches(3), Inches(1))
            source = root / "fixture.pptx"
            prs.save(source)

            report = convert_pptx_to_svg(str(source), str(root / "out"))
            self.assertEqual(report["slides"], 2)
            self.assertEqual(report["mediaFiles"], 2)
            slide = (root / "out" / "svg" / "slide_01.svg").read_text()
            self.assertRegex(slide, r"<(?:linear|radial)Gradient")
            self.assertRegex(slide, r'stop-color="#[0-9A-F]{6}"')
            media = sorted((root / "out" / "svg" / "media").iterdir())
            self.assertTrue(media[0].name.startswith("slide_001_pic_"))
            self.assertTrue(media[1].name.startswith("slide_002_pic_"))

    def test_group_transform_and_empty_paragraph_are_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prs = Presentation()
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            group = slide.shapes.add_group_shape()
            group.left = Inches(3)
            group.top = Inches(2)
            group.width = Inches(4)
            group.height = Inches(3)
            child = group.shapes.add_shape(
                MSO_AUTO_SHAPE_TYPE.RECTANGLE,
                Inches(1), Inches(1), Inches(2), Inches(1),
            )
            child.fill.solid()
            child.fill.fore_color.rgb = RGBColor(0x11, 0x22, 0x33)
            child.text_frame.paragraphs[0].text = ""
            source = root / "fixture.pptx"
            prs.save(source)

            report = convert_pptx_to_svg(str(source), str(root / "out"))
            svg = (root / "out" / "svg" / "slide_01.svg").read_text()
            self.assertEqual(report["diagnostics"], [])
            self.assertIn("<g transform=", svg)
            self.assertIn('fill="#112233"', svg)

    def test_mixed_run_styles_are_reported_as_approximation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prs = Presentation()
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
            paragraph = box.text_frame.paragraphs[0]
            paragraph.text = "RailWise"
            first = paragraph.runs[0]
            first.font.bold = True
            extra = paragraph.add_run()
            extra.text = " AI"
            extra.font.bold = False
            extra.font.color.rgb = RGBColor(0xC8, 0x87, 0x1B)
            source = root / "fixture.pptx"
            prs.save(source)

            report = convert_pptx_to_svg(str(source), str(root / "out"))
            self.assertTrue(any(item["code"] == "rich-text-approximated" for item in report["diagnostics"]))


if __name__ == "__main__":
    unittest.main()
