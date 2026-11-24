---
description: Generate source-intake stage that fills externally verifiable factual gaps before planning or direct SVG authoring.
---

# Topic Research Stage

> Factual preparation inside the active Generate profile's source intake: Default hands its output to Strategist; Quick's main agent consumes it. Run immediately for topic-only input, or after supplied material is converted and read when it leaves planning-critical factual gaps. Output is a research supplement plus stable fact provenance for project import. The facts JSON is provenance, not a page-download queue: `import-sources` imports the pair without fetching `source_url` values. This stage makes no deck image selection and performs no image search or generation.

## When to Run

| Material state | Action |
|---|---|
| Topic or requirements with no supporting facts | Research the factual baseline for the requested outcome |
| Supplied material covers only part of the outcome | After conversion and reading, research only the identified externally verifiable gaps |
| Supplied material already supports the outcome | Skip; continue the profile's source preparation |
| User requires a closed corpus, source-only transformation, or no external enrichment | Skip; plan within supplied material |

**Sufficiency test**: a gap exists when the content owner would otherwise have to invent, omit, or leave unsupported an externally verifiable claim the requested outcome needs; file presence, source length, and topic taxonomy do not decide it.

**Hard rule — preserve supplied facts**: supplement the user's material, never silently replace it; record a material source conflict in the research output instead of choosing a different claim without disclosure. Do not research omissions outside the requested scope.

---

## Step 1: Define the gap brief

| Item | Default if unspecified |
|---|---|
| Topic / scope / outcome | From the request; otherwise broad overview |
| Supplied-material baseline | Facts and claims already available |
| Research gaps | Only facts needed to support the outcome |
| External-source boundary | External enrichment allowed; supplied facts remain authoritative |
| Output language | Match user input |
| Audience / communication intent | Use what is explicit; Default leaves confirmation to Strategist, Quick resolves routine gaps in context |
| Research stem `<research_slug>` | `<topic_slug>_research`, or another unused snake_case stem rather than overwriting |

Default bundles only genuinely missing scope or research-boundary decisions into one clarifier; Quick applies the defaults and continues, stopping only when a required permission or safety boundary cannot be inferred responsibly. Do not repeat the full-pipeline confirmation here.

---

## Execution Context

**Default — isolated research when available**: the main agent owns the sufficiency decision and brief. When the host supports an isolated subagent with web/fetch access and write access to the declared outputs, dispatch exactly one research worker with the topic/outcome, baseline or source paths, declared gaps, output language, two exact unused output paths, and this stage's absolute path as execution authority (paths, not pasted source bodies). The worker reads this file completely, follows Steps 2–3, limits project writes to the two artifacts, and makes no image, deck-planning, or design decisions. Otherwise the main agent runs Steps 2–3 locally.

**Hard rule — isolate retrieval, not research**: raw page content stays in the worker context. The 250-word limit applies only to its chat receipt (`status`, artifact paths, covered/unresolved gap counts, external-fact count, material conflicts), never to the artifacts. After validation and import, the content owner reads the complete imported pair into the main context; never use the receipt as content.

**Validation**: before import, verify both files exist, the Markdown contains `## Research Brief` and no source list or URL, the JSON parses with schema `ppt-master.fact-provenance.v1` and unique sequential IDs, and the two agree. Return an invalid pair to the worker for repair; use main-context research only when isolation is unavailable.

---

## Step 2: Gather factual sources

Use the web search and fetch tools available in the research context; fetch with `--no-images` so no companion image directory is imported as content. An isolated worker without web tools returns `blocked: web-tools-unavailable`. With no usable search/fetch context, pause and ask the user for authoritative URLs covering the gaps, then fetch each with:

```bash
python3 ${SKILL_DIR}/scripts/source_to_md/web_to_md.py <URL> -o projects/<research_slug>_web_sources/<source_slug>.md --no-images
```

| Phase | Action |
|---|---|
Orient | Map authoritative sources to the declared gaps |
Deep fetch | Read the highest-signal primary pages in full |
Targeted fill | Search only for gaps still unsupported after those reads |

| Priority | Source |
|---|---|
| 1 | Primary sources, official sites, institutional releases, standards, or original research |
| 2 | Authoritative reference works and reputable academic sources |
| 3 | Reputable reporting or analysis when primary evidence is unavailable |
| Avoid | Unsourced reposts, unverifiable summaries, and stock-aggregator pages |

**Adopted webpage boundary**: record a URL only in the matching fact's `source_url`, and only when it materially supports that fact — never because its images may be useful, and never from unopened search results or a separate image-search pass. Stop when every declared gap has enough sourced evidence for the content owner to decide inclusion; do not add unrelated overview/history/outlook sections to look complete.

---

## Step 3: Save the factual supplement

Write `projects/<research_slug>.md` and `projects/<research_slug>.facts.json` under `projects/`, never the repository root. Do not overwrite an existing user file. This stage creates no image manifest or downloaded images.

Begin the research Markdown with a compact `## Research Brief` containing the supplied-material baseline, declared gaps, audience / intent already known, and requested outcome. Organize the body by gap, include concrete facts only, flag material conflicts, and cite claims by `fact_id`. Do not add a `## Sources` section or URLs to the Markdown; the JSON is the sole URL authority.

Write every externally sourced claim that may enter the deck to `<research_slug>.facts.json` with a stable sequential ID, especially quantitative, date, ranking, attribution, and named-entity claims. Do not include user-supplied claims or invented scenario values. When no external claim is retained, write the schema with an empty `facts` array.

```json
{
  "schema": "ppt-master.fact-provenance.v1",
  "topic": "<topic>",
  "facts": [
    {
      "fact_id": "F001",
      "claim": "One concise, presentation-ready factual claim",
      "source_title": "Authoritative page title",
      "source_url": "https://example.org/source",
      "classification": "external",
      "retrieved_at": "YYYY-MM-DD"
    }
  ]
}
```

IDs are immutable within the file. Correct a claim under the same ID; never reuse a removed ID for a different fact. The research Markdown and provenance file must agree. When no external claim is retained, write an empty `facts` array.

---

## Hand-off

After project initialization, import the pair alongside user sources. The facts JSON is an ordinary source file; importing it does not retrieve its webpage URLs:

```bash
python3 ${SKILL_DIR}/scripts/project_manager.py import-sources projects/<project_name> [<source_paths...>] projects/<research_slug>.md projects/<research_slug>.facts.json
```

If planning reveals a required gap, return here and repair the pair before continuing; Strategist or Quick never consumes a newly fetched claim without updating it. The imported pair is evidence-facing context, not a locked contract: Default's Strategist reads both files completely before confirmation; Quick's agent does the same before making content and design decisions.

**Single-page image fallback**: only after normal web-image providers, ranked thumbnail pages, and materially different queries fail may an image owner with visual capability select one relevant `source_url` from the facts JSON and fetch that page package. Review its companion image directory and copy only accepted images into the project image pool. Never pass the URL to `import-sources`, which would promote every companion image into the pool. Fetch another page only when the current package has no usable image; without visual capability, retain `Needs-Manual`.

```markdown
## ✅ Topic Research Complete
- [x] Research execution: <isolated worker | main-context fallback>
- [x] Research supplement: `projects/<research_slug>.md` (N declared gaps covered)
- [x] Fact provenance: `projects/<research_slug>.facts.json` (N external facts)
- [x] Artifact contract validated: `## Research Brief`, no Markdown source list, `ppt-master.fact-provenance.v1`, unique sequential IDs, Markdown/JSON agreement
- [x] Adopted webpage URLs: N unique `source_url` values; no webpage auto-imported, no image copied into the runtime pool
- [ ] **Next**: Default returns to [`generate-pptx`](../generate-pptx.md) Step 2; Quick returns to [`quick-generate`](../profiles/quick-generate.md) §2. Import all source artifacts, then read the complete research pair before planning
```
