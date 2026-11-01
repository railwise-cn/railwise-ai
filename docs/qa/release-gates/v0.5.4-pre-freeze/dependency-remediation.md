# 0.5.4 Dependency Remediation

Scope: production dependencies in the desktop application and the separately locked `kun` runtime. Package manifests retain the product version `0.5.4`. No dependency migration reads, rewrites, or removes user documents, workspace data, settings, credentials, or plugin state.

| Old item | New item | Reason | Data preservation | User action |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.30.0 (desktop), 1.29.0 (`kun`) | `^1.32.0` (resolved 1.32.2) in both locks | Fixes published MCP OAuth credential-routing, session-binding, redirect, request-size, and bearer-token advisories; stays on major 1 | No persistent data format change | None |
| `axios` 1.18.1 | `^1.20.0` (resolved 1.21.0) | Fixes published prototype-pollution, redirect/SSRF, proxy, HTTP/2 and ReDoS advisories; stays on major 1 | No persistent data format change | None |
| `markdown-it` 14.2.0 | `^14.3.3` (resolved 14.3.3) | Fixes published Markdown parsing security advisories; stays on major 14 | Markdown source and serialization are unchanged | None |
| `body-parser` 2.3.0 / 2.2.2 in nested lock | 2.4.0 | Fixes compressed request trailing-byte DoS; stays on major 2 | No persistent data format change | None |
| `fast-uri` 3.1.5 / 3.1.2 | 3.1.9 | Fixes URI host-confusion and SSRF advisories | No persistent data format change | None |
| `hono` 4.13.1 / 4.12.30 | 4.13.11 | Fixes published routing and request-handling advisories; stays on major 4 | No persistent data format change | None |
| `@hono/node-server` 2.1.0 / 1.19.14 | 2.1.3 | Fixes static-path double-decoding advisory; SDK accepts major 2 and the `kun` lock pins it directly | No persistent data format change | None |
| `ip-address` 10.5.0 / 10.2.0 | 10.7.4 | Fixes published address parsing and validation advisories; stays on major 10 | No persistent data format change | None |
| `proxy-addr` 2.0.7 | 2.0.8 | Fixes critical address parsing advisory; stays on major 2 | No persistent data format change | None |
| `qs` 6.15.2 | 6.16.1 | Fixes published query parsing advisories; stays on major 6 | No persistent data format change | None |
| `follow-redirects` 1.16.0 | 1.16.2 | Fixes request header/credential exposure advisories; stays on major 1 | No persistent data format change | None |
| `js-yaml` 4.3.1 | 4.3.2 | Fixes published YAML parser advisory | YAML compatibility remains on major 4 | None |
| `dompurify` 3.4.13 / prior nested copies | 3.4.17 for package instances | Fixes DOMPurify advisories while staying on major 3. The separate core ESM-derived offline build now uses this root instance; its input hashes and script digest are recorded, and the former UMD is excluded from ASAR. See embedded-mermaid-independent-security-review.md. | No persistent data format change | None |
| `csv-parse` 6.1.0 (`kun`) | 7.0.2 | Fixes `columns` prototype replacement; upstream 7.0.0 release explicitly states no breaking changes, and the active call site uses the stable sync parse API | Imported CSV/XLSX files remain untouched; only in-memory parsing changes | None |
| `image-size` 1.2.1 under `pptxgenjs` (`kun`) | Scoped `pptxgenjs` override to `image-size` 2.0.4 | Fixes high-severity image parser denial of service. The `pptxgenjs` published CommonJS bundle has no live `image-size` import; its only `require('sizeof')` is in a commented, marked-unused helper. Preserve `pptxgenjs` 4.0.1 instead of changing major. | PPTX files and generated outputs remain user-owned and are not migrated | None |
| `zod` 4.4.3 (`kun`) | `^4.6.6` (resolved 4.6.7) | Fixes oversized constrained collection validation DoS; stays on major 4 | No persistent data format change | None |
| KaTeX 0.16.46 | Retained pending the remaining low-severity advisory review | Fixed version 0.18.2 introduces KaTeX 0.18 class prefixing, a documented breaking change for selectors. RailWise renders untrusted TeX with `trust:false`, bounded source/expansion/size, fresh empty macros, then sanitizes Mermaid SVG output; no caller-provided settings object is passed to KaTeX. The dependency remains flagged for follow-up rather than claiming a full audit pass. | Markdown math source is unchanged | None |
| Mermaid 11.16.1 | Core ESM-derived offline bundle; version retained | Latest same-major 11.17.2 still embeds DOMPurify 3.4.12 in `dist/mermaid.min.js`. Updating only the npm override would leave that older code. The application now consumes its own core ESM-derived bundle using root DOMPurify 3.4.17; packaging rejects upstream dist assets. The embedded YAML/parser inventory and residual KaTeX advisory remain disclosed. | Mermaid source blocks remain unchanged | None |

## Audit Results

| Production dependency tree | Before | After |
| --- | --- | --- |
| Desktop | 22 findings: 2 critical, 9 high, 5 moderate, 6 low | 3 low; 0 critical, high, or moderate |
| Separately locked `kun` runtime | 12 findings: 1 critical, 7 high, 4 moderate | 0 findings |

The three remaining desktop entries are one underlying low-severity advisory, [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7), on KaTeX, with `mermaid` and `streamdown` reported as dependent packages. The advisory requires pre-existing JavaScript prototype pollution; the document renderer passes its own explicit `trust:false`, strict mode, expansion and size bounds, and a fresh macro object. This reduces the applicable surface but does not repair KaTeX or make the audit clean. KaTeX 0.18.2 fixes the advisory, while 0.18.0 changes CSS class names and requires a separate rendering/selector/export review. The reviewed 0.16.46 pin is retained for this scoped remediation. No `npm audit fix --force` or unreviewed major upgrade was used.

Raw before/after reports are archived beside this matrix as `desktop-production-audit-{before,after}.json` and `kun-production-audit-{before,after}.json`. `dependency-lock-delta.json` records every resolved version change and lock-only removal. The only removed lock entry is the obsolete `queue` transitive package after `image-size` changed; no installed user plugin, MCP configuration, Skill, or user data is removed.

## Compatibility and License Review

`csv-parse` 7.0.0 was published as a major by mistake; its upstream changelog explicitly says there are no breaking changes. Version 7.0.2 repairs prototype replacement through `columns`. RailWise uses the stable `csv-parse/sync` API with array rows and fixed delimiter/size settings. Regression coverage confirms byte-exact multiline CSV anchors, explicit mapping, original-source preservation, XLSX relationship admission, and historical reference retention.

The MCP SDK 1.32.2 accepts `@hono/node-server` major 1 or 2. The explicit 2.1.3 override is therefore within the SDK dependency contract. OAuth callback state validation, cancellation, timeouts and disposal, tool-provider behavior and local HTTP tests passed against the new installed tree.

`image-size` 2.0.4 is scoped to `pptxgenjs` in `kun`. The published `pptxgenjs` 4.0.1 CommonJS bundle does not contain a live import of `image-size`; its only `require('sizeof')` appears inside a commented helper marked unused. A portable PPTX export through the actual PptxGenJS dependency passed. This is package-level generation evidence and does not claim PowerPoint/WPS interoperability acceptance.

Every changed resolved package retains a permissive license: MIT, BSD-3-Clause, or DOMPurify's dual `MPL-2.0 OR Apache-2.0` (the Apache-2.0 option is used). Exact versions, integrity values and package metadata are preserved in `dependency-license-inventory.json`. `scripts/verify-document-dependencies.mjs` passed, preserving the reviewed MIT document-renderer pins and the existing PDF/MarkItDown license boundary.

## Verification Status

- Desktop targeted regression: 5 files, 86 tests passed, including MCP OAuth and advanced Markdown/math/footnote/export paths.
- Runtime targeted regression: 6 files, 45 tests passed, including MCP local HTTP, CSV/XLSX source-bound import and PPTX generation.
- Desktop web and main-process TypeScript checks and standalone `kun` TypeScript check passed.
- Document dependency/license policy and `git diff --check` passed.
- Complete standalone runtime suite: 221 test files passed, 2 skipped; 3,209 tests passed, 22 skipped; 0 failures. Duration 41.84 seconds. Log: `/private/tmp/railwise-054-dependency-kun-full-tests.log`.
- Full desktop/build/release-gate checks are coordinated by the parent task and remain separate evidence.

Dependency-only installation used Node 22.23.1/npm 10.9.4 with lifecycle scripts disabled. Native SQLite bindings were subsequently rebuilt for Node 22 only to run the isolated tests. The existing `html2canvas-pro` engine warning (`>=24`) was present in the starting dependency tree and was not introduced by these changes; the supported Node 22 checks above passed, with packaged Chromium rendering still requiring package acceptance. An initial restricted-sandbox test attempt could not listen on loopback; unchanged local-fixture tests passed after allowing local loopback. No dependency migration reads, rewrites, or removes user data.
