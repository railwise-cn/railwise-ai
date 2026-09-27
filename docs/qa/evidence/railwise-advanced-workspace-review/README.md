# Independent advanced-model workspace review

This evidence package reviews the generalized-w and restricted VCE experimental-model workspace. The reviewer inspected Runtime persistence, authenticated routes, renderer contracts and GUI components independently of their implementers. All database mutations in these probes occur in disposable directories created with `os.tmpdir()` and removed in `finally` blocks. Inputs are synthetic and generated in the scripts; no field data, credentials, saved application database or old temporary worktree is required.

## Replay

From a checkout with the repository's dependencies installed:

```sh
bash docs/qa/evidence/railwise-advanced-workspace-review/replay.sh
```

The script resolves the repository from its own location, so it also works when called by an absolute path from another directory. It uses the checked-out source and installed repository dependencies; it does not download dependencies, write application data, build or release the application. It forwards additional Vitest arguments, including a single test filename.

Required dependencies are Node.js, Vitest, happy-dom, React, React DOM, react-i18next/i18next, Zod and better-sqlite3, as declared in the repository. The native better-sqlite3 addon must match the Node executable used for replay, not an incompatible Electron ABI. The recorded run's actual versions and source hashes are in `summary.json`. No Python or Bun is required to replay.

## Coverage and repaired findings

The 25 probes cover these independently checked boundaries:

- `boundary.test.ts` — exact UTF-8 request/declaration preservation, schema-normalized VCE identifiers, exact-body retries, real close/reopen replay, project isolation, duplicate and escaped-equivalent JSON keys, malformed Unicode, seven SQL identity-column substitutions even after the outer storage hash is refreshed, a one-ULP result change even after all hashes are refreshed, runtime-environment mismatch, damaged-history isolation and hash semantics.
- `client.test.ts` — restoring an actual Runtime-created record without global `Buffer`; rejecting a substituted VCE convergence policy even after response hashes are refreshed; strict JSON preflight and typed runtime-environment failures.
- `http.test.ts` — authorization before service resolution or oversized-body parsing for all five operations; byte-exact incoming body, byte ceiling and strict query parsing. These invoke registered route handlers, not a TCP server.
- `gui-boundaries.test.ts` — English DOM restoration with global `Buffer` absent for maximum-dimension generalized-w (64 observations, 16 parameters, 64 directions, 4,096 covariance cells) and VCE (128 observations, 32 parameters, 8 groups); maximum identifier lengths; a genuinely computed 100-step VCE exhaustion trace; exact/overflow declaration and basis UTF-8 limits without input truncation; fresh export with Unicode/emoji, byte-exact Base64 round-trip and suppression of a late export after switching projects. The native save bridge is mocked; no actual file-save dialog is claimed.

Findings sent to implementers and verified after repair:

1. A corrupt SQL ID could poison an otherwise healthy history page. The backend now substitutes a bounded unavailable-slot identifier.
2. Duplicate-key JSON passed renderer preflight while the Runtime rejected it. Both now use the same browser-safe strict parser; validation errors are classified as input errors.
3. `replay_environment` was mistaken for a transient request failure. Renderer error mapping now preserves the environment incompatibility state.
4. The renderer now explicitly binds the output VCE convergence policy to the input declaration.

Final pagination charging was also reviewed: one base unit plus three units per actual returned row, with a maximum model replay charge of 20, makes a full ten-row page cost 231 of the 240-unit minute budget. Empty pages cost one unit. The reviewer inspected the implementer’s real ten-row maximum-declaration regression; it was not added to the independent 25-probe count. Rate exhaustion still propagates as a typed rate-limit failure and is not mislabeled as damaged history.

No additional blocking finding remained in the reviewed source. Synthetic maximum-size examples demonstrate schema and rendering boundaries, not representativeness of field data or measured production throughput. Test durations are not production performance promises.

## Hash and parameter semantics

`requestSha256` binds the exact HTTP request bytes. `declarationSha256` binds the exact original declaration string, including whitespace and key order. `modelBasisSha256` binds the separate caller's basis text. `modelHash` binds the recursively key-sorted, schema-normalized model; array order and parameter/observation identifiers remain meaningful. VCE identifier trimming is reflected in the normalized model while the retained source remains untouched. Reordering JSON keys or indentation leaves the normalized model and numerical output hashes unchanged; modifying an observation changes both. Changing only the separate basis statement changes its custody hash without pretending to change the numerical calculation.

`resultHash` binds the full structured algorithm result. The nested generalized-w `result.requestHash` uses the kernel's `JSON.stringify` of its schema-parsed request, rather than the workspace's sorted-key `modelHash`; the client checks each according to its own definition. `recordHash` binds the complete unsigned record, including project snapshot, model, output, declarations and replay environment. The storage hash additionally binds SQL columns and BLOB hashes. JSON numeric serialization treats `-0` as `0`; retained request/declaration bytes still preserve the submitted spelling.

These are local consistency checks, not signatures or authenticated custody. The Runtime recomputes the full result and compares canonical structures; the renderer verifies shape, byte hashes and model/output bindings and relies on the authenticated Runtime for numerical replay. No frontend numerical reimplementation or professional approval is implied.

## Limits of this review

This is source, route, native SQLite and happy-dom testing. It is not a packaged-application visual inspection, an Electron IPC/file-dialog end-to-end test, signature/notarization verification, updater round-trip, release approval or human engineering signoff. Layout at supported themes and actual window sizes remains a separate packaged acceptance activity. Model assumptions remain explicitly caller-declared and unverified.
