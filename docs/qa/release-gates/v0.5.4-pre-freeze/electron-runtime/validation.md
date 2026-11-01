# Electron runtime security correction before source freeze

Electron is shipped as the desktop/sidecar runtime despite its npm devDependency label. A final full audit identified 12 Electron advisories in 43.1.1, including the certificate mitigation requiring >=43.8.1. Updated only the root Electron requirement to ^43.8.6 and its exact locked official package/integrity. The public application version remains 0.5.4.

The refreshed complete npm audit has no Electron entry. Its remaining 33 aggregate findings (9 high, 21 moderate, 3 low) include build/test tools and the small local OpenClaw compatibility shim identity match; the independent review documents those boundaries. The shipped KaTeX low-severity issue remains disclosed. Production-only audit is insufficient for Electron and embedded rendering assets; final ASAR/native-runtime verification remains required.

| Old item | New status | Reason | Data preservation | User action |
| --- | --- | --- | --- | --- |
| Electron 43.1.1 desktop/Node host | Exact lock 43.8.6, same major | Runtime security fixes | No plugin, credential reference, configuration, workspace or history removal or reset | Normal application update after final package acceptance |

Owner-run existing installer tests: 3 passed. Root web/main typechecking passed. Independent source review found no unresolved source blocker, but does not replace the final packaged binary, signature/notarization, UI, model TLS/streaming, all-platform SQLite and official-baseline native updater gates. Earlier 43.1.1 renderer probes are retained as historical regression references, not 43.8.6 or final package evidence.

Official runtime acquisition and native rendering are in progress at this evidence commit; retain later results separately without rewriting old reports. Full required CI will run on this exact correction.
