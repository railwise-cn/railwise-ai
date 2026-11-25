# 第三方组件声明 / Third-party notices

以下组件只用于本计划明确列出的本地文档能力。发布构建会生成依赖 SBOM，并阻断未经批准的 AGPL、Affero 或非商业依赖进入客户端。

## Microsoft MarkItDown

WorkWise includes a locally packaged helper built from Microsoft MarkItDown
v0.1.9, commit `21d9c1d01ecc12538dab19811fd247ef2f96ef60`. MarkItDown is distributed
under the MIT License. WorkWise enables only the PDF, DOCX, PPTX, and XLSX
format extras and does not distribute the `markitdown-ocr` plugin.

Source: https://github.com/microsoft/markitdown

## Mozilla PDF.js

WorkWise includes PDF.js (`pdfjs-dist` 6.5.438) for bounded local PDF page
inspection, text search, page mapping, and safe preview rendering. PDF.js is
distributed under the Apache License 2.0.

Source: https://github.com/mozilla/pdf.js

## React Flow

WorkWise Flow uses `@xyflow/react` 12.9.2 for its controlled node canvas,
typed handles, keyboard interaction, selection, zoom, and minimap. React Flow
is distributed under the MIT License. It is a renderer component only and does
not introduce a second WorkWise Runtime or execution framework.

Source: https://github.com/xyflow/xyflow

## MinerU

MinerU is not bundled with WorkWise. Users may optionally install a locked
MinerU 3.4.x local engine or configure an authorized private deployment.
WorkWise identifies document parsing output produced by MinerU in the UI.
MinerU uses the MinerU Open Source License, which is based on Apache 2.0 with
additional conditions; it must not be described as plain Apache 2.0.

Audited 3.4 baseline: `mineru-3.4.4-released`, commit
`0dfc9460cd9ab693b9af60ae3fbffd7bc111b062`.

Source and license: https://github.com/opendatalab/MinerU
