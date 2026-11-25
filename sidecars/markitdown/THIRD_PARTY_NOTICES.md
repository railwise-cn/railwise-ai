# Third-party notices

This sidecar contains the following audited components. The notices are kept
next to the helper so packaging remains correct even when a downstream fork
does not retain the repository-level notice file.

## Microsoft MarkItDown

WorkWise packages Microsoft MarkItDown v0.1.9 at commit
`21d9c1d01ecc12538dab19811fd247ef2f96ef60` under the MIT License. Only the
PDF, DOCX, PPTX, and XLSX format extras are enabled; `markitdown-ocr` is not
included.

Source: https://github.com/microsoft/markitdown

## Mozilla PDF.js

WorkWise uses PDF.js (`pdfjs-dist` 6.5.438) under the Apache License 2.0 for
bounded local PDF inspection and preview rendering.

Source: https://github.com/mozilla/pdf.js

## MinerU

MinerU is not bundled in this sidecar. WorkWise may optionally use a locked
MinerU 3.4.x local engine or an authorized private deployment. MinerU uses
the MinerU Open Source License, based on Apache 2.0 with additional conditions.

Source and license: https://github.com/opendatalab/MinerU
