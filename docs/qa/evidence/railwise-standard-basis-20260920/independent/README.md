# Independent Standard Basis Review

Reviewed changes: `c8af2936cc043645eebaf9deda83aed6434721a8` and `a4a40d726de6e31d1ea9c4a5e9039717ea84a397`.

One P2 source-mapping defect was reproduced in `kun/src/engineering/survey-standard-basis.ts:67`: the unit-score entry described formulas (5)(6) but omitted clause 6.2.4.5. The old scoring trace also uses `6.2.5/formula-6/table-3`; this is historical text, not a reason to change persisted results silently.

Source verification used the already retained official GB/T 24356-2023 scanned PDF, SHA-256 `96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487`. Actual retained page images were opened and read:

- PDF page 10 / printed page 7: SHA-256 `931047761256be7fcdbb1f84bf097f4c132ec2fbaa29998c2c98f653ddfe9bba`. Clause 6.2.4.5 names unit-product scoring and introduces formula (6).
- PDF page 11 / printed page 8: SHA-256 `191d1ca762975077e2dfecbdade36b9b107e1a14fd187f38e723959074f23f84`. Formula (6) continues at the top; clause 6.2.5 then defines grading and Table 3.

The initial compiled probe exercised fourteen scoring operation/profile combinations with twenty-eight actual read-only route calls and reproduced the omission. After the parent agent added 6.2.4.5 and a historical-label explanation, the extended probe covered those fourteen combinations plus both sampling modes. The final result records the exact source hashes because the source correction was in progress during review. The original source revision and the patched snapshot must not be treated as identical.

The independent probes compile production modules with esbuild. An in-process real Runtime Router is connected through the actual desktop IPC request schema, renderer client and shared contracts. Only the transport shim and test identity are synthetic. They check source-document hashes, retained reviewed page mappings, exact identities, strict query rejection, auth-before-query behavior, no write routes, digest agreement, score/input immutability, and source/profile/algorithm substitutions. The DOM probe uses the actual component and real catalog/detail routes, covering lazy loading, official PDF links, offline clearing, closed/changed-context late responses, unsupported versions and missing identity.

No additional P1/P2 defect was found in that scope. GUI pixels, packaged Electron integration, real browser PDF retrieval and professional acceptance were not checked. Self-consistent local hashes do not constitute an external signature or standard-conformity authentication.

Reproduction with project dependencies installed:

```sh
node build.mjs /path/to/repository
node probe.mjs /path/to/repository
node dom-probe.mjs /path/to/repository
node run-and-record.mjs /path/to/repository
```

When running outside the repository, make its installed packages available to the probe directory (for example, a temporary `node_modules` symlink). Keep generated `compiled.mjs`, `compiled-dom.mjs` and that symlink out of the public evidence archive. Archive only these source probes, this README and `independent-result.json`; they contain no machine-specific paths or user data.

Initial probe harness attempts failed on Node 26 read-only global properties, an overly strict parent-clause lookup, and bundling the CommonJS lucide package with external React. These harness-only issues were corrected before the successful runs; no product behavior was changed to satisfy the probes.
