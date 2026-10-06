# Survey Design export fixture

`editor-vector-document.json` was generated with the current
`createDesignDocument`, `createDesignElement` and `createDesignPage` factories
from `src/shared/design-document.ts`, then validated with
`validateDesignDocumentStructure`. IDs and timestamps were fixed for repeatable
tests. It includes two differently sized pages, every supported vector type,
a signed line, multiline text, explicit paint, preset paths and a group.

Design groups store references to children with absolute geometry. The editor
bakes group movement, scaling and rotation into child coordinates and rotations;
children retain their global `zIndex`. Export must not apply a group transform
again. The fixture's group rotation checks this behavior.

Survey's safe vector export intentionally rejects raster assets, image elements,
fidelity pages and presets without verified geometry. It never substitutes blank
rectangles or drops unsupported content from a professional deliverable. Multiple
pages are stacked in one SVG, with review, scale and reference notices outside
each editable page.
