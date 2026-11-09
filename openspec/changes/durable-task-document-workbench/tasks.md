## 1. Task identity and input

- [x] 1.1 Persist execution sessions/attempts and preserve root/retry/origin mappings.
- [x] 1.2 Route status, supplement, new and chat before Turn creation; wire the real chat entry.
- [x] 1.3 Isolate durable input delivery and atomically ACK checkpoint consumption after transcript flush.
- [x] 1.4 Verify pause/late-answer/idempotency and multi-worker delivery through runtime assembly.

## 2. Reliable execution

- [x] 2.1 Bind immutable attempt fencing and process fingerprints to state/tool/artifact operations.
- [x] 2.2 Reconcile general tool receipts and unknown side effects without blind replay.
- [x] 2.3 Persist Shell identity/output/cancellation and verify live processes/PID reuse.
- [x] 2.4 Share capacity and root budgets; preserve old wall-clock and new execution-budget semantics.

## 3. Sources and context

- [x] 3.1 Commit webhook nonce/event/outbox and schedule occurrence/advance/outbox atomically.
- [x] 3.2 Recover pinned-version Flow dispatch and cross-database delivery idempotently.
- [x] 3.3 Connect shared-transaction context repository, subscriptions, spill and production hooks.
- [x] 3.4 Persist scoped child assignments/handoffs and mark changed-source dependencies stale.

## 4. Product and document delivery

- [x] 4.1 Add aggregate durable task stream and fixed-query pagination/count snapshots.
- [x] 4.2 Bridge task SSE and share live state between task workspace and chat summary.
- [x] 4.3 Show source/baseline/diff and accept/reject candidates with durable conflict-safe receipts/history.
- [x] 4.4 Deduplicate new-attention/verified-artifact notifications and deep-link to task details.
- [x] 4.5 Exercise the three document templates through the actual runtime/file/export services.

## 5. Public branding and publication

- [x] 5.1 Centralize branded artifact naming and generate a source-linked publication manifest.
- [x] 5.2 Wire packaging, collection, feeds, checks, GitHub/R2/website and recovery to publication data.
- [x] 5.3 Serve canonical railwise-ai downloads with legacy workwise update compatibility.
- [x] 5.4 Fix visible default names, prompts, new export metadata and diagnostic filenames.
- [x] 5.5 Expand brand regression checks with explicit data/identity/history/license exceptions.

## 6. Migration and acceptance

- [x] 6.1 Document actual compatibility/migration behavior and backed-up state, including old userData roots.
- [ ] 6.2 Run focused fault/integration tests, typechecks, required CI and production build.
- [x] 6.3 Record fixed synthetic scenarios and actual configured-model results without invented metrics.
- [ ] 6.4 Install the exact package; verify identity/signature/notarization and primary Chinese UI.
- [ ] 6.5 Run one real 0.5.4-to-exact-package updater smoke for renamed artifact delivery.
