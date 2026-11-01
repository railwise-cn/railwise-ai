# Final7 installed-package HTML-code edit and DOCX readback

This is independent readback of an existing export produced by the root agent through the installed private candidate's GUI. The readback script only copies and inspects files; it does not generate the DOCX or edit the source fixture.

| Identity | Value |
|---|---|
| Product/version | RailWise AI 0.5.4, private final7 |
| Source checkpoint | `5c88bfd6de0a65e0436cb33bcc1c6528154e20dd` |
| Source inventory | `3ccf6e06d0b36e1ebe67af293c9cb302aabc9ab3412c9cfbf2ddad577c2bd7b9` |
| Installed app | `dist/railwise-0.5.4-markdown-workbench-private-final7/Applications/RailWise AI Candidate 5c88bfd6de0a.app` |
| Independently hashed ASAR | `487f5c5ff8236e9e92f4d83f4e52c87afd2e06503b72918fcb07856545cccc4a` |
| Fresh exported file | `export-stress-final7.docx`, 9,467 bytes |
| Export SHA-256 | `d2665c89c024a15223c784f3ec1142e0d3798a02ad5159c5beb85c94797e388a` |
| Saved Markdown SHA-256 | `a0f489cd9a66353a70de05e9c9c01514adbd5d2e015fcd8b2cd956ec4c7f6499` |

The root agent changed `card` to `panel` inside the fenced HTML code using the rich editor, saved, and switched to source mode. Independent byte comparison against the preserved final6 source confirms **only** `class="card"` → `class="panel"` changed; both fences, TypeScript template strings and HTML/entity literals are retained. Screenshot `../screenshots/18-final7-html-code-source.png` shows the saved source result.

Screenshot `../screenshots/19-final7-docx-success.png` and its AX snapshot show the saved document after export in this exact installed candidate. The success toast expired before that screenshot and is not visible there; the root agent observed it in the immediate CUA result. The existing fresh DOCX and the independent file readback establish the export result.

`readback-docx.py` uses Python's standard ZIP/XML libraries. XML is decoded once, without a subsequent HTML/entity decode. All **10 assertions pass**, including exact package identity and evidence copy, the single intended source change, two code paragraphs matching source character for character, unchanged TypeScript, the edited HTML class, hidden frontmatter, retained literal entities and no highlighter markup leakage. Full structured results are in `readback.json`; `export-stress.source.md` and the fresh DOCX are copied alongside it. Final5 failure and final6 passing exports remain preserved separately.

Reproduce readback from the existing GUI output with:

```sh
python3 docs/qa/evidence/railwise-0.5.4-markdown-workbench-20261101/packaged-export-final7/readback-docx.py
```

This fixture verifies the HTML-code editing/export delta and inherited code-entity fixes. Final6 basic image/table/heading DOCX and final5 HTML/PDF evidence remain labeled with their own package identities; they are not relabeled as fresh final7 exports. Live model generation, phase-two visual syntax, notarization and a real updater round trip remain outside this passed fixture. No public release is authorized.
