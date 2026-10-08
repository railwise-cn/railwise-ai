# WorkWise Delivery Rules

## Release gate

- Do not change the public version, create or move a Git tag, publish or edit a GitHub Release, promote a stable or frontier feed, or update the official download page without explicit user approval naming the exact version and action.
- CI success, unit tests, a successful build, or a green GitHub Action is necessary evidence but is never release approval.
- Candidate builds must use a private, isolated feed and must never be promoted to `stable` or advertised as an official release.
- Before requesting release approval, install the final packaged application locally and record: package version, signature/notarization result, screenshots of the reviewed UI, a functional checklist, and a real updater round-trip report.
- Before any public release operation, complete and record a computer-use inspection of the installed package UI and required functions, plus a separate senior-engineer-mode AI review. The review must identify the exact package version and preserve screenshots, a functional checklist, and findings. In single-maintainer mode, this AI review is an internal quality gate and does not need to be a GitHub approval; the user must still explicitly approve the exact public version and action.
- Agent review may simulate the combined perspective of an experienced engineering-survey practitioner, software engineer, and product designer for product/software acceptance. It must be labeled as AI review and must never be represented as licensed vendor/SUC interoperability evidence, a real professional signature, or a real human approval.
- A failed or incomplete local acceptance test blocks release. Do not replace it with a mocked updater test or a manual website download.

## Compatibility and migration

- Never silently delete an existing plugin, MCP configuration, Skill, credential reference, or user data during a catalog migration.
- Any plugin removal, replacement, license restriction, or default-state change requires a migration matrix showing the old item, new status, reason, data-preservation behavior, and user action.
- Keep legacy IPC/config readers as migration compatibility until the replacement has been exercised against real user data.

## UI acceptance

- Glass material is limited to approved window chrome, startup UI, and transient overlays. Work surfaces and navigation content must remain readable and opaque enough for scanning.
- A visual change is not complete until the installed packaged application has been inspected with computer-use tooling at the supported themes, languages, and window sizes, and a separate senior-engineer-mode AI agent has reviewed the workflow and evidence. Archive screenshots, a functional checklist, accessibility findings, and defects. The user does not need to perform routine UI/functional acceptance; retain explicit user approval only for consequential public release actions.
- For Survey acceptance, the agent reviewer should combine engineering-survey practice, numerical/reporting semantics, software quality, and product-design judgment. Clearly mark simulated expertise as AI review; it does not certify regulatory conformity, vendor compatibility, professional signoff, or production acceptance that requires external evidence.
