## Architecture

Declared quality correction workflows use a dedicated append-only store rather than extending the legacy retention-check event stream. The legacy reader interprets its technical checks as retained-byte integrity; mixing declared failures into that stream would misrepresent their meaning. A new workflow freezes the project revision/workspace and the selected retention plan, record, head and artifact. Every event resolves its evidence member through a strict same-project retention read; corrections and rechecks additionally bind a distinct retained artifact and its exact record/head. Bare caller hashes cannot stand in for stored evidence.

Runtime generates event identity, time, sequence, actor and chain hashes. Appends require an expected workflow head and a payload-bound idempotency key. Reads replay the bounded chain and validate SQL/JSON identity, source bindings and local heads. Changed sources, damaged records and wrong project scopes remain unavailable rather than repaired or silently rebound. These are local consistency checks, not independently held custody evidence. Check outcomes and resolved/unresolved issues remain caller declarations; standard conformity and human signatures remain not-evaluated, and delivery approval remains not-granted.

The manual desktop surface selects retained evidence and correction targets, preserves retry identity for ambiguous transport failures, and invalidates late responses on project/revision/record/readiness changes. Its own installed package must be reviewed after source validation; the earlier 3f0dbf1 package cannot certify this new increment.

Result questions use additive typed references built from the selected verified record, preserving legacy conversation reference readers. Network source points, deformation epochs, diagnostics, free-leveling and advanced trials, quality records, standard references and monitoring outputs bind their own identities and hashes; they never inherit an unrelated currently selected adjustment. Preparing a question only preserves the scoped draft, attaches its reference and focuses the existing composer. Explicit model send can invoke a read-only evidence resolver that checks thread/project/workspace, revisions, hashes and any selected row identity using existing strict read APIs. It must not create calculations, approval or verification records. Structured selection is bounded to own JSON fields with explicit row identity or immutable matrix coordinates, and oversized/unavailable/stale results fail explicitly without silently substituting or truncating evidence.

Monitoring numerical replay uses a separate versioned endpoint and append-only attempt evidence. The existing five-check deliverable verification response and its historical audit/metrics remain unchanged. A new import retains original CSV/XLSX bytes plus its exact mapping and normalization context atomically with the dataset in an additive source store. Historical imports are not backfilled from a current file or cache.

Before a replay can pass, the service checks the published manifest, outputs and current input bindings, verifies retained source bytes, repeats normalization under the recorded context, and compares the complete recorded analysis against the version-selected pure computation. Unknown or unsupported historical algorithms, unavailable original sources and ambiguous historical same-instant ordering return not-evaluated, never passed. Each attempt independently persists a start; completion commits separately with the result, preserving interrupted starts. No replay rewrites analyses, manifests, reports, original review status or older verification attempts. The bilingual manual UI binds responses to the selected project/manifest/revision/readiness and distinguishes exact numerical consistency from source authenticity or professional approval. Source tests and exact installed-package acceptance remain separate gates.

The initial replay admits at most 20,000 observations, 32 MiB original bytes and 256 KiB normalization context. XLSX parsing limits entries to 2,048 and counts actual streamed shared-string/worksheet bytes against 32 MiB and a 200:1 source-size ratio; it rejects column indexes beyond the XLSX maximum. Resource limits apply to both new imports and replay parsing. Every repeated instant within the same monitoring-item/point group is not-evaluated: even ASCII observation IDs can change order under numeric collation, and the historical analysis did not retain its collation settings.

Approved engineering execution has a second completion condition in the existing TaskController: all approved steps must have matching persisted success receipts. Internal turn/task plan markers bind this condition through retry and resume; missing bindings fail closed. Ordinary consultation retains the existing answer acceptance. Read-only plan projection supplies completed/pending step identities and marks historical false-completed tasks as needing attention without rewriting their stored records or rerunning side effects. Final text is never evidence that a deterministic step executed.

The bounded standards-reference increment exposes a read-only catalog for already implemented GB/T 24356-2023 sampling and declared scoring. Resolution binds the catalog/rule version, algorithm identity, source digest and applicable profile to verified clause/table and PDF-page references. Unknown or mismatched identities return unavailable; resolution never substitutes the newest rule, rewrites historical records, authenticates evidence or grants professional approval. The desktop displays the source and review boundary beside existing results through the authenticated Runtime/IPC path.

WorkWise Electron remains the only desktop shell and Kun remains the only Agent Runtime. Engineering is a domain-aware view over the existing thread system, not a second chat database. The renderer selects an Engineering thread by `domain + projectId`; `ChatState` owns its blocks, live deltas, queued messages, approvals, and restoration exactly as it does for Code and Design.

```text
Workbench route
  -> engineering thread selector (domain/project filter)
  -> existing ChatState + SSE + attachment store
  -> Engineering AI routes (context/plan/approval)
  -> TaskController -> TaskRunRepository -> AgentLoop
  -> allowlisted railwise.* tools -> EngineeringService
  -> evidence cards -> report/artifact validators -> immutable manifest
```

The seven-page deterministic console stays lazy-loaded as a compatibility panel. It reads the same EngineeringService records and never owns a second AI conversation or queue. Originals stay in Attachment Store; project/run metadata stays in `.workwise/engineering`; generated files stay in `.workwise/deliverables/<projectId>/<runId>`.

## Naming and compatibility boundary

The user's 2026-09-19 consolidated plan supersedes the historical D-04 display names. User-facing platform references use `RailWise AI`; the professional workbench uses `RailWise Survey`, with `工程测量内业` / `Engineering Survey Processing` as its subtitle. Main entries are 编程 / 内业 or Code / Survey. Product naming remains separate from compatibility-sensitive implementation identifiers. New default project-thread titles use `Survey AI`, while an existing persisted title remains unchanged and is never rewritten by a display migration.

The naming update does not rename the package, bundle ID, updater/feed, Runtime API paths, route IDs, persisted storage locations, or the thread `domain: "engineering"` discriminator. This keeps 0.4.x records and the 0.5.0 upgrade chain readable while allowing the visible workbench identity to evolve independently.

## Contracts

Add `EngineeringAiThreadMetaV1`, `EngineeringContextSnapshotV1`, `EngineeringRunPlanV1`, `EngineeringEvidenceCardV1`, `EngineeringApprovalV1`, and `EngineeringWatchRuleV1` under `kun/src/contracts/engineering-ai.ts`. Additive thread fields are `domain` (`code | write | design | engineering | flow | claw`) and optional `projectId`; old records parse with `domain` omitted and continue to behave as Code/primary threads.

Keep the existing deterministic contracts `RailwiseProjectV1`, `MonitoringDatasetV1`, `MonitoringObservationV1`, `QualityFindingV1`, `MonitoringAnalysisV1`, `ChartArtifactV1`, `KnowledgeCitationV1`, and `DeliverableManifestV1`. Reuse `TaskRunV1`, `FlowRunV1`, `RuntimeSpanV1`, and artifact validators. All new records have `schemaVersion: 1`; unknown fields are retained on read and invalid writes are rejected.

## Data flow and state

```text
goal + attachments
  -> bounded ContextSnapshot (40k chars / 200 rows / 20 doc fragments)
  -> draft Typed Run Plan (no side effects)
  -> validate (allowlist, dependencies, revision, model capability)
  -> approve read steps in batch; approve write/export/threshold/archive individually
  -> TaskRun queued/running; each step emits evidence.created
  -> report preview + artifact validation
  -> human review -> immutable manifest/archive
```

Engineering status is projected from the one TaskRun: `draft`, `validating`, `awaiting_approval`, `queued`, `running`, `needs_attention`, `stale`, `completed`, `failed`, `cancelled`. Forbidden transitions (`completed/cancelled/stale -> running`) are rejected. A changed project, dataset, analysis, or citation revision invalidates the context hash and makes a plan stale; replanning creates a new plan revision instead of mutating an old run.

Models may write narrative text only. Numeric values, thresholds, warning states, citations, hashes, and artifact paths come from structured Runtime output. Missing thresholds are “待确认” and block finalization when required. Files are untrusted input; text in a CSV, document, or image can never create a tool call.

## Survey numerical kernel and strategies

`kun/src/engineering` owns the only executable survey-math kernel. It provides bounded dense/sparse matrix primitives, weighted least-squares and constrained solves, rank/condition diagnostics, covariance propagation, normalized residuals, cancellation checkpoints and deterministic hashing. Agent Pack tools and `railwise.*` aliases become adapters to this kernel; copied tool-local matrix implementations are not authoritative.

Each supported network has its own typed strategy boundary:

- leveling/height control builds height-difference equations and uses inverse route-length or supplied variance weights;
- traverse validates an ordered traverse, angular control and distance observations before solving coordinates and reporting angular/coordinate closure;
- plane control builds distance, absolute-direction and station/left/right angle equations and iterates to convergence;
- triangulation requires angle-network geometry and uses angle equations rather than accepting arbitrary distance-only input;
- CPIII free-station/resection solves station coordinates, height where supported and one orientation parameter per occupied station from fixed CPIII targets;
- GNSS uses baseline vector components and covariance against a fixed datum, and blocks scalar or covariance-free data when it cannot support the selected result;
- coordinate transform distinguishes 2-D similarity, 3-D seven-parameter and height-fit inputs and reports the actual solved parameterization;
- deformation results are derived from immutable adjusted epochs and never from model-authored numbers.

Shared matrix code is allowed; shared strategy validation or an observation-model fallback is not. Every strategy is accepted only through a golden fixture with independent expected values and negative fixtures for incomplete, singular and unsupported data.

## Professional survey-format pipeline

Professional source ingestion is a separate boundary before network validation:

```text
Attachment Store original
  -> bounded magic/header/archive sniffing
  -> SurveyFormatRegistry driver
  -> raw-record ledger + diagnostics
  -> normalized point/observation draft
  -> user confirms datum/units/roles
  -> typed network validator
  -> canonical survey-math strategy
```

Drivers expose `detect`, `inspect`, and `normalize` operations and never select a numerical strategy themselves. Detection reads only bounded prefixes, archive entry names, and declared text encodings. The registry resolves extension/content conflicts explicitly and does not pass an unknown file to the delimited parser.

Native drivers are grouped by observation semantics rather than filename alone. P0 covers COSA `.in1/.in2/.NET/.ou`, South DAT with an explicit column/role/unit mapping, and Leica GSI; the wider set covers Leica HeXML; Trimble JobXML/JXL and DiNi/Zeiss M5/DAT; TDS/Carlson RAW/RW5; Sokkia SDR2x/SDR33; Topcon GTS-7/FC-5; Nikon RAW; Spectra Survey Pro; and LandXML. A valid COSA `.in2` may become adjustment-ready when its parsed controls, observations, units, datum and selected strategy are complete. A COSA `.in1` additionally requires its explicit mapping; South DAT never guesses a column order and remains mapping-dependent. Leica GSI may proceed to strategy validation when its record semantics and canonical units are valid, but is blocked until the chosen strategy has adequate fixed controls and geometry. GNSS drivers cover RINEX 2/3/4, SINEX, NMEA, RTCM 2/3, SP3, IONEX, ANTEX, u-blox UBX, NovAtel OEM, Septentrio SBF, BINEX, Javad JPS, Topcon TPS, South STH, Hi-Target ZHD, CHCNAV HCN, and ComNav CNB. Raw GNSS observations/corrections and auxiliary products stop at `gnss-processing-required` unless a separately audited local processing adapter produces datum-bound baseline vectors and covariance. Unverified field-controller dialects stop at `archive-only`. Standard gzip/ZIP and Hatanaka wrappers are expanded with size, nesting, path, and record limits before the inner driver runs.

Opaque Trimble T00/T01/T02/T04/JOB, Leica DBX/MDB, and Spectra Survey Pro database inputs use `SurveyConverterAdapter` rather than reverse-engineered fallback parsing. A locally user-supplied adapter may process the user's local source without a WorkWise manufacturer-authorization gate; it runs with network disabled, bounded time/output, explicit arguments, and hashed input/output. Its output becomes eligible for import only after a deterministic conversion chain records both sources and the normal parser, semantic, unit, datum, topology, closure, precision, and traceability gates succeed. WorkWise does not bundle or redistribute vendor binaries; any future bundled converter package separately requires license and redistribution review. Missing or invalid adapters produce a reviewable blocker while retaining the original attachment.

`SurveySourceFileV1`, `SurveyFormatDetectionV1`, `SurveyImportDiagnosticV1`, and `SurveyRawRecordAnchorV1` carry provenance into the network, evidence package and manifest. Unknown vendor fields are retained in a bounded raw-record payload or sidecar, while numeric values sent to the canonical kernel use explicit metre/radian conversions. The workbench preflight card shows detection, parser/converter identity, readiness and failures before the user can run validation.

New numeric results use canonical metres and radians with per-closure and per-residual unit metadata. Read compatibility parses old result JSON and adds only deterministic defaults in memory; it does not persist a silent migration. Reports and evidence sheets explicitly label dimensionless `sigma0`/variance factors, linear precision, angular residuals and relative closures.

## Upstream policy

RAILWISE-CLI is the source for reviewed monitoring tools and Skills. `railwise-desktop` is reference-only. Sync uses a pinned commit manifest and allowlisted `.railwise/skill`, `.railwise/tool`, schema, and documentation paths. Existing WorkWise asset IDs, user Skills, MCPs, credentials, and data remain compatible and untouched.

Bundled specialist assets pass a generated provenance manifest before packaging. The manifest records repository, pinned commit, path hashes, license, scripts, dependencies, network and credential permissions, test evidence and package decision. Missing evidence is a blocking state, not an implicit approval.

## API and events

Add local-authenticated `GET/POST /v1/engineering/ai/threads`, `POST /v1/engineering/ai/plans`, `PATCH /v1/engineering/ai/plans/:id`, `POST .../validate`, `POST .../approve`, `POST .../start`, `GET /v1/engineering/ai/runs/:id`, cancel/resume, events with `Last-Event-ID`, context/evidence reads, and Watch rule routes. Existing deterministic project/dataset/analysis/chart/report routes remain compatible. Mutations require `expectedRevision` and `idempotencyKey`; duplicate keys replay the original result and stale revisions return `409 engineering_revision_conflict`.

The AI plan route uses the active provider/model and never changes credentials or model settings. If the provider cannot produce a typed plan or lacks required tool/vision capability, the run becomes `needs_attention` with a retry or classic-console action. No error request is sent to an incompatible model.


## Consolidated plan implementation amendment (2026-09-19)

Display branding comes from src/shared/product-brand.json; it must not change app.setName or production bundle/data identity. taskType is optional on legacy reads and inferred only for recognized historical types. Unknown values remain unclassified and readable. New tasks default to control-network. Optional taskContext carries coordinate/height datum, grade and standard/version/clause, and participates in the existing project revision/context hash boundaries. Four production stages retain internal Tab IDs for compatibility and keep one mounted AI conversation. Candidate output cannot become reviewed merely by containing files.

Acceptance now includes all items in the appended consolidated-baseline task list. Prior test totals or released 0.5.0 evidence do not close the new candidate gate. External acquisition, point-cloud and long-tail-format expansion waits for P0 acceptance; this restriction does not block every P1 implementation task.

## Free leveling trial integration

`free-leveling-trial-1` remains a separate pure kernel. A new authenticated network-scoped service creates append-only trial records in a dedicated SQLite table, guarded against update, delete and replacement. The request explicitly acknowledges releasing all original point constraints and the source-or-unit-fallback weight policy. Initial heights and original point roles are retained; missing heights are recorded as zero initial approximations. Absolute datum accuracy is not inferred from the zero-sum constraint.

The service admits only source-verified leveling/height-control networks with independent, anchored height differences and a consistent weight basis. Every observation is processed or the whole request fails. Repeated requests check their exact request hash. Creation and reads bind source admission, network revision, solver input, algorithm, original roles and full output; reads recompute without repairing or rewriting records. Paginated history returns bounded summaries, and a selected record is verified again before displaying numerical detail. Historical formal adjustments, result readers and deliverables are unchanged.

The desktop shows an explicit acknowledgement, separate trial history, metre values, original-record navigation and trial-only interpretation in Chinese and English. Network/revision changes, Runtime disconnection and failed retries invalidate pending presentation. This implements part of P1 task 44; it does not complete quasi-stable adjustment, variance components, robust estimation, statistical decisions, digital signatures or professional acceptance.

## XY error ellipse increment

Algorithm 7 adds `xyErrorEllipse` to solved point results for plane, traverse, triangulation, CPIII and GNSS. The 2×2 block comes directly from the strategy's parameter indices, is scaled by the solver variance factor, and carries explicit units/axis conventions. The old `point.covariance` is preserved with its historical meaning and is never used to infer the new field. Algorithm 6 remains a separately selected, ellipse-free output path for exact replay of existing immutable evidence; algorithms other than the current 7 and retained 6 are not newly admitted. Eigenvalues are computed using normalized symmetric matrices, with a determinant-based minor eigenvalue to reduce cancellation. Equal axes and zero scale have null orientation. This standard ellipse is not a confidence region; GNSS coordinates are not silently projected to ENU. No public app version or storage migration is involved.


## Frozen quality evidence workspace

A separate additive quality workspace owns immutable plans, retained output bundles, evidence references and append-only check records. Plans bind the exact project revision and manifest; the service reads bounded, project-contained actual bytes and freezes a mandatory artifact-integrity check plus the declared evidence requirements. A client cannot submit passing outcomes, actor identities, stage approvals or a reduced required-check list when checking a record. Checks are server-generated technical evidence-presence/integrity observations, not engineering-semantic or normative assessments.

Every read checks SQL/JSON identity, hashes, plan/artifact bindings and retained bytes; writes use expected chain heads and payload-bound idempotency. UPDATE, DELETE and replacement of durable records are blocked. This detects local inconsistency but does not establish an independently held checkpoint, authenticated professional identity or protection against replacing the entire database. Missing independent trust leaves final coverage/standard conformity/signatures unassessed. Existing draft deliverables remain available and their review status is never promoted.

A separate pure sampling module may implement only the fully checked GB/T 24356-2023 Table 1 and its associated batch rules. It must record population, exact source/version, deterministic selection algorithm and caller-supplied random seed provenance. It must keep process/final-indoor full inspection distinct from permitted sampling. Sampling is not quality approval, and engineering acceptance and human signatures remain separate prerequisites.

## Persisted sampling workspace increment

A dedicated append-only SQLite sampling store freezes a caller-declared definition as exact UTF-8 bytes and an ordered unit-product population. The project identity/revision/workspace, definition hash and population hash bind every record. This population is independent of observation counts and deliverable manifests. Initial HTTP/desktop admission is limited to 10,000 unique unit identifiers and a 1 MiB raw JSON body. Detail responses contain summaries; unit and sample collections use pages of at most 100 entries under the existing response bound.

Only round one is exposed. A population/stage uniqueness constraint prevents redrawing that stage, including with a different idempotency key. Process and final-office stages require census; final-field and acceptance allow explicit census or source-bound Table 1 random selection. Runtime generates one 32-byte seed for each random run, retains it internally and replays the exact stored result for a matching idempotent request. This local generation has no independent witness and does not prove population completeness or spatial uniformity.

Read and verify paths check SQL/JSON bindings, retained definition bytes, source/algorithm identity and complete recomputation against the frozen current project. History isolates unavailable entries instead of silently repairing them. The bilingual manual workspace is available without an AI model and invalidates stale responses on project/revision/readiness changes. Sampling does not constitute material inspection, scoring, professional signature or stage approval. These remain separate unfinished parts of task 44.

## Declared statistical families and fixed-scale Huber trials

The existing advanced-trials boundary admits two additional explicit kinds without rewriting the generalized-w or VCE records. The statistical-family kernel accepts a caller-declared complete family and exact scalar statistics, normal/t two-sided or chi-square upper tails, and Bonferroni correction. Missing, undetectable and numerically unavailable members remain in the denominator. Predeclaration and distribution assumptions are unverified. No automatic connection from approximate generalized-w output is made before upstream error propagation is defined. Critical intervals describe a software resolution policy, not certified error bounds, and do not imply engineering acceptance.

Huber trials require a full-rank independent fixed linear model, a declared fixed external scale, relative sigmas, k, initial parameters and all stopping tolerances. Pivoted QR IRLS retains every finite state, residual, multiplier, derived trial weight, objective and score diagnostic. Stationarity requires the score plus its numerical budget to meet tolerance; step and objective criteria additionally apply after the initial state. Flat minima remain distinguishable from a strict-inlier sufficient condition, and neither is presented as formally certified uniqueness. Gaussian WLS parameter precision is not supplied.

Both kinds retain exact HTTP and declaration bytes, normalized models, basis text, project revision and execution environment through the existing append-only store. Reads and exports verify bindings and recompute. Statistical members are not observations: statistical summaries use zero observation/parameter counts and a separate familyMemberCount. Old kinds do not acquire this field. Statistical result request normalization sorts the supplied statistic subset only; raw input order and its model hash remain preserved. Existing storage and work budgets continue to cover the maximum legal model and history page. Bilingual UI and automated integration checks require separate exact-package acceptance before release.

### Declared two-epoch reference datum

A separate `declared-reference-datum-1` pure kernel accepts complete one-dimensional epoch coordinates/covariances, a full point bijection and explicit independent or cross-epoch covariance. Caller-selected GLS or equal-reference definitions propagate the original covariance without clipping or automatic fallback. Near-semidefinite checks remain numerically unresolved, source hashes are caller declarations, and no stable-point selection, significance test, formal mutation or professional approval is inferred. Runtime/UI binding is a separate task.

### Reference workspace and declared quality scoring

The reference kernel uses the independent advanced-trials record path with explicit point/reference counts rather than observation or fitted-parameter counts. Numerical qualification, method and dependence remain visible with full propagated covariance; the four earlier kinds retain unchanged serialized fields.

GB/T 24356-2023 scoring uses a separate source/profile-bound kernel and exact bounded BigInt fractions. Planar-control points and height-control sections have fixed hierarchy weights. Declared checked/pending/excluded scope, strict multiple-accuracy >60, unrounded batch-rate boundaries and A/subelement vetoes remain distinct. Unsupported precision/coefficient branches stay unavailable. A separate scoring workspace will preserve declared-record trust; scores cannot authenticate source documents, classify defects or authorize delivery.

## Declared scoring records and static append integration

Declared GB/T inspection scoring uses a separate append-only project database and authenticated route family. Original UTF-8 declarations, exact rational score strings, scope/veto traces and the project snapshot are retained and recomputed before restoration/export. Caller-declared evidence, software scoring, stage qualification and human approval remain separate states. The first implementation does not automatically connect these declarations to a frozen inspection plan or approve deliverables.

Static independent-observation append is a sixth advanced-trial kind with explicit base/append/total counts. A fixed full-rank baseline, known absolute prior variances, fixed parameter set and declared fingerprint are mandatory. Row-wise Givens updates preserve the baseline column scaling and every state; a separate full Householder fit compares parameters, SSE and full prior covariance. Only this kind accepts up to 256 total observations, with at most 128 appended rows and 16 parameters. Old kinds retain their limits and stored hashes. UI displays prior covariance distinctly from the diagnostic posterior variance factor. Existing byte, replay, history, quota and late-project guards apply.

## Scoped workspace response handling

The workspace separates loaded overview state from the overview allowed to render for the current project and workspace. Project-list, overview and Survey-summary reads have independent latest-request generations. Project/workspace/Runtime changes and unmount invalidate pending reads; explicit project selection clears its previous draft, selections, preview and chart immediately. A Runtime disconnect retains already loaded historical draft evidence for reading while disabling mutations. Returning to a previous project does not revive requests from an earlier visit.

Every asynchronous workspace mutation captures the current scope identity. Success, errors, follow-up requests and busy-state cleanup check that identity after each await. File encoding must still belong to the original scope before it may issue an import. A saved project can replace only its own overview, and it invalidates older overview/project-list reads. Successful creation invalidates older project-list reads before inserting and selecting the new project, preventing a pre-creation list from removing it and restoring the previous selection. These UI guards do not cancel or roll back an already accepted server operation; the correct project's durable records remain discoverable through its ordinary reload.

## Readiness actions and one-shot evidence navigation

Adjustment is offered only for a currently admitted source and validated network, in addition to existing Runtime and busy guards. Blocked, converter-required, archive-only and unknown-admission sources retain recovery information without an adjustment button. The missing-data action uses the existing evidence-question preparation path, preserving a typed question and selected project/network revision, source/parser identity and relevant section; it neither sends a message nor authorizes computation.

Navigation uses a renderer-only typed target. A plan may locate a literal network plus expected revision, an explicitly identified adjustment, or supported monitoring inputs. Unresolved predecessor bindings are not replaced with a latest run. Existing evidence cards are matched against their exact Runtime-generated identity, digest and locator in the current project read model; titles and summaries never determine a target. The current card contract has no Survey raw-record selector, so that route uses explicitly selected conversation evidence rather than invented card fields. Unsupported citations, missing hashes, duplicate matches and stale bindings remain unavailable.

Each Survey click reads the project-scoped networks and runs again, then checks project/workspace/revision, network revision/source digest and any run/observation/anchor/point/diagnostic relationship. Exact record lookup is independent of visible summary row limits. Successful navigation selects the corresponding view and focuses the precise row or record with a visible focus indication. Each target object is consumed once; later validation can invalidate evidence but cannot replay the old selection over a user's manual navigation. A new click creates a new target. The existing AI component remains mounted, its selected evidence and typed question survive, and navigation itself performs no Runtime mutations or conversation sends.

## Verification lifecycle and recorded denominators

An additive append-only `engineering_verification_events` table records a random attempt ID and independently committed start before `verifyDeliverable` enters its existing verification transaction. The start contains project/manifest identity and time, without names, coordinates, file paths or arbitrary exception text. A finished receipt and the original terminal record commit atomically; matching identity, start/end timestamps, terminal outcome, exact terminal JSON digest and predecessor digest are required. Failure of either terminal write rolls both back and preserves the earlier start. Failure to persist the start prevents verification and remains outside the recoverable database denominator. Crash, clock reversal and transaction failures do not synthesize a failed terminal on restart.

The read-only `recordedVerificationLifecycle` metric includes all durable starts in the UTC half-open period and only outcomes completed before its end. Incomplete attempts remain in the denominator. Legacy terminal-only records are counted separately and never acquire fabricated starts; old terminal metrics retain their previous semantics. Missing tables produce `not-measurable`, an empty defined cohort produces `no-samples` with null rates, and broken identity/digest/sequence/atomic bindings make the lifecycle statistic unavailable. Historical terminal passage is not current metadata or byte validity. The local digest chain is not an independent signature or proof of production cohort authenticity. Source automation, exact-package acceptance, professional confirmation and production KPI achievement remain separate evidence layers.
