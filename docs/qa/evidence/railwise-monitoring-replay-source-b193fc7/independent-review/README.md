# Independent Monitoring Replay Review

Read-only review of the current working diff rooted at HEAD `59d2d56c691642a585407698396b41dec65c75e0`.
Product files were not edited by this reviewer. No full test suite, build, commit, push or release operation was performed.

## Scope

- Atomic original-byte and import-context retention in an additive append-only source table.
- Fresh numerical calculation, original-source normalization comparison and stored-result comparison.
- Independent durable audit starts and atomic terminal results; failed persistence cannot return a pass.
- Current manifest/output/input checks before and after asynchronous parsing; SQL identity and revision checks.
- Unchanged legacy five-check verification and legacy audit tables.
- Renderer strict response parsing, project/manifest scope, readiness/revision invalidation and bilingual outcome presentation.
- XLSX streaming resource budget follow-up and duplicate-instant collation handling.

## Independent Probe

Run `node /private/tmp/railwise-monitoring-replay-independent-review/probe.mjs`.
The script reads the old v2 implementation from Git HEAD and the new pure implementation from the working tree, then uses transpilation in memory.

The 1,000 seeded cases compare exact serialized results against the previous implementation. They exercise mixed groups, unsorted and equivalent-offset timestamps, duplicate instants, missing/zero cumulative fields, signed values and thresholds. Frozen input arrays and rows detect mutation. This is an extraction regression check, not an independent mathematical oracle.

Six direct assertions cover the 80% warning boundary, 100% alarm boundary, strict anomaly comparison, and the strict `1e-9` trend boundary. They do not establish general engineering correctness.

`output.json` contains the actual result, runtime and timestamp. It also records six child-process locale probes showing that `LANG=LC_ALL=en-US-u-kn-true` reverses the ordering of imported ASCII IDs ending `_10` and `_2`. An ASCII ID grammar therefore cannot establish historical tie order. This finding was reported and the replay implementation was changed to return `not-evaluated/ambiguous-tie-order` for any same-group, same-instant duplicate; the original v2 calculation remains unchanged.

The follow-up resource-limit tests initially used an invalid `ZZZ` column in every fixture, which could mask failure of the ratio, expansion or entry-count guard. The implementation agent corrected this: only the column-limit case contains `ZZZ`; other cases use a valid observation worksheet. This correction was reviewed.

## Final Streaming Follow-Up

The JSZip legacy adapter cannot safely be destroyed inside its own data callback: the ongoing inflate push can emit after EOF. The implementation now pauses via backpressure, clears accumulated parser chunks and rejects the read. The reviewer read the adapter, FlateWorker and DataWorker implementation and ran a separate in-memory 4 MiB repeated-text probe. Its actual output was:

```json
{"archiveBytes":4301,"limit":860200,"receivedAtPause":868352,"receivedAfter25ms":868352,"bufferedAfterPause":3325952,"limited":true,"errors":[],"upstreamPaused":false}
```

The process exited normally with no unhandled errors, and no additional data callback ran after pause. The active pako input chunk can still finish inflating into the readable buffer; in this small probe it finished the whole entry. The 32 MiB budget therefore bounds bytes consumed for parsing, with bounded additional buffering from an in-progress inflate block, not an absolute process-memory or physical-decompression ceiling. JSZip's DataWorker feeds compressed blocks of 16 KiB. The review found no additional blocking defect in this bounded follow-up.

No packaged application, real user data, production success metric, source authenticity or professional approval is established by this review or probe.
