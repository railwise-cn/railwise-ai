# RailWise Survey 0.5.3 candidate acceptance

Date: 2026-10-07

This record covers the exact private candidate built from commit `9527ec5f1bcb58b5af2560311c5b51b660bc6165`. It is an AI review using computer-use inspection from an engineering-survey, numerical/reporting, software-quality, and product-design perspective. It is not vendor interoperability evidence, standards certification, a professional signature, or human production acceptance.

## Package identity

| Item | Value |
| --- | --- |
| Version | `0.5.3` |
| Source commit | `9527ec5f1bcb58b5af2560311c5b51b660bc6165` |
| Bundle ID | `com.wangjiawei508.workwise.candidate.head9527ec5f1bcb` |
| Installed app | `/private/tmp/railwise-053-candidate-9527ec5f/runtime/RailWise AI Candidate 9527ec5f1bcb.app` |
| DMG SHA-256 | `5ec30f8c51dc3b242d87bd1f19a5921196c60382ef15b5a1297ccad3ef9aaf4e` |
| ZIP SHA-256 | `ad5410c3f337af6ad7366583338a5a370790d55fc08f3b9f4a2ec7e0dff006b5` |
| ASAR | Verified against the exact source commit: 18,368 archive files and 466 compiled files |

The candidate was installed from its DMG into an isolated temporary Applications directory. The production `/Applications/RailWise AI.app` and production user data were not modified. Candidate data, cache, logs, home, tools, Runtime, and schedule services were isolated below the candidate root; inbound and outbound IM and credential access were disabled.

## Automated checks

- Root suite: 354 files passed, 3,174 tests passed, 2 skipped.
- `kun` suite: 218 files passed, 3,166 tests passed, 22 skipped.
- `npm run typecheck`: passed.
- `npm run test:release-gate`: 8/8 passed.
- Electron 43.1.1 SQLite smoke test: passed with ABI 148.
- `codesign --verify --deep --strict`: passed.
- `spctl --assess --type execute`: accepted locally with security overrides disabled.
- Local package is ad-hoc signed and not notarized because this workstation has no Apple notarization credentials. This is recorded as a limitation, not as a release-ready notarization result.

The Node test suites were run before rebuilding `better-sqlite3` for Electron ABI 148. This is required by the project: Node 26 uses ABI 147 while Electron 43.1.1 uses ABI 148. The final packaged runtime was then smoke-tested under Electron.

## Computer-use review

The installed candidate was launched with `candidate.env` and inspected with native accessibility tooling.

- Survey entry is separate from Code; the sidebar shows `RailWise Survey` and the four work views `Overview`, `Process`, `Results`, and `Deliver`.
- Creating a task opens the professional workflow and shows `Data and calculation`, source type, network type, known control points, source recognition, scale, datum/units, and professional checks.
- A new task exposes `Confirm references` with explicit coordinate-system and height-datum fields. Before a source is imported the calculation actions are disabled.
- The task surface contains no visible `Typed Plan`, `TaskRun`, tool IDs, parameter JSON, `contextHash`, `sourceSha256`, parser version, execution receipt, or internal format key.
- The AI panel is opened as a temporary drawer and can be closed without taking space from the work surface.
- The candidate remains running with an isolated Runtime and no production application process was used.

The current local pass directly covers the candidate identity, Survey entry, task creation, reference gate, default professional vocabulary, and drawer behavior. It does not claim that every source format, every export, every theme/language/window-size combination, or a public-feed migration has been exercised.

## Remaining external or runner-only gates

- A real signed/notarized candidate and the native updater round-trip must run on the project’s ephemeral macOS GitHub runner; the local ad-hoc package cannot substitute for that gate.
- IN2, GSI, CSV/XLSX positive and negative imports, numerical replay, DOCX/PDF/XLSX readback, and the complete keyboard/live-region matrix need the authenticated runner evidence or a further local CUA pass.
- The AI review remains simulated expertise. COSA/SUC vendor compatibility, regulatory conformity, and professional sign-off remain external evidence requirements.

No public tag, GitHub Release, Stable/Frontier feed, or official download page was changed by this candidate build.
