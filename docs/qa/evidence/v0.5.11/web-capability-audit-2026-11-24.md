# Web and command capability audit

Date: 2026-11-24

## Runtime path

- `web_search` uses the eligible official DeepSeek Responses search provider first and Yuanbao OpenSearch as fallback. Explicit GitHub/repository queries can use a narrow GitHub API repository lookup; ordinary website searches retain their existing provider order.
- `web_fetch` uses the KUN safe HTTP client, public-address DNS validation and pinning, redirect revalidation, `parse5` HTML parsing, response limits, and task/domain network policy.
- Search result links are untrusted leads. A successful search receipt grants its exact canonical URLs for the current task and turn when the grant explicitly includes the `web` provider and `web_search` tool. Broader pre-existing network scope still applies.
- JavaScript pages use the existing connected Ego or BrowserSkill path. Ego opens a task-owned Space. The browser path must stay within the reviewed browser scope.
- Arbitrary host commands are separate from web access. The current workspace-write sandbox does not isolate an OS shell, so a host command requires approval for that exact command.

The GitHub repository lookup is a small user-facing capability for future repository queries. It is separate from the development practice described below: searching GitHub during development means checking candidate libraries, licenses, APIs, and maintenance before deciding whether to reuse one. The product lookup does not replace that evaluation.

## Issues fixed in this worktree

- The desktop main process emitted the combined search provider ID, while the KUN runtime rejected it as an unknown provider. The runtime now parses supported provider IDs and has a factory-level execution regression test.
- Sequential search fallback could consume one full timeout per provider. Fallback providers now share one deadline and divide remaining time, leaving the fallback a bounded opportunity to run.
- Search-result authority now checks that the saved execution grant allowed both the `web` provider and `web_search` tool.
- A fetch cancelled before its first asynchronous operation now stops before DNS or transport work.

## Open-source candidates

These projects were evaluated as development dependencies or implementation references, not as user-facing search backends by default.

- [parse5](https://github.com/inikulin/parse5) is an existing MIT dependency used for HTML parsing. KUN keeps the network layer around it because DNS pinning, redirect checks, task scope, response limits, and authorization must remain inside RailWise.
- [duck-duck-scrape](https://github.com/Snazzah/duck-duck-scrape) is MIT with a root `LICENSE` and a small TypeScript API for DuckDuckGo search, but its implementation owns direct HTTP requests and bypasses KUN's DNS pinning and task-scoped transport. It was last pushed in March 2025; mainland reachability is unverified. Do not call it directly from KUN; any reuse would need to keep query parsing behind KUN's transport and authorization.
- [duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) is MIT with a root `LICENSE`, and currently documents search plus page fetching. It is a separate Python 3.10+ MCP service with its own HTTP/fetch path. Borrow rate-limit and output-shaping ideas, not its independent fetch/runtime path.
- [Exa MCP server](https://github.com/exa-labs/exa-mcp-server) is MIT, but research and higher-limit use depend on Exa's hosted API and credentials; it is not a local keyless search engine.
- [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) is MIT, but the SearXNG service it requires is AGPL-3.0. The wrapper license does not change the server's license, so it is not a fit for the MIT-only dependency boundary.
- [Agent Web Search](https://github.com/JerryLiu369/agent-web-search) is MIT and exposes MCP/CLI/Python APIs. Its keyless default sends queries to DuckDuckGo, Exa, and Parallel remote services. A local run succeeded via DDGS, while Exa and Parallel failed certificate verification in this host's Python environment. Its Python dependency/runtime footprint and mainland-network behavior are unverified.
- [agentfetch](https://github.com/SID1ART/agentfetch) offers MCP/REST/CLI search and crawling, but its GitHub API metadata has `license: null` and the repository root has no `LICENSE` file, so its license is unverified. Its larger Python dependency set includes Redis-related service assumptions and sends queries to third-party search providers; it is not a low-risk embedded desktop dependency.
- [Magpie](https://github.com/MBemera/magpie) is MIT and the closest Node fit. It has useful patterns for Markdown extraction, metadata, SPA-shell detection, untrusted-content marking, and token limits. Its `peck()` method owns its network request and its core extraction function is not exported from the public package entry point, so direct integration would weaken KUN's network controls or require a fork. Borrow its failure-detection and extraction ideas while keeping `safeWebFetch` as the authorized transport.
- [WebReaper](https://github.com/pavlovtech/WebReaper) is MIT and can be distributed as a .NET 10 AOT sidecar, but it provides scraping/site mapping, not general search. A sidecar would need separate package, permission, and update acceptance.
- [ShadowCrawl / CortexScout](https://github.com/DevsHero/shadowcrawl) is MIT and combines search, CDP, proxies, persistent browser profiles, MCP, and an independent server. Its larger execution and network surface needs a separate security review.
- [ember](https://github.com/andalabx/ember) is MIT and supports search/crawl. Its Python alpha, additional browser downloads, Windows rendering gap, and non-pinned DNS requests make it unsuitable as the default path.
- [Browser Use](https://github.com/browser-use/browser-use) is MIT but is a separate Python agent/browser execution system with cloud and model configuration, not a read-only fetch adapter. Integrating the full agent would duplicate KUN task identity, approval, and browser scope.
- [polite-crawler](https://github.com/mark1russell7/crawler) is MIT and useful for local corpus crawling/search. It does not supply global web search and requires a separate indexing path.
- [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) is Apache-2.0 and the strongest command-isolation prototype candidate. macOS uses Seatbelt, Linux needs bubblewrap and related tools, and Windows remains Alpha with first-run administrator setup, a separate sandbox account, network-isolation gaps, and HTTPS client compatibility limits. It needs platform and packaged-app acceptance before KUN can use it.
- [Agent-Reach](https://github.com/Panniantong/Agent-Reach) is MIT, Python 3.10+, and spans web, GitHub, video, and social sources through a CLI with channel-specific tools. Some channels need credentials, browser-session reuse, or additional runtimes. Its channel priority and failure fallback are useful design references; bundling its full runtime would duplicate KUN's permission and runtime management.
- [Vane](https://github.com/ItzCrazyKns/Vane) is MIT and provides a compact answer-side sources pattern: title, domain, first few links, and an expand control. RailWise uses that interaction as a design reference while deriving domains locally and distinguishing search leads from read pages; it does not call Vane's third-party favicon service or bundle its UI.

The current selection keeps one KUN execution path. DeepSeek and Yuanbao provide general search options, the narrow GitHub provider handles explicit repository lookups, safe fetch verifies returned source pages, and existing browsers cover interactive rendering. The product GitHub lookup is separate from the development-time repository audit above. The candidates checked do not provide reliable global search, safe fetching, JavaScript rendering, keyless operation, mainland reachability, and an MIT-only fully local stack together. Do not add a Python sidecar or an unscoped HTTP library solely to claim an OSS integration; reuse parse5, Vane's source-list pattern, and selected fallback/extraction ideas where they preserve KUN's control boundaries.

## Verification and remaining work

- Local Yuanbao request returned HTTP 200 with 229,456 bytes. The current server-rendered result cards were parsed into five ranked URLs. A result for the RailWise products page was then fetched under the exact result URL plus the user-provided source origin, returning HTTP 200, 40,844 bytes, and 2,065 characters of extracted text. This verifies the current network from this Mac only.
- Unit tests cover Yuanbao parsing, exact result authority, safe redirects, search fallback timing, and the desktop combined-provider configuration.
- Actual packaged Windows cold-cache behavior on mainland networks remains unverified. The current Yuanbao HTML format has no stability guarantee.
- A real user model, the packaged desktop chat UI, dynamic-page fallback in connected Chrome/Edge, and logged-in Ego Space recovery have not been exercised as one end-to-end workflow in this audit.
- A portable OS-level workspace command sandbox is not present. Replacing per-command host approval with a task-level command grant remains unsafe until Windows, macOS, and Linux isolation is implemented and tested.

## Follow-up verification 2026-11-25

- Rechecked the listed GitHub projects in Ego Lite. `SID1ART/agentfetch` has no GitHub-recognized license and no root `LICENSE` file; its README documents Redis-related assumptions and multiple third-party search engines. Do not describe or package it as MIT without upstream license evidence. `MBemera/magpie` declares MIT and is a small local Node extractor with token limits, but it does not provide general search or JavaScript rendering. The existing KUN stack already has `parse5`, DNS-pinned fetching, result links, and task-scoped browser fallbacks, so neither package replaces the failure paths that matter here.
- `pavlovtech/WebReaper` currently redirects to `alex-on-ai/WebReaper`; `DevsHero/shadowcrawl` redirects to `cortex-works/cortex-scout`. Their .NET sidecar and Rust browser-service architectures need separate packaging and security reviews. Browser Use is an independent Python model-controlled browser system, so bundling it would duplicate KUN task and permission handling.
- A live fallback check injected a synthetic DeepSeek failure, queried Yuanbao, received three ranked sources, and fetched the first source through `safeWebFetch`: HTTP 200, 33,489 bytes of HTML from `https://kb.railwise.cn/`.
- The focused KUN web suite passed 36 tests across five files; KUN typecheck and build passed. The additional runtime-factory regression verifies that a failed DeepSeek search is followed by Yuanbao and that source metadata survives the public tool output.
- A local 0.5.11 Apple Silicon DMG was launched from its packaged app bundle with isolated data. Version `0.5.11` and bundle ID `com.wangjiawei508.workgpt` were verified. Its ad-hoc signature has no team identity, so this package is only a local UI candidate, not a distributable release. It opened to an empty workspace; a real model-backed conversation and the full packaged search-to-answer flow remain unverified.

## Follow-up authorization and conversation sources 2026-11-25

- The search call's remote destination is now declared per backend. DeepSeek search requires `https://api.deepseek.com`; Yuanbao requires `https://so.qq.com`. A fallback skips a backend outside the persisted task network scope and uses an authorized backend if one remains. A DeepSeek-only call with only Yuanbao authorized is blocked before dispatch and before prompting for an approval that cannot expand the grant.
- Search-service origins are distinct from result-site allowlists. `web.allowDomains` continues to constrain page reads; it no longer prevents the Yuanbao search service from returning leads for those pages. `denyDomains` still blocks a configured search service, including DeepSeek and Yuanbao.
- A live Ego Lite check on the Mac opened Yuanbao Search in an Agent-owned Space and returned visible result links for `SID1ART/agentfetch GitHub`, but returned five poor matches and missed the exact repository. This confirms the browser search page works, not that Yuanbao's relevance is sufficient for repository discovery. The GitHub API provider was added to handle repository-specific queries directly and reports absent license metadata as unverified.
- Regression tests now cover backend-specific network grants, fallback selection, pre-dispatch blocking, source-page allowlists, and citations attached to saved and live assistant answers. Local Windows mainland-network behavior, a real model-backed packaged conversation, and end-to-end dynamic-page fallback remain unverified.

## GitHub repository lookup follow-up 2026-11-25

- GitHub-specific queries now route to `api.github.com` before general search. The provider returns canonical repository links and GitHub metadata (description, language, stars, update date, and recognized SPDX license when present); it does not search README contents, issues, or code.
- The route is selected only for explicit repository-oriented queries. General web queries keep the original DeepSeek/Yuanbao order. A provider unit test covers this routing boundary.
- The live GitHub API response for `SID1ART/agentfetch` returned `license: null`; the repository root also has no `LICENSE` file. The result is therefore labeled `license not identified by GitHub`, not MIT.
- The built KUN provider was also called against GitHub and returned the canonical `https://github.com/SID1ART/agentfetch` link with license status `license not identified by GitHub`.
- Verification: 62 KUN tests passed across five web/search/authorization files; KUN typecheck and build passed; the desktop typecheck and production build passed. General web relevance, packaged Windows mainland-network behavior, and a real model-backed conversation remain separate acceptance items.
