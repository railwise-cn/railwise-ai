# Model Identity and Execution Follow-Through

This archive records source checks for the commit containing this document, after `fbb88ea715571e9689cbc1c0802da08762e4318d`. It does not change the public version or certify an installed package containing the new source.

## Changes

- Provider/model identity is carried through menus, additive stored preferences, send queues, persisted Turns/Tasks, Review, UI actions and delegated calls. Missing explicit providers fail; legacy model priority remains intact.
- Survey reasoning effort survives route remounts within project-scoped session drafts. Typed approval snapshots model/provider/effort together. Internal resume identifiers preserve the original Task rather than relying on a natural-language continuation regex.
- Execution terminal states cause an authoritative overview/network/result refresh while preserving draft inputs and manual selections. Late responses cannot refresh another project or thread.
- Structured stale-plan errors and three Markdown table controls use the current locale. Legacy exact stale messages remain readable; unknown service messages are not shown verbatim.

The migration matrix and focused verification methods are in [model follow-through](../../RAILWISE_SURVEY_MODEL_FOLLOWTHROUGH.md).

## Retained Checks

| Check | Result | Scope |
| --- | --- | --- |
| Desktop full, final | 2780 passed, 2 skipped; 329 files passed, 2 skipped | Includes final terminal refresh and table translations |
| Runtime full, final | 2795 passed, 22 skipped; 181 files passed, 2 skipped | Includes all Runtime routing, resume and error-code changes |
| Desktop TypeScript | passed | Web and main process |
| Build | passed | Runtime TypeScript and Electron main/preload/renderer |
| Full ESLint | 0 errors, 1 existing warning | Workbench `setInput` Hook dependency |
| Strict OpenSpec | 11 passed | Source specifications, not acceptance approval |

The earlier desktop full run passed 2770 tests and predates terminal refresh and table translations. The first Runtime run had 2794 passed and one failed assertion: the test expected only prompt/provider but the existing request parser also supplied empty attachment/reference arrays. It overlapped the agent's final assertion correction by seconds. The unchanged parser defaults and corrected assertion subsequently passed the complete Runtime run. Both earlier logs are retained; counts are not pooled.

Independent agents reviewed routing, task identity, provider configuration handling and UI refresh scope. Local HTTP fixtures exercised actual endpoint routing without real credentials. These checks are not vendor benchmarks, professional signoff or production metrics.

The separately documented [fbb signed candidate](../railwise-convergence-fbb88ea71557/README.md) completed a real model-driven synthetic four-tool run, file checks and restart. It exposed the stale panel and localization problems fixed in this source batch; its success cannot verify the new provider/effort/refresh implementation. A new exact signed candidate is required.
