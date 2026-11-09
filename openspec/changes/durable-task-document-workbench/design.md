## Context

Extend the existing KUN runtime and the in-progress task-workbench branch. A passing repository unit test is not evidence that a module is connected to a real task. Runtime assembly, renderer entry points, and release consumers must all use the contracts below.

## Goals / Non-Goals

Goals: stable task identity, durable inputs and attention, safe recovery, scoped delivery, live readable task UI, and RailWise AI public artifact names.

Non-goals: cloud coordination, daemons, new event connectors, remote embedding defaults, collaboration, automatic external sending, or changing historical app/data identity.

## Decisions

1. Root TaskRun is the public identity; ExecutionSession is the stable hidden worker and an attempt binds an immutable lease epoch. Preserve legacy threadId meaning and link originThreadId explicitly.
2. POST /v1/task-commands routes before Turn creation. Status is a local snapshot; supplements enqueue; new work owns a separate execution thread. Ordinary chat creates no visible long task and never cancels another task by default.
3. SQLite input delivery is authoritative. Stable message IDs and flushed transcript positions bridge JSONL to a same-transaction checkpoint/consumption ACK. Paused tasks accept inputs without waking.
4. Lease ownership includes PID/start fingerprint; 60-second leases renew every 20 seconds. Tools and commits check immutable attempt epochs. Unknown actions reconcile before any retry. Capacity is one multi-resource allocator; costs and execution budgets belong to the root task.
5. Flow nonce/event/outbox and schedule occurrence/next-time/outbox commit in their owning database. Cross-database delivery uses idempotent consumption and ACK. Context repository shares the task connection; bundles, subscriptions and handoffs are used by production execution hooks.
6. Task changes have a global sequence in addition to existing local sequences. The renderer shares one event-fed store. Pagination materializes query snapshots for 15 minutes, fixing members, ordering and counts; events invalidate the displayed snapshot.
7. Candidate review includes sources, target baseline and diff. Durable commit journals reconcile file hashes and history after interruption; per-target application writes serialize. Unknown external races stop overwrite and preserve competing contents.
8. product-brand and a publication manifest define display identity, artifact prefix RailWise-AI, roles, hashes and URLs. Public download namespace is railwise-ai; existing workwise update endpoints and historical artifacts stay served. App ID, .workwise, credential references and IPC/schema identities do not change.

## Risks / Trade-offs

- JSONL/files and SQLite are not one transaction: use stable IDs, prepared receipts, durable checkpoints and hash-based reconciliation.
- Arbitrary third-party side effects cannot promise exactly once: persist outcome_unknown and expose required verification.
- A version check followed by rename is not cross-application CAS: retain replaced content and stop when safe preservation is unavailable.
- OS notifications are advisory: the durable attention inbox remains authoritative.

## Migration Plan

Use versioned additive migrations and consistent SQLite backups, including WAL state. Reuse old sessions without hiding user chats. Preserve terminal records and all original documents. Missing historical process fingerprints require verification, not assumed-safe replay. Existing maxDurationMs retains wall-clock meaning; new maxExecutionMs accounts actual work and excludes queue/human waiting.

## Verification

Production-assembly fault injection covers input/ACK boundaries, late owners, duplicate ingress, unknown operations, scoped context, shared budgets, stream recovery and candidate commits. Three fixed synthetic delivery scenarios and actual-model samples precede exact-package language/identity/signature/notarization checks. Run one 0.5.4-to-exact-package updater smoke for the changed artifact mapping. No repeated freezes or blanket UI matrix is introduced.

## Open Questions

No product decisions pending. Version selection and public publication remain separate from implementing and locally verifying this change.
