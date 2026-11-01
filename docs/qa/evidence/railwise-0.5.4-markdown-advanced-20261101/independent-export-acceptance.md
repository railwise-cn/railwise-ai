# Independent AI export acceptance

Reviewed actual synthetic advanced Markdown exports from `/private/tmp/railwise-advanced-export-smoke-20261101`. SHA-256 values and structural checks are preserved in `independent-export-readback.json`.

- HTML: three MathML equations with KaTeX visuals, inline Mermaid SVG with Chinese labels, working forward/back footnote anchors. No external asset/font URLs or script elements.
- PDF: actual one-page PDF rendered with Poppler and visually inspected. Fraction, square root, sum, matrix, flowchart arrows/Chinese labels, numbered footnote and superscript all visible without clipping or overlap. Screenshot: `independent-export-pdf-page-1.png`.
- DOCX: two native body OMML equations including fraction, square root, sum scripts and three matrices; one real Word footnote with bold text and native math; one embedded PNG exactly matching the generated Mermaid diagram. All footnote references resolve. No external document relationships.

Scope limits: DOCX structure was inspected; Word/LibreOffice visual rendering was not performed in this independent check. This evidence is a synthetic export service acceptance, not final packaged GUI acceptance or an assertion of professional/vendor certification.
