# DeepSeek V4.1 picker correction

This is a source correction prepared after the first 0.5.4 freeze. It is not part of frozen run `41352323901` and does not change that run's package evidence.

- Source correction commit: `0f2c8618` (private checkout only)
- Current default shown to users: `deepseek-flash` (DeepSeek V4.1 Flash)
- Compatibility identifiers remain accepted by runtime migration/parsing paths but are filtered from composer, writing, phone-agent, and provider picker UI.
- Visible help text no longer prints `deepseek-v4-pro` as a product name.
- Validation: `npm run lint -- --no-fix`; 61 focused tests passed; `npm run build` passed.

A fresh PR, CI run, signed/notarized freeze, exact-package CUA review, and updater round-trip are required before this correction can be included in a public 0.5.4 release.
