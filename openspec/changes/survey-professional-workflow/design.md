## Context

The workspace already implements constrained leveling and control-network solvers, immutable source records, precise evidence questions and draft delivery. Simplification has moved professional inspection into advanced UI, and current reports serialize most facts as paragraphs. Research evidence and coverage limits are recorded in docs/RAILWISE_SURVEY_PROFESSIONAL_WORKFLOW_RESEARCH.zh-CN.md.

## Goals / Non-Goals

Goals: provide source-bound professional checks; render task-specific tables consistently; expose engineering decisions in the normal workflow; improve AI evidence and controlled table ingestion; verify current packaged behavior.

Non-goals for the first validated increment: invent missing instrument measurements or standards, generalize bounded numerical trials, claim full COSA/SUC interoperability, fabricate signoff, or publish a version. Later tasks retain separate acceptance gates.

## Decisions

1. Add a versioned read projection instead of changing historical AdjustmentResult fields. It binds the run, result, network revision, input hash and original source. Raw route closures and fitted residual norms have separate semantic fields. Missing precision/field-check/standard inputs remain unavailable.
2. Use one professional review model across UI, AI retrieval and report tables. Historical evidence sheets remain readable. Newly rendered reports retain source references and draft review status.
3. Keep the four workspaces but restore network, controls, observation checks and task-specific results as normal sections. JSON, hashes and statistical trials remain secondary.
4. Table parsing requires a saved explicit mapping, linear/angle unit and datum choices. Original file bytes remain preserved. Unsupported content cannot gain eligibility from a filename or model suggestion.
5. Extend the bundled kun runtime and existing task/evidence APIs. Existing idempotency, replay, cancellation and strict source-admission guards remain authoritative.
6. Import replay compares immutable measurement content independently of validated lifecycle fields. A changed lifecycle must match deterministic precheck evidence; unchanged requests may resume after validation without creating another network.
7. Repeat-survey exports require explicitly selected comparison IDs and both exact adjustment runs. Re-read append-only comparison records against current eligible sources/results before replay, artifact publication and manifest sealing. Preserve historical drafts and keep observed changes, adjusted changes and cumulative deformation semantically separate.

## Risks / Trade-offs

- More visible engineering information can become dense. Use task-specific tables and sections, progressive details and normal-sized typography.
- Legacy closure fields mix semantics. Project their verified interpretation without changing old files or allowing unsupported checks to appear passed.
- XLSX anchors address a container rather than physical rows. Preserve member provenance and reject unverified address-space claims until explicitly implemented.
- Vendor outputs and instrument models differ. Bind every comparison to exact data, parameters, versions and declared numerical tolerances.
- Packaged UI acceptance needs final frozen-source artifacts. Record exact package identity and screenshots; keep external and user signoff pending where unavailable.

## Migration Plan

Additive APIs and models first, report/UI consumers second, controlled ingestion third. Preserve old routes, source records, result hashes and output readers. Candidate package uses an isolated identity and private feed. Rollback can continue reading unchanged historical data.

## Open Questions

SUC authoritative semantics and current licensed vendor comparison environment remain external evidence requirements. Applicable engineering standards and signed technical designs are selected per project rather than inferred by the model.
