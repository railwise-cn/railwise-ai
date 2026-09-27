## ADDED Requirements

### Requirement: Retained-material declared correction workflow

The Runtime SHALL persist caller-declared quality checks, opened issues, corrections and rechecks separately from legacy technical retention checks. Creation SHALL freeze the exact project revision/workspace, retention plan, record, head and artifact. Every event SHALL reference an actually retained same-project evidence member. Correction and recheck targets SHALL be resolved from retained records rather than accepted as unverified hash strings. The service SHALL generate chain metadata, enforce bounded append-only storage, head concurrency and payload-bound idempotency, and revalidate sources and the complete chain when reading. No declaration SHALL grant delivery approval, authenticate a professional signature, assert standard conformity or rewrite an existing deliverable.

#### Scenario: Persist a declared correction and recheck

- **WHEN** an authenticated request records a nonpassing check, opens an issue, selects a different retained correction artifact and declares a recheck
- **THEN** the service preserves ordered immutable events and exact source bindings across restart
- **AND** a resolved declaration remains distinct from professional acceptance and does not change legacy retention results

#### Scenario: Reject stale, forged or conflicting workflow evidence

- **WHEN** the project or retention head changes, a material is missing or altered, a correction is unchanged, a recheck names the wrong correction, or an idempotency key conflicts
- **THEN** the service rejects the operation without rewriting prior events or substituting a current artifact
- **AND** failed and corrupted history remains explicitly unavailable

#### Scenario: Restore manual workflow safely

- **WHEN** the desktop loads history or submits a declaration while project, revision, selected retention record or Runtime readiness changes
- **THEN** late responses cannot populate the new scope or trigger a subsequent write there
- **AND** controls present the declared-only boundary in both supported languages and preserve the same request identity for an explicit transport retry

### Requirement: Exact recorded evidence questions

The Engineering UI MUST prepare scoped question drafts from the selected recorded evidence across existing Survey, quality and monitoring result surfaces. It MUST preserve an existing question and attachments, retain legacy reference compatibility, and MUST NOT send a model request, execute a calculation or mutate Runtime records merely when preparing the question. The model MUST have a bounded read-only tool that verifies the exact requested record against its project, workspace, revision, version and hashes using the corresponding strict record reader. A selected row MUST be bound by its actual identity or immutable coordinates within the hashed result, not only its current display position. Failed, stale, cross-project, unsupported or oversized evidence MUST be explicit and MUST NOT be replaced with the latest result or silently truncated as complete evidence.

#### Scenario: Ask about a selected historical result

- **WHEN** the user selects a recorded result or row while another result is currently selected elsewhere
- **THEN** the prepared question binds the clicked record's actual identities and hashes
- **AND** no unrelated adjustment, epoch, quality record or monitoring point is inherited
- **AND** existing question text and attachments remain present until explicit sending succeeds

#### Scenario: Read back stale or incorrect evidence

- **WHEN** an explicitly sent reference names the wrong project, revision, hash or selected row identity
- **THEN** the read-only tool reports the binding failure without returning another record
- **AND** no calculation, verification attempt, report or approval is created

#### Scenario: Bound a large result

- **WHEN** the requested record or selection exceeds the supported evidence output budget
- **THEN** the tool reports that a more specific supported selection is required
- **AND** it does not present a truncated result as a complete record

### Requirement: AI-first engineering sessions

The Runtime and renderer MUST provide one primary Engineering AI thread per `workspace + project`, using the existing thread persistence, ChatState, SSE, attachment, and message restoration path. Engineering views MUST filter by `domain=engineering` and exact `projectId`; Code, Write, Design, Flow, and IM threads MUST NOT appear in the Engineering list or receive Engineering context.

#### Scenario: Open a project

- **WHEN** a user opens an existing Engineering project
- **THEN** the app selects or idempotently creates its Engineering AI thread, restores its messages, and shows the current production stage with a continuously mounted AI conversation

#### Scenario: Switch from Design or Code

- **WHEN** a user switches from Design or Code to Engineering and back
- **THEN** each route restores its own selected thread and timeline without moving, duplicating, or mixing messages

#### Scenario: Legacy thread metadata

- **WHEN** an old thread has no `domain` or `projectId` fields
- **THEN** it remains readable through the existing detail path and is not silently migrated into an Engineering project list

### Requirement: RailWise AI and Survey display naming

The renderer MUST use `RailWise AI` for platform references, `RailWise Survey` for the professional workbench, and `工程测量内业` / `Engineering Survey Processing` as its subtitle. Main entry labels MUST be 编程 / 内业 or Code / Survey. Shared display branding MUST NOT rename persisted technical identifiers. Existing persisted titles and records MUST remain unchanged unless a user explicitly edits them.

The D-04 naming boundary MUST NOT rename the package name, bundle ID, updater/feed, Runtime API paths, route IDs, storage locations, or thread `domain: "engineering"` discriminator during 0.5.0.

#### Scenario: Create a new Survey project thread

- **WHEN** the user opens a Survey project that has no existing project thread
- **THEN** the renderer creates a `Survey AI` titled thread and persists `domain: "engineering"` with the exact project ID

#### Scenario: Open an existing project thread after the naming update

- **WHEN** the user opens an existing 0.4.x or 0.5.0 project thread
- **THEN** its title, messages, metadata, routes, and storage records remain readable without a rewrite or migration

### Requirement: Typed plans and approvals

The Runtime MUST turn a non-empty Engineering goal into a bounded, versioned `EngineeringRunPlanV1` before any tool side effect. A plan step MUST use an allowlisted tool and explicit risk, dependencies, input hashes, and approval state. Read steps MAY be batch-approved; write/export/threshold/archive steps MUST require separate approval tokens bound to plan revision and context hash.

#### Scenario: Malformed or unsafe plan

- **WHEN** the provider returns empty, malformed, cyclic, unknown-tool, or unapproved plan content
- **THEN** the Runtime stores the response for user-visible recovery, returns a typed `engineering_plan_invalid`/`engineering_model_malformed` error, and executes zero steps

#### Scenario: Stale approval

- **WHEN** an approval token is replayed, expired, or references a previous plan/context revision
- **THEN** the Runtime rejects it with a stable approval error and leaves all side effects untouched

### Requirement: TaskRun is the only execution carrier

Engineering AI MUST enqueue approved work through `TaskController`, persist status in `TaskRunRepository`, and execute through `AgentLoop`. `EngineeringService` MUST remain deterministic data/artifact logic and MUST NOT create a second queue or mark an AI run completed outside TaskRun terminal handling.

#### Scenario: Cancel and resume

- **WHEN** a user cancels or resumes a run
- **THEN** the same TaskRun transitions through the existing cancellation/checkpoint path, emits deduplicable events, and resumes only from a valid checkpoint and revision

#### Scenario: Duplicate submission

- **WHEN** the same `inputHash + planHash + idempotencyKey` is submitted twice
- **THEN** the original TaskRun and outputs are returned without duplicate work or files

### Requirement: Deterministic monitoring dataset import
The Runtime MUST import CSV and XLSX attachments through the managed Attachment Store, support canonical RailWise fields and explicit user mappings, preserve unknown columns, and return source hashes and row provenance.

#### Scenario: Valid CSV import
- **WHEN** a user imports a UTF-8 CSV with project, point, timestamp, value, unit, and threshold fields
- **THEN** the Runtime stores a versioned dataset and normalized observations without sending raw rows to a model

#### Scenario: Invalid data
- **WHEN** rows contain missing identifiers, invalid numbers, duplicate observations, out-of-order timestamps, unit conflicts, or missing required thresholds
- **THEN** the Runtime returns structured findings with severity, row references, and blocking status

### Requirement: Professional survey source-format ingestion

The Runtime MUST identify survey source files by bounded content signatures before trusting an extension. It MUST maintain a versioned format registry and preserve the original attachment, source hash, vendor, format/version, detection confidence, raw-record locator, parser or converter version, parse diagnostics, and import disposition (`adjustment-ready`, `gnss-processing-required`, `converter-required`, or `archive-only`). Production admission MUST depend on correct parsing, explicit observation semantics and canonical units, completed datum and topology, deterministic strategy validation, closure/precision checks, and traceability; it MUST NOT depend on a manufacturer authorization for processing a user's local data. Unknown bytes or extension/signature conflicts MUST NOT be parsed as a generic delimited table.

P0 ingestion MUST cover COSA `.in1/.in2/.NET/.ou`, South DAT, and Leica GSI-8/GSI-16. A valid COSA `.in2` may be adjustment-ready only after its parsed controls, observations, units, datum and selected strategy are complete. COSA `.in1` MUST require an explicit mapping before it can be adjustment-ready. South DAT MUST require an explicit saved column/role/unit mapping and MUST NOT infer a column order. A valid Leica GSI source MAY enter strategy validation with canonical units and raw-record anchors, but it MUST remain blocked until the selected strategy has sufficient fixed controls and geometry.

Native field-observation import MUST cover Leica GSI-8/GSI-16 and HeXML; Trimble JobXML/JXL and DiNi/Zeiss M5 or recognized DAT; TDS/Carlson RAW/RW5; Sokkia SDR2x/SDR33; and LandXML survey observations. Parsed values MUST retain station/target/backsight/foresight roles, face, set/round, instrument and target heights, units, timestamps, quality flags, source record numbers, and unrecognized vendor fields.

The same registry MUST inspect Topcon GTS-7/FC-5, Nikon RAW, and Spectra Survey Pro sources without trusting their extension. A dialect without independently verified observation semantics MUST remain preserved and blocked rather than being normalized into invented station/target relationships.

GNSS ingestion MUST recognize RINEX 2.x/3.x/4.x observation, navigation, meteorological and clock files, Hatanaka/standard compressed wrappers, SINEX solutions, NMEA 0183 logs, RTCM 2.x/3.x streams, SP3/IONEX/ANTEX products, u-blox UBX, NovAtel OEM, Septentrio SBF, BINEX, Javad JPS, Topcon TPS, South STH, Hi-Target ZHD, CHCNAV HCN, and ComNav CNB receiver sources. Importing a GNSS raw-observation, correction stream, or auxiliary product MUST NOT claim that a baseline network has been adjusted. Only a validated solution/baseline with datum and covariance may enter the GNSS adjustment strategy; otherwise the source is retained with a stable `gnss-processing-required` blocker.

Opaque vendor formats including Trimble T00/T01/T02/T04/JOB, Leica DBX/MDB, and Spectra Survey Pro databases MUST use an allowlisted, locally executed converter whose identity, version, arguments, input hash, output hash, sandbox/network policy, and diagnostics are recorded. A locally user-supplied converter MAY be used for the user's local data without a WorkWise authorization or redistribution prerequisite, but WorkWise MUST NOT bundle a vendor binary or reverse-engineer an opaque proprietary format. A converted output MAY become adjustment-ready only through a recorded two-source conversion chain and the same parser, semantics, units, datum, topology, deterministic strategy, closure, precision, and traceability gates as a native source. Any converter that WorkWise later packages for redistribution separately requires license and redistribution review. If no valid converter is available, the source MUST remain intact and visible with a `converter-required` blocker.

#### Scenario: Leica or total-station source becomes adjustment-ready

- **WHEN** a valid GSI, HeXML, JobXML/JXL, M5/DAT, RAW/RW5, SDR, or LandXML source contains the observations required by the selected network strategy
- **THEN** the Runtime creates normalized points and observations with canonical units and raw-record anchors, shows parser diagnostics, and allows deterministic validation without altering the source file

#### Scenario: P0 COSA or South DAT reaches the production gate

- **WHEN** a valid COSA `.in2`, a mapped valid COSA `.in1`, or a South DAT with an explicit saved mapping provides complete observations for a selected strategy
- **THEN** the Runtime preserves its original records and mapping provenance, applies explicit canonical units and datum/topology validation, and permits adjustment only when deterministic closure and precision checks pass

#### Scenario: Locally converted opaque source is accepted

- **WHEN** a locally supplied, sandboxed converter produces a supported output from an opaque source
- **THEN** the Runtime records the converter and both source hashes, parses the converted output normally, and blocks it unless the same engineering-validity gates required of a native source pass

#### Scenario: GNSS raw data is not a baseline solution

- **WHEN** a user imports RINEX, RTCM, NMEA, T02, or T04 data that has no validated baseline vector covariance and fixed datum
- **THEN** the Runtime classifies and preserves the file, reports the required GNSS processing or converter step, and produces no apparently successful GNSS adjustment

#### Scenario: Extension and content disagree

- **WHEN** a file extension names one supported format but bounded signature inspection identifies another format or cannot identify it safely
- **THEN** the Runtime returns an explicit format-conflict or unknown-format blocker and never falls back to CSV parsing

### Requirement: Reviewable analysis and deliverables
The Runtime MUST produce deterministic analysis, chart artifacts, DOCX/PDF reports, XLSX evidence packages, citations, and an immutable manifest tied to input hashes.

#### Scenario: Finalize reviewed report
- **WHEN** blocking findings are resolved and warnings are acknowledged
- **THEN** the Runtime validates outputs, records hashes and citations, and finalizes a new immutable deliverable manifest

#### Scenario: Blocking review
- **WHEN** a blocking finding remains unresolved
- **THEN** finalization is rejected and no deliverable is marked complete

### Requirement: Independent deterministic survey strategies

The Runtime MUST use one canonical numerical kernel for matrix operations, weighted least squares, rank and condition diagnostics, covariance propagation, standardized residuals and precision assessment. Leveling/height control, traverse, plane control, triangulation, CPIII free-station/resection, GNSS baselines and coordinate transforms MUST each have a typed validator and observation model. A strategy MUST NOT return a successful result by passing unsupported observations to a generic plane-network fallback.

#### Scenario: Incomplete specialized network

- **WHEN** a traverse lacks angular observations, a triangulation lacks valid station/left/right angle geometry, CPIII lacks at least three fixed targets and orientation observations, or GNSS lacks vector/covariance/datum data required by its selected calculation
- **THEN** the Runtime returns a stable blocking finding for that strategy and produces no apparently successful adjustment

#### Scenario: Reproducible specialized result

- **WHEN** a complete fixture for a supported network is adjusted
- **THEN** the Runtime returns the strategy ID, algorithm version, degrees of freedom, residuals, covariance/precision diagnostics and fixed expected numeric results independently verified against an approved reference calculation

### Requirement: Canonical adjustment units

The Runtime MUST normalize coordinates, heights, corrections, displacements and linear residuals to metres; direction and angle residuals to radians; relative closures and variance factors to dimensionless values; and standardized residuals to sigma multiples. Unit metadata MUST be present in new results and deliverables. Legacy results MUST remain readable through a non-destructive read adapter that infers only unambiguous units.

#### Scenario: Mixed plane observations

- **WHEN** one adjustment contains distance and angle/direction observations
- **THEN** each residual retains its own `m` or `rad` unit and the Runtime does not combine unlike dimensions into one residual norm

#### Scenario: Legacy adjustment result

- **WHEN** an existing stored adjustment lacks the new unit fields
- **THEN** the Runtime supplies compatible canonical units in the response without rewriting the stored record or user database

### Requirement: Audited specialist Skills

Only specialist Skills with a pinned source commit, file hashes, compatible redistribution license, reviewed scripts, network and credential permissions, dependency validation and a passing real-scenario test MUST be included in the packaged catalog. Existing user Skills, MCP configuration and credential references MUST remain untouched.

#### Scenario: Unreviewed or restricted Skill

- **WHEN** a bundled surveying, monitoring, tender, standards or report Skill lacks any required provenance, license, permission or test evidence
- **THEN** it remains visible as blocked with the exact reason and is excluded from the package without deleting or overwriting a user-installed copy

### Requirement: Explicit UI states and classic fallback

The Engineering UI MUST show project/thread scope, goal input, attachment boundary, typed plan, approvals, TaskRun timeline, evidence cards, report/artifact previews, and Copilot next actions. It MUST render loading, empty, partial, error, success, stale, and model-unavailable states with a recoverable action. The classic deterministic console MUST remain reachable without replacing or duplicating the AI thread.

#### Scenario: No project or no runtime

- **WHEN** the user opens Engineering without a project or while Runtime is offline
- **THEN** the UI explains the missing prerequisite, keeps typed input/attachments intact, and offers create-project or classic-console/retry actions without a blank surface

#### Scenario: Narrow window and theme

- **WHEN** the app runs in light/dark mode or supported narrow widths
- **THEN** the three-column surface collapses predictably, remains readable with 1px separators and opaque work surfaces, and exposes keyboard and accessible labels

#### Scenario: Professional source preflight

- **WHEN** a user adds a survey instrument or GNSS source file
- **THEN** the workbench shows detected vendor/format/version, confidence, source hash, observation/record summary, adjustment readiness, converter or GNSS-processing requirement, and recoverable diagnostics before enabling validation or adjustment

### Requirement: Safe compatibility
The implementation MUST preserve legacy attachment records, tool IDs, Skills, MCP configuration, credentials, and user files, and MUST use revision and idempotency checks for mutations.

#### Scenario: Repeated request
- **WHEN** the same mutation is submitted with the same idempotency key
- **THEN** the original result is returned without duplicate datasets, runs, or files


### Requirement: Compatible engineering task classification
The Runtime MUST support six explicit task types and optional task context for datum, measurement grade and standard version/clause. Legacy monitoringType records MUST remain readable without storage rewriting or unit changes. Unknown legacy types MUST NOT be silently mapped to deformation. Updates MUST preserve revision and idempotency checks.

#### Scenario: Read a legacy control network
- **WHEN** a control-network project lacks taskType
- **THEN** reads infer control-network without changing stored JSON or monitoring settings

### Requirement: Production stage and review status
The workspace MUST expose four production stages and keep its AI conversation mounted. A preview or draft manifest MUST NOT be shown as reviewed. Blocked source admission MUST take precedence over historical deliverables.

#### Scenario: Draft output exists
- **WHEN** a report preview or a draft manifest contains files
- **THEN** the summary calls it candidate output and retains its actual review status

### Requirement: Exact evidence questions
A question prepared from preflight, observations, residuals, closure, precision or delivery MUST retain its selected evidence reference across page navigation. The read-only conversation tool MUST resolve exact project-scoped observations, raw-record anchors, points and delivery records beyond summary row limits. Supplied network revisions and source hashes MUST be checked. Recorded output metadata MUST NOT be represented as a fresh file-integrity verification.

#### Scenario: Ask about a later observation
- **WHEN** a user selects observation 31 and changes the active page before sending
- **THEN** the selected reference survives, and the tool returns that observation and its corresponding residual and original record rather than the first 20 rows

#### Scenario: Evidence becomes stale or mismatched
- **WHEN** selected revision/hash, observation/anchor or project/delivery identifiers disagree
- **THEN** the read fails explicitly without substituting another record or executing a calculation

### Requirement: Runtime-owned plan effects
Tool risks MUST be derived from the deterministic implementation, not supplied by a model or API caller. Network validation, dataset checks and persisted analysis MUST be treated as writes. Legacy plans with understated risks MUST remain readable but require replanning before approval, start or resume.

#### Scenario: A caller labels export as read-only
- **WHEN** a draft labels report export or a persistent calculation as read-only
- **THEN** the saved plan shows the Runtime-defined export or write risk and resets approval to pending

#### Scenario: An old plan has an understated risk
- **WHEN** an old plan labels a mutating tool read-only
- **THEN** approval, start, resume and the execution allowlist reject it without rewriting the stored record

### Requirement: Reviewed arguments at the execution boundary
Every new Typed Plan MUST show exact literal arguments, explicit predecessor result bindings, Runtime-defined expected outputs and reversibility. Missing or ambiguous inputs MUST produce a non-executable draft. Execution through the existing tool host MUST enforce the approved arguments, project scope, dependency order and per-step idempotency. Result bindings MUST persist across Runtime restart without storing raw observations. Replanning MUST preserve the original operations and selected inputs.

#### Scenario: A model changes an approved selection
- **WHEN** a tool call changes the selected network, revision or output inputs, adds an argument, or skips a dependency
- **THEN** the Runtime rejects it before invoking the deterministic service

#### Scenario: Reading the result of a preceding adjustment
- **WHEN** a plan reads a newly completed adjustment
- **THEN** the read is bound to that exact adjustment run rather than whichever run is currently latest

### Requirement: Confirmed project suggestions
AI project changes MUST be durable unexecuted suggestions showing the authoritative previous values, proposed replacement values and impact. The model MUST NOT receive UI confirmation credentials. Applying a suggestion MUST require an authenticated explicit decision against unchanged project context. Rejecting a suggestion MUST leave project data unchanged. Confirmed edits use the existing revisioned project service and do not recalculate historical results or transform observations.

#### Scenario: A manual edit races a proposed change
- **WHEN** project context changes before the user confirms the suggestion
- **THEN** confirmation fails as stale and preserves the newer project values

#### Scenario: Confirmation is repeated
- **WHEN** a confirmed suggestion is submitted again
- **THEN** its recorded applied result is returned without another project revision or computation

### Requirement: Explicit XY standard error ellipses
New algorithm-7 plane-control, traverse, triangulation, CPIII and GNSS results MUST derive point ellipses from explicitly indexed solver XY cofactors scaled by the variance factor exactly once. Ellipses MUST record metre semi-axes, row-major m² covariance, prior/posterior variance basis, and orientation from positive X toward positive Y modulo π. They MUST use unit Mahalanobis radius and MUST NOT claim a confidence percentage. GNSS solution XY MUST NOT be described as local east/north. Isotropic and zero ellipses MUST have no claimed unique orientation. Fixed points and legacy results MUST NOT acquire invented uncertainty.

#### Scenario: Review and export an ellipse
- **WHEN** a supported adjustment produces XY precision
- **THEN** the point view, DOCX/PDF narrative, XLSX evidence and immutable manifest retain the same ellipse values and interpretation

#### Scenario: Reuse an algorithm-6 result
- **WHEN** an earlier algorithm-6 result passes source and immutable-evidence checks
- **THEN** fresh computation uses the retained ellipse-free algorithm-6 result shape and checks the existing exact computation hash without rewriting its stored result or weakening verification

### Requirement: Read-only deliverable reverification
A project-scoped user action MUST re-read the published manifest and output bytes, check current project/dataset/run bindings, and use the strict Survey reader to recompute supported recorded adjustments and check immutable evidence. It MUST report independent check outcomes and the check time without changing the original manifest or review status. Monitoring calculations are not represented as freshly recomputed by this action.

#### Scenario: An output is changed after export
- **WHEN** output bytes or the manifest file differ from their durable evidence
- **THEN** reverification fails, preserves historical records, and does not approve or regenerate a delivery

#### Scenario: A result arrives after going offline
- **WHEN** the UI loses Runtime readiness while reverification is pending
- **THEN** it disables the action and ignores the late response instead of displaying a stale pass

### Requirement: Source-bound monitoring numerical replay
The Runtime MUST expose an authenticated project-and-manifest-scoped monitoring replay action separately from the existing five-check verification contract. A passing result MUST verify current manifest, output and input bindings, retained original source bytes and normalization context, then recompute the complete recorded monitoring result with its supported recorded algorithm without reading the analysis cache as the answer. New imports MUST atomically retain bounded original bytes and mapping/context evidence without altering historical dataset JSON or backfilling old sources. Replay MUST preserve existing analyses, delivery bytes and review status.

The result MUST distinguish passed, failed, not-evaluated and not-applicable with explicit reason codes, algorithm and comparison versions, source/input/result hashes and execution environment. Unknown algorithms, unavailable historical source evidence or unresolved historical ordering MUST NOT fall back to the current algorithm or count as passed. Numerical reproducibility MUST NOT establish source authenticity, professional approval or production KPI achievement.

#### Scenario: A retained monitoring source and its bound analysis are unchanged
- **WHEN** the user requests monitoring replay for a supported recorded algorithm
- **THEN** the Runtime re-verifies the original bytes and normalized observations and compares every result field exactly
- **AND** it appends verification evidence without updating the checked records or files

#### Scenario: A historical import has no retained original
- **WHEN** the source bytes or import context required to establish source consistency are absent
- **THEN** the result is not-evaluated with the missing-evidence reason
- **AND** historical analyses remain readable without reconstructing an original from normalized rows

#### Scenario: Replay is interrupted or its audit cannot be saved
- **WHEN** a process stops after its independently committed start, or terminal persistence fails
- **THEN** the durable start remains incomplete and no saved success is returned
- **AND** old deliverable verification events and their metrics remain unchanged

#### Scenario: A monitoring replay finishes after changing selection
- **WHEN** the project, manifest, revision, review status or Runtime readiness changes before the response arrives
- **THEN** the desktop clears obsolete evidence and ignores late successes and failures
- **AND** not-evaluated and not-applicable outcomes are never displayed as a numerical pass

### Requirement: Isolated free leveling trials
The Runtime MUST expose free leveling as an explicitly requested, separately versioned trial over an eligible current leveling network. The request MUST confirm the zero-sum height-correction constraint and weight policy. All original fixed and unknown point roles MUST remain unchanged; the trial MUST record their role and initial-height basis while treating every point as free. Unsupported, correlated, mixed-weight, incomplete, stale or numerically unresolved inputs MUST fail explicitly without filtering observations into a misleading successful subset.

Trial history MUST be immutable, project-scoped and restart-safe, binding the network revision, source admission, source hash, exact numerical input, algorithm and result hash. Repeated idempotent requests MUST return the original record. Reads MUST verify bindings and recomputation, reject tampering and stale evidence, and never promote a trial to a formal adjustment, quality pass or deliverable. The bilingual interface MUST distinguish trial values, weight assumptions and unavailable engineering decisions, allow source-record navigation, and discard late responses after network changes or disconnection.

#### Scenario: Run a free trial on a fixed leveling network

- **WHEN** the user explicitly selects a zero-sum free leveling trial
- **THEN** the app saves a separate trial with the original point roles, uses all admitted height-difference observations, and leaves formal adjustments and deliverables unchanged

#### Scenario: Restore a trial after restart

- **WHEN** the user opens a persisted trial
- **THEN** the Runtime checks its exact source, input and result bindings before presenting it, and rejects stale or tampered records without repairing historical data

### Requirement: Durable verification attempts
Deliverable reverification MUST append an independent audit event for successful and failed attempts without modifying the checked manifest, original files or review status. Events MUST bind the requested project and manifest, checked input and output identities, timestamps and individual check outcomes. Failure to persist an event MUST NOT be reported as recorded evidence. The interface MUST explain that each attempt is recorded separately.

Read-only metric aggregation MUST distinguish candidate and production cohorts, deduplicate manifests, respect UTC reporting periods, and exclude mismatched or subsequently failed evidence. Recorded success describes evidence at its check time; aggregating an audit snapshot MUST NOT claim fresh file verification, professional approval or a numerical reproducibility rate for all production work.

#### Scenario: An earlier passed manifest later fails verification

- **WHEN** a later check reports a failure for that manifest
- **THEN** the audit retains both attempts and the aggregate does not use the older success to claim current recorded coverage


### Requirement: Frozen technical quality evidence workspace
The Runtime MUST freeze bounded project-scoped plans and actual deliverable output bytes in an additive quality store. Required checks MUST be immutable for a plan, and the server MUST derive technical evidence check outcomes itself. Authenticated clients MUST NOT set trusted actors, passing outcomes, stage approval or the verification-time required-check list. Mutations MUST require payload-bound idempotency and an expected record head. Reads MUST reject mismatched identities, broken bindings and altered retained bytes.

The workspace MUST preserve existing draft manifests and review status. Local chain integrity and evidence-presence checks MUST NOT claim independent custody, professional signature verification, source/numerical recomputation or normative quality acceptance. Without independent custody and authenticated review, final acceptance MUST remain unassessed.

#### Scenario: A client tries to omit a required check
- **WHEN** a verification request attempts to supply a smaller required-check list or a claimed passing outcome
- **THEN** the request is rejected and the frozen plan remains unchanged

#### Scenario: A retained artifact is changed
- **WHEN** stored output bytes or their project, plan or manifest binding differ from the frozen evidence
- **THEN** reads or verification reject the mismatch without rewriting the historical evidence or approving the deliverable

### Requirement: Source-bound sampling calculations
Any GB/T 24356 sampling calculation MUST use a completely verified version of the applicable source table and explicit inspection scope, unit-product population and batch boundaries. Full-inspection scopes MUST NOT be silently reduced to samples. Reproducible sampled selections MUST retain their algorithm and random-source provenance and MUST NOT claim quality approval.

#### Scenario: Final indoor inspection
- **WHEN** a sampling request identifies final indoor inspection
- **THEN** every unit product remains in the inspection selection regardless of the smaller Table 1 sample size

### Requirement: Frozen sampling population and replay
The authenticated Runtime and desktop MUST admit explicit ordered unit-product populations independently of observation or manifest counts. Definitions MUST be retained as exact valid UTF-8 bytes with hashes and declared trust. Requests MUST be bounded to 1 MiB and 10,000 unique units; unit and sample pages MUST contain at most 100 items. Clients MUST NOT supply random seeds, outcomes or trusted professional identities.

The initial workspace MUST permit only one first-round run per population and inspection stage. Process and final-office runs MUST inspect every unit. A random run MUST generate and retain one Runtime-owned seed, preserve the original selection on idempotent retry and remain labelled locally generated without independent witness. Persistent records MUST be additive and immutable. Reads MUST verify project revision, definition bytes, population order, SQL/JSON identity, source, algorithm and recomputed result. Sampling MUST NOT approve existing deliverables or claim population completeness, spatial uniformity or quality acceptance.

#### Scenario: Retry after losing the creation response
- **WHEN** the same payload and idempotency key are retried after a run was saved
- **THEN** the original run and sample are returned without generating a new seed, while different payloads or another run for the same population/stage are rejected

#### Scenario: Restore a stored selection
- **WHEN** the app restarts and the user selects a sampling run
- **THEN** the Runtime validates and recomputes its original selection before returning summaries and bounded sample pages, and tampered or stale entries are individually unavailable

#### Scenario: Change project while reading samples
- **WHEN** the project, revision or Runtime readiness changes before a sampling response arrives
- **THEN** the desktop clears obsolete presentation and ignores the late response

### Requirement: Explicit statistical families
Statistical trials MUST bind a complete caller-declared family, distribution parameters, tail, alpha, scalar inputs and correction policy. Missing or failed members MUST remain in the Bonferroni denominator. The Runtime MUST distinguish unsupported/numerically unresolved values from calculated probabilities, preserve boundary uncertainty, and MUST NOT infer verified distribution assumptions, actual predeclaration, outlier removal or engineering acceptance. It MUST NOT silently use approximate upstream statistics as exact inputs.

#### Scenario: A member has no usable statistic
- **WHEN** a member is missing, undetectable or outside the supported numerical domain
- **THEN** its explicit state remains in the output and its membership still contributes to the correction denominator

#### Scenario: Statistics are supplied in a different order
- **WHEN** a valid declared family supplies the same statistic subset in a different order
- **THEN** the exact original bytes remain preserved and recovery verifies the kernel's documented normalized request without falsely rejecting or rewriting the declaration

### Requirement: Fixed external scale Huber trials
Huber trials MUST use explicitly declared independent fixed linear observations, external scale, relative sigmas, loss parameter, initial parameters and stopping policy. Every finite iteration MUST retain objective, score, numerical budget, residuals and derived trial weights. Exhaustion or numerical failure MUST NOT expose accepted parameters. Stationarity MUST NOT imply engineering approval, Gaussian WLS precision or certified unique minimization. Formal observations and weights MUST remain unchanged.

#### Scenario: Huber has a flat minimizer interval
- **WHEN** a declared location model has observations [0,0,10,10] with unit scale and k=1
- **THEN** a stationary point in [1,9] is labelled without established uniqueness and without Gaussian parameter covariance

### Requirement: Additive advanced trial integration
The authenticated advanced-trials Runtime, IPC and bilingual manual interface MUST support the new statistical and Huber kinds through immutable raw-byte preservation, strict replay, bounded history and fresh verified export. Existing generalized-w and VCE records MUST remain readable without hash changes or field backfills. Family members MUST NOT be mislabeled as measured observations. Scope changes and late responses MUST follow existing project/revision guards.

#### Scenario: Read a maximum legal history page
- **WHEN** a fresh project budget reads ten maximum-cost valid records
- **THEN** the complete bounded page can be verified within the advertised per-minute work budget, while subsequent operations exceeding that budget are explicitly rate limited


### Requirement: Explicit two-epoch reference definitions remain non-authoritative trials
The system SHALL provide a versioned one-dimensional two-epoch pure comparison with complete coordinate covariance, explicit epoch dependence, a complete point mapping and a caller-selected reference set. The system SHALL propagate the original matrices, retain numerical qualification and SHALL NOT infer reference stability, authenticate source hashes, repair covariance or silently replace a requested GLS definition with an equal-reference method.

#### Scenario: Singular reference covariance does not trigger an implicit fallback
- **WHEN** the caller requests a GLS reference definition whose reference covariance is singular or numerically unresolved
- **THEN** the result is unavailable with the specific numerical reason
- **AND** an equal-reference method requires a separate explicit declaration

#### Scenario: Near-semidefinite propagation retains uncertainty
- **WHEN** the joint covariance passes only within the numerical tolerance of a semidefinite boundary
- **THEN** any returned propagation retains the unresolved classification and original matrix values
- **AND** no result is described as proof of physical stability or an engineering acceptance decision


### Requirement: Source-bound exact scoring of declared inspection records
The system SHALL provide bounded exact-rational scoring for the declared plane-control point and height-control section profiles of GB/T 24356-2023, retaining the source digest, profile/version, inspection stage, evidence references and clause trace. Accuracy, defects, layered units, overview, samples, final-inspection batches and acceptance batches SHALL use their distinct rules. Missing inspection records SHALL NOT become exclusions or zero defects; failed subelements or A-class defects SHALL NOT be offset by aggregate averages. Calculations SHALL NOT authenticate declarations, imply signatures or modify formal results.

#### Scenario: A declared scope is only partly inspected
- **WHEN** some applicable leaves are pending and others explicitly excluded with their declared basis
- **THEN** pending leaves remain unresolved and are not silently removed from the scope
- **AND** a partial computable scope is labelled partial with weights normalized separately at each included hierarchy level

#### Scenario: Precision aggregation reaches the strict sixty-point boundary
- **WHEN** a single precision score is exactly 60
- **THEN** that single-item score remains valid
- **AND** a multiple-precision group containing that score remains unavailable under the reviewed strict-greater-than-60 rule

#### Scenario: Batch percentages are near a grade threshold
- **WHEN** complete declared final-inspection batch counts and prior qualification are supplied
- **THEN** rates are compared as exact integer ratios without preliminary rounding
- **AND** acceptance batches retain their distinct qualified/failed decision and distinguish overview not performed from pending or missing

### Requirement: Immutable declared inspection scoring workspace
The system MUST preserve project-scoped scoring declarations as original UTF-8 bytes with immutable records, exact rational scores and explicit scope/veto/missing-evidence traces. Authenticated Runtime, IPC and bilingual controls MUST verify storage bindings and recompute the full result before restore or export. A scoring record MUST NOT imply authenticated evidence, human inspection or approved deliverables.

#### Scenario: A failed sub-element is hidden by a high mean
- **WHEN** a declared checked sub-element has a score below 60 and other scores are high
- **THEN** the stored and restored result retains the veto and exact leaf score without presenting the weighted mean as a passing unit score

#### Scenario: A different project becomes active during export
- **WHEN** verification completes after the active project or revision changes
- **THEN** the desktop refuses the stale export and clears the previous result

### Requirement: Bounded static independent-observation append
Static append trials MUST require a fixed full-rank baseline, declared known absolute prior variances, independent zero-mean errors, fixed parameter identities and a matching baseline fingerprint. Each Givens update MUST retain a trace and the final result MUST be checked against a separate full batch fit. Prior covariance MUST NOT be scaled by a posterior diagnostic factor. Only this kind MAY accept 256 total observations, including at most 128 appended rows and 16 parameters; old kinds retain their limits and record hashes.

#### Scenario: Baseline data changes without a new fingerprint
- **WHEN** an old value, variance, source anchor or revision changes while retaining the previous fingerprint
- **THEN** the trial refuses an accepted updated fit and does not replace any formal result

#### Scenario: Known prior variance differs from residual scale
- **WHEN** the residual-based posterior factor differs from one
- **THEN** the interface and export retain the unscaled known-prior covariance and label the posterior factor as a diagnostic

### Requirement: Declared quality linkage assessment
The system MUST bind an immutable assessment plan to a project-scoped draft deliverable, retained-material record, complete first-round sample and explicit same-unit scoring records. It MUST replay dependencies twice within a bounded work budget and support at most eight complete sampled units without truncation. Coverage and vetoes MUST remain separate. Assessment MUST NOT modify old deliverables, write deliverable-verification audit events, authenticate source materials or confer review, signature or approval authority.

#### Scenario: A failed unit and a missing unit coexist
- **WHEN** one sampled unit has a replayed nonconforming score and another lacks a complete score
- **THEN** the assessment reports both the veto and incomplete coverage
- **AND** neither missing evidence nor the failure is hidden by an aggregate passing result

#### Scenario: Material retention advances after an assessment
- **WHEN** the retained-material head changes after a saved assessment
- **THEN** a fresh read of that assessment reports changed sources and the UI clears its previous conclusion
- **AND** a new assessment may use the unchanged plan with the new source head after full revalidation

#### Scenario: History includes a damaged record
- **WHEN** an assessment history page includes malformed stored identifiers or corrupt record data
- **THEN** the damaged entry is isolated without hiding healthy rows
- **AND** saved summaries are labelled as summaries while detail, replay and export require current dependency verification

### Requirement: Exact source references for implemented quality rules

The system SHALL expose a bounded read-only reference catalog for implemented GB/T 24356-2023 first-round sampling and declared inspection scoring. Each resolvable reference SHALL identify its exact catalog and rule version, execution algorithm, source digest, applicable profile and verified clause/table/page location. The catalog SHALL retain the distinction between agent source review and authenticated professional approval.

#### Scenario: A saved quality result requests its source reference
- **WHEN** an authenticated client resolves the exact identity represented by a supported saved sampling or scoring result
- **THEN** the system returns the matching source and scope without modifying the saved record or its result
- **AND** the interface distinguishes successful reference resolution from evidence authenticity, standards conformity and human approval

#### Scenario: A requested reference differs from the implemented rule
- **WHEN** the source hash, version, execution algorithm or applicable profile does not match, or the clause is not covered
- **THEN** the system explicitly refuses the reference
- **AND** it does not select the latest rule or infer professional approval

### Requirement: Scoped asynchronous workspace state
The engineering workspace MUST bind displayed overview data to its selected project and workspace. Project-scoped overview and Survey-summary reads MUST be invalidated on project changes; pending project-list and project-scoped reads MUST also be invalidated on workspace or Runtime scope changes and unmount. Late mutation successes, failures, follow-up requests and cleanup MUST NOT change a newer scope's project, form, selection, outputs or busy state. Already loaded draft evidence MAY remain readable while Runtime is disconnected, with mutations disabled.

#### Scenario: An older read finishes after a newer read
- **WHEN** an earlier request succeeds or fails after a newer request for the same scope has completed
- **THEN** the earlier response does not overwrite or clear the newer overview or summary

#### Scenario: A save or preview finishes after selecting another project
- **WHEN** a request started in project A returns after the user selected project B
- **THEN** project B retains its own overview, form and output files without old errors or cleanup changing its state
- **AND** a successful save in the current scope invalidates older overview reads that could restore pre-save metadata

#### Scenario: Project creation completes in a previous workspace
- **WHEN** a create request returns after a workspace or Runtime scope change
- **THEN** it does not insert, select or display that project in the new scope
- **AND** the desktop does not claim to have rolled back the already accepted server operation

#### Scenario: An older project list finishes after project creation
- **WHEN** a project-list read started before a successful creation returns without the newly created project
- **THEN** its stale response cannot remove the created project or replace its selected overview

### Requirement: Readiness-specific adjustment and recovery actions
The interface MUST show an adjustment action only for a source with current positive admission and a validated network, with existing Runtime and busy guards retained. A missing-data question MUST retain the selected source and network evidence, preserve existing question text and require the ordinary user send action.

#### Scenario: A preserved source requires conversion
- **WHEN** source admission is absent or rejected, including archive-only or converter-required sources
- **THEN** the interface exposes the blocker and recovery information without an adjustment button
- **AND** preparing a missing-data question does not send a message, perform an import or execute an adjustment

### Requirement: Exact one-shot professional evidence navigation
Navigation from AI plans, evidence cards and explicitly selected Survey evidence MUST use supported structured identifiers and verified project-scoped bindings. It MUST NOT infer a target from a title, summary, unresolved predecessor output or the latest available run. Project, workspace, revision, source digest and applicable record identities MUST be checked. Navigation MUST preserve the mounted conversation and existing question, focus the exact supported target, and perform no Runtime mutation.

#### Scenario: A plan has an unresolved predecessor result
- **WHEN** the target's plan parameters still depend on an unexposed predecessor binding or omit the required run identity
- **THEN** the navigation action is unavailable with a localized reason
- **AND** the renderer does not substitute the current or latest run

#### Scenario: A Survey network changes outside an already mounted panel
- **WHEN** a user requests navigation and the fresh project-scoped read differs from the selected network revision or source digest
- **THEN** the panel refuses the target without labelling another network or record as the located evidence

#### Scenario: A selected record lies beyond the summary limit
- **WHEN** an exact selected anchor or diagnostic is outside the first twenty displayed summary entries
- **THEN** the panel resolves the full matching source record or diagnostic and focuses it
- **AND** a missing, duplicate or inconsistent identity produces an explicit unavailable result

#### Scenario: Manual navigation follows successful evidence location
- **WHEN** the user locates network A and then manually selects network B
- **THEN** later refresh, busy-state or language changes do not replay the old target and return to A
- **AND** a new explicit navigation click may locate A again without remounting the conversation

### Requirement: Durable verification lifecycle denominators
Deliverable verification MUST independently commit a start event before entering its existing verification transaction. Its finished receipt MUST commit atomically with the original terminal audit record and bind the exact attempt/project/manifest identity, start/end timestamps, outcome and terminal JSON digest. Existing terminal records and review status MUST remain unchanged. Recorded lifecycle aggregation MUST retain interrupted starts and MUST NOT backfill historical starts or claim production completeness.

#### Scenario: The process exits after a durable start
- **WHEN** verification is interrupted after the independent start commits but before atomic finish
- **THEN** the start remains as an incomplete attempt without a fabricated terminal outcome
- **AND** it remains in the started-cohort denominator at the reporting cutoff

#### Scenario: Terminal or finished audit persistence fails
- **WHEN** either member of the terminal-and-finished transaction cannot be written or their identities disagree
- **THEN** neither member is committed, the independent start survives, and no recorded success is returned
- **AND** failure to commit the initial start prevents verification and is not claimed to be recoverable from that database

#### Scenario: Verification completes after the reporting window
- **WHEN** a start lies in the UTC half-open period but its completion is at or after the end
- **THEN** the attempt remains incomplete in that period's counts and denominator
- **AND** the later success is not credited before its cutoff

#### Scenario: Only historical terminal records are available
- **WHEN** old terminal records have no corresponding durable start
- **THEN** they remain readable and are counted separately without fabricated lifecycle events
- **AND** missing lifecycle tables, empty start cohorts and corrupt lifecycle bindings respectively produce not-measurable, no-samples with null rates, and an unavailable lifecycle statistic

### Requirement: Receipt-bound typed plan completion
Task completion for an approved engineering plan MUST require successful persisted receipts for every approved step, with parameters and dependency bindings matching that plan. A model-authored completion statement MUST NOT substitute for missing execution evidence. The internal execution marker and plan identity MUST survive task continuation without being accepted as arbitrary public request fields.

#### Scenario: A model declares success without completing the approved steps
- **WHEN** the model returns final text with zero or only some successful step receipts
- **THEN** the existing bounded retry or stalled path handles the incomplete task
- **AND** neither the task nor the interface claims all approved work completed

#### Scenario: An execution loses its plan binding
- **WHEN** an internally marked engineering execution has no matching approved plan for its thread, task and turn
- **THEN** completion is refused instead of treating the turn as ordinary consultation

#### Scenario: A historical task was completed without receipts
- **WHEN** a read projects a historical completed task whose approved steps lack valid receipts
- **THEN** its displayed execution needs attention and only steps with valid receipts appear completed
- **AND** reading neither rewrites history nor executes missing operations

#### Scenario: An incomplete execution is resumed
- **WHEN** the user resumes the bound task from its checkpoint
- **THEN** the continuation preserves its plan identity and reports successful and pending steps
- **AND** existing successful writes retain their original idempotency identities
