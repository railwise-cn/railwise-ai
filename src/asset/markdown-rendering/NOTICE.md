# Local Markdown rendering components

RailWise AI implements its own document workbench. It does not include OpenKnowledge source code or its runtime.

The workbench uses the following open-source libraries for local document rendering:

| Component | Version | Purpose | License |
| --- | --- | --- | --- |
| KaTeX | 0.16.46 | Local mathematical notation and bundled fonts | KaTeX-LICENSE.txt |
| Mermaid | 11.16.1 | Local diagram layout and SVG rendering | Mermaid-LICENSE.txt |
| DOMPurify | 3.4.17 | Sanitizer used by the core ESM-derived offline Mermaid bundle | DOMPurify-LICENSE.txt (Apache-2.0 alternative) |
| markdown-it-footnote | 4.0.0 | Markdown footnote parsing | markdown-it-footnote-LICENSE.txt |

The original notices accompany this file. KaTeX and Mermaid were already present as transitive dependencies; they are now explicit, pinned document-rendering dependencies. No CDN or remote rendering service is required.

The offline Mermaid browser script is built from `mermaid.core.mjs` against the reviewed root dependencies; upstream prebundled browser files are excluded. Generated provenance records input hashes and the resulting script hash. KaTeX remains 0.16.46 and retains the documented low-severity prototype-pollution prerequisite; this list is not a zero-advisory claim.
