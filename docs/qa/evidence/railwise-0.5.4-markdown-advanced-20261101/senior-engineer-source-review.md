# Advanced Markdown source review — AI review

Reviewed on 2026-11-01 by an independent Codex agent. This is a source/security review of the in-progress 0.5.4 private candidate, not package acceptance or a human approval. Final source SHA and packaged UI acceptance remain separate gates.

## Findings and disposition

1. **P2 — No-rule fractions gained a bar in DOCX.** `write-math-omml.ts` initially converted every MathML `mfrac` into a default Office fraction. KaTeX emits `linethickness="0px"` for `\\binom`, `\\atop` and zero-rule `\\genfrac`. Reported before freeze; implementation now emits `m:fPr/m:type=noBar` and an actual DOCX XML regression was added.
2. **P2 — Unsupported MathML layout could silently flatten or misalign formulas.** `cases` and `aligned` use left/right table columns, and a one-sided stretchy brace; `\\overset{!}{=}` uses a child-bearing `mo` containing a `mover`. The initial converter centered every matrix and flattened the latter to `=!`. Ignored style and spacing attributes also changed the visual result. **Resolved:** noncenter tables, one-sided fences, compound token elements, explicit spacing, styling and unsupported fraction rules now return the locally rendered image fallback. Actual DOCX regressions verify image use for five previously unmapped cases. Editable supported expressions remain OMML.

No active-content, external-request, stale-result overwrite, or Markdown-retention blocker was found in the reviewed advanced preview paths. The SVG sanitizer preserves safe CSS for diagram styling; installed preview images have a separate SVG image document, so that CSS cannot style the workbench. Export currently embeds sanitized SVG inline and relies additionally on Mermaid's generated selector scoping and strict configuration; this is not treated as a general-purpose untrusted SVG import endpoint.

## Reviewed boundaries

- Shared Markdown parser: raw HTML disabled; inline/display TeX, named/inline/repeated footnotes, fenced Mermaid and tasks share the same grammar. KaTeX trust is false, macros are local, expression length/expansion/size are bounded.
- Mermaid source policy and SVG output: configuration/HTML/click callbacks/network/image syntax rejected; XML entities/DTDs and active SVG elements removed; only local marker references survive.
- Rich projection: advanced and unsupported blocks retain their exact original source bytes. Advanced edits check active file, full baseline and expected block bytes before applying.
- Preview/live projection: delayed diagram/image responses install only into their original surviving placeholder. Sanitized SVG is displayed as an image, with no Node or live app DOM embedded in the diagram.
- Preview IPC: strict size-bounded request schema; no caller-selected URL/file/script; identical pending work deduplicated; rendering serialized; bounded in-memory cache stores no document files.
- Main diagram/math renderer: separate temporary session; sandbox, no Node, context isolation, permission/popup/navigation denials, network request cancellation and CSP. Diagram count/source/edge/render time/dimensions bounded. Bundled Mermaid and KaTeX assets are read offline.
- HTML/PDF/DOCX: source fallbacks remain visible for invalid syntax; local images use canonical workspace containment and reject links; HTML has no CDN/base URL and includes font data; PDF uses isolated session and network/permission/navigation denials; Word footnotes are actual repeated `w:footnoteReference` entries.
- AI review application: full source baseline, current active path and selected bytes are checked before accepting an asynchronous result.
- Packaging: exact MIT dependency pins and notices; after-pack asserts offline KaTeX/Mermaid/footnote assets and rejects dependency debug logs/reports. Formal signature/notary/native updater remain pending final frozen source.

## Verification recorded

Command:

```text
npx vitest run src/shared/write-advanced-markdown.test.ts src/renderer/src/write/write-advanced-rendering.test.ts src/renderer/src/write/tiptap/WriteRichEditor.test.ts src/main/services/write-advanced-export.test.ts src/main/services/write-advanced-renderer.test.ts src/main/services/write-mermaid-preview.test.ts src/main/ipc/write-document-ipc-schemas.test.ts
```

Final result after reviewing the MathML follow-up patch: **7 files, 50 tests passed**. These include source retention, stale diagram result disposal, actual DOCX XML/footnote structure, binomial rule fidelity, conservative visual fallbacks, invalid-source fallbacks, policy boundaries, IPC payload validation and sandbox configuration. Browser/renderer mocks in some of these tests are not represented as native rendering evidence.

Source review has **no unresolved blocker** for a private signed candidate. File hashes are recorded in `source-review-hashes.json` and must match the final inventory. A preliminary whole-inventory filename/size/token-shape scan covered 6,461 files, found no file over 25 MiB or symlink, and no confirmed secret. Initial token shapes were verified as embedded-font base64, scanner pattern literals, and `task-…` filenames; localization `settings.json` files are translations, not user configuration. Repeat against the frozen checkpoint before push.

## Remaining acceptance gates

- Freeze and inventory the isolated source checkout; review before pushing the separate private candidate branch.
- Existing private workflow: signed/notarized baseline and target; actual TLS loopback manifest/ZIP update, Squirrel install/relaunch, source/ASAR identity and isolated user-data preservation.
- Inspect the exact installed signed target in the supported themes/languages/sizes; perform the real configured-model call against that target; preserve screenshots/checklist/findings.

No public release/tag/feed/version action is approved by this document.
