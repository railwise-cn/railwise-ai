---
name: design
description: >
  RailWise AI Design 画板编辑与导出能力。用户在 Design 工作区修改当前画板、
  使用预设形状或导出 PowerPoint 时使用。
---

# Design Skill

This skill operates on the active RailWise AI Design document. Canvas edits must
use the renderer-scoped command bridge; do not create disconnected SVG/HTML
files as a substitute for changing the open canvas.

## Available Tools

### design_apply_canvas_commands

Apply one atomic operation batch to the active Design page.

**Parameters:**
- `document_id`, `page_id`, `expected_revision`: copy exactly from the active-canvas context
- `idempotency_key`: use the exact key supplied in the active-canvas request
- `operations`: 1–64 ordered `add`, `update`, `remove`, `group` or `ungroup` operations

Call this tool exactly once for a visual change. The operation batch is
validated against the active workspace, document, page and revision before
the renderer applies it.

### design_export_pptx

Export a validated SVG source or a directory of SVG pages as an editable PPTX.

**Parameters:**
- `source_path` (required): Path to .svg file or directory
- `output_path` (optional): Path for output .pptx

### design_list_presets

List available DrawingML preset shape names (187 presets).

**Parameters:**
- `search` (optional): Substring to filter

## Guidelines

- Put paint fields directly on each element: `fill`, `stroke`, `stroke_width`, `opacity`.
  A nested `style` object is accepted for compatibility, but top-level fields are preferred.
- Colors may be 6-digit hex with or without `#` (e.g. `0D9488` or `#0D9488`);
  use the literal `none` when a path should have no fill.
- Every added visual element must have a visible `fill` or `stroke`; paths made from
  open line segments should normally use `fill: none`, `stroke`, and `stroke_width`.
- Preserve user-requested colors in the first and only operation batch. Never replace
  a requested palette with a default color.
- All coordinates are in pixels, origin at top-left, Y pointing down
- For text shapes, always provide the `text` parameter
- Export to PPTX only when the user explicitly asks for PowerPoint format
- Do not expose internal paths, document ids or command arguments in the final reply
- A successful canvas edit is acknowledged by the renderer; a queued command is not complete until that acknowledgement arrives
- SVG export sources must have a valid `<svg>` structure and closing tag
