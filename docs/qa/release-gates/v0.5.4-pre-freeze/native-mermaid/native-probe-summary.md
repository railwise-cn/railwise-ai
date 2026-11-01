# RailWise AI 0.5.4 — real Electron offline Mermaid bundle probe

AI engineering review of the final raw evidence, completed 2026-11-01. Both the reviewed core IIFE and upstream UMD control completed successfully in Electron 43.1.1 / Chromium 150.0.7871.114. The final runs were executed by the root agent; this review independently checked their reports, SVG structures and PNG bytes.

## Result and scope

The reviewed bundle renders the Chinese flowchart, sequence, class and state cases correctly under the product's existing strict, offline configuration. All five core captures are byte-identical PNGs to the upstream control, with matching text and dimensions. No observed network, active-content or rendering regression appears in this probe. This is dependency-bundle regression evidence, not final ASAR, signed/notarized application, installed-package computer-use acceptance, or public release approval.

The `math-label-katex` fixture deliberately retains Mermaid `$$...$$` labels as plain SVG text under the existing `htmlLabels:false` policy, exactly as the upstream control does. Neither run emitted KaTeX nodes, MathML or foreignObject nodes. This is **not** evidence of KaTeX rendering inside Mermaid labels. Separate Markdown inline/block KaTeX functionality requires its own tests; this probe neither tests nor replaces them.

## Inputs and provenance

- Harness: `/private/tmp/railwise-054-mermaid-native-probe.cjs`; shared-policy probe: `/private/tmp/railwise-054-mermaid-policy-probe.cjs`, compiled from the actual `src/shared/write-mermaid-policy.ts` without product edits.
- Executable: `/private/tmp/railwise-release-0.5.4-20261101/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- Reviewed IIFE: `out/markdown-rendering/mermaid.js`, 3,454,991 bytes, SHA-256 `4247d8d3e825d1ff43a3cd2a54d226ce0a07545ef074c53c92d8769058c620d4`. Built from Mermaid core ESM with Mermaid 11.16.1, DOMPurify 3.4.17 and KaTeX 0.16.46. Resolved inputs and hashes are recorded by `out/markdown-rendering/mermaid-build.json`.
- Upstream control: `node_modules/mermaid/dist/mermaid.min.js`, 3,566,058 bytes, SHA-256 `18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`. Its actual embedded dependencies are DOMPurify **3.4.0** and KaTeX **0.16.45** (Mermaid 11.16.1). DOMPurify's version literal/license comment and the KaTeX version literal were independently checked.

**Raw-report metadata caveat:** the harness assigns `bundle.versions` from the controlled build metadata for both runs. Thus the upstream report's 3.4.17 / 0.16.46 fields describe root package metadata, not the UMD's embedded versions. Raw reports are preserved unchanged; the actual control versions above and in `independent-comparison.json` correct the interpretation.

## Runtime isolation and observations

Both runs used a separate nonpersistent session, `sandbox:true`, `nodeIntegration:false`, `contextIsolation:true`, `webSecurity:true`, no preload, denied permissions, cancelled protocol requests, and denied navigation/redirects/window opens. Renderer `require`, `process` and `Buffer` were undefined. The observed MathMLElement constructor was available.

The CSP denied default/network/frame/object/base/form access, allowed inline local scripts/styles needed by the isolated harness, allowed data images, and denied font loads. Product-equivalent Mermaid settings included `securityLevel:'strict'`, `htmlLabels:false`, `maxTextSize:50000`, `maxEdges:500`, `suppressErrorRendering:true`, default theme and local font names.

Both raw reports show zero requests, permission requests, navigations, window opens, CSP violations and executed active content. Permission **checks** did occur (`media`, `media`, `web-app-installation`, `geolocation`) and were denied; there were not zero checks. Every case had zero XML parser errors, active-content findings, foreignObjects and Mermaid error nodes, before and after the shared SVG policy where reported.

## Captures

| Case | CSS dimensions | PNG dimensions | PNG bytes | Control comparison |
| --- | --- | --- | --- | --- |
| Chinese flowchart | 792 × 328 | 1584 × 656 | 37,925 | identical |
| Sequence | 699 × 491 | 1398 × 982 | 44,701 | identical |
| Class | 325 × 507 | 650 × 1014 | 36,014 | identical |
| State | 225 × 609 | 450 × 1218 | 33,192 | identical |
| Math-label plain-text policy | 665 × 147 | 1330 × 294 | 26,303 | identical |

PNG dimensions are 2× the CSS dimensions due to capture device scale. Chinese labels and sequence messages were checked from actual SVG text elements. The class SVG differs by four bytes overall between runs; independent XML comparison finds only six `path` `d` attributes differ among 151 elements. Tags, text and all other attributes match, and the captured PNG SHA-256 matches exactly (`96f24c70c71e259fba6120aa35eeabf67a5fe0c2b774e3df6bc05c37ed9cfd3e`). This is a path-coordinate serialization difference with no captured visual change; no deterministic cause is asserted. All other case raw SVGs are byte-identical.

## Evidence preserved

- Core: `report.json`, five `.mmd`, five raw `.svg`, five `.sanitized.svg`, and five real Electron `capturePage` `.png` files in this directory.
- Upstream control: the same evidence in `upstream-umd-control/`.
- `independent-comparison.json` records raw-report hashes, corrected version interpretation and case comparisons.
- `attempt1/` remains intact. Its initial reported failure came from two harness assertions: extracting only the tail of aggregate SVG text (including CSS) missed earlier sequence labels, and expecting KaTeX nodes despite `htmlLabels:false`. The corrected final harness checks actual SVG text elements and the existing plain-text math-label policy. The original SVGs were also independently rechecked in `attempt1/svg-independent-check.json`. These exploratory failures were not erased or treated as product failures.
