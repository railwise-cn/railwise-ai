# Exact public RailWise AI 0.5.2 package identity

The already-published public release is [v0.5.2](https://github.com/railwise-cn/railwise-ai/releases/tag/v0.5.2), published 2026-10-05. Its tagged source commit is `ea763458567ccf069067a165d812f561e9af6b62`. Later branch fixes must not be represented as part of these public bytes.

The Apple Silicon DMG was downloaded from the official HTTPS stable mirror using normal TLS verification. Its SHA-256 equals the GitHub Release asset digest:

`09dae4a270bbf06fb3fc79771eef3faa2afaba43eea9e6696762fa7ba5cf99e0`

It was mounted read-only and the application copied unchanged to `/tmp/railwise-official-052/RailWise AI.app`. The package reports version `0.5.2`, identifier `com.wangjiawei508.workgpt`, and ASAR digest:

`ce33ebb88d156a129c599ab8ec8d08094014d3d578c2704fe564b2fa9d8fb3bb`

Strict deep signature verification and stapled notarization validation both exited 0. The signature is Developer ID Application, Ningbo Ruiwei Engineering Technology Co., Ltd., Team `R35G7F4A9U`, with hardened runtime. See [identity and command results](package-identity.json), [strict verification](codesign-verify.txt), [signature identity](codesign-identity.txt), [ticket validation](stapler-validate.txt), and [public asset metadata](github-release.txt).

The bundle was not edited or re-signed. Installed UI/functional acceptance is being recorded separately against this exact ASAR identity; signature success alone does not close that gate. Existing private updater acceptance is also separate evidence and must not be presented as an updater round trip to these public bytes unless identity is established.

No release asset, public tag, or updater channel was changed during these checks.
