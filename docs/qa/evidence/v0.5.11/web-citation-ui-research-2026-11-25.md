# GitHub research: conversation source citations

Date: 2026-11-25

## User need

Show source links in the assistant conversation, close to the answer they support. Each visible source should be recognizable by title and site, open the exact HTTP(S) URL, and remain available when the conversation is replayed. Search results are unverified leads; only a successful page read is a read source.

## Repositories checked

### Vane (formerly Perplexica)

- Repository: <https://github.com/ItzCrazyKns/Vane>
- License reported by GitHub API: MIT.
- Default branch commit checked: `348feca3e378fb4157b217724ed508dc707f853f` (2026-09-01).
- Relevant implementation: [`MessageSources.tsx`](https://github.com/ItzCrazyKns/Vane/blob/348feca3e378fb4157b217724ed508dc707f853f/src/components/MessageSources.tsx) renders title, domain, and source number as links, shows the first three, and exposes the rest in a dialog. [`Citation.tsx`](https://github.com/ItzCrazyKns/Vane/blob/348feca3e378fb4157b217724ed508dc707f853f/src/components/MessageRenderer/Citation.tsx) renders compact inline citation markers. The shared `Chunk` model carries content and metadata, including URL/title.
- Fit: closest visual and data-model reference for a message-level source list. It is a Next.js research-answer product, so its dialog, styling, and search pipeline are not drop-in dependencies. Its favicon implementation calls a third-party Google service; RailWise should derive the displayed domain locally and avoid that request.
- Development use: RailWise adopted the compact source-list pattern (title, local domain, a short visible list, and expansion) as a design reference, without copying Vane's component or adding its external favicon request.

### LibreChat

- Repository: <https://github.com/LibreChat-AI/LibreChat>
- License reported by GitHub API: MIT.
- Default branch commit checked: `4700c44eb77c142b4f9f8b87476924f22890eb39` (2026-11-20).
- Relevant paths include the React/TypeScript message content pipeline and [`Composer/sources.tsx`](https://github.com/LibreChat-AI/LibreChat/blob/4700c44eb77c142b4f9f8b87476924f22890eb39/client/src/components/Chat/Input/Composer/sources.tsx). This is useful as an integration-boundary reference: source selection and app-owned permissions remain outside the generic chat component. The inspected file is an input source selector, not evidence of a directly reusable answer-citation renderer.
- Fit: architecture reference only; do not claim its composer selector implements source citations.

### Open WebUI

- Repository: <https://github.com/open-webui/open-webui>
- GitHub API reports `NOASSERTION` for its license. Its [`Citations.svelte`](https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/Messages/Citations.svelte) provides a useful interaction reference: a source-count control expands a readable list of citations in the answer area.
- Fit: behavior reference only. Do not copy or package code from this repository unless its licensing is resolved.

## RailWise implementation and boundary

- KUN tool outputs already carry `sources` and `citations`; `sourceId` identifies search (`web_search`) versus fetch (`web_fetch`) records. The renderer mapper preserves source metadata on the originating tool block.
- The source list now renders with the following assistant response in the conversation body for live and historical message mapping; it is separate from technical execution details. The UI labels search results as leads and successful page reads as read sources, without claiming that a search result was relied on by the answer.
- Deduplicate by canonical URL, accept only absolute HTTP(S) links, use title with hostname fallback, display hostname derived locally, open links with `noopener noreferrer`, and avoid third-party favicons.
- Preserve provenance: search-result records are labeled as search results; successful `web_fetch` records are labeled as pages read. Do not infer that an answer cited or relied on a source merely because the model searched it. The heading uses the neutral label “Web sources” / “网页来源”.
- No external citation package is required. The existing React timeline, persisted tool-result metadata, and translation system can render this with no new runtime dependency.

## Verification boundary and result

Repository metadata and source files were inspected through the GitHub API and Ego Browser. This verifies upstream implementation and declared license metadata, not legal advice or a RailWise packaged application. RailWise UI tests must cover URL filtering, deduplication, source labels, visible answer association, and live/history parity. Packaged Windows mainland-network reachability remains a separate acceptance item from citation rendering.

The RailWise renderer now filters sources to successful `web_search` and `web_fetch` tool results, validates HTTP(S) URLs, deduplicates by URL while retaining a successful page-read entry over a search lead, and attaches sources to the next assistant message. The current focused renderer run passed 77 tests across the runtime mapper, message summary, and citation DOM suites; coverage includes source boundaries, URL filtering, anchor preservation, deduplication, labels, expansion, and keyboard focus. Packaged Windows mainland-network reachability and a real model-backed search-to-answer conversation remain unverified.
