# WorkWise MarkItDown sidecar

This helper embeds the audited Microsoft MarkItDown `v0.1.9` snapshot
(`21d9c1d01ecc12538dab19811fd247ef2f96ef60`) with only PDF, DOCX, PPTX, and
XLSX extras. It uses `convert_local`, disables plugins, accepts one JSON request
on stdin, and rejects paths outside the selected workspace.

The same frozen helper also carries the audited PPT Master `v4.3.0` scripts
needed by Design for preset shapes and native PPTX import/export. Those
operations use an explicit local-only protocol and accept only paths contained
by the temporary operation root; a clean WorkWise installation never depends
on a system Python interpreter.

`markitdown-ocr` is intentionally not included. OCR and complex layout parsing
are delegated to the optional MinerU integration.
