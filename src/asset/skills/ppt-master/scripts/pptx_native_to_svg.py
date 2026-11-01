#!/usr/bin/env python3
"""Native PPTX → SVG converter (bypasses pptx_to_svg approximations).

Reads the PPTX directly with python-pptx and emits one SVG per slide with:
- slide-size coordinates (96 dpi px)
- shapes (rect/ellipse/line/textbox/picture/table/group) with frame geometry
- real text paragraphs: font family/size/weight/color/letter-spacing/alignment
- solid and gradient fills with color/alpha transforms, outline colors
- theme color resolution (theme1.xml schemeClr → srgbClr)
- pictures written to `<output>/svg/media/<name>` and referenced as href

RailWise AI uses this compatibility importer for editable design elements.
The conversion report records approximations; it is not a fidelity guarantee.
"""

from __future__ import annotations

import re
import sys
import zipfile
import math
import hashlib
import json
from pathlib import Path
from typing import Any, Optional

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Length

from pptx_to_svg.color_resolver import ColorPalette, resolve_color
from pptx_to_svg.fill_to_svg import resolve_fill

EMU_PER_PX = 9525.0
PT_TO_PX = 96.0 / 72.0
XML_NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"

THEME_KEY_BY_TYPE = {
    "DARK_1": "dk1",
    "DARK_2": "dk2",
    "LIGHT_1": "lt1",
    "LIGHT_2": "lt2",
    "ACCENT_1": "accent1",
    "ACCENT_2": "accent2",
    "ACCENT_3": "accent3",
    "ACCENT_4": "accent4",
    "ACCENT_5": "accent5",
    "ACCENT_6": "accent6",
    "HYPERLINK": "hlink",
    "FOLLOWED_HYPERLINK": "folHlink",
}


def px(value: Any, fallback: float = 0.0) -> float:
    if value is None:
        return fallback
    try:
        return float(value) / EMU_PER_PX
    except (TypeError, ValueError):
        return fallback


def pt_to_px(value: Any, fallback: float = 18.0) -> float:
    if value is None:
        return fallback
    try:
        emu = float(value)
        # python-pptx font.size returns EMU; accept raw pt for small numbers.
        if emu < 1000:
            return emu * PT_TO_PX
        return emu / EMU_PER_PX
    except (TypeError, ValueError):
        return fallback


def esc(value: Any) -> str:
    text = "" if value is None else str(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def resolve_theme_colors(pptx_path: str) -> dict[str, str]:
    colors: dict[str, str] = {}
    try:
        with zipfile.ZipFile(pptx_path) as archive:
            theme_names = [
                name
                for name in archive.namelist()
                if re.match(r"^ppt/theme/theme\d+\.xml$", name)
            ]
            if not theme_names:
                return colors
            root = etree.fromstring(archive.read(theme_names[0]))
            scheme = root.find(f".//{{{XML_NS_A}}}clrScheme")
            if scheme is None:
                return colors
            for child in scheme:
                tag = etree.QName(child).localname
                srgb = child.find(f"{{{XML_NS_A}}}srgbClr")
                if srgb is not None:
                    colors[tag] = "#" + (srgb.get("val") or "").upper()
                    continue
                sysclr = child.find(f"{{{XML_NS_A}}}sysClr")
                if sysclr is not None and sysclr.get("lastClr"):
                    colors[tag] = "#" + sysclr.get("lastClr").upper()
    except Exception:
        pass
    return colors


def resolve_theme_fonts(pptx_path: str) -> dict[str, str]:
    fonts: dict[str, str] = {}
    try:
        with zipfile.ZipFile(pptx_path) as archive:
            theme_names = [
                name
                for name in archive.namelist()
                if re.match(r"^ppt/theme/theme\d+\.xml$", name)
            ]
            if not theme_names:
                return fonts
            root = etree.fromstring(archive.read(theme_names[0]))
            font_scheme = root.find(f".//{{{XML_NS_A}}}fontScheme")
            if font_scheme is None:
                return fonts
            for tag in ("majorFont", "minorFont"):
                node = font_scheme.find(f"{{{XML_NS_A}}}{tag}")
                if node is None:
                    continue
                latin = node.find(f"{{{XML_NS_A}}}latin")
                ea = node.find(f"{{{XML_NS_A}}}ea")
                fonts[tag] = (
                    (latin.get("typeface") if latin is not None else "")
                    or (ea.get("typeface") if ea is not None else "")
                    or "Arial"
                )
    except Exception:
        pass
    return fonts


def color_hex(color: Any, theme_colors: dict[str, str]) -> Optional[str]:
    if color is None:
        return None
    try:
        if color.type is None:
            return None
        # ColorFormat.type is SCHEME, not ACCENT_2. Resolve the actual color
        # node so that theme slots and luminance/tint transforms are retained.
        node = getattr(getattr(color, "_color", None), "_xClr", None)
        if node is not None:
            value, _alpha = resolve_color(node, color_palette(theme_colors))
            return value
        type_name = str(color.type)
        if "RGB" in type_name or "NOT_THEME" in type_name:
            rgb: RGBColor = color.rgb
            return "#%02X%02X%02X" % (rgb[0], rgb[1], rgb[2])
        enum_name = str(color.theme_color).rsplit(".", 1)[-1]
        match = re.match(r"([A-Z][A-Z_0-9]*)", enum_name)
        key = THEME_KEY_BY_TYPE.get(match.group(1) if match else enum_name)
        return theme_colors.get(key) if key else None
    except Exception:
        return None


def color_palette(theme_colors: dict[str, str]) -> ColorPalette:
    palette = ColorPalette(None, None)
    palette.scheme = {key: value.lstrip("#") for key, value in theme_colors.items()}
    return palette


def color_opacity(color: Any, theme_colors: dict[str, str]) -> float:
    node = getattr(getattr(color, "_color", None), "_xClr", None)
    if node is None:
        return 1.0
    return resolve_color(node, color_palette(theme_colors))[1]


def shape_fill(shape: Any, theme_colors: dict[str, str], defs: list[str],
               id_prefix: str) -> dict[str, str]:
    """Use the upstream DrawingML resolver instead of flattening gradients."""
    try:
        fill = shape.fill
    except AttributeError:
        return {}
    result = resolve_fill(fill._xPr, color_palette(theme_colors), id_prefix=id_prefix)
    defs.extend(result.defs)
    return result.attrs


def shape_stroke(shape: Any, theme_colors: dict[str, str]) -> tuple[Optional[str], Optional[float], float]:
    try:
        line = shape.line
        fill = line.fill
        if fill.type is None:
            return None, None, 1.0
        type_name = str(fill.type)
        color = None
        opacity = 1.0
        if "SOLID" in type_name:
            color = color_hex(fill.fore_color, theme_colors)
            opacity = color_opacity(fill.fore_color, theme_colors)
        width = None
        try:
            if line.width is not None:
                width = max(0.0, px(line.width))
        except Exception:
            width = None
        return color, width, opacity
    except Exception:
        return None, None, 1.0


def run_letter_spacing(run: Any) -> Optional[float]:
    """Return letter spacing in px from the run XML `spc` attribute (1/100 pt)."""
    try:
        rPr = run._r.find(f"{{{XML_NS_A}}}rPr")
        if rPr is None:
            return None
        spc = rPr.get("spc")
        if spc is None:
            return None
        return float(spc) / 100.0 * PT_TO_PX
    except Exception:
        return None


def run_font_name(run: Any, default: str) -> str:
    try:
        rPr = run._r.find(f"{{{XML_NS_A}}}rPr")
        latin = None
        east_asian = None
        if rPr is not None:
            latin_node = rPr.find(f"{{{XML_NS_A}}}latin")
            ea_node = rPr.find(f"{{{XML_NS_A}}}ea")
            latin = latin_node.get("typeface") if latin_node is not None else None
            east_asian = ea_node.get("typeface") if ea_node is not None else None
        if not latin:
            latin = run.font.name or default
        stack = []
        if east_asian and east_asian != latin:
            stack.append(east_asian)
        stack.append(latin or default)
        stack.append("PingFang SC")
        stack.append("Arial")
        return ", ".join(f'"{name}"' for name in stack) + ", sans-serif"
    except Exception:
        return default


def text_anchor(alignment: Any) -> str:
    if alignment == PP_ALIGN.CENTER:
        return "middle"
    if alignment == PP_ALIGN.RIGHT:
        return "end"
    return "start"


def anchor_offset(anchor: Any, content_height: float, box_height: float) -> float:
    if anchor == MSO_ANCHOR.MIDDLE:
        return max(0.0, (box_height - content_height) / 2.0)
    if anchor == MSO_ANCHOR.BOTTOM:
        return max(0.0, box_height - content_height)
    return 0.0


def paragraph_line_height(paragraph: Any, base_font_size_px: float) -> float:
    spacing = paragraph.line_spacing
    if spacing is None:
        return base_font_size_px * 1.2
    try:
        # python-pptx returns Centipoints (a Length) for a:spcPts. Treating
        # it as a multiplier can move text tens of millions of pixels away.
        if isinstance(spacing, Length):
            return max(base_font_size_px, px(spacing))
    except Exception:
        pass
    try:
        return max(base_font_size_px, float(spacing) * base_font_size_px)
    except Exception:
        return base_font_size_px * 1.2


def emit_text(shape: Any, tf: Any, shape_left: float, shape_top: float,
              shape_w: float, shape_h: float, theme_colors: dict[str, str],
              minor_font: str, out: list[str],
              diagnostics: Optional[list[dict[str, Any]]] = None,
              slide_index: int = 1) -> None:
    try:
        ml = px(tf.margin_left, 7.2)
        mr = px(tf.margin_right, 7.2)
        mt = px(tf.margin_top, 3.6)
        mb = px(tf.margin_bottom, 3.6)
        anchor = tf.vertical_anchor
    except Exception:
        ml, mr, mt, mb, anchor = 7.2, 7.2, 3.6, 3.6, None

    paragraphs = list(tf.paragraphs)
    if not paragraphs:
        return

    # First non-empty run gives the paragraph font baseline.
    first_size = 18.0
    for paragraph in paragraphs:
        nonempty = next((run for run in paragraph.runs if run.text.strip()), None)
        if nonempty is not None:
            first_size = pt_to_px(nonempty.font.size, pt_to_px(paragraph.font.size, 18.0))
            break

    heights: list[float] = []
    for paragraph in paragraphs:
        size = pt_to_px(paragraph.font.size, first_size)
        for run in paragraph.runs:
            if run.text.strip():
                size = pt_to_px(run.font.size, first_size)
                break
        heights.append(paragraph_line_height(paragraph, size))
    content_height = sum(heights)
    usable_height = max(0.0, shape_h - mt - mb)
    y_offset = mt + anchor_offset(anchor, min(content_height, usable_height), usable_height)

    cursor_y = y_offset
    for paragraph, height in zip(paragraphs, heights):
        text = "".join(run.text for run in paragraph.runs)
        if not text.strip():
            cursor_y += height
            continue
        runs = [run for run in paragraph.runs if run.text.strip()]
        if not runs:
            cursor_y += height
            continue
        if len(runs) > 1 and diagnostics is not None:
            style_keys = {
                (
                    run_font_name(run, minor_font),
                    round(pt_to_px(run.font.size, first_size), 3),
                    bool(run.font.bold),
                    bool(run.font.italic),
                    color_hex(run.font.color, theme_colors) if run.font.color and run.font.color.type is not None else None,
                )
                for run in runs
            }
            if len(style_keys) > 1:
                diagnostics.append({
                    "slide": slide_index,
                    "shapeId": shape.shape_id,
                    "code": "rich-text-approximated",
                    "message": "Paragraph contains mixed run styles; editable compatibility output uses the first run style.",
                })
        first = runs[0]
        font_size = pt_to_px(first.font.size, first_size)
        family = run_font_name(first, minor_font)
        bold = bool(first.font.bold)
        italic = bool(first.font.italic)
        fill = color_hex(first.font.color, theme_colors) if first.font.color and first.font.color.type is not None else None
        opacity = color_opacity(first.font.color, theme_colors)
        if not fill:
            fill = color_hex(paragraph.font.color, theme_colors)
            opacity = color_opacity(paragraph.font.color, theme_colors)
        if not fill:
            fill = "#000000"
        spacing = run_letter_spacing(first)
        align = text_anchor(paragraph.alignment)
        # Baseline: top + y_offset + ascent approximation (0.85em for CJK/Latin mix).
        baseline = shape_top + cursor_y + font_size * 0.85
        if align == "middle":
            x = shape_left + (shape_w - ml - mr) / 2.0 + ml
        elif align == "end":
            x = shape_left + shape_w - mr
        else:
            x = shape_left + ml
        attrs = [
            f'x="{fmt(x)}"',
            f'y="{fmt(baseline)}"',
            f'font-family="{esc(family)}"',
            f'font-size="{fmt(font_size)}"',
            f'fill="{fill}"',
            f'fill-opacity="{fmt(opacity)}"',
            f'text-anchor="{align}"',
        ]
        if bold:
            attrs.append('font-weight="700"')
        if italic:
            attrs.append('font-style="italic"')
        if spacing:
            attrs.append(f'letter-spacing="{fmt(spacing)}"')
        out.append(f"<text {' '.join(attrs)}>{esc(text)}</text>")
        cursor_y += height


def group_child_context(shape: Any, abs_left: float, abs_top: float,
                        abs_w: float, abs_h: float) -> dict[str, float]:
    ctx: dict[str, float] = {
        "offsetX": abs_left,
        "offsetY": abs_top,
        "scaleX": 1.0,
        "scaleY": 1.0,
        "chOffX": 0.0,
        "chOffY": 0.0,
    }
    try:
        element = shape._element
        grp_sp_pr = element.find("{http://schemas.openxmlformats.org/presentationml/2006/main}grpSpPr")
        xfrm = grp_sp_pr.find(f"{{{XML_NS_A}}}xfrm") if grp_sp_pr is not None else None
        if xfrm is None:
            return ctx
        ch_off = xfrm.find(f"{{{XML_NS_A}}}chOff")
        ch_ext = xfrm.find(f"{{{XML_NS_A}}}chExt")

        def num(node: Any, attr: str) -> float:
            if node is None or node.get(attr) is None:
                return 0.0
            try:
                return float(node.get(attr))
            except (TypeError, ValueError):
                return 0.0

        ch_w = num(ch_ext, "cx")
        ch_h = num(ch_ext, "cy")
        if ch_w > 0 and ch_h > 0 and abs_w > 0 and abs_h > 0:
            ctx["scaleX"] = abs_w / (ch_w / EMU_PER_PX)
            ctx["scaleY"] = abs_h / (ch_h / EMU_PER_PX)
        ctx["chOffX"] = num(ch_off, "x") / EMU_PER_PX
        ctx["chOffY"] = num(ch_off, "y") / EMU_PER_PX
    except Exception:
        pass
    return ctx


TOP_LEVEL_CTX: dict[str, float] = {
    "offsetX": 0.0,
    "offsetY": 0.0,
    "scaleX": 1.0,
    "scaleY": 1.0,
    "chOffX": 0.0,
    "chOffY": 0.0,
}


def shape_to_svg(shape: Any, ctx: dict[str, float],
                 theme_colors: dict[str, str], minor_font: str,
                 media_dir: Path, out: list[str], slide_index: int = 1,
                 defs: Optional[list[str]] = None,
                 diagnostics: Optional[list[dict[str, Any]]] = None) -> None:
    if defs is None:
        defs = []
    if diagnostics is None:
        diagnostics = []

    def diagnose(code: str, message: str) -> None:
        diagnostics.append({"slide": slide_index, "shapeId": shape.shape_id,
                            "code": code, "message": message})

    try:
        shape_type = shape.shape_type
    except Exception:
        shape_type = None

    # Group children are in the group's chOff/chExt coordinate system. An SVG
    # group transform below preserves nested scale, rotation, and reflection.
    left = px(shape.left)
    top = px(shape.top)
    width = max(0.0, px(shape.width))
    height = max(0.0, px(shape.height))
    rotation = 0.0
    try:
        rotation = float(shape.rotation or 0.0)
    except Exception:
        rotation = 0.0

    try:
        fill_attrs = shape_fill(shape, theme_colors, defs,
                                f"s{slide_index}_shape{shape.shape_id}_")
    except (ValueError, TypeError, AttributeError) as exc:
        fill_attrs = {}
        diagnose("unsupported-fill", str(exc))
    fill = fill_attrs.get("fill")
    stroke, stroke_width, stroke_opacity = shape_stroke(shape, theme_colors)

    transform = ""
    if rotation:
        cx = left + width / 2.0
        cy = top + height / 2.0
        transform = f' transform="rotate({fmt(rotation)} {fmt(cx)} {fmt(cy)})"'

    common = (
        f'x="{fmt(left)}" y="{fmt(top)}" width="{fmt(max(width, 0.1))}" '
        f'height="{fmt(max(height, 0.1))}"'
    )
    style = [f'{key}="{esc(value)}"' for key, value in fill_attrs.items()]
    if not fill:
        style.append('fill="none"')
    if stroke:
        style.append(f'stroke="{stroke}"')
        style.append(f'stroke-width="{fmt(stroke_width if stroke_width is not None else 1.0)}"')
        style.append(f'stroke-opacity="{fmt(stroke_opacity)}"')
    else:
        style.append('stroke="none"')

    if shape_type == MSO_SHAPE_TYPE.GROUP:
        child_ctx = group_child_context(shape, left, top, width, height)
        xfrm = shape._element.find(f".//{{{XML_NS_A}}}xfrm")
        flip_x = -1 if xfrm is not None and xfrm.get("flipH") in ("1", "true") else 1
        flip_y = -1 if xfrm is not None and xfrm.get("flipV") in ("1", "true") else 1
        group_transform = (
            f"translate({fmt(left + width / 2)} {fmt(top + height / 2)}) "
            f"rotate({fmt(rotation)}) scale({flip_x} {flip_y}) "
            f"translate({fmt(-width / 2)} {fmt(-height / 2)}) "
            f"scale({fmt(child_ctx['scaleX'])} {fmt(child_ctx['scaleY'])}) "
            f"translate({fmt(-child_ctx['chOffX'])} {fmt(-child_ctx['chOffY'])})"
        )
        out.append(f'<g transform="{group_transform}">')
        try:
            for child in shape.shapes:
                shape_to_svg(child, TOP_LEVEL_CTX, theme_colors, minor_font, media_dir,
                             out, slide_index, defs, diagnostics)
        except Exception as exc:
            diagnose("group-conversion-failed", str(exc))
        finally:
            out.append("</g>")
        return

    if shape_type == MSO_SHAPE_TYPE.PICTURE:
        try:
            image = shape.image
            ext = image.ext or "png"
            # Shape IDs are only unique within a slide. The digest also
            # prevents collisions in reused output directories.
            digest = hashlib.sha256(image.blob).hexdigest()[:16]
            filename = f"slide_{slide_index:03d}_pic_{shape.shape_id}_{digest}.{ext}"
            (media_dir / filename).write_bytes(image.blob)
            out.append(f'<image href="media/{filename}" {common}{transform}/>')
        except Exception as exc:
            diagnose("picture-conversion-failed", str(exc))
            out.append(f'<rect {common} fill="#D9D9D9" stroke="#B0B0B0" stroke-width="1"{transform}/>')
        return

    if shape_type == MSO_SHAPE_TYPE.LINE:
        out.append(
            f'<line x1="{fmt(left)}" y1="{fmt(top)}" x2="{fmt(left + width)}" '
            f'y2="{fmt(top + height)}" stroke="{stroke or "#000000"}" '
            f'stroke-width="{fmt(stroke_width if stroke_width is not None else 1.0)}" '
            f'stroke-opacity="{fmt(stroke_opacity)}"{transform}/>'
        )
        return

    # PowerPoint "line" preset (straight/arrow connectors): render a real line,
    # plus arrowheads when a tail/head end is declared.
    try:
        sp_pr = shape._element.find("{http://schemas.openxmlformats.org/presentationml/2006/main}spPr")
        prst_geom = sp_pr.find(f"{{{XML_NS_A}}}prstGeom") if sp_pr is not None else None
        prst = prst_geom.get("prst") if prst_geom is not None else None
        xfrm = sp_pr.find(f"{{{XML_NS_A}}}xfrm") if sp_pr is not None else None
        flip_h = xfrm is not None and xfrm.get("flipH") == "1"
        flip_v = xfrm is not None and xfrm.get("flipV") == "1"
        ln = sp_pr.find(f"{{{XML_NS_A}}}ln") if sp_pr is not None else None
        tail_end = ln.find(f"{{{XML_NS_A}}}tailEnd") if ln is not None else None
        head_end = ln.find(f"{{{XML_NS_A}}}headEnd") if ln is not None else None
    except Exception:
        prst = None
        flip_h = False
        flip_v = False
        tail_end = None
        head_end = None

    if prst == "line":
        # The OOXML "line" preset path runs from the bounding box's top-left
        # corner to its bottom-right corner; flipH/flipV mirror that path.
        # tailEnd is the arrow at the path's end, headEnd at its start.
        x1 = left + (width if flip_h else 0.0)
        y1 = top + (height if flip_v else 0.0)
        x2 = left + (0.0 if flip_h else width)
        y2 = top + (0.0 if flip_v else height)
        color = stroke or "#000000"
        line_width = stroke_width if stroke_width is not None else 1.0
        out.append(
            f'<line x1="{fmt(x1)}" y1="{fmt(y1)}" x2="{fmt(x2)}" y2="{fmt(y2)}" '
            f'stroke="{color}" stroke-width="{fmt(max(line_width, 0.75))}"/>'
        )

        def end_size(end: Any) -> tuple[float, float]:
            """Arrowhead width/length factors relative to line width.

            PowerPoint/DrawingML sizes are relative to the line width:
            sm = 2x, med = 3x, lg = 5x (triangle-style markers). When the
            attributes are omitted the schema default is medium.
            """
            if end is None:
                return 3.0, 3.0
            factors = {"sm": 2.0, "med": 3.0, "lg": 5.0}
            w_factor = factors.get(end.get("w") or "med", 3.0)
            len_factor = factors.get(end.get("len") or "med", 3.0)
            return w_factor, len_factor

        def arrow_head(end_x: float, end_y: float, start_x: float, start_y: float,
                       width_factor: float, length_factor: float) -> None:
            dx = end_x - start_x
            dy = end_y - start_y
            length = math.hypot(dx, dy)
            if length < 1e-6:
                return
            ux, uy = dx / length, dy / length
            px, py = -uy, ux
            size_w = max(4.0, line_width * width_factor)
            size_l = max(4.0, line_width * length_factor)
            tip_x, tip_y = end_x, end_y
            base_x = end_x - ux * size_l
            base_y = end_y - uy * size_l
            half = size_w * 0.5
            p1x = base_x + px * half
            p1y = base_y + py * half
            p2x = base_x - px * half
            p2y = base_y - py * half
            out.append(
                f'<path d="M {fmt(tip_x)} {fmt(tip_y)} L {fmt(p1x)} {fmt(p1y)} '
                f'L {fmt(p2x)} {fmt(p2y)} Z" fill="{color}" stroke="none"/>'
            )

        if tail_end is not None:
            w_factor, len_factor = end_size(tail_end)
            arrow_head(x2, y2, x1, y1, w_factor, len_factor)
        if head_end is not None:
            w_factor, len_factor = end_size(head_end)
            arrow_head(x1, y1, x2, y2, w_factor, len_factor)
        return

    if shape_type == MSO_SHAPE_TYPE.TABLE:
        diagnose("table-flattened", "Table cells are approximated as shapes and text; native table semantics are not retained.")
        try:
            table = shape.table
            row_heights = [px(row.height) for row in table.rows]
            col_widths = [px(col.width) for col in table.columns]
            for row_index, row in enumerate(table.rows):
                cell_y = top + sum(row_heights[:row_index])
                cell_x = left
                for col_index, cell in enumerate(row.cells):
                    cell_w = col_widths[col_index]
                    cell_h = row_heights[row_index]
                    out.append(
                        f'<rect x="{fmt(cell_x)}" y="{fmt(cell_y)}" '
                        f'width="{fmt(cell_w)}" height="{fmt(cell_h)}" fill="{fill or "#FFFFFF"}" '
                        f'stroke="#D1D5DB" stroke-width="1"/>'
                    )
                    emit_text(shape, cell.text_frame, cell_x, cell_y, cell_w, cell_h,
                              theme_colors, minor_font, out)
                    cell_x += cell_w
        except Exception:
            out.append(f'<rect {common} fill="{fill or "#FFFFFF"}" stroke="#D1D5DB" stroke-width="1"{transform}/>')
        return

    try:
        is_ellipse = shape.auto_shape_type is not None and "OVAL" in str(shape.auto_shape_type).upper()
    except Exception:
        is_ellipse = False
    if is_ellipse:
        out.append(
            f'<ellipse cx="{fmt(left + width / 2.0)}" cy="{fmt(top + height / 2.0)}" '
            f'rx="{fmt(width / 2.0)}" ry="{fmt(height / 2.0)}" {" ".join(style)}{transform}/>'
        )
    else:
        if prst not in (None, "rect"):
            diagnose("shape-geometry-approximated", f"Preset geometry {prst!r} is approximated as a rectangle.")
        elif sp_pr is not None and sp_pr.find(f"{{{XML_NS_A}}}custGeom") is not None:
            diagnose("shape-geometry-approximated", "Custom geometry is approximated as a rectangle.")
        if shape_type == MSO_SHAPE_TYPE.CHART:
            diagnose("chart-not-editable", "Native chart geometry and data are not supported by this compatibility importer.")
        out.append(f'<rect {common} {" ".join(style)}{transform}/>')

    # Text frame
    try:
        if shape.has_text_frame:
            emit_text(shape, shape.text_frame, left, top, width, height, theme_colors, minor_font, out,
                      diagnostics, slide_index)
    except Exception as exc:
        diagnose("text-conversion-failed", str(exc))


def convert_pptx_to_svg(pptx_path: str, output_dir: str) -> dict[str, Any]:
    output = Path(output_dir)
    svg_dir = output / "svg"
    media_dir = svg_dir / "media"
    svg_dir.mkdir(parents=True, exist_ok=True)
    media_dir.mkdir(parents=True, exist_ok=True)

    theme_colors = resolve_theme_colors(pptx_path)
    theme_fonts = resolve_theme_fonts(pptx_path)
    minor_font = theme_fonts.get("minorFont") or theme_fonts.get("majorFont") or "Arial"

    prs = Presentation(pptx_path)
    slide_w = px(prs.slide_width, 1280.0)
    slide_h = px(prs.slide_height, 720.0)

    converted = 0
    diagnostics: list[dict[str, Any]] = []
    for index, slide in enumerate(prs.slides, start=1):
        defs: list[str] = []
        out: list[str] = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(slide_w)} {fmt(slide_h)}" '
            f'width="{fmt(slide_w)}" height="{fmt(slide_h)}">'
        ]
        background_attrs = {"fill": "#FFFFFF"}
        try:
            bg_fill = shape_fill(slide.background, theme_colors, defs, f"s{index}_background_")
            if bg_fill:
                background_attrs = bg_fill
        except Exception as exc:
            diagnostics.append({"slide": index, "code": "background-conversion-failed", "message": str(exc)})
        background_style = " ".join(f'{key}="{esc(value)}"' for key, value in background_attrs.items())
        out.append(f'<rect x="0" y="0" width="{fmt(slide_w)}" height="{fmt(slide_h)}" {background_style}/>')
        for shape in slide.shapes:
            shape_to_svg(shape, TOP_LEVEL_CTX, theme_colors, minor_font, media_dir,
                         out, index, defs, diagnostics)
        if defs:
            out.insert(1, "<defs>" + "\n".join(defs) + "</defs>")
        out.append("</svg>")
        (svg_dir / f"slide_{index:02d}.svg").write_text("\n".join(out), encoding="utf-8")
        converted += 1

    report = {"slides": converted, "mediaFiles": len(list(media_dir.iterdir())),
              "diagnostics": diagnostics, "renderer": "native-compatibility",
              "originalRendering": False}
    (output / "native-import-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: pptx_native_to_svg.py <input.pptx> <output_dir>", file=sys.stderr)
        sys.exit(2)
    result = convert_pptx_to_svg(sys.argv[1], sys.argv[2])
    print(f"Converted {result['slides']} slides, {result['mediaFiles']} media files.")
