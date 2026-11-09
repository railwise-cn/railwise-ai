# Task Workbench

## ADDED Requirements

### Requirement: Persist task inputs before execution
The runtime MUST persist a task supplement, tool result, handoff, or human answer before making it available to execution, and MUST use the supplied idempotency key to return the original input on replay.

#### Scenario: Replayed supplement
- **WHEN** the same task receives the same input key and identical text twice
- **THEN** the second request returns the first input and creates no duplicate input event

#### Scenario: Conflicting input key
- **WHEN** a task receives an existing input key with different text
- **THEN** the runtime returns a conflict and preserves the original input

### Requirement: Recover human attention after restart
Approvals and user questions MUST be stored durably and MUST be visible in the task inbox after the runtime restarts until they are answered, cancelled, or expired.

#### Scenario: Restart with unanswered question
- **WHEN** the process exits after creating a user question but before an answer is stored
- **THEN** a new runtime lists the question as pending and accepts the answer through the normal task input path

#### Scenario: Paused task receives a late answer
- **WHEN** a paused or cancelled task receives an answer for an older question
- **THEN** the answer is recorded for audit and the task is not resumed automatically

### Requirement: Scope child execution
Child task authority MUST be the intersection of the parent authority and the child request, including workspace containment, tool capabilities, external targets, and budget.

#### Scenario: Child requests an outside workspace
- **WHEN** a child assignment names a workspace outside the parent workspace
- **THEN** assignment creation is rejected before a child session starts

#### Scenario: Child exceeds parent budget
- **WHEN** a child requests more attempts or duration than the remaining parent budget
- **THEN** the child receives only the remaining budget and cannot increase the parent total

### Requirement: Deliver document candidates without overwriting source files
Document delivery tasks MUST expose the three built-in templates and MUST write Markdown output as a task-owned candidate with source metadata. Existing user documents MUST NOT be overwritten by the delivery tool.

#### Scenario: Start a built-in template
- **WHEN** an authorized client starts a monitoring, tender, or research template with a contained workspace
- **THEN** the runtime creates a resumable Flow and linked TaskRun with the selected template id

#### Scenario: Review a generated candidate
- **WHEN** a delivery task produces a Markdown candidate
- **THEN** the task result exposes the candidate and source references for review, while the original document remains unchanged

#### Scenario: Path escapes workspace
- **WHEN** a template source or output path resolves outside the canonical workspace
- **THEN** the request is rejected before a Flow or candidate is created

### Requirement: Provide revision-safe task controls
Task pause, resume, retry, cancel, and input mutations MUST require the current task revision and MUST reject stale writes. Terminal retries MUST preserve the original terminal record.

#### Scenario: Stale pause
- **WHEN** two clients pause a task using the same expected revision
- **THEN** exactly one mutation succeeds and the other receives a revision conflict

#### Scenario: Retry a failed task
- **WHEN** a terminal failed task is retried
- **THEN** a new linked execution is created and the failed task's events and artifacts remain readable

### Requirement: Separate task identity from execution identity
A root task MUST be the stable public identity. New independent tasks MUST execute in hidden side threads linked by originThreadId, and retries MUST retain prior terminal evidence. User conversations MUST NOT be hidden by migration.

#### Scenario: Independent request during active work
- **WHEN** a user starts an independent delivery task while another is active
- **THEN** a distinct execution is created without cancelling the existing task

#### Scenario: Successful retry
- **WHEN** a failed root has a successful linked retry
- **THEN** the root remains one visible task, current filters reflect the retry, and the old failure remains readable

### Requirement: Coordinate before creating a model turn
The production chat entry MUST route status, supplements, independent tasks, pause, resume and cancel before allocating a Turn. Status reads MUST invoke neither models nor task state mutations. Ambiguous ownership MUST be resolved through a durable, actionable attention item.

#### Scenario: Busy task status query
- **WHEN** a busy task receives a status query
- **THEN** the coordinator returns its local snapshot without queueing an ordinary chat turn

### Requirement: Confirm input consumption at a durable checkpoint
Input delivery MUST be isolated by execution session. Queued, delivered and consumed MUST distinguish persistence, flushed transcript delivery and checkpoint acknowledgement. A stable input message ID, transcript position and hash MUST bridge JSONL and SQLite recovery.

#### Scenario: Transcript flush before crash
- **WHEN** a process exits after input transcript persistence and before checkpoint ACK
- **THEN** recovery verifies the persisted message and ACKs it without injecting the input twice

### Requirement: Fence attempts and reconcile side effects
Each attempt MUST capture an immutable owner/process fingerprint and fencing epoch. Lease renewal MUST NOT grant an old attempt a newer epoch. Tools, input ACKs and artifact/state commits MUST reject stale credentials. Unknown side effects MUST be verified before replay, and Shell PID reuse MUST NOT authorize termination.

#### Scenario: Late result after takeover
- **WHEN** an old attempt returns after a newer owner acquires the lease
- **THEN** it cannot advance task state or dispatch new actions; its result may only be retained as an observation

### Requirement: Share capacity and execution budgets
Main, child and Shell execution MUST share capacity. Root budgets MUST account child work, reservations and costs. New execution-time budgets MUST NOT reinterpret legacy wall-clock duration limits, and waiting MUST NOT retain model capacity.

#### Scenario: Parent waits for child
- **WHEN** a parent awaits child work
- **THEN** the parent's waiting span does not prevent the child from acquiring the required execution capacity

### Requirement: Accept source events durably
Signed Webhook nonce, request fingerprint, source event and dispatch outbox MUST commit atomically before acknowledgement. Schedule occurrence, pinned Flow version, next time and dispatch outbox MUST commit atomically. Cross-database delivery MUST use durable idempotent inbox/outbox acknowledgements.

#### Scenario: Dispatch interrupted after acceptance
- **WHEN** a runtime exits after accepting an event but before dispatch
- **THEN** restart dispatches the pinned Flow version and duplicate delivery does not create a second run

### Requirement: Use scoped production contexts and handoffs
The production runtime MUST persist the actual ContextBundle used for model execution, scope child context and authority, hash and verify spill objects, and persist structured handoffs. Changed source versions MUST invalidate dependent context and candidate evidence.

#### Scenario: Changed candidate source
- **WHEN** source content differs from the hash recorded for a candidate
- **THEN** review marks it stale and accepting that candidate is blocked pending regeneration or renewed review

### Requirement: Share durable live task state
Task workspace and chat summary MUST share one aggregate stream with a global durable sequence. Reconnection MUST replay from the last event. Pagination MUST fix membership, order and counts in a 15-minute query snapshot while keeping legacy offset/array APIs readable. Attention and verified-artifact notices MUST be durably deduplicated.

#### Scenario: Cursor while tasks change
- **WHEN** a task is inserted between two cursor pages
- **THEN** both pages retain the same original snapshot and a new query observes the insertion

### Requirement: Safely review and commit candidate documents
Candidate review MUST display source evidence and differences against the destination. Acceptance MUST bind candidate and target versions, persist an idempotent journal, retain the actual replaced content and append history. Unverifiable file races MUST preserve versions and stop replay. Multi-format delivery MUST report each actual outcome.

#### Scenario: External editor writes through its old handle
- **WHEN** an external editor saves through an open handle after acceptance
- **THEN** the displaced original remains recoverable and the accepted candidate is not silently replaced

#### Scenario: Export bridge
- **WHEN** a template exports a task-owned candidate
- **THEN** the authenticated local bridge invokes the existing Write renderer, checks the candidate hash and writes only a contained task output without overwriting user documents

### Requirement: Unify public release branding without migrating identity
New public artifacts MUST use RailWise-AI names from a source-linked publication manifest. Packaging, feeds, collection, GitHub/R2/website, validation and recovery MUST consume the same naming policy and manifest. Canonical railwise-ai downloads MUST coexist with historical workwise feeds and files. App IDs, .workwise, schemas, credentials and legacy IPC MUST remain compatible.

#### Scenario: New download and old updater
- **WHEN** the next version is published
- **THEN** canonical downloads expose RailWise-AI filenames and the old updater entry resolves to those same verified bytes

#### Scenario: Multiple valid historical profiles
- **WHEN** several distinct valid historical userData profiles are discovered
- **THEN** migration records a conflict instead of silently choosing or overwriting one, and preserves all originals

### Requirement: Record actual acceptance evidence
Acceptance MUST include production assembly fault tests, fixed synthetic delivery scenarios, actual configured-model results, required CI/build, and exact-package identity/signature/notarization checks when applicable. Changed artifact download mapping MUST receive one actual formal-0.5.4-to-exact-package updater smoke. Missing metrics or unexecuted checks MUST NOT be reported as passing.

#### Scenario: Missing model cost
- **WHEN** a provider does not return billable cost
- **THEN** evidence reports cost as unavailable instead of inventing an estimate
