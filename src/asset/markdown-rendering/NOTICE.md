# Local Markdown rendering components

RailWise AI implements its own document workbench. It does not include OpenKnowledge source code or its runtime.

The workbench uses the following MIT-licensed libraries for local document rendering:

| Component | Version | Purpose | License |
| --- | --- | --- | --- |
| KaTeX | 0.16.46 | Local mathematical notation and bundled fonts | KaTeX-LICENSE.txt |
| Mermaid | 11.16.1 | Local diagram layout and SVG rendering | Mermaid-LICENSE.txt |
| markdown-it-footnote | 4.0.0 | Markdown footnote parsing | markdown-it-footnote-LICENSE.txt |

The original notices accompany this file. KaTeX and Mermaid were already present as transitive dependencies; they are now explicit, pinned document-rendering dependencies. No CDN or remote rendering service is required.
