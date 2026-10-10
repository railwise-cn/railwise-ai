# Installed plan binding-default defect

Private freeze 38070443344 attempt 1, source `4517bc06082258ec1a657163f2cba7a20db288a6`, installed RailWise AI 0.5.3 ASAR `fcea9d600f9e19deeea2e7aa2baf2a12e5a1ef9ad60385f97d2d13e64a13d9bb` is blocked from release.

The actual unaided GSI consultation produced unreviewable plans. An independent AI review then imported the exact installed compiler only for pure in-memory compilation. Both the advertised tool schema and installed typed schema accept binding-only steps with optional `parameters` omitted. For a reimport → validate → calculate → report declaration, omitting that object caused old-network literals and duplicate revision bindings to be added despite explicit predecessor bindings. The explicit-empty-object control compiled without those diagnostics.

The fix leaves declared bindings intact and supplies defaults only for parameters without a binding. It retains malformed caller bindings, duplicate bindings and literal/binding conflicts for the existing approval diagnostics to reject. Tests exercise resolved new-network handles, selected monitoring predecessors and the negative cases.

Original model argument bytes were deliberately omitted from persistence. This reproduction proves the compiler defect and matches the first normalized plan, but does not claim to reconstruct unavailable model arguments or explain every model response. The original request later aborted without approval or delivery; automatic task recovery is a separate turn and cannot erase that failure.

The attached JSON files preserve the original diagnostic bytes, with checksums in `original-bytes-manifest.json`. They document an installed-package failure and AI review, not a release pass, professional certification, licensed vendor interoperability, or human signoff. Source tests and CI will not close acceptance: the corrected final package must be freshly built, installed and exercised under the existing contract.
