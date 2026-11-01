# RailWise AI 0.5.4 Electron and audit classification — independent AI source review

Reviewed 2026-11-01 UTC by the release source audit agent. This is a source/dependency review, not installed-package acceptance or release approval. Product files and lockfiles were not edited by this reviewer.

## Decision

**Electron 43.1.1 is a genuine shipped-runtime blocker. Upgrade within major 43 before freezing the final package.** The supplied full audit contains 12 Electron advisories; their largest lower fixed boundary is **43.8.1**. The release owner selected **43.8.6**, the newest 43.x patch returned by the owner's successful registry query. I independently verified that the official [v43.8.6 release](https://github.com/electron/electron/releases/tag/v43.8.6) exists and includes further upstream Chromium, V8, PDFium, Skia, WebRTC and codec fixes. This is an appropriate minimal-major-change correction.

At this review's final source observation, the owner's change was already visible: `package.json:126` and root lock spec use `^43.8.6`; `package-lock.json:7478` resolves exactly 43.8.6 from `https://registry.npmjs.org/electron/-/electron-43.8.6.tgz`, with npm SHA512 integrity. `npm ci` plus the committed lock gives an exact runtime package; do not regenerate the lock after source freeze. The installed npm metadata also reads 43.8.6. These observations do **not** prove that the platform Electron binary has been downloaded or packaged: `dist/version` and `path.txt` were still missing when checked at 15:00 UTC, during the owner's installation work.

The owner then supplied registry metadata `/private/tmp/railwise-054-electron4386-registry.json` and a refreshed full audit `/private/tmp/railwise-054-full-audit-electron4386.json`; I read both. Registry integrity exactly matches the new lock. **Electron is absent from the refreshed audit. The remaining total is 33 packages: 9 high, 21 moderate, 3 low, 0 critical.** Remaining high results are build/test tools or the scoped local OpenClaw identity match described below. This is **not zero vulnerabilities**: the real packaged KaTeX advisory remains low, and propagates to Mermaid/Streamdown aggregates. The owner also reports typechecking and the three existing Electron installer tests passing; those are owner-run results, not a runtime/package acceptance by this reviewer.

## Why this is runtime, although npm calls it dev

Electron is a `devDependency` because the binary packager consumes it, but that binary becomes the application runtime and the managed sidecar's Node host. `npm audit --omit=dev` alone cannot gate this desktop release. The eMudhra certificate advisory explicitly covers both Chromium networking and Node `tls`/`https`/`fetch`; an app making network requests is within its stated impact and there is no application-side workaround. See [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9). Existing application sandbox rules cannot replace this patch.

All original Electron audit entries, grouped by minimum fixed 43.x version:

| Fixed in | Advisory | Security boundary |
| --- | --- | --- |
| 43.4.1 | [gr2m-v5gq-v685](https://github.com/advisories/GHSA-gr2m-v5gq-v685) | Opened-window sandbox inheritance |
| 43.4.1 | [j84w-jfhq-vhvj](https://github.com/advisories/GHSA-j84w-jfhq-vhvj) | Protocol handler cross-origin reads |
| 43.4.1 | [9qh4-3jw8-366w](https://github.com/advisories/GHSA-9qh4-3jw8-366w) | webview worker Node integration |
| 43.5.0 | [qmv3-fv6v-rmhq](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq) | Sandboxed preload cache poisoning |
| 43.5.1 | [98mx-cjp9-gchm](https://github.com/advisories/GHSA-98mx-cjp9-gchm) | Extension tabs permission |
| 43.7.0 | [fw47-9c62-h3vw](https://github.com/advisories/GHSA-fw47-9c62-h3vw) | HID/USB request origin |
| 43.7.0 | [2p8c-gr87-2676](https://github.com/advisories/GHSA-2p8c-gr87-2676) | Opened-window SameSite cookies |
| 43.7.0 | [997q-gvvc-jwmx](https://github.com/advisories/GHSA-997q-gvvc-jwmx) | openExternal request origin |
| 43.7.3 | [3qxv-5xgr-q7w9](https://github.com/advisories/GHSA-3qxv-5xgr-q7w9) | Frame subscription GPU geometry |
| 43.7.3 | [h3v5-h239-pg29](https://github.com/advisories/GHSA-h3v5-h239-pg29) | macOS offscreen GPU geometry |
| 43.7.6 | [x562-297c-g43g](https://github.com/advisories/GHSA-x562-297c-g43g) | Pointer-lock request frame |
| 43.8.1 | [jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9) | Compromised certificate mitigation |

Range data above comes from `/private/tmp/railwise-054-full-audit-after.json`; the certificate, preload, protocol and webview advisories and official releases were also read from their primary pages. The old audit's Electron result describes 43.1.1; it must be refreshed after the owner's upgrade rather than attached as a 43.8.6 audit.

The main window is explicitly sandboxed and isolated at `src/main/index.ts:998`, and the webview guard sets sandbox, isolation and disables Node at `src/main/index.ts:495`. That makes the webview advisory's unsandboxed-embedder precondition absent in the reviewed main-window path. The app nevertheless loads untrusted local document/project content and makes TLS requests; it is incorrect to dismiss the entire Electron set based on that one mitigation. Final installed webview, preload, preview and export behavior still need regression coverage.

## Pins, checksums, ABI, packaging

- Runtime selection: `package.json:126`, lock root spec at `package-lock.json:73`, exact package at `package-lock.json:7478`. No independent production 43.1.1 override found. `src/main/services/electron-install.test.ts` retains 43.1.1 only as an arbitrary synthetic metadata fixture.
- `scripts/ensure-electron-install.cjs:58` dynamically resolves the installed Electron package version and requires matching platform path, dist version, in-directory regular executable. For an install it deletes override-dist and remote-checksum environment switches and calls the official `install.js`.
- The official `node_modules/electron/install.js` passes npm-package `checksums.json` to `@electron/get`, unless a remote-checksum switch is set; the wrapper clears those switches. Present checksums for 43.8.6 are recorded in the evidence JSON. Three application zip hashes are: mac arm64 `dd3ef1cf749e11f4426a1b5fb203bff1dbbc8cd589f43c46423ee40a87371390`, mac x64 `c12e82216da91117623165c8f9f6c8175cb7f9940d01da2cbbd5c6696dcf0b45`, win x64 `e4b7f67b4205e13780088e07b29d5c7d2decc10f2331fd62927f8ea7750e9ba8`.
- A ready preexisting extracted dist is checked for metadata/path, **not rehashed**. For a release use a clean verified install or retain verified original zip hashes; do not call metadata checks a new content-integrity proof.
- `scripts/before-pack.cjs:13` executes the actual Electron binary with `ELECTRON_RUN_AS_NODE` to read native ABI; `:35` takes its installed package version; `:53` / `:56` feed that version and measured ABI to forced source rebuild of `better-sqlite3` for each target architecture. This is dynamic, so no guessed ABI bump is needed.
- `scripts/postinstall.cjs:28` also takes the actual Electron version. This optional prebuild has a fallback and is not the final native acceptance gate. `scripts/verify-packaged-runtime-native.cjs:20` executes SQLite CREATE/INSERT/SELECT in each packaged runtime and reports its ABI. Record Electron/Node/Chrome versions in final evidence in addition to this ABI result.
- `.github/workflows/release.yml:633` mentions ABI 148 in a comment only. Confirm measured value before deciding whether that comment needs adjustment. Existing CI Node 22.22.0 satisfies the new Electron npm installer engine `>=22.12.0`.
- `scripts/verify-build-freshness.cjs` includes package/lock inputs, so the changed lock requires a fresh build. Existing signed 43.1.1 application artifacts cannot serve as final 43.8.6 acceptance evidence.

## OpenClaw audit result: local shim identity match, not upstream vulnerable implementation

The `openclaw` high aggregate in the supplied audit is **not evidence that upstream OpenClaw 2026.5.18 is installed**. `package.json:96` is `file:vendor/openclaw-shim`; its manifest uses upstream name/version for peer import compatibility. The whole local implementation is four small SDK modules plus the manifest (2,655 JS bytes), and installed `node_modules/openclaw/plugin-sdk/*` matches those reviewed files byte-for-byte.

Reachable duties are account ID normalization (including dangerous-object-key rejection), local JSON config/store paths, basic JSON file IO, temp-directory selection, passthrough schema, and stub session operations. `infra-runtime.withFileLock` is a passthrough rather than an OS lock; this review does not certify concurrency behavior of those helpers.

The audited upstream vulnerable mechanisms are absent from this shim: gateway device/node-token restore and reconnect approval, control-UI admin device token minting, host environment/executable sanitizer, exec wrapper allowlist, MCP SSE redirect handling, message-read channel authorization, owner MCP hooks, Homebrew skill install selection, and browser CDP discovery. The eleven upstream advisories therefore have no corresponding vulnerable implementation in these four files. For example [GHSA-q99w-vh6v-q3v7](https://github.com/advisories/GHSA-q99w-vh6v-q3v7) concerns upstream gateway `node.pair` authority; this shim does not expose a gateway or node pairing handler.

The shim is still a **real shipped compatibility dependency**: `electron-builder.cjs:235` explains retention for the WeChat provider. Current app media execution imports the Tencent provider's CDN upload and MIME entry points at `src/main/weixin-bridge-runtime.ts:1578`; that graph reaches its logger and shim temp-dir helper. The provider package contains other OpenClaw imports, but the reviewed media path does not execute upstream gateway/CLI/hook runtime. Do not replace the local file dependency with latest upstream OpenClaw, remove it, or alter its version merely to make the audit report green. Record a scoped name/version false-positive disposition, preserving this evidence and packaged-file validation. This conclusion does not exempt RailWise's separately implemented pairing, network or execution controls from their own tests.

## Remaining full-audit findings: build tools versus shipped execution

| Category | Review disposition |
| --- | --- |
| Electron | Shipped binary despite dev flag; must patch and accept actual rebuilt packages. |
| KaTeX / Mermaid / Streamdown | Real shipped rendering chain. Existing independent Mermaid review records patched root copies and remaining low KaTeX advisory with prototype-pollution precondition. Retain that scoped finding; do not label runtime audit clean. |
| OpenClaw local shim | Shipped helper code; upstream advisory implementation absent as above. |
| happy-dom | Dev/test environment, referenced by DOM tests; no product-source import found. High issues affect executing/parsing attacker-controlled test HTML. Record build/test exposure; do not force a major upgrade in the frozen release solely to erase a runtime finding that is not shipped. |
| Vite, Vitest, @vitest/mocker | Dev server/test toolchain. Only non-test Vite import found in `scripts/verify-native-pptx-roundtrip.mjs`, a QA script; product bundle does not start a Vite server. Keep dev servers local/isolated. A Vite major jump would also require changing electron-vite's supported peer range and is not a minimal runtime fix. |
| npm undici 7.28.0 | Present only through Electron **download tool** `@electron/get@5.0.0`, lock marked dev; this npm module is distinct from Node's built-in networking inside the shipped Electron binary. Installer supply-chain/network findings remain build exposure, while binary Node fixes require the Electron update. |
| tar, node-gyp, make-fetch-happen, cacache, glob/brace-expansion/minimatch, @electron/rebuild / @electron/asar | Native rebuild, packaging and related dev toolchain; all affected npm lock nodes marked dev. Do not treat them as app runtime merely because the packaging scripts run them. Retain clean build-host exposure and audit evidence. |
| PostCSS / selector parser / source-map-js, browserslist / baseline mapping, ESLint / TypeScript ESLint | Build, lint and CSS tooling, affected nodes marked dev. Product-source search found no imports loading those tools at runtime. |

This table uses full audit plus current root lock flags and source import/packager checks, **not** production audit alone. A final ASAR and managed runtime inventory must confirm excluded tools were not accidentally bundled. npm flags are supporting metadata, not sufficient proof: Electron is the counterexample, and renderer-generated assets can embed dependency copies.

## Required focused validation after the owner upgrade

1. Fresh locked install and `prepare:electron`; retain original download checksum evidence. Refresh both full and production audits and archive dispositions for remaining results. Run existing Electron install tests and required CI on the new frozen commit.
2. Rebuild app and managed runtime. Run production Electron smoke, document math/footnote/Mermaid rendering and security tests, IPC/preload tests, local preview/webview navigation tests, and real model TLS/streaming with configured key without logging secrets.
3. Build mac arm64, mac x64 and Windows x64 from the upgraded lock. Execute each platform's packaged SQLite/native gate, record actual Electron/Node/Chrome/native ABI, final ASAR/embedded rendering fingerprints and exact package hashes. Check final packages contain the local shim and exclude upstream OpenClaw runtime, happy-dom, Vite server and other dev-only tools.
4. Re-sign/re-notarize final mac artifacts and verify corresponding signature/notarization and Windows signature gate. Prior runtime package signatures/acceptance are obsolete for this new package.
5. Install the exact final package locally, inspect UI and required workflows with computer-use tooling, retain screenshots/checklist plus independent AI package review, and execute the real isolated updater round trip with the final upgraded artifacts. Source review does not replace these gates.

## Evidence and limitations

- Input full audit: `/private/tmp/railwise-054-full-audit-after.json` (before the owner Electron upgrade).
- Refreshed full audit independently read: `/private/tmp/railwise-054-full-audit-electron4386.json` (33 remaining; Electron absent).
- Official registry metadata independently read: `/private/tmp/railwise-054-electron4386-registry.json`; exact 43.8.6 npm integrity agrees with the lock.
- Current-lock classification: `/private/tmp/railwise-054-audit-runtime-classification.json`. Because the owner upgraded concurrently, its Electron row is 43.8.6; it is a mapping of the old finding names to current lock nodes, not a new audit result.
- Local exact versions, shim SHA256s and official npm-package download checksums: `/private/tmp/railwise-054-electron-local-evidence.json`.
- Offline npm explanation of undici/tar build paths: `/private/tmp/railwise-054-undici-tar-paths.json`.
- Independent browser verification: official Electron 43.8.1 and 43.8.6 release pages; certificate, protocol, preload, webview and OpenClaw gateway advisory pages.
- This reviewer's sandbox registry `npm view` attempts returned DNS `ENOTFOUND`; latest-43.x registry enumeration is the release owner's successful observation. Its saved exact-version registry metadata, the official 43.8.6 release page and locally installed official package metadata were independently inspected. No runtime ABI measurement, product app launch, end-to-end UI acceptance, signing, notarization or updater operation was performed by this reviewer.
