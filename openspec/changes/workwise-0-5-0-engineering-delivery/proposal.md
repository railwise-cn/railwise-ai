## Why

WorkWise already has the Electron shell, Kun Runtime, attachments, Flow, Design, and RailWise specialist assets. The current engineering screen still makes the user drive a form-heavy console and the existing AI command center keeps its own `localStorage` thread pointer and SSE subscription. That makes Engineering look separate from the AI product and makes a Design/Code-style conversation impossible to recover reliably.

0.5.0 therefore makes the engineering project conversation the primary surface. A user states an engineering goal in natural language, attaches data, reviews a typed plan, approves risk-bearing steps, and watches deterministic analysis produce evidence and deliverables. The model explains and coordinates; it never becomes the source of numeric truth.

## What Changes

- Add an AI-first Engineering session that uses the existing `/v1/threads`, `ChatState`, SSE, attachment store, and message restoration path. Engineering threads carry additive `domain: "engineering"` and `projectId` metadata and are isolated from Code, Write, Design, Flow, and IM threads.
- Apply the user's consolidated naming baseline: RailWise AI names the platform and RailWise Survey names the professional workbench, with 工程测量内业 / Engineering Survey Processing as its subtitle. Main entries are 编程 / 内业 or Code / Survey. This supersedes the historical D-04 display names; existing package, bundle, updater, API, route, and `domain: "engineering"` identifiers remain unchanged through 0.5.0 so existing records and upgrades remain compatible.
- Replace the component-local engineering chat shim with a renderer session shell: project/thread sidebar, AI timeline and typed-plan cards in the center, evidence/Copilot inspector on the right, and a clearly labeled classic deterministic console fallback.
- Add versioned Runtime contracts and local authenticated APIs for context snapshots, typed plans, approvals, TaskRun projection, evidence cards, Watch drafts, deterministic analysis, charts, reports, and immutable manifests.
- Add one canonical survey-math kernel and independent typed strategies for leveling/height control, traverse, plane control, triangulation, CPIII free-station/resection, GNSS baselines, coordinate transforms, and deformation results. Unsupported or incomplete networks must be blocked instead of being reported through a generic plane-network fallback.
- Add a content-sniffed professional survey-format registry. P0 processing covers COSA `.in1/.in2/.NET/.ou`, South DAT with an explicit saved mapping, and Leica GSI-8/GSI-16; other native import covers HeXML, Trimble JobXML/JXL and DiNi/Zeiss M5 or recognized DAT, TDS/Carlson RAW/RW5, Sokkia SDR2x/SDR33, LandXML, plus dialect-safe inspection for Topcon GTS-7/FC-5, Nikon RAW, and Spectra Survey Pro. GNSS inspection covers RINEX/SINEX/NMEA/RTCM, SP3/IONEX/ANTEX, u-blox UBX, NovAtel OEM, Septentrio SBF, BINEX, Javad JPS, Topcon TPS, South STH, Hi-Target ZHD, CHCNAV HCN, and ComNav CNB. Production admission is determined by correct parsing, explicit semantics and units, datum/topology completion, deterministic adjustment, closure/precision checks, and traceability, rather than a manufacturer authorization requirement. Proprietary opaque formats such as Trimble T00/T01/T02/T04/JOB, Leica DBX/MDB, and Survey Pro databases use an audited, locally supplied converter adapter; absent or invalid conversion preserves the source and returns a stable blocker rather than fabricating observations. WorkWise neither bundles vendor binaries nor reverse-engineers proprietary binary formats.
- Record canonical linear/angular units on every adjustment result, closure and observation residual, and carry those units into the UI, DOCX/PDF narrative, XLSX evidence and legacy-read compatibility path.
- Audit the bundled surveying, monitoring, tender, standards and report Skills against pinned source commits, licenses, scripts, network access and credential access before including them in a candidate package.
- Make `TaskController`/`TaskRunRepository`/`AgentLoop` the only execution path. `EngineeringService` remains the deterministic data and artifact layer and is called by allowlisted RailWise tools; it must not create a parallel engineering queue or mark a run complete without TaskRun completion.
- Reuse existing Attachment Store, artifact validation, RailWise tool IDs, Skills, MCP configuration, credentials, and knowledge sources. No second desktop shell, Runtime, provider switcher, or hidden credential path.
- Ship DOCX/PDF reports, XLSX evidence packages, and `manifest.json` in 0.5.0. PPTX remains a 0.5.1 follow-up using the existing Design/PPT Master path.
- Preserve existing files, threads, logs, plugins, Skills, MCPs, credentials, attachments, and legacy tool IDs. Migrations are additive, lazy, revision-safe, and reversible via the existing feature-flag/settings path.

## Capabilities

The P1 quality-chain continuation adds a separate declared correction workflow over exact retained material records. It persists checks, issues, correction targets and rechecks without changing the legacy evidence-retention verification API, draft deliverables, professional identities or release approval gates. Software validation and installed-candidate/human acceptance remain separate tasks.

### New Capabilities

- `engineering-delivery`: AI-first engineering-survey sessions, deterministic survey adjustment and monitoring analysis, reviewed specialist Skills, and traceable DOCX/PDF/XLSX/manifest delivery.

### Modified Capabilities

- None.

## Impact

- Adds engineering AI contracts, survey contracts and canonical units, professional source-format contracts and parsers, independent survey strategies, thread metadata and filtering, context/orchestration services, TaskRun projection, authenticated AI routes/events, evidence cards, renderer session components, specialist-Skill provenance, golden fixtures, and tests.
- Keeps the old seven-page Engineering console available behind an explicit compatibility entry; it is not the default route.
- Does not change provider credentials, DeepSeek model selection, Electron/Tauri architecture, public version metadata, release feeds, or download pages.


## Consolidated plan amendment (2026-09-19)

The user-provided RailWise AI / Survey convergence plan supersedes the older D-04 display-name rule and the AI-only first-screen design above. The platform display name is RailWise AI; Survey is RailWise Survey with Engineering Survey Processing / 工程测量内业. Four production stages share a persistent conversation. Six typed engineering jobs and non-destructive legacy migration replace the monitoring-only assumption. External acquisition, point clouds and long-tail formats remain gated by P0 packaged acceptance. Other P1 work may proceed when its authoritative inputs are available. Technical identifiers, user data and public release gates remain unchanged.
