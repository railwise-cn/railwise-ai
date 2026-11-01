# RailWise AI 0.5.4 — independent AI Mermaid security review

Review date: 2026-11-01. Reviewed checkout: `/private/tmp/railwise-release-0.5.4-20261101`. This is an independent AI source/security review using the `code-review` skill. It is not a human approval, professional signoff, or final installed-package acceptance. The exact reviewed file hashes and source HEAD are recorded in `embedded-mermaid-review-evidence.json` beside this report.

## Decision

The new offline Mermaid build addresses the sanitizer-copy problem at its actual execution boundary. No unresolved blocking source defect was found in the reviewed change after the implementation corrected the initial test fixtures, build entry points, and DOMPurify notices. Final ASAR inspection and actual Electron rendering of this precise bundle remain required before package acceptance. Do not describe this result as “zero vulnerabilities”: KaTeX 0.16.46 retains a documented low-severity advisory.

## Actual asset and provenance

The previous consumer read `node_modules/mermaid/dist/mermaid.min.js`. That upstream browser bundle independently embedded DOMPurify 3.4.0 and KaTeX 0.16.45; changing the npm root DOMPurify override could not patch those embedded copies.

The new builder starts from `mermaid/dist/mermaid.core.mjs`, uses esbuild to produce a single browser IIFE, rejects external imports, rejects legacy Mermaid browser bundles and nested DOMPurify/KaTeX resolution, and checks the actual installed package versions. The independently generated artifact has:

| Field | Verified value |
| --- | --- |
| Mermaid | 11.16.1 |
| DOMPurify input | root `node_modules/dompurify/dist/purify.es.mjs`, 3.4.17 |
| KaTeX input | root `node_modules/katex/dist/katex.mjs`, 0.16.46 |
| Bundle size | 3,454,991 bytes |
| Bundle SHA-256 | `4247d8d3e825d1ff43a3cd2a54d226ce0a07545ef074c53c92d8769058c620d4` |
| Metafile inputs | 2,040; all recorded on-disk input hashes independently matched |

The bundle preserves a DOMPurify 3.4.17 license banner and contains no old DOMPurify 3.4.0 banner. `write-advanced-renderer.ts` now reads `out/markdown-rendering/mermaid.js`. Build, dev, and postinstall generate the asset. Build freshness requires both the script and its provenance record and includes package/lock/build-script inputs. Electron Builder excludes upstream `**/node_modules/mermaid/dist/**/*`; after-pack verification requires the new assets, verifies script hash/size/versions/input provenance, and rejects remaining upstream Mermaid dist assets in ASAR.

The hash record is a build receipt bound to the packaged script, not a separately authenticated attestation. It relies on the reviewed build script and source checkout; final package signing and source-commit identity still need their own checks.

## Advisory assessment

The advisory pages were re-read directly from GitHub Advisory Database on the review date.

| Advisory | Current assessment |
| --- | --- |
| [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), DOMPurify Critical | Actual new input 3.4.17 is patched. Independently, the reviewed Mermaid path does not enable SAFE_FOR_TEMPLATES or DOM-returning/IN_PLACE modes and does not feed downstream template evaluation. The exact advisory affected range begins at 3.4.4, so do not claim the previous embedded 3.4.0 fell within this particular range. |
| [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr), DOMPurify High | Actual new input 3.4.17 is patched. Reviewed calls pass strings and do not enable IN_PLACE. Mermaid's hooks only preserve anchor target/rel attributes; they do not remove parent/sibling nodes. |
| [GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f), DOMPurify Low | Actual new input 3.4.17 is patched. No application/xhtml+xml parser option is used, and the application SVG whitelist rejects animate/set elements. |
| [GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2), DOMPurify Low | Actual new input 3.4.17 is newer than patched 3.4.16. No IN_PLACE Node-input path exists in the reviewed Mermaid calls. |
| [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7), KaTeX Low | **Residual advisory remains**: 0.16.46 is within the affected range, patched at 0.18.2. Exploitation requires pre-existing prototype pollution or attacker control of the renderer options prototype, then insertion without a separate sanitizer. RailWise's direct math options explicitly set trust:false, bound expansion/size, and use a fresh macros object. Mermaid's internal KaTeX call does not explicitly set trust, but its SVG output is subsequently sanitized by DOMPurify and the application SVG whitelist. This is defense in depth, not a KaTeX version fix. |

## Other embedded dependencies and scope limits

The core ESM distribution is not an entirely unbundled source tree. A Mermaid core chunk embeds js-yaml 4.1.1, and parser chunks contain bundled Lodash code. Therefore the npm root overrides do not cover every internally precompiled dependency. This review does not claim otherwise.

The embedded js-yaml consumers were traced: document frontmatter, flowchart node metadata, sequence actor metadata, and kanban shape metadata all call `load(..., { schema: JSON_SCHEMA })`. RailWise's source policy rejects frontmatter delimiters and `@{` metadata. Independent execution of that exact embedded loader confirmed that JSON_SCHEMA treats `<<` as a literal key and rejects `!!omap`. The merge/omap CPU-consumption prerequisites described by [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj), [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m), and [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) are consequently not enabled in the reviewed path. That embedded version should still remain visible in future inventory/security reviews.

## Isolation and output policy

The diagram service uses a unique sandboxed, nonpersistent Chromium session, no Node integration, context isolation, web security, denied permissions/popups/navigation/redirects, a network-deny handler, CSP, source-length/line/diagram limits, render deadlines, and image dimension bounds. Initialization explicitly selects strict security and disables HTML labels.

Before output leaves the renderer, the application parses SVG as XML, rejects DTD/entities/malformed documents, and keeps a narrow tag/attribute allowlist. Event attributes, foreignObject, external images/URLs, active links, CSS imports and nonlocal CSS url() references do not survive. Preview additionally uses a data SVG image rather than inserting diagram nodes into the workbench DOM; export sanitizes supplied SVG again. These controls reduce impact and do not substitute for patching the sanitizer dependency.

## License review

The 63 resolved input packages have permissive license metadata (MIT, ISC, BSD-3-Clause, Unlicense, or DOMPurify's Apache-2.0 alternative). Khroma 2.1.0 omits a package.json license field, but its `license` file and readme identify MIT with the original copyright holders. The inventory is saved as `mermaid-bundle-license-inventory.json` beside this report. No GPL/AGPL dependency was identified in this input inventory.

DOMPurify's full Apache license copy is present in `src/asset/markdown-rendering/DOMPurify-LICENSE.txt`; NOTICE identifies the chosen alternative, and both source license policy and after-pack notice verification require it. esbuild preserves available legal comments in the generated script. Original dependency license files remain part of the dependency packaging policy. Final ASAR/license presence still must be checked on the frozen package.

## Independent verification performed

- Ran the real builder successfully and independently matched all recorded input hashes and the final script hash.
- Executed six build/provenance/ASAR regression tests: all passed. They exercise actual bundle initialization/API presence, reject legacy/nested sanitizer inputs, reject script mutation, reject old upstream Mermaid dist assets, and reject a missing local math font.
- Ran 28 targeted advanced Markdown, Mermaid preview, renderer-isolation, and HTML/DOCX semantics tests in five Vitest files: all passed.
- Ran `verify-document-dependencies.mjs`: passed.
- Executed the embedded YAML loader with JSON_SCHEMA to verify merge handling and rejection of omap: passed.

The VM/API test is not a real Chromium layout/render test, and the mock BrowserWindow tests are not installed-package acceptance. The final frozen package must demonstrate actual Mermaid layout, sanitized SVG/PNG output, preview IPC, export behavior, exclusion of old upstream assets, and the same verified bundle hash before release acceptance can be closed.
