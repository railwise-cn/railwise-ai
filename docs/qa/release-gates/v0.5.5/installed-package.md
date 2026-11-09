# RailWise AI 0.5.5: exact package installation

Source: `02165b64bffe5e24f4a4f50811d22086f1489299`. Release run: [42625022802](https://github.com/railwise-cn/railwise-ai/actions/runs/42625022802).

The exact arm64 DMG was installed into a private temporary directory and inspected. Version `0.5.5`, bundle `com.wangjiawei508.workgpt`, package `workwise`, product `RailWise AI`.

DMG SHA-256: `77c80faa00c4c40d13c37aba6f350caf37e42f4be1cbcf9395de8345b64b4994`. ASAR SHA-256: `296312d513668a4d7c45be717cc227816ff4de0d2dffbc8c0d567f74498a2a7a`. These equal the original same-run updater package hashes.

macOS deep/strict codesign verification passed; Developer ID team `R35G7F4A9U`. Application stapled notarization validation passed. This does not assert a ticket stapled to the DMG itself.

Local Gatekeeper status:

```text
exitCode=1
assessments disabled
```

Local application assessment:

```text
exitCode=0
/private/tmp/railwise-exact-42625022802/installed/RailWise AI.app: accepted
source=Notarized Developer ID
override=security disabled
```

The same-run Windows installer was installed, inspected and uninstalled on a clean GitHub-hosted Windows runner. Version/source, branded shortcuts/uninstall metadata and profile sentinels passed. Windows Authenticode is **NotSigned** (signing is not configured); no Windows signature pass is claimed.

Intel UI was not run on this Apple Silicon host. Raw local verification and Windows records are retained alongside this document.
