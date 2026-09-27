# Declared quality scoring Runtime and renderer integration review

Independent AI code/integration review on 2026-09-20 of `/private/tmp/railwise-quality-scoring`. No unresolved blocking finding. The reviewed source and compiled service hashes are in `source-hashes.json`; all nine previously reviewed pure-kernel source/test/compiled hashes remain unchanged.

24 independent tests passed: 12 service/client and 12 happy-dom GUI. Four additional parent-supplied fixture files passed through the compiled Node Runtime service with exact raw declaration preservation and reverify. Independently reran the author's 55 service/HTTP/factory tests and 27 IPC/DOM tests: all passed. Some author DOM tests emit React act-wrapping warnings; the independent DOM tests passed without those warnings.

The four acceptance inputs retain their declared scopes and outcomes: full product score 9141/100; child veto produces nonconforming; pending and multiple-accuracy equality at 60 remain unavailable. The full score was independently checked as (80*3/10+83*2/5+90*3/10)/2 + (100+99)/2*3/10 + (98*3/10+97*7/10)/5 = 9141/100. The review harness initially had an incorrect expected fixture total; this was corrected by that independent arithmetic, with no implementation change.

## Coverage

- Real SQLite service records preserve the original UTF-8 request bytes, declaration whitespace and Unicode basis including an emoji. Renderer restore and export work with browser Buffer absent.
- Invalid UTF-8, escaped-equivalent duplicate keys, floating/exponent precision inputs and lone surrogates refuse calculation; same-key changed raw bytes conflict. No lossy numerical coercion is accepted.
- Scope/identity mismatches, skipped pagination and duplicate history identities are rejected. Separate quality endpoints, token authorization, no-store responses, exact query bounds, native IPC allowlisting and Runtime lifecycle wiring were read and the related HTTP/IPC/factory tests rerun.
- A 128-member sample uses the exact decimal score 89.999999999999999999999999 and remains grade good, without rounding up. Ten maximum-member records reopen and list within 191 work units; two further 21-unit details succeed and the third rate-limits.
- A forged exact score with result, record and storage hashes all coherently rewritten is still rejected by actual Runtime recomputation and quarantined in history. Unkeyed hashes do not provide external authenticity; the renderer verifies the server record and hashes while the Runtime performs scoring replay.
- Both languages explicitly label partial scope, partial grade and unverified declared qualification. The GUI displays fractions without coercing to Number; a 24-decimal value just below m/m0=1 remains distinguishable from the unsupported multiple-60 equality branch.
- Pending items and veto reasons remain visible with trace rows. Results retain engineeringDecision=not-evaluated, evidence/classification/priorQualification=not-verified and formalResultsModified=false. A restored height-section record now labels its actual product/profile and stage independently of the unfinished draft selector; this was an author self-review improvement and independently verified afterward.
- Native Save As payload preserves the entire exact Unicode record and calls fresh Runtime export. Delayed export never opens Save As after a project switch; delayed details are discarded after workspace, revision or Runtime availability changes.

## Reproduction and limits

With dependencies installed and `kun/dist` built:

```sh
./replay.sh /path/to/checkout
```

The evidence includes all four original fixture JSON files, source hashes, tests, compact summary and compiled results. Service tests use real temporary SQLite databases. Renderer transport and native Save As are mocked; GUI uses happy-dom, not an installed desktop application. This review is not real field-data validation, normative certification, a qualified professional's signature, packaged visual acceptance or release authorization.
